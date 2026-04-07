/**
 * CLI tool — create a new account.
 *
 * Usage:
 *   npm run db:add-account -- <username> <password>
 */

import { createAccount, findAccount } from './accounts.js';
import { pool } from './client.js';

const [username, password] = process.argv.slice(2);

if (!username || !password) {
  process.stderr.write('Usage: npm run db:add-account -- <username> <password>\n');
  process.exit(1);
}

const existing = await findAccount(username);
if (existing) {
  process.stderr.write(`Error: account "${username}" already exists (id=${existing.id})\n`);
  process.exit(1);
}

const account = await createAccount(username, password);
process.stdout.write(`Account created: id=${account.id} username="${account.username}"\n`);
await pool.end();
