/**
 * Character data-access helpers.
 *
 * One character per account (extend in M9 for multi-character support).
 */

import { pool } from './client.js';

export type Allegiance = 'Davion' | 'Steiner' | 'Liao' | 'Marik' | 'Kurita';

export const ALLEGIANCES: Allegiance[] = ['Davion', 'Steiner', 'Liao', 'Marik', 'Kurita'];

export interface CharacterRow {
  id: number;
  account_id: number;
  display_name: string;
  allegiance: Allegiance;
  created_at: Date;
}

/** Find the character for a given account, or null if none exists. */
export async function findCharacter(accountId: number): Promise<CharacterRow | null> {
  const res = await pool.query<CharacterRow>(
    `SELECT id, account_id, display_name, allegiance, created_at
     FROM characters
     WHERE account_id = $1
     LIMIT 1`,
    [accountId],
  );
  return res.rows[0] ?? null;
}

/**
 * Create a new character for the account.
 *
 * `displayName` must be globally unique (enforced by the UNIQUE constraint).
 * Throws a `UniqueViolationError` (pg error code 23505) if the display name
 * is already taken.
 */
export async function createCharacter(
  accountId: number,
  displayName: string,
  allegiance: Allegiance,
): Promise<CharacterRow> {
  const res = await pool.query<CharacterRow>(
    `INSERT INTO characters (account_id, display_name, allegiance)
     VALUES ($1, $2, $3)
     RETURNING id, account_id, display_name, allegiance, created_at`,
    [accountId, displayName, allegiance],
  );
  return res.rows[0]!;
}

/**
 * Check whether a display name is already taken by another character.
 * Used to re-prompt when a chosen name is unavailable.
 */
export async function isDisplayNameTaken(displayName: string): Promise<boolean> {
  const res = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM characters WHERE lower(display_name) = lower($1)
     ) AS exists`,
    [displayName],
  );
  return res.rows[0]?.exists ?? false;
}
