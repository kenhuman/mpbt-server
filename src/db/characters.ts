/**
 * Character data-access helpers.
 *
 * One character per account (extend in M9 for multi-character support).
 */

import { pool } from './client.js';

export type Allegiance = 'Davion' | 'Steiner' | 'Liao' | 'Marik' | 'Kurita';

export const ALLEGIANCES: Allegiance[] = ['Davion', 'Steiner', 'Liao', 'Marik', 'Kurita'];
export const STARTING_CBILLS = 100_000;

export interface CharacterRow {
  id: number;
  account_id: number;
  display_name: string;
  allegiance: Allegiance;
  cbills: number;
  mech_id: number | null;
  mech_slot: number | null;
  created_at: Date;
}

export interface DuelStakeSettlement {
  transferCb: number;
  winnerCbills: number;
  loserCbills: number;
}

/** Find the character for a given account, or null if none exists. */
export async function findCharacter(accountId: number): Promise<CharacterRow | null> {
  const res = await pool.query<CharacterRow>(
    `SELECT id, account_id, display_name, allegiance, cbills, mech_id, mech_slot, created_at
     FROM characters
     WHERE account_id = $1
     LIMIT 1`,
    [accountId],
  );
  return res.rows[0] ?? null;
}

/** List all persisted characters. */
export async function listCharacters(): Promise<CharacterRow[]> {
  const res = await pool.query<CharacterRow>(
    `SELECT id, account_id, display_name, allegiance, cbills, mech_id, mech_slot, created_at
     FROM characters`,
  );
  return res.rows;
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
  mechId: number,
  mechSlot: number,
): Promise<CharacterRow> {
  const res = await pool.query<CharacterRow>(
    `INSERT INTO characters (account_id, display_name, allegiance, cbills, mech_id, mech_slot)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, account_id, display_name, allegiance, cbills, mech_id, mech_slot, created_at`,
    [accountId, displayName, allegiance, STARTING_CBILLS, mechId, mechSlot],
  );
  return res.rows[0]!;
}

/**
 * Update the allegiance for an existing character.
 */
export async function updateCharacterAllegiance(
  accountId: number,
  allegiance: Allegiance,
): Promise<void> {
  await pool.query(
    `UPDATE characters SET allegiance = $1 WHERE account_id = $2`,
    [allegiance, accountId],
  );
}

/** Persist the player's selected mech for future lobby/world launches. */
export async function updateCharacterMech(
  accountId: number,
  mechId: number,
  mechSlot: number,
): Promise<void> {
  await pool.query(
    `UPDATE characters
     SET mech_id = $1, mech_slot = $2
     WHERE account_id = $3`,
    [mechId, mechSlot, accountId],
  );
}

/** Persist a new display name for an existing character. */
export async function updateCharacterDisplayName(
  accountId: number,
  displayName: string,
): Promise<void> {
  await pool.query(
    `UPDATE characters
     SET display_name = $1
     WHERE account_id = $2`,
    [displayName, accountId],
  );
}

/** Transfer sanctioned duel CB from the losing duelist to the winner atomically. */
export async function settleDuelStakeTransfer(
  winnerAccountId: number,
  loserAccountId: number,
  transferCb: number,
): Promise<DuelStakeSettlement> {
  const amount = Math.max(0, Math.trunc(transferCb));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const res = await client.query<{ account_id: number; cbills: number }>(
      `SELECT account_id, cbills
       FROM characters
       WHERE account_id = ANY($1::int[])
       FOR UPDATE`,
      [[winnerAccountId, loserAccountId]],
    );
    const winnerRow = res.rows.find(row => row.account_id === winnerAccountId);
    const loserRow = res.rows.find(row => row.account_id === loserAccountId);
    if (!winnerRow || !loserRow) {
      throw new Error('Missing winner or loser character row for duel settlement.');
    }
    if (amount > loserRow.cbills) {
      throw new Error(
        `Loser account ${loserAccountId} has ${loserRow.cbills} cb for ${amount} cb settlement.`,
      );
    }
    if (amount > 0) {
      await client.query(
        `UPDATE characters
         SET cbills = CASE
           WHEN account_id = $1 THEN cbills + $3
           WHEN account_id = $2 THEN cbills - $3
           ELSE cbills
         END
         WHERE account_id IN ($1, $2)`,
        [winnerAccountId, loserAccountId, amount],
      );
    }
    await client.query('COMMIT');
    return {
      transferCb: amount,
      winnerCbills: winnerRow.cbills + amount,
      loserCbills: loserRow.cbills - amount,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Find the character for a given display name (case-insensitive), or null if none exists. */
export async function findCharacterByDisplayName(displayName: string): Promise<CharacterRow | null> {
  const res = await pool.query<CharacterRow>(
    `SELECT id, account_id, display_name, allegiance, cbills, mech_id, mech_slot, created_at
     FROM characters
     WHERE lower(display_name) = lower($1)
     LIMIT 1`,
    [displayName],
  );
  return res.rows[0] ?? null;
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
