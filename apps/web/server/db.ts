import pg from 'pg';
import { logError } from './log.ts';

export type Pool = pg.Pool;
export type Queryable = Pick<pg.Pool, 'query'>;

export function createPool(databaseUrl: string, max = 10): Pool {
  const pool = new pg.Pool({ connectionString: databaseUrl, max, idleTimeoutMillis: 30_000 });
  // An idle client can be dropped by a database restart or a network fault. Without a listener that event is unhandled and
  // kills the process; log it by code only (driver messages can echo connection details) and let the pool replace the client.
  pool.on('error', (error) => logError('db.pool.idle_client_error', error));
  return pool;
}

/** Runs fn inside one transaction. Money and audit writes in later milestones use this boundary. */
export async function withTransaction<T>(pool: Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (error) {
    try {
      await client.query('rollback');
    } catch {
      // Keep the original error.
    }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Runs read-only queries against one consistent snapshot (repeatable read), so a multi-table export or report cannot mix rows
 * from before and after a concurrent write.
 */
export async function withSnapshot<T>(pool: Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin isolation level repeatable read read only');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (error) {
    try {
      await client.query('rollback');
    } catch {
      // Keep the original error.
    }
    throw error;
  } finally {
    client.release();
  }
}

export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const e = error as { code?: string; constraint?: string };
  return e?.code === '23505' && (constraint === undefined || e.constraint === constraint);
}
