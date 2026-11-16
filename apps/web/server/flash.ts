// One-shot form re-fill after a validation error. Typed values travel in a short-lived HttpOnly cookie, never in the
// redirect URL, so dates of birth and free-text notes stay out of access logs, browser history and Referer headers.
// The cookie only pre-fills a form for the page it names, and only while that page shows an error.
import type { AppConfig } from './config.ts';

export const FLASH_MAX_AGE_SECONDS = 120;
const MAX_VALUE = 300;
const MAX_COOKIE_BYTES = 3500;
/**
 * Fields that hold a list, one item per line (the plan forms' pasted schedule and their table rows). They may be longer than other values
 * (up to MAX_LONG_VALUE characters) and, when the cookie would be too big, lose whole lines from the end, never part of a line, until it fits.
 * The cookie then says so in `flashTrimmed` (the names of the lists that were shortened) so a page never shows a shortened list as complete.
 */
export const FLASH_LONG_FIELDS: readonly string[] = ['installmentsText', 'instRows'];
const MAX_LONG_VALUE = 6000;

export const flashCookieName = (config: Pick<AppConfig, 'secureCookies'>) => (config.secureCookies ? '__Host-tallymed_flash' : 'tallymed_flash');

/** Builds the Set-Cookie value for the typed fields, or null when there is nothing to keep (or what must be kept cannot be made to fit). */
export function flashSetCookie(config: Pick<AppConfig, 'secureCookies'>, path: string, body: Record<string, unknown>, fields: string[]): string | null {
  const v: Record<string, string> = {};
  const trimmed = new Set<string>();
  for (const f of fields) {
    if (typeof body[f] !== 'string' || body[f] === '') continue;
    if (!FLASH_LONG_FIELDS.includes(f)) { v[f] = (body[f] as string).slice(0, MAX_VALUE); continue; }
    const lines = (body[f] as string).split(/\r\n|\r|\n/);
    while (lines.length > 0 && lines.join('\n').length > MAX_LONG_VALUE) { lines.pop(); trimmed.add(f); }
    if (lines.length > 0) v[f] = lines.join('\n');
  }
  if (Object.keys(v).length === 0) return null;
  // The page the values belong to, without any query (an error path such as `/settings/signin?add=1` reopens a dialog there).
  const encode = () => Buffer.from(JSON.stringify({ p: path.split('?')[0], v: trimmed.size > 0 ? { ...v, flashTrimmed: [...trimmed].join(',') } : v }), 'utf8').toString('base64url');
  let value = encode();
  while (value.length > MAX_COOKIE_BYTES) {
    // Shorten the longest list by its last line; anything else that is too big cannot be made to fit.
    const longest = Object.keys(v).filter((k) => FLASH_LONG_FIELDS.includes(k)).sort((a, b) => v[b]!.length - v[a]!.length)[0];
    if (!longest) return null;
    const lines = v[longest]!.split('\n');
    lines.pop();
    trimmed.add(longest);
    if (lines.length === 0) delete v[longest]; else v[longest] = lines.join('\n');
    value = encode();
  }
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
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) if (typeof val === 'string' && /^[A-Za-z][A-Za-z0-9.]{0,39}$/.test(k)) out[k] = val.slice(0, FLASH_LONG_FIELDS.includes(k) ? MAX_LONG_VALUE : MAX_VALUE);
    return out;
  } catch {
    return {};
  }
}
