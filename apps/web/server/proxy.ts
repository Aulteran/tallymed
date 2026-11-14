import { isIP } from 'node:net';
import type { AppConfig } from './config.ts';
import { AppError } from './errors.ts';
import { IpMatcher, normalizeIp, parseTrustedList } from './ip.ts';
import { readPeer } from './peer.ts';
import { safeEqual } from './tokens.ts';

export const PROXY_SECRET_HEADER = 'x-tallymed-proxy-secret';

export interface ClientInfo {
  /** True only when the request came from a trusted address or carried the operator proxy's shared secret. */
  trustedProxy: boolean;
  /** How the proxy was recognised. */
  trustedBy: 'address' | 'secret' | null;
  /** Client address as reported by the trusted proxy, otherwise null. Only this value is ever used for throttling keys. */
  ip: string | null;
  /** The TCP peer address of this request (the nearest hop), when the server could determine it. */
  peer: string | null;
}

const matchers = new Map<string, IpMatcher>();
/** Compiled matcher for a trusted list. Cached by content; invalid entries are skipped (they cannot be saved, only come from a bad edit). */
export function trustedMatcher(entries: string[]): IpMatcher {
  const key = entries.join(',');
  let m = matchers.get(key);
  if (!m) {
    m = new IpMatcher(parseTrustedList(entries).ok);
    if (matchers.size > 50) matchers.clear();
    matchers.set(key, m);
  }
  return m;
}

/**
 * Forwarded headers (X-Forwarded-For / -Proto) are honoured only for a request that arrived from a trusted proxy: either its TCP peer
 * address is in the trusted list (Settings > Reverse proxy, or TALLYMED_TRUSTED_PROXIES), or it presents the configured shared secret
 * (TALLYMED_PROXY_SECRET). With neither configured every forwarded header is ignored (trust nothing). The client is the right-most
 * X-Forwarded-For entry that is not itself a trusted proxy, so a chain of trusted proxies works and a client-supplied left part never
 * counts. The operator's proxy must replace (not append to) any client-supplied forwarded headers it receives. The canonical origin never
 * depends on Host or X-Forwarded-Host.
 */
export function clientInfo(headers: Headers, config: AppConfig): ClientInfo {
  const peer = readPeer(headers);
  const trusted = trustedMatcher(config.trustedProxies);
  const presented = headers.get(PROXY_SECRET_HEADER);
  const byAddress = peer !== null && trusted.has(peer);
  const bySecret = !!config.proxySecret && !!presented && safeEqual(presented, config.proxySecret);
  if (!byAddress && !bySecret) return { trustedProxy: false, trustedBy: null, ip: null, peer };
  const entries = (headers.get('x-forwarded-for') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  let client: string | null = null;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (isIP(e) === 0) { client = null; break; } // anything unparseable means the chain cannot be believed
    client = normalizeIp(e);
    if (!trusted.has(e)) break;
  }
  return { trustedProxy: true, trustedBy: byAddress ? 'address' : 'secret', ip: client, peer };
}

/** For an https canonical origin, a trusted proxy that reports plain http is a misconfiguration. */
export function assertTransport(headers: Headers, config: AppConfig, client: ClientInfo): void {
  if (!config.secureCookies || !client.trustedProxy) return;
  const proto = headers.get('x-forwarded-proto')?.split(',').at(-1)?.trim().toLowerCase();
  if (proto && proto !== 'https') throw new AppError('forbidden', 'HTTPS is required');
}
