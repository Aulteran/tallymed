import { log } from './log.ts';

export interface AppConfig {
  databaseUrl: string;
  /** Canonical browser origin, for example https://tallymed.example. Never derived from request headers. */
  canonicalOrigin: string;
  secureCookies: boolean;
  /** Shared secret the operator's reverse proxy sends to prove forwarded headers are trustworthy. */
  proxySecret: string | null;
  sessionAbsoluteSeconds: number;
  sessionIdleSeconds: number;
  invitationSeconds: number;
  sourceUrl: string | null;
  /** Absolute directory on a private volume for document bytes. Null disables document upload and download. */
  documentsDir: string | null;
  documentMaxBytes: number;
  /** Total stored bytes allowed per household across all versions. */
  documentQuotaBytes: number;
  /** Days a removed document's bytes are kept before the cleanup command purges them. */
  documentRetentionDays: number;
  /** Operator-defined one-time setup token (TALLYMED_SETUP_TOKEN). Null means the server generates one at startup while setup is needed. */
  setupToken: string | null;
  /**
   * Why TALLYMED_SETUP_TOKEN was rejected, or null. An invalid value never stops the app: once an administrator exists the variable is
   * irrelevant, and while setup is needed setup fails closed with this reason in the log.
   */
  setupTokenError: string | null;
}

export const MIN_SETUP_TOKEN_LENGTH = 32;
export const MAX_SETUP_TOKEN_LENGTH = 128;
const PLACEHOLDER_TOKEN = /^(change[-_ ]?me|replace[-_ ]?me|your[-_ ]?token|setup[-_ ]?token|tallymed|password|passphrase|secret|example|test)/i;
const COMMON_WORDS = ['password', 'passphrase', 'tallymed', 'changeme', 'replaceme', 'secret', 'token', 'setup', 'example', 'correct', 'horse', 'battery', 'staple',
  'admin', 'letmein', 'welcome', 'qwerty', 'abcdef', 'hunter'];
const KEYBOARD_ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm', '1234567890'];

/** True for 5 or more consecutive ascending or descending characters (`abcde`, `98765`) or a keyboard row fragment. */
function hasPattern(value: string): boolean {
  const lower = value.toLowerCase();
  let up = 1;
  let down = 1;
  for (let i = 1; i < lower.length; i++) {
    const d = lower.charCodeAt(i) - lower.charCodeAt(i - 1);
    up = d === 1 ? up + 1 : 1;
    down = d === -1 ? down + 1 : 1;
    if (up >= 5 || down >= 5) return true;
  }
  for (const row of KEYBOARD_ROWS) {
    for (const r of [row, [...row].reverse().join('')]) {
      for (let i = 0; i + 5 <= r.length; i++) if (lower.includes(r.slice(i, i + 5))) return true;
    }
  }
  return false;
}

/** True when any 8-character block occurs twice (`abcdefgh-abcdefgh-...`) or a single character makes up a quarter of the value. */
function isRepetitive(value: string): boolean {
  const seen = new Set<string>();
  for (let i = 0; i + 8 <= value.length; i++) {
    const block = value.slice(i, i + 8);
    if (seen.has(block)) return true;
    seen.add(block);
  }
  const counts = new Map<string, number>();
  for (const c of value) counts.set(c, (counts.get(c) ?? 0) + 1);
  return Math.max(...counts.values()) * 4 > value.length;
}

/**
 * An operator-defined setup token is a bearer credential for creating the first administrator, so it must be long and
 * not guessable from a dictionary: 32 to 128 printable ASCII characters without whitespace, at least 16 different
 * characters, no run of 5 sequential characters or keyboard-row fragment, no repeated 8-character block, no common word
 * or placeholder. Values from `openssl rand -base64 32` or `-hex 32` pass. Error messages never contain the value.
 */
export function parseSetupToken(value: string | undefined): string | null {
  if (value === undefined || value === '') return null;
  if (value.length < MIN_SETUP_TOKEN_LENGTH || value.length > MAX_SETUP_TOKEN_LENGTH) {
    throw new Error(`TALLYMED_SETUP_TOKEN must be ${MIN_SETUP_TOKEN_LENGTH} to ${MAX_SETUP_TOKEN_LENGTH} characters (use \`openssl rand -base64 32\`, or leave it empty to have the server generate one)`);
  }
  if (!/^[\x21-\x7e]+$/.test(value)) throw new Error('TALLYMED_SETUP_TOKEN must use printable ASCII characters without spaces');
  const lower = value.toLowerCase();
  if (new Set(value).size < 16 || PLACEHOLDER_TOKEN.test(value) || COMMON_WORDS.some((w) => lower.includes(w)) || hasPattern(value) || isRepetitive(value)) {
    throw new Error('TALLYMED_SETUP_TOKEN is too guessable: use a random value such as `openssl rand -base64 32` (or leave it empty)');
  }
  return value;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

function intEnv(env: Record<string, string | undefined>, key: string, fallback: number, min: number, max: number) {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${key} must be an integer from ${min} to ${max}`);
  }
  return value;
}

export function parseCanonicalOrigin(value: string | undefined): { origin: string; secure: boolean } {
  if (!value) throw new Error('TALLYMED_CANONICAL_ORIGIN is required');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('TALLYMED_CANONICAL_ORIGIN must be an absolute origin');
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('TALLYMED_CANONICAL_ORIGIN must be an origin without credentials or path');
  }
  const loopback = LOOPBACK.has(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('TALLYMED_CANONICAL_ORIGIN must use https (http is allowed only for loopback development)');
  }
  return { origin: url.origin, secure: url.protocol === 'https:' };
}

export function sourceUrl(value: string | undefined | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * The document volume must be an absolute, normalized path that is not the filesystem root and not part of the application's
 * served tree (a `public` or `.next` directory), so a stored object can never be reached as a static file.
 */
export function parseDocumentsDir(value: string | undefined): string | null {
  if (!value) return null;
  const parts = value.split('/');
  if (!value.startsWith('/') || value === '/' || value.includes('\0') || parts.some((p) => p === '..' || p === '.' || p === 'public' || p === '.next')
      || value.replace(/\/+$/, '') !== value.replace(/\/{2,}/g, '/').replace(/\/+$/, '')) {
    throw new Error('TALLYMED_DOCUMENTS_DIR must be a normalized absolute path outside the web root (no .., public or .next segments)');
  }
  return value.replace(/\/+$/, '');
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const { origin, secure } = parseCanonicalOrigin(env.TALLYMED_CANONICAL_ORIGIN);
  const proxySecret = env.TALLYMED_PROXY_SECRET ? env.TALLYMED_PROXY_SECRET : null;
  if (proxySecret !== null && proxySecret.length < 32) {
    throw new Error('TALLYMED_PROXY_SECRET must be at least 32 characters');
  }
  if (secure && proxySecret === null) {
    log('warn', 'config.proxy_secret_missing', {
      note: 'Per-address login throttling is disabled until TALLYMED_PROXY_SECRET is set and the proxy sends it.',
    });
  }
  let setupToken: string | null = null;
  let setupTokenError: string | null = null;
  try {
    setupToken = parseSetupToken(env.TALLYMED_SETUP_TOKEN);
  } catch (error) {
    setupTokenError = error instanceof Error ? error.message : 'invalid TALLYMED_SETUP_TOKEN';
    log('warn', 'config.setup_token_invalid', { reason: setupTokenError, note: 'ignored once an administrator exists; setup stays closed until fixed' });
  }
  return {
    databaseUrl,
    canonicalOrigin: origin,
    secureCookies: secure,
    proxySecret,
    sessionAbsoluteSeconds: intEnv(env, 'TALLYMED_SESSION_ABSOLUTE_SECONDS', 12 * 3600, 60, 30 * 86400),
    sessionIdleSeconds: intEnv(env, 'TALLYMED_SESSION_IDLE_SECONDS', 2 * 3600, 60, 7 * 86400),
    invitationSeconds: intEnv(env, 'TALLYMED_INVITATION_SECONDS', 72 * 3600, 60, 14 * 86400),
    sourceUrl: sourceUrl(env.TALLYMED_SOURCE_URL),
    documentsDir: parseDocumentsDir(env.TALLYMED_DOCUMENTS_DIR),
    documentMaxBytes: intEnv(env, 'TALLYMED_DOCUMENT_MAX_MB', 10, 1, 25) * 1024 * 1024,
    documentQuotaBytes: intEnv(env, 'TALLYMED_DOCUMENT_QUOTA_MB', 2048, 10, 1_048_576) * 1024 * 1024,
    documentRetentionDays: intEnv(env, 'TALLYMED_DOCUMENT_RETENTION_DAYS', 30, 0, 3650),
    setupToken,
    setupTokenError,
  };
}
