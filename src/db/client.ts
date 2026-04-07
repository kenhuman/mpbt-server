/**
 * PostgreSQL connection pool singleton.
 *
 * Reads DATABASE_URL from the environment.  All DB modules import from here
 * so there is exactly one pool per process.
 *
 * This module performs a startup connectivity check with `pool.connect()` so
 * configuration or database availability problems surface immediately rather
 * than on the first query. Schema creation and migrations are handled
 * separately; run the external `db:migrate` step before accepting clients.
 */

import pg from 'pg';

const { Pool } = pg;

const databaseUrl = process.env['DATABASE_URL'];

if (!databaseUrl) {
  throw new Error(
    'DATABASE_URL environment variable is not set.\n' +
    'Set it in your shell or in a .env file before starting the server.\n' +
    'Example: DATABASE_URL=postgres://mpbt:mpbt@localhost:5432/mpbt',
  );
}

export const pool = new Pool({ connectionString: databaseUrl });

pool.on('error', (err: Error) => {
  process.stderr.write(`[db] idle client error: ${err.message}\n`);
});

// Verify DB connectivity at startup so misconfiguration surfaces immediately
// rather than on the first player login.
void pool.connect().then(client => {
  client.release();
}).catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[db] startup connectivity check failed: ${msg}\n`);
  process.exit(1);
});
