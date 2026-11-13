import { loadConfig } from './config.ts';
import { createPool } from './db.ts';
import type { AppContext } from './http.ts';
import { FileObjectStore } from './storage.ts';

let ctx: AppContext | null = null;

/** Lazily builds the process-wide config and pool. Throws on invalid configuration. */
export function appContext(): AppContext {
  if (!ctx) {
    const config = loadConfig();
    ctx = { config, pool: createPool(config.databaseUrl), store: config.documentsDir ? new FileObjectStore(config.documentsDir) : null };
  }
  return ctx;
}
