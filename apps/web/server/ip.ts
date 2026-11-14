// IP address helpers shared by the trusted-proxy check and the SMTP target check. Pure functions, no I/O.
import { BlockList, isIP } from 'node:net';

export type Family = 4 | 6;
export interface Ip { family: Family; text: string; /** 4 numbers for IPv4, 8 hextets for IPv6 */ parts: number[] }

function parseV4(text: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n <= 255) ? parts : null;
}

function parseV6(text: string): number[] | null {
  if (isIP(text) !== 6) return null;
  let s = text.split('%')[0]!.toLowerCase();
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (dotted) {
    const v4 = parseV4(dotted[1]!);
    if (!v4) return null;
    s = s.slice(0, -dotted[1]!.length) + ((v4[0]! << 8) | v4[1]!).toString(16) + ':' + ((v4[2]! << 8) | v4[3]!).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const all = [...head, ...Array<string>(fill).fill('0'), ...tail].map((h) => parseInt(h, 16));
  return all.length === 8 && all.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? all : null;
}

/** Parses an address and unwraps IPv4-mapped IPv6 (::ffff:a.b.c.d) to IPv4. Returns null for anything that is not a bare address. */
export function parseIp(text: string): Ip | null {
  const t = text.trim();
  const v4 = isIP(t) === 4 ? parseV4(t) : null;
  if (v4) return { family: 4, text: v4.join('.'), parts: v4 };
  const v6 = parseV6(t);
  if (!v6) return null;
  if (v6.slice(0, 5).every((n) => n === 0) && v6[5] === 0xffff) {
    const p = [v6[6]! >> 8, v6[6]! & 255, v6[7]! >> 8, v6[7]! & 255];
    return { family: 4, text: p.join('.'), parts: p };
  }
  return { family: 6, text: v6.map((n) => n.toString(16)).join(':'), parts: v6 };
}

export function normalizeIp(text: string | null | undefined): string | null {
  return text ? parseIp(text)?.text ?? null : null;
}

// ---------- trusted proxy list ----------

export const MIN_V4_PREFIX = 8;
export const MIN_V6_PREFIX = 32;

export type ParsedEntry = { entry: string; family: Family; address: string; prefix: number };

/**
 * One list entry: an address or a CIDR range. A range that is nearly everything (IPv4 shorter than /8, IPv6 shorter than /32) is refused,
 * because trusting it is the same as trusting any client that can reach the app.
 */
export function parseTrustedEntry(raw: string): ParsedEntry | { error: string } {
  const entry = raw.trim();
  const [addr, len, ...rest] = entry.split('/');
  const ip = addr ? parseIp(addr) : null;
  if (!ip || rest.length > 0 || addr!.includes('%')) return { error: `"${entry.slice(0, 60)}" is not an IP address or CIDR range` };
  const max = ip.family === 4 ? 32 : 128;
  let prefix = max;
  if (len !== undefined) {
    if (!/^\d{1,3}$/.test(len) || Number(len) > max) return { error: `"${entry.slice(0, 60)}" has an invalid prefix length` };
    prefix = ip.family === 4 && /:/.test(addr!) ? Number(len) - 96 : Number(len);
    if (prefix < 0) return { error: `"${entry.slice(0, 60)}" is too broad` };
  }
  if (prefix < (ip.family === 4 ? MIN_V4_PREFIX : MIN_V6_PREFIX)) return { error: `"${entry.slice(0, 60)}" is too broad to trust; list your proxy's own address or a small range` };
  return { entry, family: ip.family, address: ip.text, prefix };
}

export function parseTrustedList(entries: string[]): { ok: ParsedEntry[]; errors: string[] } {
  const ok: ParsedEntry[] = [];
  const errors: string[] = [];
  for (const e of entries) {
    const r = parseTrustedEntry(e);
    if ('error' in r) errors.push(r.error); else ok.push(r);
  }
  return { ok, errors };
}

export class IpMatcher {
  private readonly list = new BlockList();
  readonly size: number;
  constructor(entries: ParsedEntry[]) {
    for (const e of entries) {
      if (e.prefix === (e.family === 4 ? 32 : 128)) this.list.addAddress(e.address, e.family === 4 ? 'ipv4' : 'ipv6');
      else this.list.addSubnet(e.address, e.prefix, e.family === 4 ? 'ipv4' : 'ipv6');
    }
    this.size = entries.length;
  }
  has(ip: string | null | undefined): boolean {
    const p = ip ? parseIp(ip) : null;
    return !!p && this.size > 0 && this.list.check(p.text, p.family === 4 ? 'ipv4' : 'ipv6');
  }
}

// ---------- address classes (SMTP target policy) ----------

export type AddressClass = 'public' | 'private' | 'loopback' | 'link_local' | 'metadata' | 'unspecified' | 'multicast';

const V4_METADATA = ['100.100.100.200', '192.0.0.192', '168.63.129.16'];

/** Classifies a resolved address. Cloud metadata endpoints are named explicitly; everything link-local is covered separately. */
export function classifyAddress(text: string): AddressClass {
  let ip = parseIp(text);
  if (!ip) return 'unspecified';
  // Embedded IPv4 in NAT64 (64:ff9b::/96) and 6to4 (2002::/16) addresses is judged as that IPv4 address.
  if (ip.family === 6) {
    const p = ip.parts;
    if (p[0] === 0x64 && p[1] === 0xff9b && p.slice(2, 6).every((n) => n === 0)) ip = parseIp(`${p[6]! >> 8}.${p[6]! & 255}.${p[7]! >> 8}.${p[7]! & 255}`)!;
    else if (p[0] === 0x2002) ip = parseIp(`${p[1]! >> 8}.${p[1]! & 255}.${p[2]! >> 8}.${p[2]! & 255}`)!;
  }
  if (ip.family === 4) {
    const [a, b] = ip.parts as [number, number];
    if (V4_METADATA.includes(ip.text)) return 'metadata';
    if (a === 0) return 'unspecified';
    if (a === 127) return 'loopback';
    if (a === 169 && b === 254) return ip.text === '169.254.169.254' ? 'metadata' : 'link_local';
    if (a >= 224) return 'multicast'; // multicast, reserved and broadcast
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return 'private';
    return 'public';
  }
  const p = ip.parts;
  if (p.every((n) => n === 0)) return 'unspecified';
  if (p.slice(0, 7).every((n) => n === 0) && p[7] === 1) return 'loopback';
  if ((p[0]! & 0xffc0) === 0xfe80) return 'link_local';
  if ((p[0]! & 0xff00) === 0xff00) return 'multicast';
  if (p[0] === 0xfd00 && p[1] === 0x0ec2 && p.slice(2, 7).every((n) => n === 0) && p[7] === 0x254) return 'metadata';
  if ((p[0]! & 0xfe00) === 0xfc00) return 'private';
  return 'public';
}
