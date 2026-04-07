/**
 * CLI tool — change an account's password.
 *
 * Usage:
 *   npm run db:edit-account -- <username> <new-password>
 */

import bcrypt from 'bcryptjs';
import { findAccount } from './accounts.js';
import { pool } from './client.js';

const BCRYPT_ROUNDS = 12;

const [username, newPassword] = process.argv.slice(2);

if (!username || !newPassword) {
  process.stderr.write('Usage: npm run db:edit-account -- <username> <new-password>\n');
  process.exit(1);
}

const account = await findAccount(username);
if (!account) {
  process.stderr.write(`Error: account "${username}" not found\n`);
  process.exit(1);
}

const hash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
await pool.query(
  'UPDATE accounts SET password_hash = $1 WHERE id = $2',
  [hash, account.id],
);
process.stdout.write(`Password updated for account "${username}" (id=${account.id})\n`);
await pool.end();
