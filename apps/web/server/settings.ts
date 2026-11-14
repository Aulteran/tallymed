// Administrator-editable server settings. Environment variables stay the bootstrap and security-critical layer (database, canonical origin,
// proxy secret, secrets key, setup token, document volume path, MCP listener); a small set of operational values can be overridden here.
// Precedence for an editable value: stored setting, then environment variable, then built-in default. A missing or blank stored field means
// "use the environment value", so clearing a field restores it. Stored groups are applied to the process-wide config object in place and
// re-read at most every few seconds, so a change reaches every process shortly after it is saved.
import type { AppConfig } from './config.ts';
import { sourceUrl } from './config.ts';
import type { Queryable } from './db.ts';
import { log, logError } from './log.ts';

export type GroupKey = 'general' | 'documents' | 'email' | 'proxy';
export type SmtpSecurity = 'tls' | 'starttls' | 'none';

/** Allowed submission ports. A fixed list narrows what the SMTP test and mail helper can be pointed at. */
export const SMTP_PORTS = [25, 465, 587, 1025, 2465, 2525] as const;

export interface GeneralValue {
  sourceUrl?: string | null;
  sessionAbsoluteSeconds?: number | null;
  sessionIdleSeconds?: number | null;
  invitationSeconds?: number | null;
}
export interface DocumentsValue {
  documentMaxMb?: number | null;
  documentQuotaMb?: number | null;
  documentRetentionDays?: number | null;
}
export interface EmailValue {
  host?: string | null;
  port?: number | null;
  security?: SmtpSecurity | null;
  username?: string | null;
  fromAddress?: string | null;
  fromName?: string | null;
  /** Allow loopback and link-local relay addresses. Cloud metadata and unspecified addresses stay blocked either way. */
  allowRestrictedTargets?: boolean | null;
}
export interface ProxyValue { trustedProxies?: string[] | null }
export type GroupValue = { general: GeneralValue; documents: DocumentsValue; email: EmailValue; proxy: ProxyValue };

export interface StoredGroup<K extends GroupKey = GroupKey> {
  value: GroupValue[K];
  /** Encrypted secret, present only for the email group. Never leaves the server. */
  secretCiphertext: string | null;
  version: number;
  updatedAt: Date | null;
}

const COLUMNS = `value, secret_ciphertext as "secretCiphertext", version, updated_at as "updatedAt"`;

export async function readGroup<K extends GroupKey>(db: Queryable, key: K, lock = false): Promise<StoredGroup<K>> {
  const r = await db.query<StoredGroup<K>>(`select ${COLUMNS} from server_settings where group_key = $1${lock ? ' for update' : ''}`, [key]);
  return r.rows[0] ?? { value: {} as GroupValue[K], secretCiphertext: null, version: 0, updatedAt: null };
}

/** Insert or optimistic update. The caller holds the settings lock and has checked the version. */
export async function writeGroup(
  db: Queryable, key: GroupKey, value: object, secretCiphertext: string | null, expectedVersion: number, userId: string,
): Promise<void> {
  if (expectedVersion === 0) {
    await db.query(
      `insert into server_settings (group_key, value, secret_ciphertext, updated_by) values ($1, $2, $3, $4)`,
      [key, JSON.stringify(value), secretCiphertext, userId],
    );
    return;
  }
  const r = await db.query(
    `update server_settings set value = $2, secret_ciphertext = $3, version = version + 1, updated_by = $4, updated_at = now()
     where group_key = $1 and version = $5`,
    [key, JSON.stringify(value), secretCiphertext, userId, expectedVersion],
  );
  if (r.rowCount !== 1) throw new Error('settings version changed under the lock');
}

// ---------- applying stored values to the running config ----------

type Defaults = Pick<AppConfig, 'sourceUrl' | 'sessionAbsoluteSeconds' | 'sessionIdleSeconds' | 'invitationSeconds' | 'documentMaxBytes' | 'documentQuotaBytes' | 'documentRetentionDays' | 'trustedProxies'>;
const MB = 1024 * 1024;
const REFRESH_MS = 5000;

const states = new WeakMap<AppConfig, { defaults: Defaults; loadedAt: number; inFlight: Promise<void> | null }>();

function snapshotDefaults(c: AppConfig): Defaults {
  return {
    sourceUrl: c.sourceUrl, sessionAbsoluteSeconds: c.sessionAbsoluteSeconds, sessionIdleSeconds: c.sessionIdleSeconds,
    invitationSeconds: c.invitationSeconds, documentMaxBytes: c.documentMaxBytes, documentQuotaBytes: c.documentQuotaBytes,
    documentRetentionDays: c.documentRetentionDays, trustedProxies: c.trustedProxies,
  };
}

/** The values the environment (or built-in defaults) give, before any stored override. Captured the first time the config is touched. */
export function environmentDefaults(config: AppConfig): Defaults {
  let s = states.get(config);
  if (!s) {
    s = { defaults: snapshotDefaults(config), loadedAt: 0, inFlight: null };
    states.set(config, s);
  }
  return s.defaults;
}

export function applyStored(config: AppConfig, general: GeneralValue, documents: DocumentsValue, proxy: ProxyValue = {}): void {
  const d = environmentDefaults(config);
  config.sourceUrl = general.sourceUrl ? sourceUrl(general.sourceUrl) ?? d.sourceUrl : d.sourceUrl;
  config.sessionAbsoluteSeconds = general.sessionAbsoluteSeconds ?? d.sessionAbsoluteSeconds;
  config.sessionIdleSeconds = general.sessionIdleSeconds ?? d.sessionIdleSeconds;
  config.invitationSeconds = general.invitationSeconds ?? d.invitationSeconds;
  config.documentMaxBytes = documents.documentMaxMb ? documents.documentMaxMb * MB : d.documentMaxBytes;
  config.documentQuotaBytes = documents.documentQuotaMb ? documents.documentQuotaMb * MB : d.documentQuotaBytes;
  config.documentRetentionDays = documents.documentRetentionDays ?? d.documentRetentionDays;
  // A stored list (even an empty one) replaces the environment list; no stored value means the environment list applies.
  config.trustedProxies = Array.isArray(proxy.trustedProxies) ? proxy.trustedProxies : d.trustedProxies;
}

/**
 * Brings the config up to date with the stored settings, at most once every few seconds per process. A read failure keeps the values in
 * force (and is logged by code only), so a database blip or a database that has not been migrated yet never takes the app down.
 */
export async function refreshRuntimeConfig(config: AppConfig, db: Queryable, force = false): Promise<void> {
  environmentDefaults(config);
  const s = states.get(config)!;
  if (!force && Date.now() - s.loadedAt < REFRESH_MS) return s.inFlight ?? undefined;
  if (s.inFlight) return s.inFlight;
  s.inFlight = (async () => {
    try {
      const r = await db.query<{ group_key: GroupKey; value: GeneralValue & DocumentsValue & ProxyValue }>(
        `select group_key, value from server_settings where group_key in ('general', 'documents', 'proxy')`);
      const by = new Map(r.rows.map((row) => [row.group_key, row.value]));
      applyStored(config, by.get('general') ?? {}, by.get('documents') ?? {}, by.get('proxy') ?? {});
    } catch (error) {
      if ((error as { code?: string })?.code !== '42P01') logError('settings.refresh_failed', error);
    } finally {
      s.loadedAt = Date.now();
      s.inFlight = null;
    }
  })();
  return s.inFlight;
}

export function logSettingsChange(group: GroupKey, changed: string[]) {
  log('info', 'settings.updated', { group, changed });
}
