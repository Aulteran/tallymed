import { randomUUID } from 'node:crypto';
import type { AppConfig } from './config.ts';
import type { Pool } from './db.ts';
import type { Actor } from './authz.ts';
import { AppError } from './errors.ts';
import { log, logError } from './log.ts';
import { assertTransport, clientInfo, type ClientInfo } from './proxy.ts';
import { authenticate, login, logout } from './services/auth.ts';
import { acceptInvitation, inviteOperator, updateOperator } from './services/operators.ts';
import { csrfFor, safeEqual } from './tokens.ts';
import { parse, schemas } from './validation.ts';

export interface AppContext { config: AppConfig; pool: Pool }

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
const wantsHtml = (req: Request) => (req.headers.get('accept') ?? '').includes('text/html');

export function redirect(config: AppConfig, pathAndQuery: string, headers: Record<string, string> = {}): Response {
  return new Response(null, {
    status: 303,
    headers: { ...BASE_HEADERS, Location: new URL(pathAndQuery, config.canonicalOrigin).href, ...headers },
  });
}

function errorResponse(req: Request, ctx: AppContext | null, error: unknown, errorPath: string | null): Response {
  const app = error instanceof AppError ? error : new AppError('internal');
  const code = app.code;
  const headers: Record<string, string> = { ...BASE_HEADERS };
  if (app.retryAfterSeconds) headers['Retry-After'] = String(app.retryAfterSeconds);
  if (ctx && errorPath && wantsHtml(req) && app.status !== 413 && app.status !== 415) {
    return redirect(ctx.config, `${errorPath}?error=${code}`, headers);
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
  run: (input: RouteInput) => Promise<RouteResult>;
}) {
  return async (req: Request, ctx: AppContext): Promise<Response> => {
    const requestId = randomUUID();
    let body: Record<string, unknown> = {};
    try {
      if (req.method !== 'POST') throw new AppError('invalid_input', 'POST required');
      const client = clientInfo(req.headers, ctx.config);
      assertTransport(req.headers, ctx.config, client);
      assertSameOrigin(req.headers, ctx.config);
      body = await readBody(req);
      const sessionToken = readCookie(req.headers, sessionCookieName(ctx.config));
      let actor: Actor | null = null;
      if (opts.session) {
        actor = await authenticate(ctx.pool, ctx.config, sessionToken);
        if (!actor || !sessionToken) throw new AppError('unauthenticated');
        const presented = (req.headers.get('x-csrf-token') ?? (typeof body.csrf === 'string' ? body.csrf : '')) as string;
        if (!presented || !safeEqual(presented, csrfFor(sessionToken))) throw new AppError('csrf_failed');
      }
      const result = await opts.run({ req, ctx, body, actor, sessionToken, client, requestId });
      if ('response' in result) return result.response;
      return Response.json(result.json, { status: result.status ?? 200, headers: { ...BASE_HEADERS, ...result.headers } });
    } catch (error) {
      if (!(error instanceof AppError) || error.code === 'internal') logError(`http.${opts.name}`, error, { requestId });
      else log('info', `http.${opts.name}.rejected`, { requestId, code: error.code });
      let errorPath: string | null = null;
      try {
        errorPath = opts.errorPath(body);
      } catch {
        errorPath = null;
      }
      return errorResponse(req, ctx, error, errorPath);
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
      email: data.email, password: data.password, ip: client.ip, requestId, previousToken: sessionToken,
    });
    const cookie = cookieHeader(ctx.config, result.token, ctx.config.sessionAbsoluteSeconds);
    if (wantsHtml(req)) return { response: redirect(ctx.config, '/', { 'Set-Cookie': cookie }) };
    return { json: { ok: true, csrfToken: csrfFor(result.token) }, headers: { 'Set-Cookie': cookie } };
  },
});

export const handleLogout = route({
  name: 'logout',
  session: true,
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
  errorPath: () => '/operators',
  async run({ ctx, actor, body, requestId, req }) {
    const invitation = await inviteOperator(ctx.pool, ctx.config, actor!, body, requestId);
    const link = new URL(`/invite/${invitation.token}`, ctx.config.canonicalOrigin).href;
    if (wantsHtml(req)) {
      // Shown once and never stored in recoverable form; the page must not be cached.
      const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Invitation created</title>`
        + `<body style="font-family:system-ui;max-width:40rem;margin:3rem auto;padding:0 1rem"><h1>Invitation created</h1>`
        + `<p>Share this one-time link with ${escapeHtml(invitation.email)}. It expires ${escapeHtml(invitation.expiresAt.toISOString())} and is not shown again.</p>`
        + `<p><code>${escapeHtml(link)}</code></p><p><a href="/operators">Back to operators</a></p></body></html>`;
      return { response: new Response(html, { status: 201, headers: { ...BASE_HEADERS, 'Content-Type': 'text/html; charset=utf-8' } }) };
    }
    return { json: { ok: true, link, email: invitation.email, expiresAt: invitation.expiresAt.toISOString() }, status: 201 };
  },
});

export const handleUpdateOperator = route({
  name: 'update-operator',
  session: true,
  errorPath: () => '/operators',
  async run({ ctx, actor, body, requestId, req }) {
    await updateOperator(ctx.pool, actor!, body, requestId);
    if (wantsHtml(req)) return { response: redirect(ctx.config, '/operators') };
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

/** Used by server-rendered pages. Authorization still happens in the service for every mutation. */
export async function pageActor(ctx: AppContext, headers: Headers): Promise<{ actor: Actor; csrf: string } | null> {
  const token = readCookie(headers, sessionCookieName(ctx.config));
  const actor = await authenticate(ctx.pool, ctx.config, token);
  return actor && token ? { actor, csrf: csrfFor(token) } : null;
}

