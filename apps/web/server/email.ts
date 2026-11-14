// Outgoing email. One place sends mail for the whole application:
//
//   isEmailConfigured(db, config)  -> boolean, for features that offer an email option only when it can work
//   sendEmail({ db, config }, message, { purpose, requestId })  -> { sent: true } | { sent: false, reason, smtpCode? }
//
// sendEmail never throws for delivery problems and never includes secrets, the recipient or the body in its result or logs. A caller that
// needs an audit trail records its own audit row (for example "password reset email requested") in its own transaction. The SMTP settings
// come from Settings > Email (stored encrypted password, see secrets.ts). The relay host is resolved here and the connection is made to
// the checked address, so a hostname cannot resolve to a forbidden address between the check and the connection. See docs/operations.md.
import dns from 'node:dns/promises';
import nodemailer from 'nodemailer';
import type { AppConfig } from './config.ts';
import type { Queryable } from './db.ts';
import { classifyAddress } from './ip.ts';
import { log } from './log.ts';
import { SlidingWindowLimiter } from './rate-limit.ts';
import { decryptSecret } from './secrets.ts';
import { readGroup, type EmailValue, type SmtpSecurity } from './settings.ts';

export const EMAIL_SECRET_PURPOSE = 'email.smtp_password';

export interface OutgoingEmail {
  /** One recipient address. */
  to: string;
  /** Single line, at most 200 characters. */
  subject: string;
  /** Plain text body, at most 20,000 characters. */
  text: string;
}

export type EmailFailure =
  | 'not_configured' | 'invalid_message' | 'password_unavailable' | 'rate_limited'
  | 'host_unresolved' | 'target_blocked' | 'connect_failed' | 'timeout' | 'tls_failed' | 'auth_failed' | 'rejected';

export type EmailResult = { sent: true } | { sent: false; reason: EmailFailure; smtpCode?: number };

export const FAILURE_TEXT: Record<EmailFailure, string> = {
  not_configured: 'Email is not set up. Save the SMTP settings first.',
  invalid_message: 'The message was not valid.',
  password_unavailable: 'The saved SMTP password cannot be read. Enter the password again and save. (Was TALLYMED_SECRETS_KEY changed or removed?)',
  rate_limited: 'Too many emails were sent recently. Wait a few minutes and try again.',
  host_unresolved: 'The SMTP host name did not resolve.',
  target_blocked: 'The SMTP host resolves to an address this installation is not allowed to connect to (loopback, link-local or a cloud metadata address). Use the relay\'s normal address, or tick "Allow loopback and link-local addresses" if the relay really runs there.',
  connect_failed: 'Could not connect to the SMTP server. Check the host, port and security mode, and that the server is reachable from the TallyMed container.',
  timeout: 'The SMTP server did not answer in time.',
  tls_failed: 'The secure connection failed: the server\'s certificate was not accepted or it does not speak the selected security mode.',
  auth_failed: 'The SMTP server refused the username or password.',
  rejected: 'The SMTP server refused the message or the sender or recipient address.',
};

const MAX_SUBJECT = 200;
const MAX_BODY = 20_000;
const CONNECT_TIMEOUT_MS = 8000;
const SOCKET_TIMEOUT_MS = 15_000;
const DNS_TIMEOUT_MS = 5000;
/** Messages the whole process may send per hour: a mail-bomb guard for any feature that calls the helper. */
export const SENDS_PER_HOUR = 60;
const globalLimiter = new SlidingWindowLimiter(SENDS_PER_HOUR, 3600_000);
export const resetEmailLimiterForTests = () => globalLimiter.reset();

export interface SmtpSettings {
  host: string; port: number; security: SmtpSecurity; username: string | null; password: string | null;
  fromAddress: string; fromName: string; allowRestrictedTargets: boolean;
}

export type Lookup = (host: string) => Promise<string[]>;
const defaultLookup: Lookup = async (host) => {
  const timer = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('dns timeout')), DNS_TIMEOUT_MS).unref());
  const found = await Promise.race([dns.lookup(host, { all: true, verbatim: true }), timer]);
  return found.map((f) => f.address);
};

/** Resolves the relay and applies the target policy to every address it resolves to. Returns the address to connect to. */
export async function resolveSmtpTarget(
  host: string, allowRestricted: boolean, lookup: Lookup = defaultLookup,
): Promise<{ ok: true; address: string } | { ok: false; reason: 'host_unresolved' | 'target_blocked' }> {
  let addresses: string[];
  try {
    addresses = await lookup(host);
  } catch {
    return { ok: false, reason: 'host_unresolved' };
  }
  if (addresses.length === 0) return { ok: false, reason: 'host_unresolved' };
  for (const a of addresses) {
    const c = classifyAddress(a);
    const allowed = c === 'public' || c === 'private' || (allowRestricted && (c === 'loopback' || c === 'link_local'));
    if (!allowed) return { ok: false, reason: 'target_blocked' }; // one forbidden answer refuses the host: no mixing tricks
  }
  return { ok: true, address: addresses[0]! };
}

/** Loads the effective SMTP settings, or null when email is not configured. */
export async function loadSmtpSettings(db: Queryable, config: AppConfig): Promise<{ settings: SmtpSettings } | { error: 'not_configured' | 'password_unavailable' }> {
  const stored = await readGroup(db, 'email');
  const v: EmailValue = stored.value;
  if (!v.host || !v.fromAddress || !v.port) return { error: 'not_configured' };
  let password: string | null = null;
  if (stored.secretCiphertext) {
    if (!config.secretsKey) return { error: 'password_unavailable' };
    const d = decryptSecret(config.secretsKey, EMAIL_SECRET_PURPOSE, stored.secretCiphertext);
    if (d.status !== 'ok') return { error: 'password_unavailable' };
    password = d.value;
  }
  return {
    settings: {
      host: v.host, port: v.port, security: v.security ?? 'starttls', username: v.username ?? null, password,
      fromAddress: v.fromAddress, fromName: v.fromName ?? 'TallyMed', allowRestrictedTargets: v.allowRestrictedTargets === true,
    },
  };
}

export async function isEmailConfigured(db: Queryable, config: AppConfig): Promise<boolean> {
  return 'settings' in (await loadSmtpSettings(db, config));
}

function categorize(error: unknown): { reason: EmailFailure; smtpCode?: number } {
  const e = error as { code?: string; responseCode?: number; message?: string };
  const code = e?.code ?? '';
  const smtpCode = typeof e?.responseCode === 'number' ? e.responseCode : undefined;
  const msg = String(e?.message ?? '');
  if (code === 'EAUTH') return { reason: 'auth_failed', smtpCode };
  if (code === 'ETLS' || /certificate|self.signed|CERT_|ssl|tls|wrong version number|handshake/i.test(code + ' ' + msg)) return { reason: 'tls_failed' };
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT' || /timeout|timed out/i.test(msg)) return { reason: 'timeout' };
  if (code === 'EENVELOPE' || code === 'EMESSAGE' || (smtpCode !== undefined && smtpCode >= 500)) return { reason: 'rejected', smtpCode };
  return { reason: 'connect_failed' };
}

export interface DeliverDeps { lookup?: Lookup }

/** Sends one message with explicit settings. Used by sendEmail and by tests; callers normally use sendEmail. */
export async function deliver(s: SmtpSettings, message: OutgoingEmail, canonicalHost: string, deps: DeliverDeps = {}): Promise<EmailResult> {
  const target = await resolveSmtpTarget(s.host, s.allowRestrictedTargets, deps.lookup);
  if (!target.ok) return { sent: false, reason: target.reason };
  const transport = nodemailer.createTransport({
    host: target.address,
    port: s.port,
    secure: s.security === 'tls',
    requireTLS: s.security === 'starttls',
    ignoreTLS: s.security === 'none',
    name: canonicalHost,
    auth: s.username && s.password ? { user: s.username, pass: s.password } : undefined,
    // The connection goes to the checked address; the certificate is still verified against the configured host name.
    tls: { servername: /^[\d.:]+$/.test(s.host) ? undefined : s.host, minVersion: 'TLSv1.2' },
    connectionTimeout: CONNECT_TIMEOUT_MS,
    greetingTimeout: CONNECT_TIMEOUT_MS,
    socketTimeout: SOCKET_TIMEOUT_MS,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  try {
    await transport.sendMail({
      from: { name: s.fromName, address: s.fromAddress }, to: message.to, subject: message.subject, text: message.text,
      headers: { 'Auto-Submitted': 'auto-generated' },
    });
    return { sent: true };
  } catch (error) {
    return { sent: false, ...categorize(error) };
  } finally {
    transport.close();
  }
}

const ADDRESS = /^[^\s@<>(),;:"\\]{1,64}@[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
export const isMailAddress = (v: string) => v.length <= 254 && ADDRESS.test(v);

export async function sendEmail(
  ctx: { db: Queryable; config: AppConfig }, message: OutgoingEmail, opts: { purpose: string; requestId?: string; deps?: DeliverDeps },
): Promise<EmailResult> {
  const purpose = /^[a-z][a-z0-9_.]{0,39}$/.test(opts.purpose) ? opts.purpose : 'unspecified';
  const done = (r: EmailResult): EmailResult => {
    log(r.sent ? 'info' : 'warn', r.sent ? 'email.sent' : 'email.failed', { purpose, requestId: opts.requestId, reason: r.sent ? undefined : r.reason, smtpCode: r.sent ? undefined : r.smtpCode });
    return r;
  };
  if (!isMailAddress(message.to) || /[\r\n]/.test(message.subject) || message.subject.length === 0 || message.subject.length > MAX_SUBJECT
      || message.text.length === 0 || message.text.length > MAX_BODY) {
    return done({ sent: false, reason: 'invalid_message' });
  }
  const loaded = await loadSmtpSettings(ctx.db, ctx.config);
  if ('error' in loaded) return done({ sent: false, reason: loaded.error });
  if (globalLimiter.take('send') !== null) return done({ sent: false, reason: 'rate_limited' });
  return done(await deliver(loaded.settings, message, new URL(ctx.config.canonicalOrigin).hostname, opts.deps));
}
