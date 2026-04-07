/**
 * DB migration — applies src/db/schema.sql against the configured Postgres
 * instance.  Safe to run multiple times (all statements use IF NOT EXISTS).
 *
 * Usage:
 *   npm run db:migrate
 *   node --loader ts-node/esm src/db/migrate.ts
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { pool } from './client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(__dirname, 'schema.sql');
const schemaSql  = readFileSync(schemaPath, 'utf-8');

const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query(schemaSql);
  await client.query('COMMIT');
  process.stdout.write('[db:migrate] schema applied successfully\n');
} catch (err) {
  await client.query('ROLLBACK');
  throw err;
} finally {
  client.release();
  await pool.end();
}
