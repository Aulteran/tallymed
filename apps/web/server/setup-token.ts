// One-time setup token for creating the first administrator through the web setup page.
//
// The token is never stored: not in the database, not in audit rows, not in structured logs. An operator-defined token
// comes from TALLYMED_SETUP_TOKEN (validated in config.ts). When that is empty the server generates 256 random bits at
// startup, keeps them in this process's memory only, and prints them once to the console while setup is still needed.
// Failed attempts are limited in memory (a restart is an operator action and resets the window). Everything here is
// synchronous between the limit check and the comparison, so a burst of concurrent requests cannot exceed the limit.
import { randomBytes } from 'node:crypto';
import type { AppConfig } from './config.ts';
import { AppError } from './errors.ts';
import { log } from './log.ts';
import { safeEqual } from './tokens.ts';

export const SETUP_WINDOW_SECONDS = 15 * 60;
export const MAX_SETUP_FAILURES = 10;
export const MAX_SETUP_FAILURES_PER_ADDRESS = 5;

interface SetupState {
  generated: string | null;
  failures: number[];
  byAddress: Map<string, number[]>;
}

// globalThis, not a module variable: the startup hook and the route bundles can load separate copies of this module.
const KEY = Symbol.for('tallymed.setupState');
const holder = globalThis as unknown as Record<symbol, SetupState | undefined>;
const state = (): SetupState => (holder[KEY] ??= { generated: null, failures: [], byAddress: new Map() });

type Output = (text: string) => void;
let output: Output = (text) => { process.stdout.write(text); };
/** Redirects the console banner (tests). Returns the previous writer. */
export function setSetupOutput(next: Output): Output {
  const previous = output;
  output = next;
  return previous;
}

/** Test helper: forgets the generated token and every recorded failure. */
export function resetSetupState(): void {
  holder[KEY] = undefined;
}

export type SetupTokenSource = 'env' | 'generated';

function banner(origin: string, token: string | null): string {
  const bar = '='.repeat(72);
  return [
    '', bar,
    'TallyMed setup is required: no administrator exists yet.',
    `Open ${origin}/setup and enter this one-time setup token:`,
    '',
    ...(token === null
      ? ['    the value of TALLYMED_SETUP_TOKEN from your configuration']
      : [`    ${token}`, '', 'The token exists only in this process\'s memory. It stops working when the first administrator is created, and it is not',
        'printed again. If you restart before finishing, a new token is generated and printed.']),
    bar, '',
  ].join('\n');
}

/**
 * Returns the token that currently opens setup, generating (and printing) one if none is configured. Call it only while
 * setup is still needed, so a completed installation never produces a token.
 */
export function ensureSetupToken(config: Pick<AppConfig, 'setupToken' | 'canonicalOrigin'>): { token: string; source: SetupTokenSource } {
  if (config.setupToken) return { token: config.setupToken, source: 'env' };
  const s = state();
  if (!s.generated) {
    s.generated = randomBytes(32).toString('base64url');
    output(banner(config.canonicalOrigin, s.generated));
    log('info', 'setup.token_generated', { note: 'printed to the console once; held in memory only' });
  }
  return { token: s.generated, source: 'generated' };
}

/** Prints the startup notice while setup is needed. For a configured token the banner names the variable, never the value. */
export function announceSetup(config: Pick<AppConfig, 'setupToken' | 'canonicalOrigin'>): void {
  if (config.setupToken) {
    output(banner(config.canonicalOrigin, null));
    log('info', 'setup.required', { tokenSource: 'env' });
  } else {
    ensureSetupToken(config);
  }
}

/** Called once the first administrator exists: drops the generated token and the failure history from memory. */
export function closeSetup(): void {
  const s = state();
  s.generated = null;
  s.failures = [];
  s.byAddress.clear();
}

const pruned = (list: number[], now: number) => list.filter((t) => now - t < SETUP_WINDOW_SECONDS * 1000);

/**
 * Compares a presented token in constant time (both sides are hashed first, so length does not leak) and counts the
 * failure. Refuses everything, including the right token, while the failure budget for the window is spent: the budget is
 * global because an attacker can use any address, and per address when a trusted proxy reports one.
 * `ip` is null unless it came through the trusted proxy path.
 */
export function checkSetupToken(config: Pick<AppConfig, 'setupToken' | 'canonicalOrigin'>, presented: string, ip: string | null, now = Date.now()): { source: SetupTokenSource } {
  const s = state();
  s.failures = pruned(s.failures, now);
  const mine = ip ? pruned(s.byAddress.get(ip) ?? [], now) : [];
  if (ip) {
    if (mine.length) s.byAddress.set(ip, mine);
    else s.byAddress.delete(ip);
  }
  if (s.failures.length >= MAX_SETUP_FAILURES || mine.length >= MAX_SETUP_FAILURES_PER_ADDRESS) {
    const oldest = Math.min(...(s.failures.length >= MAX_SETUP_FAILURES ? s.failures : mine));
    const wait = Math.max(1, Math.ceil((oldest + SETUP_WINDOW_SECONDS * 1000 - now) / 1000));
    log('warn', 'setup.locked', { retryAfterSeconds: wait });
    throw new AppError('rate_limited', 'Too many setup attempts', wait);
  }
  const { token, source } = ensureSetupToken(config);
  if (!safeEqual(presented, token)) {
    s.failures.push(now);
    if (ip) s.byAddress.set(ip, [...mine, now]);
    log('info', 'setup.token_rejected', { failuresInWindow: s.failures.length });
    throw new AppError('invalid_setup_token', 'Setup token not accepted');
  }
  return { source };
}
