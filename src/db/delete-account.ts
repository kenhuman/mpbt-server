/**
 * CLI tool — delete an account and its associated character.
 *
 * Usage:
 *   npm run db:delete-account -- <username>
 *
 * The characters table has ON DELETE CASCADE, so the character is removed too.
 */

import { findAccount } from './accounts.js';
import { pool } from './client.js';

const [username] = process.argv.slice(2);

if (!username) {
  process.stderr.write('Usage: npm run db:delete-account -- <username>\n');
  process.exit(1);
}

const account = await findAccount(username);
if (!account) {
  process.stderr.write(`Error: account "${username}" not found\n`);
  process.exit(1);
}

const result = await pool.query('DELETE FROM accounts WHERE id = $1', [account.id]);
const deleted = result.rowCount ?? 0;
process.stdout.write(
  `Deleted ${deleted} account(s) for "${username}" (id=${account.id}); associated character also removed.\n`,
);
await pool.end();
