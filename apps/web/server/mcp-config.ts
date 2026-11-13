// Configuration of the optional MCP listener. Disabled unless explicitly enabled, and a non-loopback bind additionally needs TLS,
// an application-level network allowlist and an explicit list of accepted Host names. See docs/mcp.md.
import { BlockList, isIP } from 'node:net';
import { parseDocumentsDir } from './config.ts';

export interface McpConfig {
  enabled: boolean;
  databaseUrl: string;
  bind: string;
  port: number;
  loopback: boolean;
  tlsCertFile: string | null;
  tlsKeyFile: string | null;
  /** Peer addresses allowed to connect, as CIDR blocks or single addresses. Always applied; loopback binds also admit loopback peers. */
  allowedCidrs: string[];
  /** Accepted `Host` header values (lower case, with port). Protects against DNS rebinding. */
  allowedHosts: string[];
  /** Accepted `Origin` header values. A native MCP client sends none; the default list is empty and any other origin is refused. */
  allowedOrigins: string[];
  documentsDir: string | null;
  contentMaxBytes: number;
  /** Failed credential checks one peer address may make per minute before it is refused outright. */
  failedAuthPerMinute: number;
  /** Authenticated tool calls one client may make per minute. */
  callsPerMinute: number;
  /** Open proposals one client may have at once. */
  pendingPerClient: number;
  /** Open proposals one household may have at once, across clients. */
  pendingPerHousehold: number;
}

const truthy = (v: string | undefined) => v === 'true';
const list = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

function intEnv(env: Record<string, string | undefined>, key: string, fallback: number, min: number, max: number) {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${key} must be an integer from ${min} to ${max}`);
  return value;
}

/** Strips the brackets of an IPv6 literal and unwraps an IPv4-mapped address, so one address has one spelling. */
export function normalizeAddress(address: string): string {
  const a = address.replace(/^\[|\]$/g, '').toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a);
  return mapped ? mapped[1]! : a;
}

export function isLoopbackAddress(address: string): boolean {
  const a = normalizeAddress(address);
  return a === '::1' || (isIP(a) === 4 && a.startsWith('127.'));
}

const PRIVATE = (() => {
  const b = new BlockList();
  for (const [net, bits] of [['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['169.254.0.0', 16], ['127.0.0.0', 8]] as const) b.addSubnet(net, bits, 'ipv4');
  for (const [net, bits] of [['fc00::', 7], ['fe80::', 10], ['::1', 128]] as const) b.addSubnet(net, bits, 'ipv6');
  return b;
})();

/** Loopback, RFC 1918, link-local or unique-local only. A wildcard or public address is refused: MCP never listens publicly. */
export function isPrivateAddress(address: string): boolean {
  const a = normalizeAddress(address);
  const family = isIP(a);
  if (family === 0) return false;
  return PRIVATE.check(a, family === 4 ? 'ipv4' : 'ipv6');
}

export function parseAllowlist(entries: string[]): BlockList {
  const block = new BlockList();
  for (const entry of entries) {
    const [addr, bits, extra] = entry.split('/');
    const a = normalizeAddress(addr ?? '');
    const family = isIP(a);
    const max = family === 4 ? 32 : 128;
    if (extra !== undefined || family === 0 || (bits !== undefined && !(/^\d{1,3}$/.test(bits) && Number(bits) <= max))) {
      throw new Error('TALLYMED_MCP_ALLOWED_CIDRS entries must be an IP address or CIDR block');
    }
    if (bits === '0') throw new Error('TALLYMED_MCP_ALLOWED_CIDRS must not allow every address');
    if (family === 4) block.addSubnet(a, bits === undefined ? 32 : Number(bits), 'ipv4');
    else block.addSubnet(a, bits === undefined ? 128 : Number(bits), 'ipv6');
  }
  return block;
}

export function peerAllowed(peer: string | undefined, config: Pick<McpConfig, 'allowedCidrs' | 'loopback'>, block = parseAllowlist(config.allowedCidrs)): boolean {
  if (!peer) return false;
  const a = normalizeAddress(peer);
  const family = isIP(a);
  if (family === 0) return false;
  if (isLoopbackAddress(a)) return true;
  // A loopback listener has no remote peers; anything else must be on the allowlist.
  return !config.loopback && block.check(a, family === 4 ? 'ipv4' : 'ipv6');
}

const HOST_PATTERN = /^(?:[a-z0-9]|[a-z0-9][a-z0-9.-]*[a-z0-9]|\[[0-9a-f:]+\])(?::\d{1,5})$/;

export function loadMcpConfig(env: Record<string, string | undefined> = process.env): McpConfig {
  const enabled = truthy(env.TALLYMED_MCP_ENABLED);
  const databaseUrl = env.TALLYMED_MCP_DATABASE_URL ?? '';
  const bind = normalizeAddress(env.TALLYMED_MCP_BIND || '127.0.0.1');
  const port = intEnv(env, 'TALLYMED_MCP_PORT', 8765, 1024, 65535);
  const base = {
    databaseUrl, bind, port,
    failedAuthPerMinute: intEnv(env, 'TALLYMED_MCP_FAILED_AUTH_PER_MINUTE', 20, 1, 1000),
    callsPerMinute: intEnv(env, 'TALLYMED_MCP_CALLS_PER_MINUTE', 120, 1, 6000),
    pendingPerClient: intEnv(env, 'TALLYMED_MCP_PENDING_PER_CLIENT', 50, 1, 1000),
    pendingPerHousehold: intEnv(env, 'TALLYMED_MCP_PENDING_PER_HOUSEHOLD', 200, 1, 5000),
    contentMaxBytes: intEnv(env, 'TALLYMED_MCP_CONTENT_MAX_KB', 2048, 1, 8192) * 1024,
    documentsDir: parseDocumentsDir(env.TALLYMED_DOCUMENTS_DIR),
  };
  if (!enabled) {
    return { ...base, enabled: false, loopback: true, tlsCertFile: null, tlsKeyFile: null, allowedCidrs: [], allowedHosts: [], allowedOrigins: [] };
  }
  if (!databaseUrl) throw new Error('TALLYMED_MCP_DATABASE_URL is required (a restricted role: run the setup-role command)');
  // A container cannot know its own private address in advance, so a wildcard bind inside one is allowed only when the operator
  // says so. Every other non-loopback requirement still applies, and the container's published port must be bound to a private
  // host interface (see docs/mcp.md).
  const wildcard = (bind === '0.0.0.0' || bind === '::') && env.TALLYMED_MCP_CONTAINER === 'true';
  if (!wildcard && (isIP(bind) === 0 || !isPrivateAddress(bind))) {
    throw new Error('TALLYMED_MCP_BIND must be a loopback or private-network interface address (not a wildcard, hostname or public address)');
  }
  const loopback = !wildcard && isLoopbackAddress(bind);
  const tlsCertFile = env.TALLYMED_MCP_TLS_CERT_FILE || null;
  const tlsKeyFile = env.TALLYMED_MCP_TLS_KEY_FILE || null;
  if ((tlsCertFile === null) !== (tlsKeyFile === null)) throw new Error('Set both TALLYMED_MCP_TLS_CERT_FILE and TALLYMED_MCP_TLS_KEY_FILE, or neither');
  const allowedCidrs = list(env.TALLYMED_MCP_ALLOWED_CIDRS);
  parseAllowlist(allowedCidrs);
  let allowedHosts = list(env.TALLYMED_MCP_ALLOWED_HOSTS).map((h) => h.toLowerCase());
  if (allowedHosts.some((h) => !HOST_PATTERN.test(h))) throw new Error('TALLYMED_MCP_ALLOWED_HOSTS entries must be host:port values');
  if (!loopback) {
    if (tlsCertFile === null) throw new Error('A non-loopback MCP bind requires TLS (TALLYMED_MCP_TLS_CERT_FILE and TALLYMED_MCP_TLS_KEY_FILE)');
    if (allowedCidrs.length === 0) throw new Error('A non-loopback MCP bind requires TALLYMED_MCP_ALLOWED_CIDRS (the clients that may connect)');
    if (allowedHosts.length === 0) throw new Error('A non-loopback MCP bind requires TALLYMED_MCP_ALLOWED_HOSTS (the names and port clients use)');
  } else if (allowedHosts.length === 0) {
    allowedHosts = [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`];
  }
  const allowedOrigins = list(env.TALLYMED_MCP_ALLOWED_ORIGINS).map((o) => {
    try {
      const url = new URL(o);
      if (!['https:', 'http:'].includes(url.protocol) || url.origin !== o) throw new Error('bad');
      return url.origin;
    } catch {
      throw new Error('TALLYMED_MCP_ALLOWED_ORIGINS entries must be origins such as https://assistant.example');
    }
  });
  return { ...base, enabled: true, loopback, tlsCertFile, tlsKeyFile, allowedCidrs, allowedHosts, allowedOrigins };
}
