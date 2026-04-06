/**
 * Account data-access helpers.
 *
 * Auto-registration on first login: if the account does not exist it is
 * created with the supplied password.  If it does exist the password is
 * verified with bcrypt.  This matches the typical MPBT usage pattern where
 * the client submits credentials chosen by the player.
 */

import bcrypt from 'bcryptjs';
import { pool } from './client.js';

const BCRYPT_ROUNDS = 12;

export interface AccountRow {
  id: number;
  username: string;
  password_hash: string;
  created_at: Date;
}

/** Look up an account by username (case-insensitive). */
export async function findAccount(username: string): Promise<AccountRow | null> {
  const res = await pool.query<AccountRow>(
    'SELECT id, username, password_hash, created_at FROM accounts WHERE lower(username) = lower($1)',
    [username],
  );
  return res.rows[0] ?? null;
}

/**
 * Create a new account and return the inserted row.
 * Throws if the username is already taken (UNIQUE violation).
 */
export async function createAccount(username: string, password: string): Promise<AccountRow> {
  const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const res = await pool.query<AccountRow>(
    `INSERT INTO accounts (username, password_hash)
     VALUES ($1, $2)
     RETURNING id, username, password_hash, created_at`,
    [username, hash],
  );
  return res.rows[0]!;
}

/**
 * Verify a login attempt.
 *
 * - If the account does not exist it is created with the supplied password
 *   (auto-registration on first login).  Returns `{ ok: true, account, created: true }`.
 * - If the account exists and the password matches, returns
 *   `{ ok: true, account, created: false }`.
 * - If the account exists but the password is wrong, returns `{ ok: false }`.
 */
export async function verifyOrRegister(
  username: string,
  password: string,
): Promise<
  | { ok: true;  account: AccountRow; created: boolean }
  | { ok: false; reason: string }
> {
  const existing = await findAccount(username);

  if (!existing) {
    // First time this username is used — create the account.
    const account = await createAccount(username, password);
    return { ok: true, account, created: true };
  }

  const passwordOk = await bcrypt.compare(password, existing.password_hash);
  if (!passwordOk) {
    return { ok: false, reason: 'incorrect password' };
  }

  return { ok: true, account: existing, created: false };
}
