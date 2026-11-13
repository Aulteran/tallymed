// Operator commands for the optional MCP listener.
//   node apps/web/cli/mcp.ts [serve]    start the listener (only when TALLYMED_MCP_ENABLED=true; otherwise exits without listening)
//   node apps/web/cli/mcp.ts setup-role create or update the restricted database role `tallymed_mcp` and apply its grants.
//                                       Run it with the owner DATABASE_URL and the new role's password on stdin (at least 24 characters).
//                                       TALLYMED_MCP_ROLE overrides the role name (default tallymed_mcp; migration 0008 grants that name automatically).
// The listener needs TALLYMED_MCP_DATABASE_URL (the restricted role), and TALLYMED_DOCUMENTS_DIR only if the content scope is used.
import { readFileSync } from 'node:fs';
import { createPool } from '../server/db.ts';
import { log } from '../server/log.ts';
import { loadMcpConfig } from '../server/mcp-config.ts';
import { assertRestrictedRole } from '../server/services/mcp.ts';
import { FileObjectStore } from '../server/storage.ts';
import { startListener } from '../mcp/listener.ts';

const command = process.argv[2] ?? 'serve';

if (command === 'setup-role') {
  const url = process.env.DATABASE_URL;
  const password = readFileSync(0, 'utf8').replace(/\r?\n$/, '');
  if (!url || password.length < 24 || password.length > 200 || password.includes('\0')) {
    console.error('Usage: DATABASE_URL=<owner url> node apps/web/cli/mcp.ts setup-role < password-file   (password of 24 to 200 characters on stdin)');
    process.exit(2);
  }
  const pool = createPool(url, 1);
  try {
    const role = process.env.TALLYMED_MCP_ROLE ?? 'tallymed_mcp';
    if (!/^[a-z_][a-z0-9_]{0,40}$/.test(role)) {
      console.error('TALLYMED_MCP_ROLE must be lower-case letters, digits and underscores');
      process.exit(2);
    }
    const exists = (await pool.query(`select 1 from pg_roles where rolname = $1`, [role])).rowCount === 1;
    const verb = `${exists ? 'alter' : 'create'} role ${role}`;
    const { rows } = await pool.query<{ sql: string }>(
      `select format('${verb} login nosuperuser nocreatedb nocreaterole noinherit noreplication password %L', $1::text) as sql`, [password]);
    await pool.query(rows[0]!.sql);
    await pool.query(`select tallymed_apply_mcp_grants($1)`, [role]);
    console.log(`Role ${role} ${exists ? 'updated' : 'created'} with read access to the document-matching tables and insert access to proposals and audit rows only.`);
  } finally {
    await pool.end();
  }
} else if (command === 'serve') {
  let config;
  try {
    config = loadMcpConfig();
  } catch (error) {
    console.error((error as Error).message);
    process.exit(2);
  }
  if (!config.enabled) {
    console.error('The MCP listener is disabled. Set TALLYMED_MCP_ENABLED=true (and see docs/mcp.md) to start it. Nothing is listening.');
    process.exit(0);
  }
  const pool = createPool(config.databaseUrl, 4);
  try {
    await assertRestrictedRole(pool);
  } catch (error) {
    console.error((error as Error).message);
    await pool.end();
    process.exit(2);
  }
  const store = config.documentsDir ? new FileObjectStore(config.documentsDir) : null;
  const listener = await startListener({ config, pool, store });
  const { address, port } = listener.address();
  log('info', 'mcp.listening', { address, port, tls: config.tlsCertFile !== null });
  const stop = () => void listener.close().then(() => pool.end()).then(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
} else {
  console.error('Usage: node apps/web/cli/mcp.ts [serve|setup-role]');
  process.exit(2);
}
