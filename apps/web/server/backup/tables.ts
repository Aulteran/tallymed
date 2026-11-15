// What a backup contains, table by table. Every table of the schema must be listed in exactly one of the two lists below; a test fails when a
// migration adds a table that is in neither, so nobody can forget to decide.
//
// Included tables are exported as one JSON object per row (PostgreSQL's own row_to_json, so every type round-trips exactly through
// json_populate_recordset on restore). The order clause is part of the format: it puts rows that other rows of the same table point to first
// (a restore inserts in this order under the table's own foreign keys) and it makes the export deterministic, which is what lets a restore
// re-export each table and compare it byte for byte with the backup.
import type { Queryable } from '../db.ts';

export interface TableSpec {
  name: string;
  /** Deterministic order. Self-referencing tables list the referenced rows first. */
  orderBy: string;
  /** Rows to leave out (server settings that belong to the old server's environment). */
  where?: string;
  /** Columns exported as a fixed expression instead of the stored value, so a secret never enters the archive. */
  replace?: Record<string, string>;
}

/** In foreign-key order: a table comes after every table it references. */
export const BACKUP_TABLES: readonly TableSpec[] = [
  { name: 'households', orderBy: 'id' },
  { name: 'users', orderBy: 'id' },
  { name: 'bootstrap_state', orderBy: 'singleton' },
  { name: 'family_members', orderBy: 'id' },
  { name: 'providers', orderBy: 'id' },
  { name: 'visits', orderBy: 'id' },
  { name: 'bills', orderBy: 'id' },
  { name: 'bill_adjustments', orderBy: '(reverses_adjustment_id is not null), id' },
  { name: 'payments', orderBy: 'id' },
  { name: 'payment_voids', orderBy: 'payment_id' },
  { name: 'payment_entries', orderBy: `(kind <> 'allocation'), seq` },
  { name: 'payment_plans', orderBy: 'id' },
  { name: 'payment_plan_bills', orderBy: 'plan_id, bill_id' },
  { name: 'plan_revisions', orderBy: 'id' },
  { name: 'plan_installments', orderBy: 'id' },
  { name: 'installment_matches', orderBy: 'seq' },
  { name: 'hsa_eligibility_decisions', orderBy: 'seq' },
  { name: 'hsa_claims', orderBy: 'id' },
  { name: 'hsa_receipts', orderBy: 'id' },
  { name: 'hsa_entries', orderBy: `(case kind when 'reserve' then 0 when 'receipt_reversal' then 2 else 1 end), seq` },
  { name: 'documents', orderBy: 'id' },
  { name: 'document_versions', orderBy: 'id' },
  { name: 'document_attachments', orderBy: 'id' },
  // Kept because proposals reference their client, but the token digest is replaced by a value no token can hash to: an assistant
  // credential never travels in a backup, and the restored instance needs new credentials.
  { name: 'mcp_clients', orderBy: 'id', replace: { token_hash: `sha256(convert_to('tallymed-backup:no-credential:' || id::text, 'UTF8'))` } },
  { name: 'document_match_proposals', orderBy: 'id' },
  { name: 'idempotency_records', orderBy: 'id' },
  // Only the groups that describe the household's preferences. Email and reverse-proxy settings describe the old server's network, and the
  // encrypted SMTP password could not be read without the old server's key anyway; they are entered again on the new server.
  { name: 'server_settings', orderBy: 'group_key collate "C"', where: `group_key in ('general', 'documents')`, replace: { secret_ciphertext: 'null::text' } },
  { name: 'audit_events', orderBy: 'id' },
];

/** Never in a backup, with the reason shown to the administrator. */
export const EXCLUDED_TABLES: Readonly<Record<string, string>> = {
  sessions: 'Sign-in sessions. Everyone signs in again on the restored server.',
  invitations: 'Open invitation links. Invite people again if needed.',
  password_resets: 'Temporary passwords. An account that was waiting to choose a new password needs a new reset from an administrator.',
  password_reset_requests: 'Forgot-password request counters.',
  login_attempts: 'Sign-in throttle counters.',
  schema_migrations: 'Recorded in the backup manifest instead, and recreated by the migration command.',
};

export const quoteIdent = (name: string) => {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) throw new Error('unexpected identifier');
  return `"${name}"`;
};

/** Stored (non-generated) columns of a table in definition order. Generated columns are derived again by the database on restore. */
export async function tableColumns(db: Queryable, table: string): Promise<string[]> {
  const r = await db.query<{ attname: string }>(
    `select a.attname from pg_attribute a
      where a.attrelid = to_regclass($1) and a.attnum > 0 and not a.attisdropped and a.attgenerated = ''
      order by a.attnum`,
    [`public.${table}`],
  );
  return r.rows.map((row) => row.attname);
}

/** The query that produces a table's export, one JSON text per row. Used for the backup and again to check a restore. */
export function exportQuery(spec: TableSpec, columns: string[]): string {
  const list = columns.map((c) => (spec.replace?.[c] ? `${spec.replace[c]} as ${quoteIdent(c)}` : quoteIdent(c))).join(', ');
  return `select row_to_json(t)::text as line from (select ${list} from ${quoteIdent(spec.name)}${spec.where ? ` where ${spec.where}` : ''} order by ${spec.orderBy}) t`;
}

/** Session settings that the text form of a row depends on. Applied to the snapshot that exports and to the transaction that restores. */
export async function pinOutputFormat(db: Queryable): Promise<void> {
  await db.query(`set local timezone = 'UTC'`);
  await db.query(`set local bytea_output = 'hex'`);
  await db.query(`set local extra_float_digits = 1`);
}

/** Identity columns whose sequences must continue after the highest restored value. */
export async function identityColumns(db: Queryable, table: string): Promise<string[]> {
  const r = await db.query<{ attname: string }>(
    `select a.attname from pg_attribute a where a.attrelid = to_regclass($1) and a.attnum > 0 and not a.attisdropped and a.attidentity <> ''`,
    [`public.${table}`],
  );
  return r.rows.map((row) => row.attname);
}
