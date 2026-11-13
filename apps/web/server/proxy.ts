import { isIP } from 'node:net';
import type { AppConfig } from './config.ts';
import { AppError } from './errors.ts';
import { safeEqual } from './tokens.ts';

export const PROXY_SECRET_HEADER = 'x-tallymed-proxy-secret';

export interface ClientInfo {
  /** True only when the request carried the operator proxy's shared secret. */
  trustedProxy: boolean;
  /** Client address as reported by the trusted proxy, otherwise null. */
  ip: string | null;
}

/**
 * Forwarded headers (X-Forwarded-For / -Proto) are honoured only when the request presents the
 * configured proxy secret. The operator's proxy must strip client-supplied copies of both the
 * secret header and the forwarded headers, then set them. Without a configured secret every
 * forwarded header is ignored. The canonical origin never depends on Host or X-Forwarded-Host.
 */
export function clientInfo(headers: Headers, config: AppConfig): ClientInfo {
  const presented = headers.get(PROXY_SECRET_HEADER);
  if (!config.proxySecret || !presented || !safeEqual(presented, config.proxySecret)) {
    return { trustedProxy: false, ip: null };
  }
  const forwarded = headers.get('x-forwarded-for');
  // The proxy appends the address it observed, so the right-most entry is the only one it vouches for.
  const last = forwarded?.split(',').map((s) => s.trim()).filter(Boolean).at(-1) ?? null;
  return { trustedProxy: true, ip: last && isIP(last) ? last : null };
}

/** For an https canonical origin, a trusted proxy that reports plain http is a misconfiguration. */
export function assertTransport(headers: Headers, config: AppConfig, client: ClientInfo): void {
  if (!config.secureCookies || !client.trustedProxy) return;
  const proto = headers.get('x-forwarded-proto')?.split(',').at(-1)?.trim().toLowerCase();
  if (proto && proto !== 'https') throw new AppError('forbidden', 'HTTPS is required');
}
