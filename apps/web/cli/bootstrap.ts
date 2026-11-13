// One-time local bootstrap: creates the household and first administrator, then closes bootstrap.
// Usage: TALLYMED_BOOTSTRAP_EMAIL=... TALLYMED_BOOTSTRAP_NAME=... TALLYMED_HOUSEHOLD_NAME=... \
//        npm run bootstrap -w @tallymed/web < password-file    (password is read from stdin, never argv)
import { AppError } from '../server/errors.ts';
import { createPool } from '../server/db.ts';
import { bootstrapAdmin } from '../server/services/bootstrap.ts';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(2);
}
let password = '';
for await (const chunk of process.stdin) password += chunk;
password = password.replace(/\r?\n$/, '');

const pool = createPool(url, 2);
try {
  await bootstrapAdmin(pool, {
    householdName: process.env.TALLYMED_HOUSEHOLD_NAME ?? '',
    email: process.env.TALLYMED_BOOTSTRAP_EMAIL ?? '',
    displayName: process.env.TALLYMED_BOOTSTRAP_NAME ?? '',
    password,
  });
  console.log('Administrator created. Bootstrap is now closed.');
} catch (error) {
  console.error(error instanceof AppError ? `Bootstrap failed: ${error.code}` : 'Bootstrap failed');
  process.exitCode = 1;
} finally {
  await pool.end();
}
