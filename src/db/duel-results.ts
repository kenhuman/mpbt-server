/**
 * Persisted Solaris duel-result helpers.
 */

import { pool } from './client.js';

export interface DuelResultRow {
  id: number;
  combat_session_id: string;
  world_map_room_id: number;
  room_name: string;
  winner_account_id: number;
  loser_account_id: number;
  winner_display_name: string;
  loser_display_name: string;
  winner_comstar_id: number;
  loser_comstar_id: number;
  winner_mech_id: number;
  loser_mech_id: number;
  winner_stake_cb: number;
  loser_stake_cb: number;
  settled_transfer_cb: number;
  winner_balance_cb: number;
  loser_balance_cb: number;
  winner_remaining_health: number;
  winner_max_health: number;
  loser_remaining_health: number;
  loser_max_health: number;
  result_reason: string;
  completed_at: Date;
}

export interface CreateDuelResultInput {
  combatSessionId: string;
  worldMapRoomId: number;
  roomName: string;
  winnerAccountId: number;
  loserAccountId: number;
  winnerDisplayName: string;
  loserDisplayName: string;
  winnerComstarId: number;
  loserComstarId: number;
  winnerMechId: number;
  loserMechId: number;
  winnerStakeCb: number;
  loserStakeCb: number;
  winnerRemainingHealth: number;
  winnerMaxHealth: number;
  loserRemainingHealth: number;
  loserMaxHealth: number;
  resultReason: string;
}

const DUEL_RESULT_SELECT = `
  SELECT id, combat_session_id, world_map_room_id, room_name,
         winner_account_id, loser_account_id,
         winner_display_name, loser_display_name,
         winner_comstar_id, loser_comstar_id,
         winner_mech_id, loser_mech_id,
         winner_stake_cb, loser_stake_cb,
         settled_transfer_cb, winner_balance_cb, loser_balance_cb,
         winner_remaining_health, winner_max_health,
         loser_remaining_health, loser_max_health,
         result_reason, completed_at
  FROM duel_results
`;

export async function createDuelResult(input: CreateDuelResultInput): Promise<DuelResultRow | null> {
  const res = await pool.query<DuelResultRow>(
    `INSERT INTO duel_results (
       combat_session_id, world_map_room_id, room_name,
       winner_account_id, loser_account_id,
       winner_display_name, loser_display_name,
       winner_comstar_id, loser_comstar_id,
       winner_mech_id, loser_mech_id,
       winner_stake_cb, loser_stake_cb,
       settled_transfer_cb, winner_balance_cb, loser_balance_cb,
       winner_remaining_health, winner_max_health,
       loser_remaining_health, loser_max_health,
       result_reason
     )
     VALUES (
       $1, $2, $3,
       $4, $5,
       $6, $7,
       $8, $9,
       $10, $11,
       $12, $13,
       $14, $15, $16,
       $17, $18,
       $19, $20,
       $21
      )
      ON CONFLICT (combat_session_id) DO NOTHING
      RETURNING id, combat_session_id, world_map_room_id, room_name,
                winner_account_id, loser_account_id,
                winner_display_name, loser_display_name,
                winner_comstar_id, loser_comstar_id,
                winner_mech_id, loser_mech_id,
                winner_stake_cb, loser_stake_cb,
                settled_transfer_cb, winner_balance_cb, loser_balance_cb,
                winner_remaining_health, winner_max_health,
                loser_remaining_health, loser_max_health,
                result_reason, completed_at`,
    [
      input.combatSessionId,
      input.worldMapRoomId,
      input.roomName,
      input.winnerAccountId,
      input.loserAccountId,
      input.winnerDisplayName,
      input.loserDisplayName,
      input.winnerComstarId,
      input.loserComstarId,
      input.winnerMechId,
      input.loserMechId,
      input.winnerStakeCb,
      input.loserStakeCb,
      0,
      0,
      0,
      input.winnerRemainingHealth,
      input.winnerMaxHealth,
      input.loserRemainingHealth,
      input.loserMaxHealth,
      input.resultReason,
    ],
  );
  return res.rows[0] ?? null;
}

export async function updateDuelResultSettlement(
  combatSessionId: string,
  settledTransferCb: number,
  winnerBalanceCb: number,
  loserBalanceCb: number,
): Promise<DuelResultRow | null> {
  const res = await pool.query<DuelResultRow>(
    `UPDATE duel_results
     SET settled_transfer_cb = $2,
         winner_balance_cb = $3,
         loser_balance_cb = $4
     WHERE combat_session_id = $1
     RETURNING id, combat_session_id, world_map_room_id, room_name,
               winner_account_id, loser_account_id,
               winner_display_name, loser_display_name,
               winner_comstar_id, loser_comstar_id,
               winner_mech_id, loser_mech_id,
               winner_stake_cb, loser_stake_cb,
               settled_transfer_cb, winner_balance_cb, loser_balance_cb,
               winner_remaining_health, winner_max_health,
               loser_remaining_health, loser_max_health,
               result_reason, completed_at`,
    [combatSessionId, settledTransferCb, winnerBalanceCb, loserBalanceCb],
  );
  return res.rows[0] ?? null;
}

export async function listAllDuelResults(): Promise<DuelResultRow[]> {
  const res = await pool.query<DuelResultRow>(
    `${DUEL_RESULT_SELECT}
     ORDER BY completed_at ASC, id ASC`,
  );
  return res.rows;
}

export async function listRecentDuelResults(limit: number): Promise<DuelResultRow[]> {
  const safeLimit = Math.max(1, Math.min(50, limit));
  const res = await pool.query<DuelResultRow>(
    `${DUEL_RESULT_SELECT}
     ORDER BY completed_at DESC, id DESC
     LIMIT $1`,
    [safeLimit],
  );
  return res.rows;
}

export async function fetchDuelResultById(id: number): Promise<DuelResultRow | null> {
  const res = await pool.query<DuelResultRow>(
    `${DUEL_RESULT_SELECT}
     WHERE id = $1
     LIMIT 1`,
    [id],
  );
  return res.rows[0] ?? null;
}
