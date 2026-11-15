// OpenID Connect relying-party protocol code: provider discovery, the authorization request (code flow with PKCE, state and nonce), the
// code exchange and ID token verification. No database access and no sessions here; services/signin.ts decides who may sign in.
//
// Conservative by construction:
//   - Only the authorization code flow. The ID token is read only from the token endpoint response (never from the browser).
//   - Signatures: RS256/384/512, PS256/384/512, ES256/384 with keys from the provider's JWKS. `none` and shared-secret algorithms are refused.
//   - The issuer in the discovery document and in the token must be the configured issuer; the audience must be this client.
//   - Outbound requests go only to https URLs (http only with TALLYMED_OIDC_ALLOW_INSECURE_ISSUER, for a local test provider), never
//     follow redirects, are bounded in time and size, and connect only to an address that passed the same address policy as the SMTP
//     relay (no cloud metadata, unspecified or multicast addresses; loopback only with the insecure switch).
import { createHash, createPublicKey, randomBytes, verify as verifySignature, constants as cryptoConstants, type JsonWebKey } from 'node:crypto';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { classifyAddress } from './ip.ts';

export type OidcFailure =
  | 'target_blocked' | 'unreachable' | 'bad_response' | 'issuer_mismatch' | 'metadata_invalid' | 'jwks_invalid'
  | 'token_rejected' | 'token_invalid' | 'signature_invalid' | 'claims_invalid' | 'nonce_mismatch';

export class OidcError extends Error {
  readonly reason: OidcFailure;
  constructor(reason: OidcFailure, detail?: string) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = 'OidcError';
    this.reason = reason;
  }
}

export interface OidcClientConfig { issuer: string; clientId: string; clientSecret: string | null; scopes: string; allowInsecure: boolean }

export interface ProviderMetadata {
  issuer: string; authorizationEndpoint: string; tokenEndpoint: string; jwksUri: string; tokenAuthMethods: string[];
}

const TIMEOUT_MS = 8000;
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_TOKEN_CHARS = 16 * 1024;
const CACHE_MS = 10 * 60_000;
const JWKS_REFETCH_MS = 60_000;
const CLOCK_SKEW_SECONDS = 60;

// ---------- outbound requests ----------

function addressAllowed(address: string, allowInsecure: boolean): boolean {
  const c = classifyAddress(address);
  return c === 'public' || c === 'private' || (allowInsecure && c === 'loopback');
}

/** Parses and checks a provider URL. Https only unless the insecure switch is on; no credentials or fragment. */
export function providerUrl(value: string, allowInsecure: boolean): URL | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && !(allowInsecure && url.protocol === 'http:')) return null;
  if (url.username || url.password || url.hash || !url.hostname) return null;
  return url;
}

interface HttpResult { status: number; json: unknown }

/** One bounded JSON request. The connection is made only to an address that passed the policy, checked at connect time. */
export function requestJson(
  target: string, allowInsecure: boolean, init: { method: 'GET' | 'POST'; headers?: Record<string, string>; body?: string } = { method: 'GET' },
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const url = providerUrl(target, allowInsecure);
    if (!url) return reject(new OidcError('metadata_invalid', 'url'));
    const bare = url.hostname.replace(/^\[|\]$/g, '');
    if (isIP(bare) && !addressAllowed(bare, allowInsecure)) return reject(new OidcError('target_blocked'));
    const lookup = ((hostname: string, options: dns.LookupOptions, callback: (...args: unknown[]) => void) => {
      dns.lookup(hostname, { ...options, all: true }, (error, found) => {
        if (error) return callback(error);
        const list = found as dns.LookupAddress[];
        // One forbidden answer refuses the host, so a name cannot mix a public and an internal address.
        if (list.length === 0 || list.some((a) => !addressAllowed(a.address, allowInsecure))) {
          return callback(Object.assign(new Error('address not allowed'), { code: 'EOIDC_TARGET_BLOCKED' }));
        }
        if (options.all) callback(null, list);
        else callback(null, list[0]!.address, list[0]!.family);
      });
    }) as unknown as http.RequestOptions['lookup'];
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(url, {
      method: init.method, lookup, timeout: TIMEOUT_MS, agent: false,
      headers: { Accept: 'application/json', 'User-Agent': 'tallymed-oidc', ...(init.headers ?? {}), ...(init.body ? { 'Content-Length': String(Buffer.byteLength(init.body)) } : {}) },
    }, (res) => {
      const status = res.statusCode ?? 0;
      // Redirects are never followed: a provider endpoint that moves is a configuration change an administrator must make.
      if (status >= 300 && status < 400) {
        res.destroy();
        return reject(new OidcError('bad_response', 'redirect'));
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          res.destroy();
          reject(new OidcError('bad_response', 'too large'));
        } else chunks.push(chunk);
      });
      res.on('error', () => reject(new OidcError('unreachable')));
      res.on('end', () => {
        try {
          resolve({ status, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        } catch {
          reject(new OidcError('bad_response', 'not json'));
        }
      });
    });
    const deadline = setTimeout(() => req.destroy(new Error('deadline')), TIMEOUT_MS * 2);
    req.on('close', () => clearTimeout(deadline));
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (error) => reject((error as { code?: string }).code === 'EOIDC_TARGET_BLOCKED' ? new OidcError('target_blocked') : new OidcError('unreachable')));
    if (init.body) req.write(init.body);
    req.end();
  });
}

// ---------- discovery and keys ----------

const trimSlash = (s: string) => s.replace(/\/$/, '');
const metadataCache = new Map<string, { at: number; value: ProviderMetadata }>();
const jwksCache = new Map<string, { at: number; keys: JsonWebKey[] }>();
export const resetOidcCachesForTests = () => { metadataCache.clear(); jwksCache.clear(); };

export async function discover(issuer: string, allowInsecure: boolean, fresh = false): Promise<ProviderMetadata> {
  const cached = metadataCache.get(issuer);
  if (!fresh && cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  const res = await requestJson(`${trimSlash(issuer)}/.well-known/openid-configuration`, allowInsecure);
  if (res.status !== 200 || res.json === null || typeof res.json !== 'object') throw new OidcError('bad_response', `discovery ${res.status}`);
  const m = res.json as Record<string, unknown>;
  // The document must describe the issuer that was asked for; otherwise another issuer's keys could be accepted for this one.
  if (typeof m.issuer !== 'string' || trimSlash(m.issuer) !== trimSlash(issuer)) throw new OidcError('issuer_mismatch');
  const endpoint = (v: unknown) => (typeof v === 'string' && providerUrl(v, allowInsecure) ? v : null);
  const authorizationEndpoint = endpoint(m.authorization_endpoint);
  const tokenEndpoint = endpoint(m.token_endpoint);
  const jwksUri = endpoint(m.jwks_uri);
  if (!authorizationEndpoint || !tokenEndpoint || !jwksUri) throw new OidcError('metadata_invalid', 'endpoints');
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null);
  const responseTypes = list(m.response_types_supported);
  if (responseTypes && !responseTypes.includes('code')) throw new OidcError('metadata_invalid', 'code flow not supported');
  const challenges = list(m.code_challenge_methods_supported);
  if (challenges && !challenges.includes('S256')) throw new OidcError('metadata_invalid', 'S256 not supported');
  const value: ProviderMetadata = {
    issuer: m.issuer, authorizationEndpoint, tokenEndpoint, jwksUri,
    tokenAuthMethods: list(m.token_endpoint_auth_methods_supported) ?? ['client_secret_basic'],
  };
  metadataCache.set(issuer, { at: Date.now(), value });
  return value;
}

async function loadKeys(jwksUri: string, allowInsecure: boolean, force: boolean): Promise<JsonWebKey[]> {
  const cached = jwksCache.get(jwksUri);
  if (cached && (force ? Date.now() - cached.at < JWKS_REFETCH_MS : Date.now() - cached.at < CACHE_MS)) return cached.keys;
  const res = await requestJson(jwksUri, allowInsecure);
  const keys = (res.json as { keys?: unknown } | null)?.keys;
  if (res.status !== 200 || !Array.isArray(keys)) throw new OidcError('jwks_invalid');
  const usable = keys.filter((k): k is JsonWebKey => k !== null && typeof k === 'object').slice(0, 50);
  jwksCache.set(jwksUri, { at: Date.now(), keys: usable });
  return usable;
}

/** Discovery plus a key fetch, for the administrator's "test connection" button. */
export async function probeProvider(issuer: string, allowInsecure: boolean): Promise<{ metadata: ProviderMetadata; signingKeys: number }> {
  const metadata = await discover(issuer, allowInsecure, true);
  const keys = await loadKeys(metadata.jwksUri, allowInsecure, false);
  const signingKeys = keys.filter((k) => (k.use ?? 'sig') === 'sig' && (k.kty === 'RSA' || k.kty === 'EC')).length;
  if (signingKeys === 0) throw new OidcError('jwks_invalid', 'no signing keys');
  return { metadata, signingKeys };
}

// ---------- authorization request ----------

const b64url = (b: Buffer) => b.toString('base64url');

export interface FlowSecrets { state: string; nonce: string; codeVerifier: string }

export function newFlowSecrets(): FlowSecrets {
  return { state: b64url(randomBytes(32)), nonce: b64url(randomBytes(32)), codeVerifier: b64url(randomBytes(32)) };
}

export function authorizationUrl(metadata: ProviderMetadata, client: OidcClientConfig, redirectUri: string, flow: FlowSecrets): string {
  const url = new URL(metadata.authorizationEndpoint);
  const set = (k: string, v: string) => url.searchParams.set(k, v);
  set('response_type', 'code');
  set('client_id', client.clientId);
  set('redirect_uri', redirectUri);
  set('scope', client.scopes);
  set('state', flow.state);
  set('nonce', flow.nonce);
  set('code_challenge', b64url(createHash('sha256').update(flow.codeVerifier).digest()));
  set('code_challenge_method', 'S256');
  return url.href;
}

// ---------- code exchange and ID token ----------

const ALGORITHMS: Record<string, { kty: 'RSA' | 'EC'; hash: string; pss?: boolean; curve?: string }> = {
  RS256: { kty: 'RSA', hash: 'sha256' }, RS384: { kty: 'RSA', hash: 'sha384' }, RS512: { kty: 'RSA', hash: 'sha512' },
  PS256: { kty: 'RSA', hash: 'sha256', pss: true }, PS384: { kty: 'RSA', hash: 'sha384', pss: true }, PS512: { kty: 'RSA', hash: 'sha512', pss: true },
  ES256: { kty: 'EC', hash: 'sha256', curve: 'P-256' }, ES384: { kty: 'EC', hash: 'sha384', curve: 'P-384' },
};

export interface IdClaims {
  issuer: string; subject: string; email: string | null; emailVerified: boolean; name: string | null;
}

function decodePart(part: string): Record<string, unknown> {
  if (!/^[A-Za-z0-9_-]+$/.test(part)) throw new OidcError('token_invalid', 'encoding');
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    throw new OidcError('token_invalid', 'json');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new OidcError('token_invalid', 'shape');
  return value as Record<string, unknown>;
}

function signatureValid(alg: (typeof ALGORITHMS)[string], jwk: JsonWebKey, signed: Buffer, signature: Buffer): boolean {
  try {
    const key = createPublicKey({ key: jwk, format: 'jwk' });
    if (alg.kty === 'RSA') {
      if (key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) return false;
      return verifySignature(alg.hash, signed, alg.pss
        ? { key, padding: cryptoConstants.RSA_PKCS1_PSS_PADDING, saltLength: cryptoConstants.RSA_PSS_SALTLEN_DIGEST }
        : { key, padding: cryptoConstants.RSA_PKCS1_PADDING }, signature);
    }
    if (key.asymmetricKeyType !== 'ec' || jwk.crv !== alg.curve) return false;
    return verifySignature(alg.hash, signed, { key, dsaEncoding: 'ieee-p1363' }, signature);
  } catch {
    return false;
  }
}

/**
 * Verifies an ID token from the token endpoint: signature against the provider's keys, issuer, audience, time window and nonce. Returns
 * only the few claims sign-in uses. `now` is injectable for tests.
 */
export async function verifyIdToken(
  token: unknown, metadata: ProviderMetadata, client: OidcClientConfig, expectedNonce: string, now: () => number = Date.now,
): Promise<IdClaims> {
  if (typeof token !== 'string' || token.length > MAX_TOKEN_CHARS) throw new OidcError('token_invalid', 'missing');
  const parts = token.split('.');
  if (parts.length !== 3) throw new OidcError('token_invalid', 'parts');
  const header = decodePart(parts[0]!);
  const claims = decodePart(parts[1]!);
  const alg = typeof header.alg === 'string' ? ALGORITHMS[header.alg] : undefined;
  if (!alg || !Object.hasOwn(ALGORITHMS, header.alg as string)) throw new OidcError('signature_invalid', 'algorithm');
  if (header.crit !== undefined) throw new OidcError('token_invalid', 'crit');
  const kid = typeof header.kid === 'string' ? header.kid : null;
  const candidates = (keys: JsonWebKey[]) => keys.filter((k) => k.kty === alg.kty && (k.use ?? 'sig') === 'sig'
    && (k.alg === undefined || k.alg === header.alg) && (kid === null || k.kid === kid));
  let keys = candidates(await loadKeys(metadata.jwksUri, client.allowInsecure, false));
  // An unknown key id usually means the provider rotated its keys: fetch them again, at most once a minute.
  if (keys.length === 0) keys = candidates(await loadKeys(metadata.jwksUri, client.allowInsecure, true));
  // Without a key id the token must match the single suitable key; trying several keys would widen what is accepted.
  if (keys.length === 0 || (kid === null && keys.length !== 1)) throw new OidcError('signature_invalid', 'no key');
  const signed = Buffer.from(`${parts[0]}.${parts[1]}`);
  const signature = Buffer.from(parts[2]!, 'base64url');
  if (!keys.some((k) => signatureValid(alg, k, signed, signature))) throw new OidcError('signature_invalid');

  if (claims.iss !== metadata.issuer) throw new OidcError('claims_invalid', 'iss');
  const aud = typeof claims.aud === 'string' ? [claims.aud] : Array.isArray(claims.aud) ? claims.aud : [];
  if (!aud.includes(client.clientId)) throw new OidcError('claims_invalid', 'aud');
  // With several audiences, or whenever the provider names an authorized party, that party must be this client.
  if ((aud.length > 1 || claims.azp !== undefined) && claims.azp !== client.clientId) throw new OidcError('claims_invalid', 'azp');
  const seconds = Math.floor(now() / 1000);
  if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_SECONDS <= seconds) throw new OidcError('claims_invalid', 'exp');
  if (typeof claims.iat !== 'number' || claims.iat - CLOCK_SKEW_SECONDS > seconds || seconds - claims.iat > 3600) throw new OidcError('claims_invalid', 'iat');
  if (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || claims.nbf - CLOCK_SKEW_SECONDS > seconds)) throw new OidcError('claims_invalid', 'nbf');
  if (typeof claims.nonce !== 'string' || claims.nonce !== expectedNonce) throw new OidcError('nonce_mismatch');
  if (typeof claims.sub !== 'string' || claims.sub.length < 1 || claims.sub.length > 255) throw new OidcError('claims_invalid', 'sub');
  const email = typeof claims.email === 'string' && claims.email.length <= 254 ? claims.email.trim() : null;
  // Only a literal `true` counts. Microsoft Entra ID does not send email_verified; its optional `xms_edov` claim states that the
  // domain of the address is verified by the tenant, and is honoured only for Microsoft's own issuer.
  const microsoft = /^https:\/\/login\.microsoftonline\.com\//.test(metadata.issuer);
  const emailVerified = email !== null && (claims.email_verified === true || (microsoft && claims.xms_edov === true));
  const name = typeof claims.name === 'string' ? claims.name : null;
  return { issuer: metadata.issuer, subject: claims.sub, email, emailVerified, name };
}

/** Exchanges the authorization code. The client authenticates with its secret (when it has one) and always sends the PKCE verifier. */
export async function exchangeCode(
  metadata: ProviderMetadata, client: OidcClientConfig, redirectUri: string, code: string, codeVerifier: string,
): Promise<{ idToken: unknown }> {
  const form = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: codeVerifier });
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (client.clientSecret === null) form.set('client_id', client.clientId);
  else if (metadata.tokenAuthMethods.includes('client_secret_basic')) {
    const enc = (s: string) => encodeURIComponent(s).replace(/%20/g, '+');
    headers.Authorization = `Basic ${Buffer.from(`${enc(client.clientId)}:${enc(client.clientSecret)}`).toString('base64')}`;
  } else {
    form.set('client_id', client.clientId);
    form.set('client_secret', client.clientSecret);
  }
  const res = await requestJson(metadata.tokenEndpoint, client.allowInsecure, { method: 'POST', headers, body: form.toString() });
  if (res.status !== 200 || res.json === null || typeof res.json !== 'object') throw new OidcError('token_rejected', String(res.status));
  return { idToken: (res.json as Record<string, unknown>).id_token };
}
