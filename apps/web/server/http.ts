import { randomUUID } from 'node:crypto';
import type { AppConfig } from './config.ts';
import type { Pool } from './db.ts';
import type { Actor } from './authz.ts';
import { AppError } from './errors.ts';
import { flashSetCookie } from './flash.ts';
import { log, logError } from './log.ts';
import { assertTransport, clientInfo, type ClientInfo } from './proxy.ts';
import { authenticate, login, logout } from './services/auth.ts';
import * as expenses from './services/expenses.ts';
import * as payments from './services/payments.ts';
import * as plans from './services/plans.ts';
import { acceptInvitation, inviteOperator, revokeInvitation, updateOperator } from './services/operators.ts';
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

function errorResponse(req: Request, ctx: AppContext | null, error: unknown, errorPath: string | null, flash: string | null = null): Response {
  const app = error instanceof AppError ? error : new AppError('internal');
  const code = app.code;
  const headers: Record<string, string> = { ...BASE_HEADERS };
  if (app.retryAfterSeconds) headers['Retry-After'] = String(app.retryAfterSeconds);
  if (ctx && errorPath && wantsHtml(req) && app.status !== 413 && app.status !== 415) {
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
      let flash: string | null = null;
      try {
        errorPath = opts.errorPath(body);
        if (opts.keepFields) flash = flashSetCookie(ctx.config, errorPath, body, opts.keepFields);
      } catch {
        errorPath = null;
      }
      return errorResponse(req, ctx, error, errorPath, flash);
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

export const handleRevokeInvitation = route({
  name: 'revoke-invitation',
  session: true,
  errorPath: () => '/operators',
  async run({ ctx, actor, body, requestId, req }) {
    await revokeInvitation(ctx.pool, actor!, body, requestId);
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

const PAYMENT_FIELDS = ['paidOn', 'amount', 'method', 'reference', 'note', 'billId', 'allocateAmount'];
const paymentPath = (b: Record<string, unknown>, id: string) => `/payments/${str(b.paymentId) ?? id}`;
const planPath = (b: Record<string, unknown>, id: string) => `/plans/${str(b.planId) ?? id}`;
const paymentOf = (b: Record<string, unknown>) => `/payments/${str(b.paymentId)}`;
const planOf = (b: Record<string, unknown>) => `/plans/${str(b.planId)}`;
const SCHEDULE_FIELDS = ['totalAmount', 'installmentCount', 'firstDueDate', 'cadence'];
// Payments, refunds and plans use the same pipeline and the same fixed allow-list as the expense actions.
const MONEY_ACTIONS: Record<string, {
  service: ExpenseService; error: (b: Record<string, unknown>) => string; ok: (b: Record<string, unknown>, id: string) => string; keep?: string[];
}> = {
  'payments/create': { service: payments.recordPayment, error: () => '/payments', keep: PAYMENT_FIELDS, ok: (_b, id) => `/payments/${id}` },
  'payments/allocate': { service: payments.allocatePayment, error: paymentOf, keep: ['billId', 'allocateAmount'], ok: paymentPath },
  'payments/unapply': { service: payments.reverseAllocation, error: paymentOf, keep: ['amount', 'effectiveDate', 'reason'], ok: paymentPath },
  'payments/refund': { service: payments.recordRefund, error: paymentOf, keep: ['allocationId', 'amount', 'effectiveDate', 'reason'], ok: paymentPath },
  'payments/refund-reverse': { service: payments.reverseRefund, error: paymentOf, keep: ['effectiveDate', 'reason'], ok: paymentPath },
  'payments/void': { service: payments.voidPayment, error: paymentOf, keep: ['voidedOn', 'reason'], ok: paymentPath },
  'plans/create': { service: plans.createPlan, error: () => '/plans', keep: ['name', 'providerId', 'billId', ...SCHEDULE_FIELDS], ok: (_b, id) => `/plans/${id}` },
  'plans/revise': { service: plans.revisePlan, error: planOf, keep: ['reason', ...SCHEDULE_FIELDS], ok: planPath },
  'plans/cancel': { service: plans.cancelPlan, error: planOf, keep: ['reason'], ok: planPath },
  'plans/match': { service: plans.matchInstallment, error: planOf, keep: ['installmentId', 'allocationId', 'amount'], ok: planPath },
  'plans/unmatch': { service: plans.unmatchInstallment, error: planOf, keep: ['reason', 'amount'], ok: planPath },
};

const expenseRoutes = new Map(Object.entries({ ...EXPENSE_ACTIONS, ...MONEY_ACTIONS }).map(([name, a]) => [name, route({
  name: `expenses.${name}`,
  session: true,
  errorPath: a.error,
  keepFields: a.keep,
  async run({ ctx, actor, body, requestId, req }) {
    const result = await a.service(ctx.pool, actor!, body, requestId);
    if (wantsHtml(req)) return { response: redirect(ctx.config, a.ok(body, result.id)) };
    return { json: { ok: true, ...result }, status: name.endsWith('/create') ? 201 : 200 };
  },
})]));

/** Single entry point for every expense mutation. The action comes from a fixed allow-list, never from the body. */
export async function handleExpenseAction(req: Request, ctx: AppContext, action: string): Promise<Response> {
  const handler = expenseRoutes.get(action);
  if (!handler) return Response.json({ error: { code: 'not_found', message: 'not_found' } }, { status: 404, headers: BASE_HEADERS });
  return handler(req, ctx);
}
