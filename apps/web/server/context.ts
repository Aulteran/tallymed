import { loadConfig } from './config.ts';
import { createPool } from './db.ts';
import type { AppContext } from './http.ts';
import { FileObjectStore } from './storage.ts';

// Cached on globalThis because the startup hook (instrumentation) and the route bundles can load separate copies of this module.
const KEY = Symbol.for('tallymed.appContext');
const holder = globalThis as unknown as Record<symbol, AppContext | undefined>;

/** Lazily builds the process-wide config and pool. Throws on invalid configuration. */
export function appContext(): AppContext {
  let ctx = holder[KEY];
  if (!ctx) {
    const config = loadConfig();
    ctx = { config, pool: createPool(config.databaseUrl), store: config.documentsDir ? new FileObjectStore(config.documentsDir) : null };
    holder[KEY] = ctx;
  }
  return ctx;
}
