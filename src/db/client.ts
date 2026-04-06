/**
 * PostgreSQL connection pool singleton.
 *
 * Reads DATABASE_URL from the environment.  All DB modules import from here
 * so there is exactly one pool per process.
 *
 * Pool is not initialised eagerly — the first query creates the underlying
 * connection.  Call `ensureSchema()` from `src/db/migrate.ts` (or at
 * server startup) to guarantee the schema exists before accepting clients.
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
