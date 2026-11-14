// Administrator settings: the editable server values, the SMTP configuration and the trusted reverse proxy list. Every function here is
// admin-only (re-checked on the server for every call), asks for the administrator's password again before saving, is optimistic-locked by
// the group's version, and writes its audit row in the same transaction as the change. Secrets are encrypted, never returned and never audited.
import { isIP } from 'node:net';
import { z } from 'zod';
import type { AppConfig } from '../config.ts';
import { sourceUrl } from '../config.ts';
import { AppError } from '../errors.ts';
import { withTransaction, type Pool } from '../db.ts';
import { authorize, type Actor } from '../authz.ts';
import { isMailAddress, loadSmtpSettings, sendEmail, EMAIL_SECRET_PURPOSE, type EmailResult } from '../email.ts';
import { parseTrustedList } from '../ip.ts';
import { verifyPassword } from '../passwords.ts';
import { SlidingWindowLimiter } from '../rate-limit.ts';
import { recordAudit } from '../repositories/audit.ts';
import { findUserInHousehold } from '../repositories/users.ts';
import { decryptSecret, encryptSecret } from '../secrets.ts';
import {
  environmentDefaults, readGroup, refreshRuntimeConfig, SMTP_PORTS, writeGroup, logSettingsChange,
  type DocumentsValue, type EmailValue, type GeneralValue, type GroupKey, type GroupValue, type ProxyValue, type StoredGroup,
} from '../settings.ts';
import { parse } from '../validation.ts';

const SETTINGS_LOCK = 7_203_501;
export const REAUTH_FAILURES = 5;
const reauth = new SlidingWindowLimiter(REAUTH_FAILURES, 15 * 60_000);
export const TEST_EMAILS_PER_WINDOW = 3;
const testLimiter = new SlidingWindowLimiter(TEST_EMAILS_PER_WINDOW, 5 * 60_000);
export const resetSettingsLimitersForTests = () => { reauth.reset(); testLimiter.reset(); };

/** Verifies the acting administrator's own password. Five wrong answers in 15 minutes lock this check for that administrator. */
async function confirmPassword(pool: Pool, actor: Actor, password: string): Promise<void> {
  const wait = reauth.blockedFor(actor.userId);
  if (wait !== null) throw new AppError('rate_limited', 'Too many incorrect passwords', wait);
  const user = await findUserInHousehold(pool, actor.householdId, actor.userId);
  if (!user || user.status !== 'active' || !(await verifyPassword(user.passwordHash, password))) {
    reauth.record(actor.userId);
    throw new AppError('reauth_failed');
  }
  reauth.reset(actor.userId);
}

// ---------- input schemas ----------

const csrf = { csrf: z.string().optional() };
const version = z.coerce.number().int().min(0).max(2_000_000_000);
const currentPassword = z.string().min(1).max(256);
const blank = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);
const optInt = (min: number, max: number) => z.preprocess(blank, z.coerce.number().int().min(min).max(max).nullable().default(null));
const checkbox = z.preprocess((v) => v === 'yes' || v === 'on' || v === true, z.boolean());
const optText = (max: number) => z.preprocess(blank, z.string().trim().max(max).nullable().default(null));
const HOST = /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,62}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,62}[A-Za-z0-9])?)*$/;
const host = z.string().trim().toLowerCase().refine((h) => HOST.test(h) || isIP(h) === 6, 'invalid host');
const port = z.coerce.number().int().refine((p) => (SMTP_PORTS as readonly number[]).includes(p), 'port not allowed');
const noCtl = (s: string) => !/[\u0000-\u001f\u007f]/.test(s);

export const settingsSchemas = {
  general: z.strictObject({
    version, currentPassword, ...csrf,
    sourceUrl: z.preprocess(blank, z.string().trim().max(300).refine((u) => sourceUrl(u) !== null, 'https URL required').nullable().default(null)),
    sessionAbsoluteMinutes: optInt(1, 43_200), sessionIdleMinutes: optInt(1, 10_080), invitationMinutes: optInt(1, 20_160),
  }),
  documents: z.strictObject({ version, currentPassword, ...csrf, documentMaxMb: optInt(1, 25), documentQuotaMb: optInt(10, 1_048_576), documentRetentionDays: optInt(0, 3650) }),
  email: z.strictObject({
    version, currentPassword, ...csrf,
    host, port, security: z.enum(['tls', 'starttls', 'none']),
    username: optText(254).refine((u) => u === null || noCtl(u), 'invalid'),
    password: z.preprocess((v) => (v === undefined ? '' : v), z.string().max(256).refine(noCtl, 'invalid')),
    clearPassword: checkbox.optional(),
    fromAddress: z.string().trim().refine(isMailAddress, 'invalid address'),
    fromName: optText(80).refine((n) => n === null || noCtl(n), 'invalid'),
    allowRestrictedTargets: checkbox.optional(),
  }),
  clearEmail: z.strictObject({ version, currentPassword, ...csrf }),
  proxy: z.strictObject({
    version, currentPassword, ...csrf,
    trustedProxies: z.preprocess((v) => (v === undefined ? '' : v), z.string().max(2000)),
    useEnvironment: checkbox.optional(),
  }),
  test: z.strictObject({ ...csrf }),
};

// ---------- shared commit ----------

type Detail = Record<string, string | number | boolean | null>;
const show = (v: unknown): string | number | boolean | null => (v === undefined || v === null ? null : Array.isArray(v) ? v.join(' ').slice(0, 300) : typeof v === 'string' ? v.slice(0, 300) : (v as number | boolean));

/** Changed fields as `field.from` / `field.to`. Fields named in `hide` only record that they changed. */
function diff(before: object, after: object, hide: string[] = []): Detail {
  const out: Detail = {};
  const a = before as Record<string, unknown>;
  const b = after as Record<string, unknown>;
  for (const f of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (JSON.stringify(a[f] ?? null) === JSON.stringify(b[f] ?? null)) continue;
    if (hide.includes(f)) out[f] = 'changed';
    else { out[`${f}.from`] = show(a[f]); out[`${f}.to`] = show(b[f]); }
  }
  return out;
}

async function commit<K extends GroupKey>(
  pool: Pool, config: AppConfig, actor: Actor, requestId: string, group: K, expected: number,
  compute: (current: StoredGroup<K>) => { value: GroupValue[K]; secret: string | null; extra?: Detail; hide?: string[] },
  action = 'settings.updated',
): Promise<boolean> {
  const changed = await withTransaction(pool, async (tx) => {
    await tx.query('select pg_advisory_xact_lock($1)', [SETTINGS_LOCK]);
    const current = await readGroup(tx, group, true);
    if (current.version !== expected) throw new AppError('stale_version');
    const next = compute(current);
    const detail = { ...diff(current.value, next.value, next.hide), ...(next.extra ?? {}) };
    if (Object.keys(detail).length === 0 && next.secret === current.secretCiphertext) return false;
    await writeGroup(tx, group, next.value, next.secret, current.version, actor.userId);
    await recordAudit(tx, {
      householdId: actor.householdId, actorUserId: actor.userId, action, entityType: 'server_settings', entityId: group, requestId,
      detail: { group, ...detail },
    });
    logSettingsChange(group, Object.keys(detail));
    return true;
  });
  await refreshRuntimeConfig(config, pool, true);
  return changed;
}

const minutes = (m: number | null) => (m === null ? undefined : m * 60);

// ---------- general and documents ----------

export async function saveGeneral(pool: Pool, config: AppConfig, actor: Actor, input: unknown, requestId: string): Promise<void> {
  authorize(actor, 'settings:manage');
  const d = parse(settingsSchemas.general, input);
  await confirmPassword(pool, actor, d.currentPassword);
  const defaults = environmentDefaults(config);
  const absolute = minutes(d.sessionAbsoluteMinutes) ?? defaults.sessionAbsoluteSeconds;
  const idle = minutes(d.sessionIdleMinutes) ?? defaults.sessionIdleSeconds;
  if (idle > absolute) throw new AppError('invalid_input', 'The idle limit cannot be longer than the maximum session length');
  const value: GeneralValue = {
    sourceUrl: d.sourceUrl ? sourceUrl(d.sourceUrl) : null,
    sessionAbsoluteSeconds: minutes(d.sessionAbsoluteMinutes) ?? null, sessionIdleSeconds: minutes(d.sessionIdleMinutes) ?? null,
    invitationSeconds: minutes(d.invitationMinutes) ?? null,
  };
  await commit(pool, config, actor, requestId, 'general', d.version, () => ({ value, secret: null }));
}

export async function saveDocuments(pool: Pool, config: AppConfig, actor: Actor, input: unknown, requestId: string): Promise<void> {
  authorize(actor, 'settings:manage');
  const d = parse(settingsSchemas.documents, input);
  await confirmPassword(pool, actor, d.currentPassword);
  const defaults = environmentDefaults(config);
  const max = d.documentMaxMb ?? defaults.documentMaxBytes / 1048576;
  const quota = d.documentQuotaMb ?? defaults.documentQuotaBytes / 1048576;
  if (max > quota) throw new AppError('invalid_input', 'The file size limit cannot be larger than the household storage limit');
  const value: DocumentsValue = { documentMaxMb: d.documentMaxMb, documentQuotaMb: d.documentQuotaMb, documentRetentionDays: d.documentRetentionDays };
  await commit(pool, config, actor, requestId, 'documents', d.version, () => ({ value, secret: null }));
}

// ---------- reverse proxy ----------

export function splitEntries(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).map((e) => e.trim()).filter(Boolean))];
}

export async function saveProxy(pool: Pool, config: AppConfig, actor: Actor, input: unknown, requestId: string): Promise<void> {
  authorize(actor, 'settings:manage');
  const d = parse(settingsSchemas.proxy, input);
  let list: string[] | null = null;
  if (!d.useEnvironment) {
    const entries = splitEntries(d.trustedProxies);
    if (entries.length > 20) throw new AppError('invalid_input', 'At most 20 entries');
    const parsed = parseTrustedList(entries);
    if (parsed.errors.length) throw new AppError('invalid_input', parsed.errors[0]);
    list = parsed.ok.map((e) => e.entry);
  }
  await confirmPassword(pool, actor, d.currentPassword);
  const value: ProxyValue = { trustedProxies: list };
  await commit(pool, config, actor, requestId, 'proxy', d.version, () => ({ value, secret: null }), 'settings.proxy_updated');
}

// ---------- email ----------

export async function saveEmail(pool: Pool, config: AppConfig, actor: Actor, input: unknown, requestId: string): Promise<void> {
  authorize(actor, 'settings:manage');
  const d = parse(settingsSchemas.email, input);
  if (d.security === 'none' && (d.username !== null || d.password !== '')) {
    throw new AppError('invalid_input', 'Credentials are never sent without encryption: choose TLS or STARTTLS, or remove the username');
  }
  await confirmPassword(pool, actor, d.currentPassword);
  const value: EmailValue = {
    host: d.host, port: d.port, security: d.security, username: d.username, fromAddress: d.fromAddress, fromName: d.fromName,
    allowRestrictedTargets: d.allowRestrictedTargets === true,
  };
  await commit(pool, config, actor, requestId, 'email', d.version, (current) => {
    let secret = current.secretCiphertext;
    let passwordChange: string | null = null;
    if (d.username === null || d.clearPassword) {
      if (secret) passwordChange = 'cleared';
      secret = null;
    }
    if (d.password !== '' && d.username !== null) {
      if (!config.secretsKey) throw new AppError('secrets_key_missing');
      secret = encryptSecret(config.secretsKey, EMAIL_SECRET_PURPOSE, d.password);
      passwordChange = 'set';
    }
    if (d.username !== null && secret === null) throw new AppError('invalid_input', 'A username needs a password');
    return { value, secret, extra: (passwordChange ? { password: passwordChange } : {}) as Detail, hide: ['username'] };
  });
}

export async function clearEmail(pool: Pool, config: AppConfig, actor: Actor, input: unknown, requestId: string): Promise<void> {
  authorize(actor, 'settings:manage');
  const d = parse(settingsSchemas.clearEmail, input);
  await confirmPassword(pool, actor, d.currentPassword);
  await commit(pool, config, actor, requestId, 'email', d.version, (current) => ({
    value: {}, secret: null, extra: { cleared: true, ...(current.secretCiphertext ? { password: 'cleared' } : {}) }, hide: ['username'],
  }), 'settings.email_cleared');
}

/** Sends a test message to the acting administrator's own address only. There is no recipient input, so it cannot be used as a relay. */
export async function sendTestEmail(pool: Pool, config: AppConfig, actor: Actor, input: unknown, requestId: string, deps?: Parameters<typeof sendEmail>[2]['deps']): Promise<EmailResult> {
  authorize(actor, 'settings:manage');
  parse(settingsSchemas.test, input);
  const wait = testLimiter.take(actor.userId);
  if (wait !== null) throw new AppError('rate_limited', 'Too many test emails', wait);
  const user = await findUserInHousehold(pool, actor.householdId, actor.userId);
  if (!user) throw new AppError('not_found');
  const result = await sendEmail({ db: pool, config }, {
    to: user.email, subject: 'TallyMed test email',
    text: 'This is a test message from your TallyMed installation. If you can read it, outgoing email works.\n\nNothing needs to be done.',
  }, { purpose: 'settings.test', requestId, deps });
  await recordAudit(pool, {
    householdId: actor.householdId, actorUserId: actor.userId, action: 'settings.email_tested', entityType: 'server_settings', entityId: 'email', requestId,
    detail: { sent: result.sent, reason: result.sent ? null : result.reason, smtpCode: result.sent ? null : result.smtpCode ?? null },
  });
  return result;
}

// ---------- reading for the pages ----------

export async function loadSettingsView(pool: Pool, config: AppConfig, actor: Actor) {
  authorize(actor, 'settings:manage');
  const [general, documents, email, proxy] = await Promise.all([
    readGroup(pool, 'general'), readGroup(pool, 'documents'), readGroup(pool, 'email'), readGroup(pool, 'proxy'),
  ]);
  const defaults = environmentDefaults(config);
  const smtp = await loadSmtpSettings(pool, config);
  let passwordState: 'none' | 'saved' | 'unreadable' = 'none';
  if (email.secretCiphertext) {
    const key = config.secretsKey;
    passwordState = key && decryptSecret(key, EMAIL_SECRET_PURPOSE, email.secretCiphertext).status === 'ok' ? 'saved' : 'unreadable';
  }
  return {
    general, documents, email: { ...email, secretCiphertext: undefined }, proxy, defaults,
    emailConfigured: 'settings' in smtp, passwordState, secretsKeyAvailable: config.secretsKey !== null,
    // Never includes the secret: only the stored non-secret value and a flag.
  };
}
