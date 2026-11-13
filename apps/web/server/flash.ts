// One-shot form re-fill after a validation error. Typed values travel in a short-lived HttpOnly cookie, never in the
// redirect URL, so dates of birth and free-text notes stay out of access logs, browser history and Referer headers.
// The cookie only pre-fills a form for the page it names, and only while that page shows an error.
import type { AppConfig } from './config.ts';

export const FLASH_MAX_AGE_SECONDS = 120;
const MAX_VALUE = 300;
const MAX_COOKIE_BYTES = 3500;

export const flashCookieName = (config: Pick<AppConfig, 'secureCookies'>) => (config.secureCookies ? '__Host-tallymed_flash' : 'tallymed_flash');

/** Builds the Set-Cookie value for the typed fields, or null when there is nothing to keep. */
export function flashSetCookie(config: Pick<AppConfig, 'secureCookies'>, path: string, body: Record<string, unknown>, fields: string[]): string | null {
  const v: Record<string, string> = {};
  for (const f of fields) if (typeof body[f] === 'string' && body[f] !== '') v[f] = (body[f] as string).slice(0, MAX_VALUE);
  if (Object.keys(v).length === 0) return null;
  const value = Buffer.from(JSON.stringify({ p: path, v }), 'utf8').toString('base64url');
  if (value.length > MAX_COOKIE_BYTES) return null;
  return [`${flashCookieName(config)}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${FLASH_MAX_AGE_SECONDS}`,
    ...(config.secureCookies ? ['Secure'] : [])].join('; ');
}

/** Returns the kept values when the cookie was written for this exact path; anything malformed yields nothing. */
export function readFlash(raw: string | null | undefined, path: string): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (parsed === null || typeof parsed !== 'object') return {};
    const { p, v } = parsed as { p?: unknown; v?: unknown };
    if (p !== path || v === null || typeof v !== 'object') return {};
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) if (typeof val === 'string' && /^[A-Za-z]{1,40}$/.test(k)) out[k] = val.slice(0, MAX_VALUE);
    return out;
  } catch {
    return {};
  }
}
