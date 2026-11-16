// Sign-in with an external OpenID Connect provider: the administrator's settings and the sign-in itself.
//
// Who may sign in is decided here, not by the provider:
//   1. A subject that is already linked signs in as its account (if that account is active).
//   2. Otherwise the provider must vouch for a verified email address. If an account has that address, the subject is linked to it.
//   3. Otherwise, only when an administrator switched it on and the address is in an allowed domain, a new Standard account is created.
//      An administrator account is never created or promoted here.
// Password sign-in keeps working. It can be switched off only by an administrator who has signed in through the provider, and it comes
// back by itself whenever the provider configuration stops being usable or no active administrator is linked any more.
import { z } from 'zod';
import type { AppConfig } from '../config.ts';
import { AppError } from '../errors.ts';
import { withTransaction, type Pool, type Queryable } from '../db.ts';
import { authorize, type Actor } from '../authz.ts';
import { isMailAddress } from '../email.ts';
import { log } from '../log.ts';
import {
  authorizationUrl, discover, exchangeCode, newFlowSecrets, OidcError, probeProvider, providerUrl, verifyIdToken,
  type OidcClientConfig, type OidcFailure,
} from '../oidc.ts';
import { hashPassword } from '../passwords.ts';
import { SlidingWindowLimiter } from '../rate-limit.ts';
import { recordAudit } from '../repositories/audit.ts';
import {
  adminHasSignedInWith, deleteIdentity, findIdentity, findIdentityOfUser, insertIdentity, listIdentities, touchIdentity,
} from '../repositories/identities.ts';
import { findActiveSession, insertSession, revokeSession, revokeUserSessions } from '../repositories/sessions.ts';
import { findUserByEmail, findUserInHousehold, insertUser, type UserRow } from '../repositories/users.ts';
import { decryptSecret, encryptSecret } from '../secrets.ts';
import { readGroup, refreshRuntimeConfig, type SigninProvider, type SigninValue, type StoredGroup } from '../settings.ts';
import { digest, newToken, safeEqual } from '../tokens.ts';
import { parse } from '../validation.ts';
import { commit, confirmPassword, type Detail } from './settings.ts';

export const SIGNIN_SECRET_PURPOSE = 'signin.oidc_client_secret';
const FLOW_PURPOSE = 'signin.oidc_flow';
export const FLOW_SECONDS = 10 * 60;
export const DEFAULT_SCOPES = 'openid email profile';
export const GOOGLE_ISSUER = 'https://accounts.google.com';
const microsoftIssuer = (tenant: string) => `https://login.microsoftonline.com/${tenant}/v2.0`;
const PROVIDER_LABEL: Record<SigninProvider, string> = { generic: 'single sign-on', google: 'Google', microsoft: 'Microsoft' };

/** Per client address. Sign-in attempts make outbound requests to the provider, so they are bounded like other sign-in work. */
const attempts = new SlidingWindowLimiter(30, 5 * 60_000);
const tests = new SlidingWindowLimiter(5, 5 * 60_000);
export const resetSigninLimitersForTests = () => { attempts.reset(); tests.reset(); };

/** The address the provider sends the browser back to. Built from the canonical origin only, never from request headers. */
export const callbackUrl = (config: AppConfig) => new URL('/api/auth/oidc/callback', config.canonicalOrigin).href;

export type SigninProblem = 'disabled' | 'incomplete' | 'secrets_key_missing' | 'secret_unreadable';

interface Loaded { stored: StoredGroup<'signin'>; client: OidcClientConfig | null; problem: SigninProblem | null; label: string }

async function loadOidc(db: Queryable, config: AppConfig): Promise<Loaded> {
  const stored = await readGroup(db, 'signin');
  const v = stored.value;
  const label = v.buttonLabel || PROVIDER_LABEL[v.provider ?? 'generic'];
  const fail = (problem: SigninProblem): Loaded => ({ stored, client: null, problem, label });
  if (!v.enabled) return fail('disabled');
  if (!v.issuer || !v.clientId || !providerUrl(v.issuer, config.oidcAllowInsecure)) return fail('incomplete');
  // The key also protects the short-lived cookie that carries the flow's state, nonce and PKCE verifier.
  if (!config.secretsKey) return fail('secrets_key_missing');
  let clientSecret: string | null = null;
  if (stored.secretCiphertext) {
    const d = decryptSecret(config.secretsKey, SIGNIN_SECRET_PURPOSE, stored.secretCiphertext);
    if (d.status !== 'ok') return fail('secret_unreadable');
    clientSecret = d.value;
  }
  return {
    stored, problem: null, label,
    client: { issuer: v.issuer, clientId: v.clientId, clientSecret, scopes: v.scopes || DEFAULT_SCOPES, allowInsecure: config.oidcAllowInsecure },
  };
}

export interface SigninState {
  /** Text for the provider button on the sign-in page, or null when provider sign-in is not available. */
  oidcLabel: string | null;
  /** False only when an administrator switched password sign-in off and every condition for that still holds. */
  passwordLogin: boolean;
}

/**
 * What the sign-in page offers and what the password route accepts. Password sign-in is refused only while all of this is true: the
 * switch is on, the provider configuration is usable, an active administrator has signed in through it, and the server was not started
 * with TALLYMED_PASSWORD_LOGIN=on. Any read failure leaves password sign-in available.
 */
export async function signinState(db: Queryable, config: AppConfig): Promise<SigninState> {
  try {
    const o = await loadOidc(db, config);
    if (!o.client) return { oidcLabel: null, passwordLogin: true };
    const off = o.stored.value.passwordLoginDisabled === true && !config.forcePasswordLogin && await adminHasSignedInWith(db, o.client.issuer);
    return { oidcLabel: o.label, passwordLogin: !off };
  } catch (error) {
    if ((error as { code?: string })?.code !== '42P01') log('warn', 'signin.state_unavailable', {});
    return { oidcLabel: null, passwordLogin: true };
  }
}

// ---------- administrator settings ----------

const blank = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);
const optText = (max: number) => z.preprocess(blank, z.string().trim().max(max).nullable().default(null));
const checkbox = z.preprocess((v) => v === 'yes' || v === 'on' || v === true, z.boolean());
const noCtl = (s: string) => !/[\u0000-\u001f\u007f]/.test(s);
const DOMAIN = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?)+$/;
const TENANT = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?)+)$/;
const SCOPE = /^[\x21\x23-\x5b\x5d-\x7e]{1,64}$/;

export const signinSchemas = {
  save: z.strictObject({
    version: z.coerce.number().int().min(0).max(2_000_000_000), currentPassword: z.string().min(1).max(256), csrf: z.string().optional(),
    enabled: checkbox.optional(),
    provider: z.enum(['generic', 'google', 'microsoft']),
    issuer: optText(300), tenant: optText(64),
    clientId: optText(200).refine((c) => c === null || noCtl(c), 'invalid'),
    clientSecret: z.preprocess((v) => (v === undefined ? '' : v), z.string().max(512).refine(noCtl, 'invalid')),
    clearSecret: checkbox.optional(),
    scopes: optText(200), buttonLabel: optText(40).refine((c) => c === null || noCtl(c), 'invalid'),
    autoProvision: checkbox.optional(),
    allowedDomains: z.preprocess((v) => (v === undefined ? '' : v), z.string().max(1000)),
    passwordLoginDisabled: checkbox.optional(),
  }),
  test: z.strictObject({ csrf: z.string().optional() }),
  unlink: z.strictObject({ identityId: z.uuid(), currentPassword: z.string().min(1).max(256), csrf: z.string().optional() }),
};

export async function saveSignin(pool: Pool, config: AppConfig, actor: Actor, input: unknown, requestId: string): Promise<void> {
  authorize(actor, 'settings:manage');
  const d = parse(signinSchemas.save, input);
  let issuer: string | null = null;
  let tenant: string | null = null;
  if (d.provider === 'google') issuer = GOOGLE_ISSUER;
  else if (d.provider === 'microsoft') {
    tenant = d.tenant?.toLowerCase() ?? null;
    // The shared "common", "organizations" and "consumers" endpoints issue tokens for any tenant, so they are not accepted.
    if (tenant !== null && !TENANT.test(tenant)) throw new AppError('invalid_input', 'Enter the directory (tenant) ID or its domain name');
    issuer = tenant ? microsoftIssuer(tenant) : null;
  } else if (d.issuer !== null) {
    const url = providerUrl(d.issuer, config.oidcAllowInsecure);
    if (!url || url.search) throw new AppError('invalid_input', 'The issuer must be an https URL without a query or fragment');
    issuer = d.issuer;
  }
  const scopes = [...new Set((d.scopes ?? DEFAULT_SCOPES).split(/\s+/).filter(Boolean))];
  if (scopes.length > 10 || !scopes.every((s) => SCOPE.test(s)) || !scopes.includes('openid')) {
    throw new AppError('invalid_input', 'Scopes are separated by spaces and must include openid');
  }
  const domains = [...new Set(d.allowedDomains.split(/[\s,;]+/).map((x) => x.trim().toLowerCase().replace(/^@/, '')).filter(Boolean))];
  if (domains.length > 20 || !domains.every((x) => DOMAIN.test(x))) throw new AppError('invalid_input', 'Enter up to 20 email domains, such as example.com');
  const enabled = d.enabled === true;
  if (enabled && (!issuer || !d.clientId)) throw new AppError('invalid_input', 'An issuer and a client ID are needed to turn provider sign-in on');
  if (enabled && !config.secretsKey) throw new AppError('secrets_key_missing');
  // New accounts are only ever created for addresses in a listed domain: without a list, anyone the provider knows could join.
  if (d.autoProvision && domains.length === 0) throw new AppError('invalid_input', 'List at least one email domain before allowing new accounts');
  if (d.passwordLoginDisabled && !enabled) throw new AppError('invalid_input', 'Password sign-in can only be turned off while provider sign-in is on');
  await confirmPassword(pool, actor, d.currentPassword, requestId);
  const value: SigninValue = {
    enabled, provider: d.provider, issuer, tenant, clientId: d.clientId, scopes: scopes.join(' '), buttonLabel: d.buttonLabel,
    autoProvision: d.autoProvision === true, allowedDomains: domains, passwordLoginDisabled: d.passwordLoginDisabled === true,
  };
  if (value.passwordLoginDisabled) {
    // Proof before lock: the person turning passwords off must already have signed in through this exact provider configuration.
    const current = await readGroup(pool, 'signin');
    const same = current.value.enabled === true && current.value.issuer === issuer && current.value.clientId === d.clientId
      && d.clientSecret === '' && !d.clearSecret;
    if (!same || !issuer || !(await adminHasSignedInWith(pool, issuer, actor.userId))) throw new AppError('sso_not_proven');
  }
  await commit(pool, config, actor, requestId, 'signin', d.version, (current) => {
    let secret = current.secretCiphertext;
    let secretChange: string | null = null;
    // A saved secret belongs to the provider and client it was entered for. It is never carried over to another issuer or client,
    // where it would be sent to a different token endpoint: it is dropped and must be typed again.
    if (secret && (current.value.issuer !== issuer || current.value.clientId !== d.clientId)) {
      secret = null;
      secretChange = 'cleared';
    }
    if (d.clearSecret) {
      if (secret) secretChange = 'cleared';
      secret = null;
    }
    if (d.clientSecret !== '') {
      if (!config.secretsKey) throw new AppError('secrets_key_missing');
      secret = encryptSecret(config.secretsKey, SIGNIN_SECRET_PURPOSE, d.clientSecret);
      secretChange = 'set';
    }
    return { value, secret, extra: (secretChange ? { clientSecret: secretChange } : {}) as Detail };
  }, 'settings.signin_updated');
}

export type SigninTestResult = 'ok' | SigninProblem | OidcFailure;

/** Reads the provider's discovery document and keys with the saved settings. Makes no sign-in and changes nothing. */
export async function testSignin(pool: Pool, config: AppConfig, actor: Actor, input: unknown, requestId: string): Promise<SigninTestResult> {
  authorize(actor, 'settings:manage');
  parse(signinSchemas.test, input);
  const wait = tests.take(actor.userId);
  if (wait !== null) throw new AppError('rate_limited', 'Too many connection tests', wait);
  const stored = await readGroup(pool, 'signin');
  const v = stored.value;
  let result: SigninTestResult = 'ok';
  if (!v.issuer || !v.clientId || !providerUrl(v.issuer, config.oidcAllowInsecure)) result = 'incomplete';
  else {
    try {
      await probeProvider(v.issuer, config.oidcAllowInsecure);
    } catch (error) {
      result = error instanceof OidcError ? error.reason : 'unreachable';
    }
  }
  await recordAudit(pool, {
    householdId: actor.householdId, actorUserId: actor.userId, action: 'settings.signin_tested', entityType: 'server_settings', entityId: 'signin',
    requestId, detail: { result },
  });
  return result;
}

export async function unlinkIdentity(pool: Pool, config: AppConfig, actor: Actor, input: unknown, requestId: string): Promise<void> {
  authorize(actor, 'settings:manage');
  const d = parse(signinSchemas.unlink, input);
  await confirmPassword(pool, actor, d.currentPassword, requestId);
  await withTransaction(pool, async (tx) => {
    const removed = await deleteIdentity(tx, actor.householdId, d.identityId);
    if (!removed) throw new AppError('not_found');
    // The person's sessions end with the link (except the administrator's own, who is doing this), so removing a link takes effect now.
    const ended = removed.userId === actor.userId ? 0 : await revokeUserSessions(tx, removed.userId, 'identity_unlinked');
    await recordAudit(tx, {
      householdId: actor.householdId, actorUserId: actor.userId, action: 'auth.oidc_unlinked', entityType: 'user', entityId: removed.userId, requestId,
      detail: { issuer: removed.issuer, sessionsEnded: ended },
    });
  });
  void config;
}

export async function loadSigninView(pool: Pool, config: AppConfig, actor: Actor) {
  authorize(actor, 'settings:manage');
  const o = await loadOidc(pool, config);
  const state = await signinState(pool, config);
  const issuer = o.stored.value.issuer ?? null;
  return {
    value: o.stored.value, version: o.stored.version, problem: o.problem, label: o.label,
    secretState: !o.stored.secretCiphertext ? 'none' as const : o.problem === 'secret_unreadable' || !config.secretsKey ? 'unreadable' as const : 'saved' as const,
    secretsKeyAvailable: config.secretsKey !== null, callbackUrl: callbackUrl(config), allowInsecure: config.oidcAllowInsecure,
    forcePasswordLogin: config.forcePasswordLogin, passwordLogin: state.passwordLogin,
    youSignedIn: issuer ? await adminHasSignedInWith(pool, issuer, actor.userId) : false,
    identities: (await listIdentities(pool, actor.householdId)).map((i) => ({
      id: i.id, email: i.email, displayName: i.displayName, role: i.role, status: i.status, current: i.issuer === issuer,
      createdVia: i.createdVia, createdAt: i.createdAt, lastLoginAt: i.lastLoginAt,
    })),
  };
}

// ---------- the sign-in flow ----------

interface Flow { s: string; n: string; v: string; exp: number; iss: string; cid: string }

const refuse = (code: 'sso_failed' | 'sso_no_account' | 'sso_unavailable', reason: string, requestId: string): AppError => {
  log('info', 'auth.oidc_refused', { requestId, reason });
  return new AppError(code);
};

/** First step: where to send the browser, and the encrypted cookie that binds the answer to this browser. */
export async function startOidc(pool: Pool, config: AppConfig, input: { ip: string | null; requestId: string }): Promise<{ location: string; flowCookie: string }> {
  await refreshRuntimeConfig(config, pool);
  const wait = attempts.take(input.ip ?? 'untrusted');
  if (wait !== null) throw new AppError('rate_limited', 'Too many sign-in attempts', wait);
  const o = await loadOidc(pool, config);
  if (!o.client || !config.secretsKey) throw refuse('sso_unavailable', o.problem ?? 'unavailable', input.requestId);
  let metadata;
  try {
    metadata = await discover(o.client.issuer, o.client.allowInsecure);
  } catch (error) {
    throw refuse('sso_unavailable', error instanceof OidcError ? error.reason : 'unreachable', input.requestId);
  }
  const secrets = newFlowSecrets();
  const flow: Flow = { s: secrets.state, n: secrets.nonce, v: secrets.codeVerifier, exp: Date.now() + FLOW_SECONDS * 1000, iss: o.client.issuer, cid: o.client.clientId };
  return {
    location: authorizationUrl(metadata, o.client, callbackUrl(config), secrets),
    flowCookie: encryptSecret(config.secretsKey, FLOW_PURPOSE, JSON.stringify(flow)),
  };
}

function readFlow(config: AppConfig, cookie: string | null): Flow | null {
  if (!cookie || cookie.length > 2048 || !config.secretsKey) return null;
  const d = decryptSecret(config.secretsKey, FLOW_PURPOSE, cookie);
  if (d.status !== 'ok') return null;
  try {
    const f = JSON.parse(d.value) as Flow;
    return typeof f.s === 'string' && typeof f.n === 'string' && typeof f.v === 'string' && typeof f.exp === 'number'
      && typeof f.iss === 'string' && typeof f.cid === 'string' ? f : null;
  } catch {
    return null;
  }
}

const displayNameFrom = (name: string | null, email: string) => {
  const clean = (name ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  return clean || email.split('@')[0]!.slice(0, 80) || 'New user';
};

export interface OidcLoginResult { token: string; expiresAt: Date; passwordChangeRequired: boolean }

type Resolved =
  | { ok: true; user: UserRow; sessionId: string }
  | { ok: false; code: 'sso_failed' | 'sso_no_account'; reason: string; user?: UserRow };

/**
 * Second step: the provider sent the browser back. Checks the state against this browser's cookie, exchanges the code, verifies the ID
 * token, decides which account (if any) the subject signs in as, and creates the session.
 */
export async function finishOidc(
  pool: Pool, config: AppConfig,
  input: { query: Record<string, string>; flowCookie: string | null; ip: string | null; requestId: string; previousToken?: string | null },
): Promise<OidcLoginResult> {
  await refreshRuntimeConfig(config, pool);
  const { requestId } = input;
  const wait = attempts.take(input.ip ?? 'untrusted');
  if (wait !== null) throw new AppError('rate_limited', 'Too many sign-in attempts', wait);
  const o = await loadOidc(pool, config);
  if (!o.client) throw refuse('sso_unavailable', o.problem ?? 'unavailable', requestId);
  const client = o.client;
  const flow = readFlow(config, input.flowCookie);
  if (!flow || flow.exp < Date.now()) throw refuse('sso_failed', 'flow_missing_or_expired', requestId);
  // A flow started under another provider configuration must not complete under this one.
  if (flow.iss !== client.issuer || flow.cid !== client.clientId) throw refuse('sso_failed', 'configuration_changed', requestId);
  const state = input.query.state;
  if (typeof state !== 'string' || state.length > 200 || !safeEqual(state, flow.s)) throw refuse('sso_failed', 'state_mismatch', requestId);
  if (input.query.error !== undefined) {
    throw refuse('sso_failed', `provider_error:${/^[a-z_]{1,40}$/.test(input.query.error) ? input.query.error : 'other'}`, requestId);
  }
  const code = input.query.code;
  if (typeof code !== 'string' || code.length < 1 || code.length > 2048) throw refuse('sso_failed', 'code_missing', requestId);

  let claims;
  try {
    const metadata = await discover(client.issuer, client.allowInsecure);
    // RFC 9207: when the provider names itself in the answer, it must be the provider this flow was started with.
    if (input.query.iss !== undefined && input.query.iss !== metadata.issuer) throw new OidcError('issuer_mismatch');
    const tokens = await exchangeCode(metadata, client, callbackUrl(config), code, flow.v);
    claims = await verifyIdToken(tokens.idToken, metadata, client, flow.n);
  } catch (error) {
    throw refuse('sso_failed', error instanceof OidcError ? error.reason : 'internal', requestId);
  }

  const value = o.stored.value;
  const email = claims.email && claims.emailVerified && isMailAddress(claims.email) ? claims.email : null;
  // Hash outside the transaction: an account created here gets a random password nobody knows.
  const unknowablePassword = value.autoProvision ? await hashPassword(newToken() + newToken()) : null;
  const token = newToken();
  const expiresAt = new Date(Date.now() + config.sessionAbsoluteSeconds * 1000);
  let resolved: Resolved;
  try {
    resolved = await withTransaction(pool, async (tx): Promise<Resolved> => {
      // Identities are keyed by the configured issuer, the same value the settings and the lockout check use.
      const identity = await findIdentity(tx, client.issuer, claims.subject);
      let user: UserRow | null;
      let identityId: string;
      if (identity) {
        user = await findUserInHousehold(tx, identity.householdId, identity.userId, true);
        identityId = identity.id;
      } else {
        if (!email) return { ok: false, code: 'sso_no_account', reason: 'email_not_verified' };
        const found = await findUserByEmail(tx, email);
        if (found) {
          user = await findUserInHousehold(tx, found.householdId, found.id, true);
          if (!user || user.status !== 'active') return { ok: false, code: 'sso_no_account', reason: 'account_disabled', user: user ?? undefined };
          // One subject per account and issuer: a second subject claiming the same address is never linked silently.
          if (await findIdentityOfUser(tx, user.id, client.issuer)) return { ok: false, code: 'sso_failed', reason: 'identity_conflict', user };
          identityId = await insertIdentity(tx, { userId: user.id, householdId: user.householdId, issuer: client.issuer, subject: claims.subject, emailAtLink: email, createdVia: 'email_match' });
          await recordAudit(tx, {
            householdId: user.householdId, actorUserId: user.id, action: 'auth.oidc_linked', entityType: 'user', entityId: user.id, requestId,
            detail: { issuer: client.issuer, via: 'email_match' },
          });
        } else {
          const domain = email.split('@').pop()!.toLowerCase();
          if (!value.autoProvision || !unknowablePassword || !(value.allowedDomains ?? []).includes(domain)) {
            return { ok: false, code: 'sso_no_account', reason: 'no_account' };
          }
          const households = await tx.query<{ id: string }>('select id from households order by created_at limit 2');
          if (households.rowCount !== 1) return { ok: false, code: 'sso_no_account', reason: 'no_single_household' };
          const householdId = households.rows[0]!.id;
          // Always a Standard account. Making someone an administrator stays a deliberate act on the Users page.
          const userId = await insertUser(tx, { householdId, email, displayName: displayNameFrom(claims.name, email), role: 'operator', passwordHash: unknowablePassword });
          user = await findUserInHousehold(tx, householdId, userId, true);
          identityId = await insertIdentity(tx, { userId, householdId, issuer: client.issuer, subject: claims.subject, emailAtLink: email, createdVia: 'provisioned' });
          await recordAudit(tx, {
            householdId, actorUserId: userId, action: 'auth.oidc_user_created', entityType: 'user', entityId: userId, requestId,
            detail: { issuer: client.issuer, role: 'operator' },
          });
        }
      }
      if (!user || user.status !== 'active') return { ok: false, code: 'sso_no_account', reason: 'account_disabled', user: user ?? undefined };
      await touchIdentity(tx, identityId);
      if (input.previousToken) {
        const prev = await findActiveSession(tx, digest(input.previousToken), config.sessionIdleSeconds, config.rememberSessionIdleSeconds);
        if (prev) await revokeSession(tx, prev.sessionId, 'rotated_at_login');
      }
      const sessionId = await insertSession(tx, { userId: user.id, householdId: user.householdId, tokenHash: digest(token), expiresAt });
      await recordAudit(tx, {
        householdId: user.householdId, actorUserId: user.id, action: 'auth.login', entityType: 'session', entityId: sessionId, requestId,
        detail: { method: 'oidc', ...(user.mustChangePassword ? { restricted: true } : {}) },
      });
      return { ok: true, user, sessionId };
    });
  } catch (error) {
    // Two first sign-ins of the same person at once: the unique indexes let one through. The other simply tries again.
    if ((error as { code?: string })?.code === '23505') throw refuse('sso_failed', 'concurrent_link', requestId);
    throw error;
  }
  if (!resolved.ok) {
    if (resolved.user) {
      await recordAudit(pool, {
        householdId: resolved.user.householdId, actorUserId: null, action: 'auth.oidc_refused', entityType: 'user', entityId: resolved.user.id, requestId,
        detail: { reason: resolved.reason },
      });
    }
    throw refuse(resolved.code, resolved.reason, requestId);
  }
  return { token, expiresAt, passwordChangeRequired: resolved.user.mustChangePassword };
}
