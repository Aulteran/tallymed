import { appContext } from './context.ts';
import { log, logError } from './log.ts';
import { isBootstrapped } from './services/bootstrap.ts';
import { announceSetup } from './setup-token.ts';

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms).unref(); });

/**
 * Waits for the database to be reachable and migrated (the stack can start before the migration step), then prints the setup
 * notice if and only if no administrator exists. Never throws and never blocks startup. If the database stays unavailable,
 * the setup page prints the notice on first visit instead.
 */
export async function announceSetupWhenNeeded(attempts = 120, delayMs = 3000): Promise<boolean> {
  let ctx;
  try {
    ctx = appContext();
  } catch (error) {
    // Configuration errors name the variable, never its value.
    log('error', 'setup.config_invalid', { reason: error instanceof Error ? error.message : 'invalid configuration' });
    return false;
  }
  for (let i = 0; i < attempts; i++) {
    try {
      if (await isBootstrapped(ctx.pool)) return false;
      if (ctx.config.setupTokenError) {
        log('error', 'setup.config_invalid', { reason: ctx.config.setupTokenError, note: 'setup is closed until TALLYMED_SETUP_TOKEN is fixed or emptied' });
        return false;
      }
      announceSetup(ctx.config);
      return true;
    } catch (error) {
      if (i === 0) logError('setup.announce_waiting_for_database', error);
    }
    await sleep(delayMs);
  }
  log('warn', 'setup.announce_gave_up', { note: 'database unavailable; the setup page will print the notice on first visit' });
  return false;
}
