// The TCP peer address of a request. Route handlers receive a standard Request, which does not carry the socket, so the server process
// stamps each incoming request with its peer address before Next.js reads it (installPeerStamp, called from instrumentation.ts). The stamp
// is an HMAC under a per-process random key, so a client cannot supply or alter it: a header with a missing or wrong signature is ignored,
// and the stamp always overwrites whatever the client sent. When the stamp is not installed the peer is simply unknown and nothing is
// trusted by address.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { normalizeIp } from './ip.ts';

export const PEER_HEADER = 'x-tallymed-peer';
export const PEER_SIG_HEADER = 'x-tallymed-peer-sig';

const KEY = Symbol.for('tallymed.peerKey');
const INSTALLED = Symbol.for('tallymed.peerStampInstalled');
const holder = globalThis as unknown as Record<symbol, Buffer | boolean | undefined>;

function key(): Buffer {
  let k = holder[KEY] as Buffer | undefined;
  if (!k) {
    k = randomBytes(32);
    holder[KEY] = k;
  }
  return k;
}

const sign = (peer: string) => createHmac('sha256', key()).update(peer).digest('base64url');

/** Sets the stamp on a header map (also used by tests to simulate a connection from `peer`). */
export function stampPeer(headers: Record<string, string | string[] | undefined>, peer: string | undefined) {
  delete headers[PEER_HEADER];
  delete headers[PEER_SIG_HEADER];
  const normalized = normalizeIp(peer);
  if (normalized) {
    headers[PEER_HEADER] = normalized;
    headers[PEER_SIG_HEADER] = sign(normalized);
  }
}

/** The verified peer address, or null when absent or not signed by this process. */
export function readPeer(headers: Headers): string | null {
  const peer = headers.get(PEER_HEADER);
  const sig = headers.get(PEER_SIG_HEADER);
  if (!peer || !sig) return null;
  const expected = Buffer.from(sign(peer));
  const given = Buffer.from(sig);
  return expected.length === given.length && timingSafeEqual(expected, given) ? peer : null;
}

/** Wraps every HTTP server's request dispatch in this process. Idempotent. */
export function installPeerStamp() {
  if (holder[INSTALLED]) return;
  holder[INSTALLED] = true;
  const emit = http.Server.prototype.emit;
  http.Server.prototype.emit = function (this: http.Server, event: string | symbol, ...args: unknown[]) {
    if (event === 'request') {
      const req = args[0] as http.IncomingMessage;
      stampPeer(req.headers, req.socket?.remoteAddress);
    }
    return (emit as (...a: unknown[]) => boolean).call(this, event, ...args);
  } as typeof emit;
}
