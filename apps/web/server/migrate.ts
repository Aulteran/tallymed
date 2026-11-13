import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from './db.ts';

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../db/migrations');
const LOCK_ID = 7_203_401;

export interface MigrationFile { version: string; name: string; sql: string; checksum: string }

export function listMigrations(dir = MIGRATIONS_DIR): MigrationFile[] {
  return readdirSync(dir)
    .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))
    .sort()
    .map((file) => {
      const sql = readFileSync(path.join(dir, file), 'utf8');
      return {
        version: file.slice(0, 4),
        name: file.slice(5, -4),
        sql,
        checksum: createHash('sha256').update(sql).digest('hex'),
      };
    });
}

/**
 * Applies pending migrations in order, each in its own transaction, under an advisory lock.
 * Already-applied files must match their recorded checksum so history cannot be edited silently.
 * `upTo` stops after a version, which lets tests build a prior schema and then upgrade it.
 */
export async function migrate(pool: Pool, options: { upTo?: string; dir?: string } = {}): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('select pg_advisory_lock($1)', [LOCK_ID]);
    await client.query(`create table if not exists schema_migrations (
      version text primary key, name text not null, checksum text not null,
      applied_at timestamptz not null default now())`);
    const done = new Map<string, string>(
      (await client.query<{ version: string; checksum: string }>('select version, checksum from schema_migrations'))
        .rows.map((r) => [r.version, r.checksum]),
    );
    for (const m of listMigrations(options.dir)) {
      if (options.upTo !== undefined && m.version > options.upTo) break;
      const recorded = done.get(m.version);
      if (recorded !== undefined) {
        if (recorded !== m.checksum) throw new Error(`Migration ${m.version}_${m.name} changed after it was applied`);
        continue;
      }
      try {
        await client.query('begin');
        await client.query(m.sql);
        await client.query('insert into schema_migrations (version, name, checksum) values ($1, $2, $3)', [
          m.version, m.name, m.checksum,
        ]);
        await client.query('commit');
      } catch (error) {
        await client.query('rollback');
        throw error;
      }
      applied.push(m.version);
    }
    return applied;
  } finally {
    try {
      await client.query('select pg_advisory_unlock($1)', [LOCK_ID]);
    } finally {
      client.release();
    }
  }
}
