import { createPool } from '../server/db.ts';
import { migrate } from '../server/migrate.ts';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(2);
}
const pool = createPool(url, 2);
try {
  const applied = await migrate(pool);
  console.log(applied.length ? `Applied migrations: ${applied.join(', ')}` : 'Database is up to date');
} catch (error) {
  console.error('Migration failed:', (error as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
