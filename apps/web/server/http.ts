import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { AppConfig } from './config.ts';
import type { Pool } from './db.ts';
import type { ObjectStore } from './storage.ts';
import type { Actor } from './authz.ts';
import { contentDisposition } from './document-files.ts';
import { AppError } from './errors.ts';
import { flashCookieName, flashSetCookie } from './flash.ts';
import { withCheckedRows, withFormRows } from './form-rows.ts';
import { BILL_KEYS, LIST_FIELDS, PREVIEW_KEEP, PROGRESS_FIELDS, previewKind, previewPage, SCHEDULE_FIELDS, withBillSlots } from './plan-preview-form.ts';
import { withInstallmentList, withInstRowsFlash } from './plan-installments.ts';
import { authorize } from './authz.ts';
import { log, logError } from './log.ts';
import { assertTransport, clientInfo, type ClientInfo } from './proxy.ts';
import { authenticate, login, logout } from './services/auth.ts';
import { requestPasswordReset } from './services/forgot-password.ts';
import { changePassword, resetOperatorPassword } from './services/credentials.ts';
import * as expenses from './services/expenses.ts';
import * as assistant from './services/assistant.ts';
import * as documents from './services/documents.ts';
import * as hsa from './services/hsa.ts';
import * as hsaAccounts from './services/hsa-accounts.ts';
import * as paymentMethods from './services/payment-methods.ts';
import * as payments from './services/payments.ts';
import * as plans from './services/plans.ts';
import * as undoService from './services/undo.ts';
import { completeSetup } from './services/bootstrap.ts';
import { acceptInvitation, inviteOperator, revokeInvitation, updateOperator } from './services/operators.ts';
import * as settingsService from './services/settings.ts';
import * as signin from './services/signin.ts';
import { restoreFromSetup, startBackup } from './services/backup.ts';
import { refreshRuntimeConfig } from './settings.ts';
import { clearUndoSlot } from './repositories/undo.ts';
import { touchSession } from './repositories/sessions.ts';
import { csrfFor, safeEqual } from './tokens.ts';
import { parse, safeReturnPath, schemas } from './validation.ts';
import { changePin, lockSession, unlockSession } from './services/pin.ts';

export interface AppContext { config: AppConfig; pool: Pool; /** Private document volume. Null or absent disables document upload and download. */ store?: ObjectStore | null }

export const MAX_BODY_BYTES = 8 * 1024;

export function sessionCookieName(config: AppConfig): string {
  return config.secureCookies ? '__Host-tallymed_session' : 'tallymed_session';
}

export function readCookie(headers: Headers, name: string): string | null {
  for (const part of (headers.get('cookie') ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

function cookieHeader(config: AppConfig, value: string, maxAgeSeconds: number): string {
  return [`${sessionCookieName(config)}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSeconds}`,
    ...(config.secureCookies ? ['Secure'] : [])].join('; ');
}

const BASE_HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

/** State-changing requests must come from the canonical origin; Host and forwarded host are ignored. */
export function assertSameOrigin(headers: Headers, config: AppConfig): void {
  const site = headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') throw new AppError('csrf_failed');
  const origin = headers.get('origin');
  let seen: string | null = origin && origin !== 'null' ? origin : null;
  if (!seen && !origin) {
    const referer = headers.get('referer');
    try {
      seen = referer ? new URL(referer).origin : null;
    } catch {
      seen = null;
    }
  }
  if (seen !== config.canonicalOrigin) throw new AppError('csrf_failed');
}

/**
 * True when any JSON object repeats a key (compared after unescaping). JSON.parse keeps the last value silently,
 * so this scans text that has already parsed successfully and therefore has valid syntax.
 */
export function hasDuplicateKeys(text: string): boolean {
  const stack: Array<Set<string> | null> = [];
  let expectKey = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      let j = i + 1;
      while (text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      if (expectKey) {
        const key = JSON.parse(text.slice(i, j + 1)) as string;
        const seen = stack[stack.length - 1]!;
        if (seen!.has(key)) return true;
        seen!.add(key);
        expectKey = false;
      }
      i = j;
    } else if (c === '{') {
      stack.push(new Set());
      expectKey = true;
    } else if (c === '[') {
      stack.push(null);
    } else if (c === '}' || c === ']') {
      stack.pop();
      expectKey = false;
    } else if (c === ',') {
      expectKey = stack[stack.length - 1] instanceof Set;
    }
  }
  return false;
}

/** Reads a bounded urlencoded or JSON body into a flat object of strings. */
export async function readBody(req: Request, maxBytes = MAX_BODY_BYTES): Promise<Record<string, unknown>> {
  const declared = req.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) throw new AppError('payload_too_large');
  const type = (req.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (type !== 'application/json' && type !== 'application/x-www-form-urlencoded') throw new AppError('unsupported_media_type');
  let size = 0;
  const chunks: Uint8Array[] = [];
  if (req.body) {
    const reader = req.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new AppError('payload_too_large');
      }
      chunks.push(value);
    }
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (type === 'application/json') {
    try {
      const parsed: unknown = JSON.parse(text);
      if (hasDuplicateKeys(text)) throw new Error();
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      return parsed as Record<string, unknown>;
    } catch {
      throw new AppError('invalid_input');
    }
  }
  const out: Record<string, unknown> = Object.create(null);
  for (const [k, v] of new URLSearchParams(text)) {
    if (k in out) throw new AppError('invalid_input');
    out[k] = v;
  }
  return out;
}

/** Overhead allowed on top of the largest file for multipart boundaries and the small text fields. */
export const MULTIPART_OVERHEAD_BYTES = 64 * 1024;
const MAX_FIELD_CHARS = 2000;

/**
 * Reads a bounded multipart/form-data upload. The whole body is capped (declared length first, then bytes actually received),
 * every field name may appear once, text fields are short, and the only file part must be named `file`. The file name and type
 * are returned as untrusted strings; nothing here trusts them.
 */
export async function readMultipart(req: Request, maxFileBytes: number): Promise<Record<string, unknown>> {
  const maxBytes = maxFileBytes + MULTIPART_OVERHEAD_BYTES;
  const declared = req.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) throw new AppError('payload_too_large');
  const type = req.headers.get('content-type') ?? '';
  if (!/^multipart\/form-data\s*;\s*boundary=/i.test(type)) throw new AppError('unsupported_media_type');
  let size = 0;
  const chunks: Uint8Array[] = [];
  if (req.body) {
    const reader = req.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new AppError('payload_too_large');
      }
      chunks.push(value);
    }
  }
  let form: FormData;
  try {
    form = await new Response(Buffer.concat(chunks), { headers: { 'content-type': type } }).formData();
  } catch {
    throw new AppError('invalid_input');
  }
  const out: Record<string, unknown> = Object.create(null);
  for (const [key, value] of form) {
    if (key in out) throw new AppError('invalid_input');
    if (typeof value === 'string') {
      if (value.length > MAX_FIELD_CHARS) throw new AppError('invalid_input');
      out[key] = value;
    } else {
      if (key !== 'file') throw new AppError('invalid_input');
      out[key] = { name: value.name.slice(0, 255), type: value.type.slice(0, 100), bytes: new Uint8Array(await value.arrayBuffer()) };
    }
  }
  return out;
}

interface RouteInput {
  req: Request;
  ctx: AppContext;
  body: Record<string, unknown>;
  actor: Actor | null;
  sessionToken: string | null;
  client: ClientInfo;
  requestId: string;
}
type RouteResult = { response: Response } | { json: unknown; status?: number; headers?: Record<string, string> };

const escapeHtml = (v: string) => v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * Presentation only, for the two one-time pages below (new invitation link, new assistant token). A fixed string with no
 * interpolation; the colours are the design tokens from app/globals.css and follow the system theme.
 */
const RESULT_PAGE_BODY = '<style>:root{color-scheme:light dark}'
  + 'body{font:1rem/1.55 system-ui,sans-serif;margin:0;padding:3rem 1rem;background:light-dark(#F4F7F9,#061725);color:light-dark(#0B2942,#E9EEF2)}'
  + 'main{max-width:44rem;margin:0 auto;padding:2rem 1.5rem;background:light-dark(#FFFFFF,#0B2942);border:1px solid light-dark(#D5DEE5,#1F4663);border-top:4px solid #14B8A6;border-radius:.625rem}'
  + 'h1{font-size:1.375rem;line-height:1.2;margin:0 0 1rem}'
  + 'code{display:block;padding:.75rem 1rem;border-radius:.375rem;background:light-dark(#E9EEF2,#113550);font-family:ui-monospace,Menlo,Consolas,monospace;word-break:break-all}'
  + 'a{color:light-dark(#0A6B62,#5FE0CF);font-weight:600}a:focus-visible{outline:3px solid light-dark(#0A6B62,#5FE0CF);outline-offset:2px}'
  + '</style><body><main>';
const wantsHtml = (req: Request) => (req.headers.get('accept') ?? '').includes('text/html');

export function redirect(config: AppConfig, pathAndQuery: string, headers: Record<string, string> = {}): Response {
  return new Response(null, {
    status: 303,
    headers: { ...BASE_HEADERS, Location: new URL(pathAndQuery, config.canonicalOrigin).href, ...headers },
  });
}

function errorResponse(req: Request, ctx: AppContext | null, error: unknown, errorPath: string | null, flash: string | null = null, redirectAll = false): Response {
  const app = error instanceof AppError ? error : new AppError('internal');
  const code = app.code;
  const headers: Record<string, string> = { ...BASE_HEADERS };
  if (app.retryAfterSeconds) headers['Retry-After'] = String(app.retryAfterSeconds);
  if (ctx && errorPath && wantsHtml(req) && (redirectAll || (app.status !== 413 && app.status !== 415))) {
    if (flash) headers['Set-Cookie'] = flash;
    return redirect(ctx.config, `${errorPath}${errorPath.includes('?') ? '&' : '?'}error=${code}`, headers);
  }
  return Response.json({ error: { code, message: code === 'internal' ? 'Internal error' : app.message } }, { status: app.status, headers });
}

/**
 * Shared pipeline for every POST route: transport check, origin check, bounded body, optional session
 * and CSRF token. Handlers receive an authenticated actor or null and own their authorization.
 */
function route(opts: {
  name: string;
  session: boolean;
  errorPath: (body: Record<string, unknown>) => string;
  /** Fields to keep for re-filling the form at errorPath after a validation error (sent as a flash cookie, not in the URL). */
  keepFields?: string[];
  /** Rewrites the body before its `keepFields` go into the flash cookie (a row list is spelled as one text there). */
  flashBody?: (body: Record<string, unknown>) => Record<string, unknown>;
  /** Replaces the bounded form/JSON reader (uploads read multipart). */
  readBody?: (req: Request, ctx: AppContext) => Promise<Record<string, unknown>>;
  /** Authenticate before reading the body, so an unauthenticated caller cannot make the server buffer a large upload. */
  authBeforeBody?: boolean;
  /** Runs right after authentication and before the body is read (a per-user limit can refuse without buffering the upload). */
  beforeBody?: (actor: Actor) => void;
  /** Redirect browser form posts back with an error code even for size and type failures. */
  redirectAllErrors?: boolean;
  /**
   * Lets an account that must still replace a temporary password through. Every other authenticated route refuses it with
   * `password_change_required`, so the gate cannot be forgotten by a new route: the default is closed.
   */
  allowPendingPasswordChange?: boolean;
  /**
   * Lets a locked session through. Every other authenticated route refuses it with `locked`, so a new route cannot forget the lock: the
   * default is closed. Only lock, unlock and sign-out set it.
   */
  allowLocked?: boolean;
  /**
   * Every authenticated POST is a mutation by its actor, and a mutation supersedes that actor's undo slot (see the hook in the pipeline
   * below). Set false only for the `undo` action itself and for session, password and download routes that change no record.
   */
  keepsUndo?: boolean;
  run: (input: RouteInput) => Promise<RouteResult>;
}) {
  return async (req: Request, ctx: AppContext): Promise<Response> => {
    const requestId = randomUUID();
    let body: Record<string, unknown> = {};
    try {
      if (req.method !== 'POST') throw new AppError('invalid_input', 'POST required');
      await refreshRuntimeConfig(ctx.config, ctx.pool);
      const client = clientInfo(req.headers, ctx.config);
      assertTransport(req.headers, ctx.config, client);
      assertSameOrigin(req.headers, ctx.config);
      const sessionToken = readCookie(req.headers, sessionCookieName(ctx.config));
      let actor: Actor | null = null;
      const signIn = async () => {
        actor = await authenticate(ctx.pool, ctx.config, sessionToken);
        if (!actor || !sessionToken) throw new AppError('unauthenticated');
        if (actor.mustChangePassword && !opts.allowPendingPasswordChange) throw new AppError('password_change_required');
        if (actor.locked && !opts.allowLocked) throw new AppError('locked');
      };
      if (opts.session && opts.authBeforeBody) {
        await signIn();
        if (opts.beforeBody) opts.beforeBody(actor!);
      }
      body = opts.readBody ? await opts.readBody(req, ctx) : await readBody(req);
      if (opts.session) {
        if (!opts.authBeforeBody) await signIn();
        const presented = (req.headers.get('x-csrf-token') ?? (typeof body.csrf === 'string' ? body.csrf : '')) as string;
        if (!presented || !safeEqual(presented, csrfFor(sessionToken!))) throw new AppError('csrf_failed');
        // Undo slot supersession. This is the one place every authenticated POST action passes before its service runs, so it is the hook.
        // It comes after the session and CSRF checks (a forged or unauthenticated request must not clear anyone's slot) and before the
        // service. It runs even when the service then fails or replays: the actor attempted another mutation, so their last one can no
        // longer be undone ("until your next mutation"). Reads (GET pages) never reach this pipeline. Routes without a session (login,
        // forgot-password) have no actor to clear; logout, password changes and the backup download opt out with `keepsUndo`, as does
        // `undo`, whose own transaction deletes the slot it consumes.
        if (opts.keepsUndo !== true) await clearUndoSlot(ctx.pool, actor!);
      }
      const result = await opts.run({ req, ctx, body, actor, sessionToken, client, requestId });
      if ('response' in result) return result.response;
      return Response.json(result.json, { status: result.status ?? 200, headers: { ...BASE_HEADERS, ...result.headers } });
    } catch (error) {
      if (!(error instanceof AppError) || error.code === 'internal') logError(`http.${opts.name}`, error, { requestId });
      else log('info', `http.${opts.name}.rejected`, { requestId, code: error.code });
      let errorPath: string | null = null;
      let flash: string | null = null;
      try {
        errorPath = opts.errorPath(body);
        if (opts.keepFields) flash = flashSetCookie(ctx.config, errorPath, opts.flashBody ? opts.flashBody(body) : body, opts.keepFields);
      } catch {
        errorPath = null;
      }
      // A browser form post from an account that must change its password goes to the page that does it, not back to the form.
      if (error instanceof AppError && error.code === 'password_change_required' && wantsHtml(req)) {
        return redirect(ctx.config, '/password/change', BASE_HEADERS);
      }
      // A browser form post from a locked session lands on the PIN screen, and the unlock returns the person to the page they were on.
      if (error instanceof AppError && error.code === 'locked' && wantsHtml(req)) {
        // The page the form was on comes from Referer (same origin only, and only a plain application path), so unlocking returns there.
        let next = '/';
        try {
          const from = new URL(req.headers.get('referer') ?? '');
          if (from.origin === new URL(ctx.config.canonicalOrigin).origin) next = safeReturnPath(`${from.pathname}${from.search}`);
        } catch { /* no usable Referer: the overview */ }
        return redirect(ctx.config, next === '/' ? '/locked' : `/locked?next=${encodeURIComponent(next)}`, BASE_HEADERS);
      }
      return errorResponse(req, ctx, error, errorPath, flash, opts.redirectAllErrors);
    }
  };
}

export const handleLogin = route({
  name: 'login',
  session: false,
  errorPath: () => '/login',
  async run({ ctx, body, sessionToken, client, requestId, req }) {
    const data = parse(schemas.login, body);
    const result = await login(ctx.pool, ctx.config, {
      email: data.email, password: data.password, ip: client.ip, requestId, previousToken: sessionToken, remember: data.remember,
    });
    const cookie = cookieHeader(ctx.config, result.token, Math.max(1, Math.floor((result.expiresAt.getTime() - Date.now()) / 1000)));
    if (wantsHtml(req)) return { response: redirect(ctx.config, result.passwordChangeRequired ? '/password/change' : '/', { 'Set-Cookie': cookie }) };
    return {
      json: { ok: true, csrfToken: csrfFor(result.token), ...(result.passwordChangeRequired ? { passwordChangeRequired: true } : {}) },
      headers: { 'Set-Cookie': cookie },
    };
  },
});


// ---------- interface lock and security PIN ----------
// The lock is a state of the session (see services/auth.ts `authenticate`), so signing in stays untouched: these routes only change that state.

/** Locks the caller's own session now: the Lock button, the browser's idle timer and the cross-tab signal all post here. */
export const handleLock = route({
  name: 'lock',
  keepsUndo: true,
  session: true,
  allowLocked: true,
  errorPath: () => '/',
  async run({ ctx, actor, body, req, requestId }) {
    await lockSession(ctx.pool, actor!, body, requestId);
    const next = safeReturnPath(body.next);
    if (wantsHtml(req)) return { response: redirect(ctx.config, next === '/' ? '/locked' : `/locked?next=${encodeURIComponent(next)}`) };
    return { json: { ok: true } };
  },
});

/** Opens a locked session with the PIN. The session cookie is not replaced and nothing else changes. */
export const handleUnlock = route({
  name: 'unlock',
  keepsUndo: true,
  session: true,
  allowLocked: true,
  errorPath: (b) => { const next = safeReturnPath(b.next); return next === '/' ? '/locked' : `/locked?next=${encodeURIComponent(next)}`; },
  async run({ ctx, actor, body, req, requestId }) {
    const result = await unlockSession(ctx.pool, actor!, body, requestId);
    const next = safeReturnPath(body.next);
    if (result.status === 'ok') {
      if (wantsHtml(req)) return { response: redirect(ctx.config, next) };
      return { json: { ok: true } };
    }
    if (result.status === 'revoked') {
      // The one time the lock signs anyone out: too many wrong PINs on this session. The cookie goes with it.
      const cookie = cookieHeader(ctx.config, '', 0);
      if (wantsHtml(req)) return { response: redirect(ctx.config, '/login?error=pin_attempts_exceeded', { 'Set-Cookie': cookie }) };
      return { json: { error: { code: 'pin_attempts_exceeded', message: 'Too many wrong PINs' } }, status: 401, headers: { 'Set-Cookie': cookie } };
    }
    if (wantsHtml(req)) {
      const q = new URLSearchParams({ error: 'invalid_pin', left: String(result.remaining) });
      if (next !== '/') q.set('next', next);
      return { response: redirect(ctx.config, `/locked?${q}`) };
    }
    return { json: { error: { code: 'invalid_pin', message: 'That PIN is not correct' }, remaining: result.remaining }, status: 401 };
  },
});

/** Sets the first PIN or changes it (needs the current PIN or the password). */
export const handleChangePin = route({
  name: 'change-pin',
  keepsUndo: true,
  session: true,
  errorPath: () => '/account/pin',
  async run({ ctx, actor, body, req, requestId }) {
    const result = await changePin(ctx.pool, actor!, body, requestId);
    if (result.status === 'revoked') {
      const cookie = cookieHeader(ctx.config, '', 0);
      if (wantsHtml(req)) return { response: redirect(ctx.config, '/login?error=pin_attempts_exceeded', { 'Set-Cookie': cookie }) };
      return { json: { error: { code: 'pin_attempts_exceeded', message: 'Too many wrong PINs' } }, status: 401, headers: { 'Set-Cookie': cookie } };
    }
    if (result.status === 'wrong') {
      if (wantsHtml(req)) return { response: redirect(ctx.config, `/account/pin?error=invalid_pin&left=${result.remaining}`) };
      return { json: { error: { code: 'invalid_pin', message: 'That PIN is not correct' }, remaining: result.remaining }, status: 401 };
    }
    if (wantsHtml(req)) return { response: redirect(ctx.config, `/?notice=${result.first ? 'pin_set' : 'pin_changed'}`) };
    return { json: { ok: true } };
  },
});

/** Keeps a session that is in use from looking idle: the browser posts here while the person is active, since reading a page makes no request. */
export const handleHeartbeat = route({
  name: 'heartbeat',
  keepsUndo: true,
  session: true,
  errorPath: () => '/',
  async run({ ctx, actor, body }) {
    parse(schemas.heartbeat, body);
    // Always counts as activity (the pipeline only touches a session quiet for a minute), so the server's idle rule never trails the browser's.
    await touchSession(ctx.pool, actor!.sessionId);
    return { json: { ok: true } };
  },
});

// ---------- sign-in with an OpenID Connect provider ----------

export function oidcCookieName(config: AppConfig): string {
  return config.secureCookies ? '__Host-tallymed_oidc' : 'tallymed_oidc';
}

/** Lax, so the cookie comes back on the provider's top-level redirect to the callback and on nothing cross-site that is not a navigation. */
function oidcCookie(config: AppConfig, value: string, maxAgeSeconds: number): string {
  return [`${oidcCookieName(config)}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSeconds}`,
    ...(config.secureCookies ? ['Secure'] : [])].join('; ');
}

const SSO_ERRORS = new Set(['sso_unavailable', 'sso_failed', 'sso_no_account', 'rate_limited']);

/** Both steps are browser navigations, so every failure goes back to the sign-in page with a code; details stay in the server log. */
function oidcFailure(ctx: AppContext, name: string, error: unknown, requestId: string): Response {
  if (!(error instanceof AppError) || error.code === 'internal') logError(`http.${name}`, error, { requestId });
  const code = error instanceof AppError && SSO_ERRORS.has(error.code) ? error.code : 'sso_failed';
  const headers = new Headers({ ...BASE_HEADERS, Location: new URL(`/login?error=${code}`, ctx.config.canonicalOrigin).href, 'Referrer-Policy': 'no-referrer' });
  headers.append('Set-Cookie', oidcCookie(ctx.config, '', 0));
  return new Response(null, { status: 303, headers });
}

/** Starts provider sign-in: sets the flow cookie and sends the browser to the provider. Reads nothing from the request but its address. */
export async function handleOidcStart(req: Request, ctx: AppContext): Promise<Response> {
  const requestId = randomUUID();
  try {
    if (req.method !== 'GET') throw new AppError('invalid_input', 'GET required');
    await refreshRuntimeConfig(ctx.config, ctx.pool);
    const client = clientInfo(req.headers, ctx.config);
    assertTransport(req.headers, ctx.config, client);
    const started = await signin.startOidc(ctx.pool, ctx.config, { ip: client.ip, requestId });
    return new Response(null, {
      status: 303,
      headers: { ...BASE_HEADERS, Location: started.location, 'Set-Cookie': oidcCookie(ctx.config, started.flowCookie, signin.FLOW_SECONDS), 'Referrer-Policy': 'no-referrer' },
    });
  } catch (error) {
    return oidcFailure(ctx, 'oidc.start', error, requestId);
  }
}

/** The provider's redirect back. The flow cookie is always cleared, so an answer can be used once at most. */
export async function handleOidcCallback(req: Request, ctx: AppContext): Promise<Response> {
  const requestId = randomUUID();
  try {
    if (req.method !== 'GET') throw new AppError('invalid_input', 'GET required');
    await refreshRuntimeConfig(ctx.config, ctx.pool);
    const client = clientInfo(req.headers, ctx.config);
    assertTransport(req.headers, ctx.config, client);
    const params = new URL(req.url).searchParams;
    const query: Record<string, string> = Object.create(null);
    for (const key of ['code', 'state', 'error', 'iss']) {
      const all = params.getAll(key);
      if (all.length > 1) throw new AppError('sso_failed');
      if (all.length === 1) query[key] = all[0]!;
    }
    const result = await signin.finishOidc(ctx.pool, ctx.config, {
      query, flowCookie: readCookie(req.headers, oidcCookieName(ctx.config)), ip: client.ip, requestId,
      previousToken: readCookie(req.headers, sessionCookieName(ctx.config)),
    });
    const headers = new Headers({
      ...BASE_HEADERS, Location: new URL(result.passwordChangeRequired ? '/password/change' : '/', ctx.config.canonicalOrigin).href, 'Referrer-Policy': 'no-referrer',
    });
    headers.append('Set-Cookie', cookieHeader(ctx.config, result.token, Math.max(1, Math.floor((result.expiresAt.getTime() - Date.now()) / 1000))));
    headers.append('Set-Cookie', oidcCookie(ctx.config, '', 0));
    return new Response(null, { status: 303, headers });
  } catch (error) {
    return oidcFailure(ctx, 'oidc.callback', error, requestId);
  }
}

/**
 * "Forgot password": always the same answer for a well-formed address, whether or not an account exists. The email, if any, is sent after
 * the response. The only address-independent refusals are email not being set up and the caller's own request budget.
 */
export const handleForgotPassword = route({
  name: 'forgot-password',
  session: false,
  errorPath: () => '/password/forgot',
  async run({ ctx, body, client, requestId, req }) {
    const data = parse(schemas.forgotPassword, body);
    const { delivery } = await requestPasswordReset(ctx.pool, ctx.config, { email: data.email, ip: client.ip, requestId });
    delivery.catch(() => undefined);
    if (wantsHtml(req)) return { response: redirect(ctx.config, '/password/forgot?notice=sent', BASE_HEADERS) };
    return { json: { ok: true } };
  },
});

export const handleLogout = route({
  name: 'logout',
  keepsUndo: true,
  session: true,
  allowPendingPasswordChange: true,
  allowLocked: true,
  errorPath: () => '/',
  async run({ ctx, actor, body, req, requestId }) {
    parse(schemas.logout, body);
    await logout(ctx.pool, actor!, requestId);
    const cookie = cookieHeader(ctx.config, '', 0);
    if (wantsHtml(req)) return { response: redirect(ctx.config, '/login', { 'Set-Cookie': cookie }) };
    return { json: { ok: true }, headers: { 'Set-Cookie': cookie } };
  },
});

export const handleInvite = route({
  name: 'invite',
  session: true,
  // `add=1` reopens the invite dialog on the Users page, so the message appears next to the form it belongs to.
  errorPath: () => '/users?add=1',
  async run({ ctx, actor, body, requestId, req }) {
    const invitation = await inviteOperator(ctx.pool, ctx.config, actor!, body, requestId);
    const link = new URL(`/invite/${invitation.token}`, ctx.config.canonicalOrigin).href;
    if (wantsHtml(req)) {
      // Shown once and never stored in recoverable form; the page must not be cached.
      const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Invitation created</title>`
        + RESULT_PAGE_BODY + `<h1>Invitation created</h1>`
        + `<p>Share this one-time link with ${escapeHtml(invitation.email)}. It expires ${escapeHtml(invitation.expiresAt.toISOString())} and is not shown again.</p>`
        + `<p><code>${escapeHtml(link)}</code></p><p><a href="/users">Back to users</a></p></main></body></html>`;
      return { response: new Response(html, { status: 201, headers: { ...BASE_HEADERS, 'Content-Type': 'text/html; charset=utf-8' } }) };
    }
    return { json: { ok: true, link, email: invitation.email, expiresAt: invitation.expiresAt.toISOString() }, status: 201 };
  },
});

/** Administrator-issued temporary password. The secret is shown once on a never-cached page and is not stored, logged or audited. */
export const handleResetPassword = route({
  name: 'reset-password',
  keepsUndo: true,
  session: true,
  errorPath: () => '/users',
  async run({ ctx, actor, body, requestId, req }) {
    const issued = await resetOperatorPassword(ctx.pool, ctx.config, actor!, body, requestId);
    const headers = { 'Referrer-Policy': 'no-referrer' };
    if (wantsHtml(req)) {
      const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><title>Temporary password</title>`
        + RESULT_PAGE_BODY + `<h1>Temporary password for ${escapeHtml(issued.displayName)}</h1>`
        + `<p>Give this temporary password to ${escapeHtml(issued.email)} in person or by phone. It is shown only once, works once, and expires ${escapeHtml(issued.expiresAt.toISOString())}. `
        + `They are signed out everywhere and must choose a new password when they sign in with it.</p>`
        + `<p><code>${escapeHtml(issued.temporaryPassword)}</code></p><p><a href="/users">Back to users</a></p></main></body></html>`;
      return { response: new Response(html, { status: 201, headers: { ...BASE_HEADERS, ...headers, 'Content-Type': 'text/html; charset=utf-8' } }) };
    }
    return {
      json: { ok: true, temporaryPassword: issued.temporaryPassword, email: issued.email, expiresAt: issued.expiresAt.toISOString() },
      status: 201, headers,
    };
  },
});

/** Change password for the signed-in account: a normal change (current password required) or the forced change after a temporary password. */
export const handleChangePassword = route({
  name: 'change-password',
  keepsUndo: true,
  session: true,
  allowPendingPasswordChange: true,
  errorPath: (body) => (body.page === 'required' ? '/password/change' : '/account/password'),
  async run({ ctx, actor, body, requestId, req }) {
    const result = await changePassword(ctx.pool, ctx.config, actor!, body, requestId);
    const cookie = cookieHeader(ctx.config, result.token, Math.max(1, Math.floor((result.expiresAt.getTime() - Date.now()) / 1000)));
    if (wantsHtml(req)) return { response: redirect(ctx.config, '/?notice=password_changed', { 'Set-Cookie': cookie }) };
    return { json: { ok: true, csrfToken: csrfFor(result.token), sessionsRevoked: result.sessionsRevoked }, headers: { 'Set-Cookie': cookie } };
  },
});

export const handleUpdateOperator = route({
  name: 'update-operator',
  session: true,
  errorPath: () => '/users',
  async run({ ctx, actor, body, requestId, req }) {
    await updateOperator(ctx.pool, actor!, body, requestId);
    if (wantsHtml(req)) return { response: redirect(ctx.config, '/users') };
    return { json: { ok: true } };
  },
});

export const handleRevokeInvitation = route({
  name: 'revoke-invitation',
  session: true,
  errorPath: () => '/users',
  async run({ ctx, actor, body, requestId, req }) {
    await revokeInvitation(ctx.pool, actor!, body, requestId);
    if (wantsHtml(req)) return { response: redirect(ctx.config, '/users') };
    return { json: { ok: true } };
  },
});

export const handleAcceptInvitation = route({
  name: 'accept-invitation',
  session: false,
  errorPath: (body) => (typeof body.token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(body.token) ? `/invite/${body.token}` : '/login'),
  async run({ ctx, body, requestId, req }) {
    await acceptInvitation(ctx.pool, body, requestId);
    if (wantsHtml(req)) return { response: redirect(ctx.config, '/login?notice=account_created') };
    return { json: { ok: true }, status: 201 };
  },
});

export const handleSetup = route({
  name: 'setup',
  session: false,
  errorPath: () => '/setup',
  keepFields: ['householdName', 'displayName', 'email'],
  async run({ ctx, body, client, requestId, req }) {
    await completeSetup(ctx.pool, ctx.config, body, { ip: client.ip, requestId });
    if (wantsHtml(req)) return { response: redirect(ctx.config, '/login?notice=setup_complete') };
    return { json: { ok: true }, status: 201 };
  },
});

const fromBase64Url = (value: string | null): string | null => {
  if (value === null || value === '') return null;
  if (!/^[A-Za-z0-9_-]{1,2048}$/.test(value)) throw new AppError('invalid_input');
  return Buffer.from(value, 'base64url').toString('utf8');
};

/**
 * A web stream over a Node stream that reads one chunk only when the client asks for one. `Readable.toWeb` pushes chunks as they arrive
 * and throws an uncaught "Controller is already closed" when one arrives just after the client went away, which would stop the process.
 * Here a chunk is only ever handed over inside `pull`, and a cancelled download destroys the source so the backup ends and is audited.
 */
function downloadBody(source: Readable): ReadableStream<Uint8Array> {
  const chunks = source[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await chunks.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value as Uint8Array);
      } catch (error) {
        try { controller.error(error); } catch { /* already closed by a cancel */ }
      }
    },
    cancel() {
      source.destroy(Object.assign(new Error('The download was cancelled'), { name: 'AbortError', code: 'ABORT_ERR' }));
    },
  }, { highWaterMark: 0 });
}

/**
 * Restore a backup into an installation that has never been set up. The body is the backup file itself (not a form), so it can be streamed
 * to disk instead of held in memory; the setup token and the optional passphrase travel in headers, base64url-encoded. Same transport and
 * origin checks as every other POST. Once an administrator exists this answers 404 like the setup route.
 */
export async function handleSetupRestore(req: Request, ctx: AppContext): Promise<Response> {
  const requestId = randomUUID();
  try {
    if (req.method !== 'POST') throw new AppError('invalid_input', 'POST required');
    await refreshRuntimeConfig(ctx.config, ctx.pool);
    const client = clientInfo(req.headers, ctx.config);
    assertTransport(req.headers, ctx.config, client);
    assertSameOrigin(req.headers, ctx.config);
    if ((req.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase() !== 'application/octet-stream') throw new AppError('unsupported_media_type');
    const declared = req.headers.get('content-length');
    if (declared !== null && !/^\d+$/.test(declared)) throw new AppError('invalid_input');
    const result = await restoreFromSetup(ctx, {
      setupToken: fromBase64Url(req.headers.get('x-setup-token')) ?? '', passphrase: fromBase64Url(req.headers.get('x-backup-passphrase')),
      body: req.body, declaredLength: declared === null ? null : Number(declared), ip: client.ip, requestId,
    });
    return Response.json({
      ok: true, backupCreatedAt: result.createdAt, records: result.rows, documents: result.documents, openBalanceCents: result.ledger.openBalanceCents ?? null,
    }, { status: 201, headers: BASE_HEADERS });
  } catch (error) {
    if (!(error instanceof AppError) || error.code === 'internal') logError('http.setup.restore', error, { requestId });
    else log('info', 'http.setup.restore.rejected', { requestId, code: error.code });
    return errorResponse(req, null, error, null);
  }
}

/**
 * The signed-in session for a page or a GET route, including an account that must still replace a temporary password. Only the
 * sign-in, shell and change-password pages use this directly; everything else goes through `pageActor`, which refuses that state.
 */
export async function pageSession(ctx: AppContext, headers: Headers): Promise<{ actor: Actor; csrf: string } | null> {
  const token = readCookie(headers, sessionCookieName(ctx.config));
  const actor = await authenticate(ctx.pool, ctx.config, token);
  return actor && token ? { actor, csrf: csrfFor(token) } : null;
}

/**
 * Used by server-rendered pages and GET routes. Closed by default: an account that must change its temporary password is refused
 * with `password_change_required`. Authorization still happens in the service for every mutation.
 */
export async function pageActor(ctx: AppContext, headers: Headers): Promise<{ actor: Actor; csrf: string } | null> {
  const session = await pageSession(ctx, headers);
  if (session?.actor.mustChangePassword) throw new AppError('password_change_required');
  // Closed by default for the lock too: a locked session reads nothing until the PIN is entered.
  if (session?.actor.locked) throw new AppError('locked');
  return session;
}


// ---------- expense management ----------

type ExpenseService = (pool: Pool, actor: Actor, input: unknown, requestId: string) => Promise<{ id: string }>;
const str = (v: unknown) => (typeof v === 'string' && /^[0-9a-f-]{36}$/.test(v) ? v : null);

const BILL_FIELDS = ['memberId', 'providerId', 'visitId', 'providerReference', 'statementDate', 'dueDate', 'originalAmount', 'responsibilityAmount',
  'amountStatus', 'amountSource', 'sourceNote', 'notes'];
const ADJUSTMENT_FIELDS = ['amount', 'category', 'effectiveDate', 'reason', 'source', 'sourceNote'];

const entity = (base: string) => (b: Record<string, unknown>, id: string) => `${base}/${str(b.id) ?? id}`;
const billPath = (b: Record<string, unknown>, id: string) => `/bills/${str(b.billId) ?? str(b.id) ?? id}`;
const EXPENSE_ACTIONS: Record<string, {
  service: ExpenseService; error: (b: Record<string, unknown>) => string; ok: (b: Record<string, unknown>, id: string) => string; keep?: string[];
}> = {
  'members/create': { service: expenses.createMember, error: () => '/members', keep: ['name', 'dateOfBirth', 'notes'], ok: entity('/members') },
  'members/update': { service: expenses.updateMember, error: (b) => `/members/${str(b.id)}`, ok: entity('/members') },
  'members/archive': { service: expenses.archiveMember, error: (b) => `/members/${str(b.id)}`, ok: entity('/members') },
  'providers/create': { service: expenses.createProvider, error: () => '/providers', keep: ['name', 'kind', 'notes'], ok: entity('/providers') },
  'providers/update': { service: expenses.updateProvider, error: (b) => `/providers/${str(b.id)}`, ok: entity('/providers') },
  'providers/archive': { service: expenses.archiveProvider, error: (b) => `/providers/${str(b.id)}`, ok: entity('/providers') },
  'visits/create': { service: expenses.createVisit, error: () => '/visits', keep: ['memberId', 'providerId', 'serviceDate', 'description', 'notes'], ok: entity('/visits') },
  'visits/update': { service: expenses.updateVisit, error: (b) => `/visits/${str(b.id)}`, ok: entity('/visits') },
  'bills/create': { service: expenses.createBill, error: () => '/bills/new', keep: BILL_FIELDS, ok: entity('/bills') },
  'bills/update': { service: expenses.updateBill, error: (b) => `/bills/${str(b.id)}`, ok: entity('/bills') },
  'bills/confirm': { service: expenses.confirmBillAmounts, error: (b) => `/bills/${str(b.id)}`, ok: entity('/bills') },
  'bills/assign-visit': { service: expenses.assignBillVisit, error: (b) => `/bills/${str(b.id)}`, ok: entity('/bills') },
  'adjustments/create': { service: expenses.addAdjustment, error: (b) => billPath(b, ''), keep: ADJUSTMENT_FIELDS, ok: billPath },
  'adjustments/reverse': { service: expenses.reverseAdjustment, error: (b) => billPath(b, ''), ok: billPath },
};

/** Bill rows of the payment forms: `alloc.<n>.billId` and `alloc.<n>.amount` (see docs/contracts.md, "Form row lists"). The form offers up to ALLOC_FORM_ROWS. */
const ALLOC_ROWS = { prefix: 'alloc', into: 'allocations', fields: ['billId', 'amount'], max: 25 } as const;
export const ALLOC_FORM_ROWS = 10;
const ALLOC_KEEP = Array.from({ length: ALLOC_FORM_ROWS }, (_, i) => [`alloc.${i}.billId`, `alloc.${i}.amount`]).flat();
const PAYMENT_FIELDS = ['paidOn', 'amount', 'method', 'paidWithId', 'hsaIneligible', 'reference', 'note', 'billId', 'allocateAmount', ...ALLOC_KEEP];
const allocRows = (b: Record<string, unknown>) => withFormRows(b, ALLOC_ROWS);
/** A recorded payment with exactly one bill row and no amount applies the whole payment to it, as the single-bill form always did. */
const createRows = (b: Record<string, unknown>) => {
  const out = allocRows(b);
  const rows = out.allocations;
  if (rows === b.allocations || !Array.isArray(rows) || rows.length !== 1) return out;
  const only = rows[0] as Record<string, string>;
  return only.amount === '' && typeof b.amount === 'string' ? { ...out, allocations: [{ ...only, amount: b.amount }] } : out;
};
const paymentPath = (b: Record<string, unknown>, id: string) => `/payments/${str(b.paymentId) ?? id}`;
const planPath = (b: Record<string, unknown>, id: string) => `/plans/${str(b.planId) ?? id}`;
const paymentOf = (b: Record<string, unknown>) => `/payments/${str(b.paymentId)}`;
const planOf = (b: Record<string, unknown>) => `/plans/${str(b.planId)}`;
const withoutFormMarker = (b: Record<string, unknown>) => { const { dialog: _dialog, ...rest } = b; return rest; };
/** Rows of the "Suggested matches" card: `sug.<n>.installmentId`, `.allocationId`, `.amount` and the tick `.apply` ("1"; an unticked box is not sent). */
const SUGGESTION_ROWS = { prefix: 'sug', into: 'rows', fields: ['installmentId', 'allocationId', 'amount'], flag: 'apply', max: 120 } as const;
const suggestionRows = (b: Record<string, unknown>) => withCheckedRows(b, SUGGESTION_ROWS);
// Payments, refunds and plans use the same pipeline and the same fixed allow-list as the expense actions.
const MONEY_ACTIONS: Record<string, {
  service: ExpenseService; error: (b: Record<string, unknown>) => string; ok: (b: Record<string, unknown>, id: string, result?: { target?: string; path?: string | null }) => string; keep?: string[];
  /** Turns the flat form body into the service input (row lists). */
  prepare?: (b: Record<string, unknown>) => Record<string, unknown>;
}> = {
  'payments/create': { service: payments.recordPayment, error: () => '/payments', keep: PAYMENT_FIELDS, prepare: createRows, ok: (_b, id) => `/payments/${id}` },
  'payments/allocate': { service: payments.allocatePayment, error: paymentOf, keep: ['billId', 'allocateAmount', ...ALLOC_KEEP], prepare: allocRows, ok: paymentPath },
  'payments/unapply': { service: payments.reverseAllocation, error: paymentOf, keep: ['amount', 'effectiveDate', 'reason'], ok: paymentPath },
  'payments/refund': { service: payments.recordRefund, error: paymentOf, keep: ['allocationId', 'amount', 'effectiveDate', 'reason'], ok: paymentPath },
  'payments/refund-reverse': { service: payments.reverseRefund, error: paymentOf, keep: ['effectiveDate', 'reason'], ok: paymentPath },
  'payments/paid-with': { service: paymentMethods.setPaidWith, error: paymentOf, keep: ['paidWithId'], ok: paymentPath },
  'payment-methods/create': { service: paymentMethods.createPaymentMethod, error: () => '/payment-methods', keep: ['nickname', 'kind', 'lastFour', 'hsaAccountId'], ok: entity('/payment-methods') },
  'payment-methods/update': { service: paymentMethods.updatePaymentMethod, error: (b) => `/payment-methods/${str(b.id)}`, ok: entity('/payment-methods') },
  'payment-methods/archive': { service: paymentMethods.archivePaymentMethod, error: (b) => `/payment-methods/${str(b.id)}`, ok: entity('/payment-methods') },
  'hsa-accounts/create': { service: hsaAccounts.createHsaAccount, error: () => '/hsa', keep: ['name', 'administrator', 'lastFour', 'hasCard', 'cardNickname', 'cardLastFour'], ok: () => '/hsa' },
  'hsa-accounts/update': { service: hsaAccounts.updateHsaAccount, error: (b) => `/hsa/accounts/${str(b.id)}`, ok: entity('/hsa/accounts') },
  'hsa-accounts/archive': { service: hsaAccounts.archiveHsaAccount, error: (b) => `/hsa/accounts/${str(b.id)}`, ok: entity('/hsa/accounts') },
  'payments/remove': { service: payments.removePayment, error: paymentOf, keep: ['reason'], ok: () => '/payments' },
  // The undo action's service consumes the slot itself; the pipeline must not delete it first (keepsUndo below). It runs only for an administrator.
  // HSA records land on their own page (`path`, an allocation page for a decision); payments and plans on theirs.
  'undo': { service: undoService.undo, error: () => '/', ok: (_b, id, r) => r?.path ?? (r?.target === 'plan' ? `/plans/${id}` : `/payments/${id}`) },
  'payments/void': { service: payments.voidPayment, error: paymentOf, keep: ['voidedOn', 'reason'], ok: paymentPath },
  // `prepare: withInstallmentList` reads the form's "List each installment" table or pasted text (docs/contracts.md, "Plans").
  'plans/create': { service: plans.createPlan, error: () => '/plans', keep: ['name', 'providerId', 'startedOn', 'matchExisting', ...BILL_KEYS, ...SCHEDULE_FIELDS, ...LIST_FIELDS], prepare: withInstallmentList, ok: (_b, id) => `/plans/${id}` },
  // One guided form for a plan that started earlier: original agreement, payments already made, optional restructure, one save. `dialog=progress`
  // reopens this dialog (not "Create plan") after an error; it is not part of the service input.
  'plans/create-in-progress': {
    service: plans.createPlanInProgress, error: () => '/plans', keep: ['name', 'startedOn', 'matchExisting', 'reason', 'dialog', ...PROGRESS_FIELDS, ...BILL_KEYS, ...SCHEDULE_FIELDS, ...LIST_FIELDS],
    prepare: (b) => withInstallmentList(withoutFormMarker(b)), ok: (_b, id) => `/plans/${id}`,
  },
  // `dialog` marks a post from the "Plan was restructured" dialog so an error reopens that dialog; it is not part of the service input.
  'plans/revise': { service: plans.revisePlan, error: planOf, keep: ['reason', 'dialog', ...SCHEDULE_FIELDS, ...LIST_FIELDS], prepare: (b) => withInstallmentList(withoutFormMarker(b)), ok: planPath },
  'plans/cancel': { service: plans.cancelPlan, error: planOf, keep: ['reason'], ok: planPath },
  'plans/remove': { service: plans.removePlan, error: planOf, keep: ['reason'], ok: () => '/plans' },
  'plans/rename': { service: plans.renamePlan, error: planOf, keep: ['name'], ok: planPath },
  'plans/match': { service: plans.matchInstallment, error: planOf, keep: ['installmentId', 'allocationId', 'amount'], ok: planPath },
  // No `keep`: after any refusal the suggestions are computed again and every row starts ticked, so row indexes from the old list would mislead.
  'plans/apply-suggestions': { service: plans.applySuggestedMatches, error: planOf, prepare: suggestionRows, ok: planPath },
  'plans/match-existing': { service: plans.matchExistingPayments, error: planOf, ok: planPath },
  'plans/unmatch': { service: plans.unmatchInstallment, error: planOf, keep: ['reason', 'amount'], ok: planPath },
};

const allocationOf = (b: Record<string, unknown>) => `/hsa/allocations/${str(b.allocationId)}`;
const claimOf = (b: Record<string, unknown>) => `/hsa/claims/${str(b.claimId)}`;
const receiptOf = (b: Record<string, unknown>) => `/hsa/receipts/${str(b.receiptId)}`;
// HSA reimbursements use the same pipeline and allow-list. A failed form returns to the page it came from.
const HSA_ACTIONS: Record<string, {
  service: ExpenseService; error: (b: Record<string, unknown>) => string; ok: (b: Record<string, unknown>, id: string) => string; keep?: string[];
}> = {
  'hsa/decide': { service: hsa.recordDecision, error: allocationOf, keep: ['status', 'eligibleAmount', 'rationale', 'evidenceType', 'evidenceNote', 'contextNote', 'decidedOn'], ok: allocationOf },
  'hsa/claim': { service: hsa.submitClaim, error: allocationOf, keep: ['submittedOn', 'administrator', 'reference', 'note', 'amount'], ok: (_b, id) => `/hsa/claims/${id}` },
  'hsa/release': { service: hsa.releaseClaimLine, error: claimOf, keep: ['kind', 'amount', 'effectiveDate', 'reason'], ok: claimOf },
  'hsa/receipt': { service: hsa.recordReceipt, error: claimOf, keep: ['receivedOn', 'source', 'reference', 'note', 'lineId', 'amount', 'evidenceType', 'evidenceNote'], ok: (_b, id) => `/hsa/receipts/${id}` },
  'hsa/external-receipt': { service: hsa.recordExternalReceipt, error: allocationOf, keep: ['receivedOn', 'source', 'reference', 'note', 'amount', 'evidenceType', 'evidenceNote'], ok: (_b, id) => `/hsa/receipts/${id}` },
  'hsa/receipt-reverse': { service: hsa.reverseReceipt, error: receiptOf, keep: ['effectiveDate', 'reason'], ok: receiptOf },
  // Administrator removal (records:remove) with undo. Each lands on the record's list or parent page; a failure returns to the record's own page.
  // The optional allocationId (decision) and claimId (receipt) of the form only steer the redirect.
  'hsa/decision-remove': { service: hsa.removeHsaDecision, error: (b) => (str(b.allocationId) ? allocationOf(b) : '/hsa'), keep: ['reason'], ok: (b) => (str(b.allocationId) ? allocationOf(b) : '/hsa') },
  'hsa/claim-remove': { service: hsa.removeHsaClaim, error: claimOf, keep: ['reason'], ok: () => '/hsa/claims' },
  'hsa/receipt-remove': { service: hsa.removeHsaReceipt, error: receiptOf, keep: ['reason'], ok: (b) => (str(b.claimId) ? claimOf(b) : '/hsa/claims') },
};

const expenseRoutes = new Map(Object.entries({ ...EXPENSE_ACTIONS, ...MONEY_ACTIONS, ...HSA_ACTIONS } as Record<string, typeof MONEY_ACTIONS[string]>).map(([name, a]) => [name, route({
  name: `expenses.${name}`,
  session: true,
  errorPath: a.error,
  keepFields: a.keep,
  // The create form also keeps its ticked bills (as `bill.<n>`), so a refused list does not lose them.
  flashBody: a.keep?.includes('instRows') ? (b) => withInstRowsFlash(a.keep!.includes('bill.0') ? withBillSlots(b) : b) : undefined,
  keepsUndo: name === 'undo',
  async run({ ctx, actor, body, requestId, req }) {
    const result = await a.service(ctx.pool, actor!, a.prepare ? a.prepare(body) : body, requestId);
    if (wantsHtml(req)) return { response: redirect(ctx.config, a.ok(body, result.id, result as { target?: string; path?: string | null })) };
    return { json: { ok: true, ...result }, status: name.endsWith('/create') || name === 'plans/create-in-progress' || name === 'hsa/claim' || name.endsWith('receipt') ? 201 : 200 };
  },
})]));

/**
 * The Preview buttons of the plan forms. A POST with the CSRF token that writes nothing: the submitted schedule fields (and the dialog
 * marker) go into the flash cookie, which is HttpOnly and bound to the page, and the redirect carries only `?preview=<kind>`, so the
 * reason, the name and the CSRF token never reach the address bar, history, logs or Referer. The page reads the cookie and runs the
 * same read-only preview as before. It is not a mutation, so it keeps the actor's undo slot.
 */
expenseRoutes.set('plans/preview', route({
  name: 'expenses.plans.preview',
  session: true,
  errorPath: (b) => previewPage(previewKind(b), b),
  keepFields: PREVIEW_KEEP,
  flashBody: (b) => withInstRowsFlash(withBillSlots(b)),
  keepsUndo: true,
  async run({ ctx, actor, body, req }) {
    authorize(actor!, 'expenses:write');
    const kind = previewKind(body);
    const page = previewPage(kind, body);
    // Always set the cookie, an expired one when there is nothing to keep, so an older flash for this page cannot show up in its place.
    const flash = flashSetCookie(ctx.config, page, withInstRowsFlash(withBillSlots(body)), PREVIEW_KEEP) ?? `${flashCookieName(ctx.config)}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${ctx.config.secureCookies ? '; Secure' : ''}`;
    if (wantsHtml(req)) return { response: redirect(ctx.config, `${page}?preview=${kind}`, { 'Set-Cookie': flash }) };
    return { json: { ok: true, preview: kind } };
  },
}));

/** Single entry point for every expense mutation. The action comes from a fixed allow-list, never from the body. */
export async function handleExpenseAction(req: Request, ctx: AppContext, action: string): Promise<Response> {
  const handler = expenseRoutes.get(action);
  if (!handler) return Response.json({ error: { code: 'not_found', message: 'not_found' } }, { status: 404, headers: BASE_HEADERS });
  return handler(req, ctx);
}


/**
 * Scoped HSA export (GET, read-only). Authenticates by session cookie, reads one consistent snapshot and answers with a CSV that is
 * never cached. State changes stay POST-only with CSRF; a GET cannot change anything.
 */
export async function handleHsaExport(req: Request, ctx: AppContext): Promise<Response> {
  const requestId = randomUUID();
  try {
    if (req.method !== 'GET') throw new AppError('invalid_input', 'GET required');
    await refreshRuntimeConfig(ctx.config, ctx.pool);
    const client = clientInfo(req.headers, ctx.config);
    assertTransport(req.headers, ctx.config, client);
    const session = await pageActor(ctx, req.headers);
    if (!session) throw new AppError('unauthenticated');
    const query = Object.fromEntries(new URL(req.url).searchParams);
    const out = await hsa.exportHsa(ctx.pool, session.actor, query, requestId);
    return new Response(out.csv, {
      status: 200,
      headers: { ...BASE_HEADERS, 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${out.filename}"` },
    });
  } catch (error) {
    if (!(error instanceof AppError) || error.code === 'internal') logError('http.hsa.export', error, { requestId });
    return errorResponse(req, null, error, null);
  }
}


// ---------- documents ----------

const RETURN_TO = /^\/(bills|visits|documents|hsa\/allocations|hsa\/receipts)\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A form's `returnTo` is a fixed set of record pages only; anything else is ignored, so it can never become an open redirect. */
const returnPath = (b: Record<string, unknown>): string | null => (typeof b.returnTo === 'string' && RETURN_TO.test(b.returnTo) ? b.returnTo : null);
const withoutReturn = (b: Record<string, unknown>) => {
  const { returnTo: _r, ...rest } = b;
  return rest;
};
const documentPage = (b: Record<string, unknown>, id?: string) => {
  const doc = str(b.documentId) ?? str(b.id) ?? id;
  return returnPath(b) ?? (doc ? `/documents/${doc}` : '/documents');
};

/** The record page a form was posted from (its Referer path, when it is one of the allowed record pages), else the document list. */
const busyReturnPath = (req: Request): string => {
  try {
    const p = new URL(req.headers.get('referer') ?? '').pathname;
    return RETURN_TO.test(p) ? p : '/documents';
  } catch {
    return '/documents';
  }
};
const TARGET_PAGES: Record<string, string> = { bill: '/bills', visit: '/visits', hsa_receipt: '/hsa/receipts' };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** After a failed attach, land back on the record the person was attaching to (also when the form carried no returnTo). */
const attachErrorPage = (b: Record<string, unknown>): string => {
  const base = typeof b.targetType === 'string' ? TARGET_PAGES[b.targetType] : undefined;
  return returnPath(b) ?? (base && typeof b.targetId === 'string' && UUID_RE.test(b.targetId) ? `${base}/${b.targetId}` : documentPage(b));
};

interface DocumentAction {
  run: (ctx: AppContext, actor: Actor, body: Record<string, unknown>, requestId: string) => Promise<{ id: string }>;
  error: (b: Record<string, unknown>) => string;
  ok: (b: Record<string, unknown>, id: string) => string;
  keep?: string[];
  upload?: boolean;
  status?: number;
}
const deps = (ctx: AppContext): documents.DocumentDeps => ({ pool: ctx.pool, store: ctx.store ?? null, limits: ctx.config });
const DOCUMENT_ACTIONS: Record<string, DocumentAction> = {
  'upload': {
    run: (ctx, actor, b, rid) => documents.uploadDocument(deps(ctx), actor, withoutReturn(b), rid), upload: true, status: 201,
    error: (b) => returnPath(b) ?? '/documents', ok: (b, id) => returnPath(b) ?? `/documents/${id}`, keep: ['title', 'kind', 'note'],
  },
  'version': {
    run: (ctx, actor, b, rid) => documents.addDocumentVersion(deps(ctx), actor, withoutReturn(b), rid), upload: true, status: 201,
    error: (b) => documentPage(b), ok: (b, id) => documentPage(b, id),
  },
  'update': { run: (ctx, actor, b, rid) => documents.updateDocument(ctx.pool, actor, withoutReturn(b), rid), error: (b) => documentPage(b), ok: (b, id) => documentPage(b, id), keep: ['title', 'kind', 'note'] },
  'remove': { run: (ctx, actor, b, rid) => documents.removeDocument(ctx.pool, actor, withoutReturn(b), rid), error: (b) => documentPage(b), ok: () => '/documents', keep: ['reason'] },
  'attach': { run: (ctx, actor, b, rid) => documents.attachDocument(ctx.pool, actor, withoutReturn(b), rid), error: attachErrorPage, ok: (b, id) => documentPage(b, id), keep: ['note'] },
  'detach': { run: (ctx, actor, b, rid) => documents.detachDocument(ctx.pool, actor, withoutReturn(b), rid), error: (b) => returnPath(b) ?? '/documents', ok: (b, id) => returnPath(b) ?? `/documents/${id}`, keep: ['reason'] },
};

const documentRoutes = new Map(Object.entries(DOCUMENT_ACTIONS).map(([name, a]) => [name, route({
  name: `documents.${name}`,
  session: true,
  errorPath: a.error,
  keepFields: a.keep,
  redirectAllErrors: true,
  ...(a.upload ? {
    authBeforeBody: true,
    beforeBody: (actor: Actor) => checkUploadRate(actor.userId),
    readBody: (req: Request, ctx: AppContext) => readMultipart(req, ctx.config.documentMaxBytes),
  } : {}),
  async run({ ctx, actor, body, requestId, req }) {
    const result = await a.run(ctx, actor!, body, requestId);
    if (wantsHtml(req)) return { response: redirect(ctx.config, a.ok(body, result.id)) };
    return { json: { ok: true, ...result }, status: a.status ?? 200 };
  },
})]));

/** Document mutations. The action comes from a fixed allow-list; uploads are multipart, everything else is a small form or JSON body. */
export async function handleDocumentAction(req: Request, ctx: AppContext, action: string): Promise<Response> {
  const handler = documentRoutes.get(action);
  if (!handler) return Response.json({ error: { code: 'not_found', message: 'not_found' } }, { status: 404, headers: BASE_HEADERS });
  if (!DOCUMENT_ACTIONS[action]!.upload) return handler(req, ctx);
  // An upload is buffered in memory several times over; cap how many run at once in this process.
  if (uploadsInFlight >= MAX_CONCURRENT_UPLOADS) {
    // Browser form posts go back to the page they came from with a friendly message; API callers get the JSON error.
    return errorResponse(req, ctx, new AppError('busy', 'busy', 2), busyReturnPath(req));
  }
  uploadsInFlight++;
  try {
    return await handler(req, ctx);
  } finally {
    uploadsInFlight--;
  }
}

export const MAX_CONCURRENT_UPLOADS = 4;

/** At most this many upload attempts (accepted or refused) per person per minute, so no one can keep the server busy scanning files. */
export const MAX_UPLOADS_PER_MINUTE = 30;
const uploadAttempts = new Map<string, number[]>();
function checkUploadRate(userId: string, now = Date.now()): void {
  const recent = (uploadAttempts.get(userId) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= MAX_UPLOADS_PER_MINUTE) {
    uploadAttempts.set(userId, recent);
    throw new AppError('busy', 'busy', 30);
  }
  recent.push(now);
  uploadAttempts.set(userId, recent);
  if (uploadAttempts.size > 5000) for (const [k, v] of uploadAttempts) if (v.every((t) => now - t >= 60_000)) uploadAttempts.delete(k);
}
let uploadsInFlight = 0;

/** Types a browser may render inline. PDFs are always downloaded: an in-browser PDF viewer is active content. */
const INLINE_TYPES = new Set(['image/png', 'image/jpeg']);

/**
 * Authenticated, household-scoped download (GET, read-only). The bytes are verified against the stored checksum, the type is the
 * one recorded from the content, and every response forbids sniffing, framing, caching and scripting.
 */
export async function handleDocumentDownload(req: Request, ctx: AppContext, id: string): Promise<Response> {
  const requestId = randomUUID();
  try {
    if (req.method !== 'GET') throw new AppError('invalid_input', 'GET required');
    await refreshRuntimeConfig(ctx.config, ctx.pool);
    const client = clientInfo(req.headers, ctx.config);
    assertTransport(req.headers, ctx.config, client);
    const session = await pageActor(ctx, req.headers);
    if (!session) throw new AppError('unauthenticated');
    const query = new URL(req.url).searchParams;
    const v = query.get('version');
    if (v !== null && !/^[1-9]\d{0,5}$/.test(v)) throw new AppError('invalid_input');
    const file = await documents.downloadDocument(ctx.pool, ctx.store ?? null, session.actor, id, v === null ? undefined : Number(v), requestId);
    const inline = query.get('disposition') === 'inline' && INLINE_TYPES.has(file.mediaType);
    return new Response(new Uint8Array(file.bytes), {
      status: 200,
      headers: {
        ...BASE_HEADERS,
        'Cache-Control': 'private, no-store',
        'Content-Type': file.mediaType,
        'Content-Length': String(file.bytes.length),
        'Content-Disposition': contentDisposition(inline ? 'inline' : 'attachment', file.filename),
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Cross-Origin-Resource-Policy': 'same-origin',
      },
    });
  } catch (error) {
    if (!(error instanceof AppError) || error.code === 'internal') logError('http.documents.download', error, { requestId });
    return errorResponse(req, null, error, null);
  }
}


// ---------- optional assistant: client credentials and proposal review ----------

const proposalPage = (b: Record<string, unknown>) => (str(b.proposalId) ? `/proposals/${str(b.proposalId)}` : '/proposals');
const planProposalPage = (b: Record<string, unknown>) => (str(b.proposalId) ? `/proposals/plans/${str(b.proposalId)}` : '/proposals');

const createAssistantClient = route({
  name: 'assistant.clients.create',
  session: true,
  errorPath: () => '/assistant',
  keepFields: ['name', 'expiryDays'],
  async run({ ctx, actor, body, requestId, req }) {
    const c = await assistant.createClient(ctx.pool, actor!, body, requestId);
    if (wantsHtml(req)) {
      // Shown once and never stored in recoverable form; the page must not be cached.
      const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Assistant credential created</title>`
        + RESULT_PAGE_BODY + `<h1>Assistant credential created</h1>`
        + `<p>Copy this token into your assistant client now. It is shown once, only its checksum is stored, and it expires ${escapeHtml(c.expiresAt.toISOString())}.</p>`
        + `<p><code>${escapeHtml(c.token)}</code></p><p>Permissions: ${escapeHtml(c.scopes.join(', '))}</p>`
        + `<p>If it is ever exposed, revoke it on the assistant page.</p><p><a href="/assistant">Back to assistant settings</a></p></main></body></html>`;
      return { response: new Response(html, { status: 201, headers: { ...BASE_HEADERS, 'Content-Type': 'text/html; charset=utf-8' } }) };
    }
    return { json: { ok: true, id: c.id, token: c.token, scopes: c.scopes, expiresAt: c.expiresAt.toISOString() }, status: 201 };
  },
});

const ASSISTANT_ROUTES = new Map<string, ReturnType<typeof route>>([
  ['clients/create', createAssistantClient],
  ['clients/revoke', route({
    name: 'assistant.clients.revoke',
    session: true,
    errorPath: () => '/assistant',
    async run({ ctx, actor, body, requestId, req }) {
      const r = await assistant.revokeClient(ctx.pool, actor!, body, requestId);
      if (wantsHtml(req)) return { response: redirect(ctx.config, '/assistant') };
      return { json: { ok: true, ...r } };
    },
  })],
  ['proposals/approve', route({
    name: 'assistant.proposals.approve',
    session: true,
    errorPath: proposalPage,
    async run({ ctx, actor, body, requestId, req }) {
      const r = await assistant.approveProposal(ctx.pool, actor!, body, requestId);
      if (wantsHtml(req)) return { response: redirect(ctx.config, proposalPage(body)) };
      return { json: { ok: true, ...r } };
    },
  })],
  ['proposals/reject', route({
    name: 'assistant.proposals.reject',
    session: true,
    errorPath: proposalPage,
    keepFields: ['reason'],
    async run({ ctx, actor, body, requestId, req }) {
      const r = await assistant.rejectProposal(ctx.pool, actor!, body, requestId);
      if (wantsHtml(req)) return { response: redirect(ctx.config, proposalPage(body)) };
      return { json: { ok: true, ...r } };
    },
  })],
  // A payment plan proposal is applied only here, by a signed-in person: the approval creates the plan and lands on its page.
  ['proposals/plan-approve', route({
    name: 'assistant.proposals.plan_approve',
    session: true,
    errorPath: planProposalPage,
    async run({ ctx, actor, body, requestId, req }) {
      const r = await assistant.approvePlanProposal(ctx.pool, actor!, body, requestId);
      if (wantsHtml(req)) return { response: redirect(ctx.config, `/plans/${r.planId}`) };
      return { json: { ok: true, ...r }, status: r.replayed ? 200 : 201 };
    },
  })],
  ['proposals/plan-reject', route({
    name: 'assistant.proposals.plan_reject',
    session: true,
    errorPath: planProposalPage,
    keepFields: ['reason'],
    async run({ ctx, actor, body, requestId, req }) {
      const r = await assistant.rejectPlanProposal(ctx.pool, actor!, body, requestId);
      if (wantsHtml(req)) return { response: redirect(ctx.config, planProposalPage(body)) };
      return { json: { ok: true, ...r } };
    },
  })],
]);

/** Assistant mutations from a fixed allow-list. The MCP listener has no route into any of them. */
export async function handleAssistantAction(req: Request, ctx: AppContext, action: string): Promise<Response> {
  const handler = ASSISTANT_ROUTES.get(action);
  if (!handler) return Response.json({ error: { code: 'not_found', message: 'not_found' } }, { status: 404, headers: BASE_HEADERS });
  return handler(req, ctx);
}

/** Names of every allow-listed action behind the catch-all routes, so tests can prove each one is behind the password-change gate. */
export function actionInventory(): { expenses: string[]; documents: string[]; assistant: string[]; settings: string[] } {
  return { expenses: [...expenseRoutes.keys()], documents: [...documentRoutes.keys()], assistant: [...ASSISTANT_ROUTES.keys()], settings: [...SETTINGS_ROUTES.keys()] };
}

// ---------- administrator settings ----------

const SETTINGS_PAGES = { general: '/settings', documents: '/settings', proxy: '/settings/proxy', email: '/settings/email', signin: '/settings/signin' } as const;
const SETTINGS_ACTIONS: Record<string, {
  service: (pool: Pool, config: AppConfig, actor: Actor, input: unknown, requestId: string) => Promise<void>; page: string; saved: string; keep?: string[];
  /** Where a failed save goes back to, when that differs from the page (for example to reopen the dialog the form lives in). */
  errorPage?: string;
}> = {
  general: { service: settingsService.saveGeneral, page: SETTINGS_PAGES.general, saved: 'general', keep: ['sourceUrl', 'sessionAbsoluteMinutes', 'sessionIdleMinutes', 'invitationMinutes'] },
  documents: { service: settingsService.saveDocuments, page: SETTINGS_PAGES.documents, saved: 'documents', keep: ['documentMaxMb', 'documentQuotaMb', 'documentRetentionDays'] },
  proxy: { service: settingsService.saveProxy, page: SETTINGS_PAGES.proxy, saved: 'proxy', keep: ['trustedProxies'] },
  email: { service: settingsService.saveEmail, page: SETTINGS_PAGES.email, saved: 'email', keep: ['host', 'port', 'security', 'username', 'fromAddress', 'fromName'] },
  'email/clear': { service: settingsService.clearEmail, page: SETTINGS_PAGES.email, saved: 'email_cleared' },
  // `add=1` reopens the provider dialog on the Sign-in page, so the message appears next to the form it belongs to.
  signin: { service: signin.saveSignin, page: SETTINGS_PAGES.signin, errorPage: `${SETTINGS_PAGES.signin}?add=1`, saved: 'signin', keep: ['provider', 'issuer', 'tenant', 'clientId', 'scopes', 'buttonLabel', 'allowedDomains'] },
  'signin/unlink': { service: signin.unlinkIdentity, page: SETTINGS_PAGES.signin, saved: 'signin_unlinked' },
};

const SETTINGS_ROUTES = new Map<string, (req: Request, ctx: AppContext) => Promise<Response>>([
  ...Object.entries(SETTINGS_ACTIONS).map(([name, a]) => [name, route({
    name: `settings.${name}`,
    session: true,
    errorPath: () => a.errorPage ?? a.page,
    keepFields: a.keep,
    async run({ ctx, actor, body, requestId, req }) {
      await a.service(ctx.pool, ctx.config, actor!, body, requestId);
      if (wantsHtml(req)) return { response: redirect(ctx.config, `${a.page}?saved=${a.saved}`) };
      return { json: { ok: true } };
    },
  })] as const),
  ['email/test', route({
    name: 'settings.email.test',
    session: true,
    errorPath: () => '/settings/email',
    async run({ ctx, actor, body, requestId, req }) {
      const result = await settingsService.sendTestEmail(ctx.pool, ctx.config, actor!, body, requestId);
      const outcome = result.sent ? 'sent' : result.reason;
      if (wantsHtml(req)) return { response: redirect(ctx.config, `/settings/email?tested=${outcome}`) };
      return { json: { ok: result.sent, result: outcome, smtpCode: result.sent ? undefined : result.smtpCode } };
    },
  })],
  ['signin/test', route({
    name: 'settings.signin.test',
    session: true,
    errorPath: () => '/settings/signin',
    async run({ ctx, actor, body, requestId, req }) {
      const result = await signin.testSignin(ctx.pool, ctx.config, actor!, body, requestId);
      if (wantsHtml(req)) return { response: redirect(ctx.config, `/settings/signin?tested=${result}`) };
      return { json: { ok: result === 'ok', result } };
    },
  })],
  // Server-wide backup: answers with the archive itself, streamed as it is produced. The service re-checks the role and the password.
  ['backup', route({
    name: 'settings.backup',
    keepsUndo: true,
    session: true,
    errorPath: () => '/settings/backup',
    async run({ ctx, actor, body, requestId }) {
      const backup = await startBackup(ctx, actor!, body, requestId);
      return {
        response: new Response(downloadBody(backup.stream), {
          status: 200,
          headers: {
            ...BASE_HEADERS, 'Cache-Control': 'private, no-store', 'Content-Type': 'application/octet-stream',
            'Content-Disposition': `attachment; filename="${backup.filename}"`, 'X-TallyMed-Backup-Id': backup.backupId,
          },
        }),
      };
    },
  })],
]);

/** Settings mutations from a fixed allow-list. Admin-only; each one also re-checks the role and the administrator's password in its service. */
export async function handleSettingsAction(req: Request, ctx: AppContext, action: string): Promise<Response> {
  const handler = SETTINGS_ROUTES.get(action);
  if (!handler) return Response.json({ error: { code: 'not_found', message: 'not_found' } }, { status: 404, headers: BASE_HEADERS });
  return handler(req, ctx);
}
