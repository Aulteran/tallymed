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
  };
}
