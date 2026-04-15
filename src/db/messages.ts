/**
 * ComStar message persistence helpers.
 *
 * Messages are persisted for both online and offline recipients so the
 * terminal inbox can read from a single Postgres-backed source of truth.
 */

import { pool } from './client.js';

export const COMSTAR_UNREAD_LIMIT = 25;

export interface MessageRow {
  id: number;
  sender_account_id: number;
  recipient_account_id: number;
  /** Sender's comstarId (= 100_000 + accountId); used as Cmd36 dialogId. */
  sender_comstar_id: number;
  /** Full formatted text ready for Cmd36 — already contains sender name prefix. */
  body: string;
  sent_at: Date;
  delivered_at: Date | null;
  saved_at: Date | null;
  read_at: Date | null;
}

/**
 * Persist a ComStar message.
 *
 * `body` must be the value produced by `buildComstarDeliveryText()` — it
 * includes the "ComStar message from <name>\" prefix and is already clamped
 * to the base-85 maximum length.
 */
export async function storeMessage(
  senderAccountId: number,
  recipientAccountId: number,
  senderComstarId: number,
  body: string,
): Promise<MessageRow | null> {
  const res = await pool.query<MessageRow>(
    `INSERT INTO messages
       (sender_account_id, recipient_account_id, sender_comstar_id, body)
     SELECT $1, $2, $3, $4
     WHERE (
       SELECT COUNT(*)
       FROM messages
       WHERE recipient_account_id = $2 AND read_at IS NULL
     ) < $5
     RETURNING id, sender_account_id, recipient_account_id,
                sender_comstar_id, body, sent_at, delivered_at, saved_at, read_at`,
    [senderAccountId, recipientAccountId, senderComstarId, body, COMSTAR_UNREAD_LIMIT],
  );
  return res.rows[0] ?? null;
}

/**
 * Count unread messages for a recipient account.
 */
export async function countUnreadMessages(
  recipientAccountId: number,
): Promise<number> {
  const res = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM messages
     WHERE recipient_account_id = $1 AND read_at IS NULL`,
    [recipientAccountId],
  );
  return Number(res.rows[0]?.count ?? '0');
}

/**
 * Count saved-but-unread messages for a recipient account.
 */
export async function countSavedUnreadMessages(
  recipientAccountId: number,
): Promise<number> {
  const res = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM messages
     WHERE recipient_account_id = $1
       AND saved_at IS NOT NULL
       AND read_at IS NULL`,
    [recipientAccountId],
  );
  return Number(res.rows[0]?.count ?? '0');
}

/**
 * Fetch the next unread message for a recipient account, oldest first.
 * Returns null when there are no unread messages.
 */
export async function fetchNextUnreadMessage(
  recipientAccountId: number,
): Promise<MessageRow | null> {
  const res = await pool.query<MessageRow>(
    `SELECT id, sender_account_id, recipient_account_id,
            sender_comstar_id, body, sent_at, delivered_at, read_at
     FROM messages
     WHERE recipient_account_id = $1 AND read_at IS NULL
     ORDER BY sent_at ASC, id ASC
     LIMIT 1`,
    [recipientAccountId],
  );
  return res.rows[0] ?? null;
}

/**
 * Fetch the next saved unread message for a recipient account, oldest first.
 * Returns null when there are no saved unread messages.
 */
export async function fetchNextSavedUnreadMessage(
  recipientAccountId: number,
): Promise<MessageRow | null> {
  const res = await pool.query<MessageRow>(
    `SELECT id, sender_account_id, recipient_account_id,
            sender_comstar_id, body, sent_at, delivered_at, saved_at, read_at
     FROM messages
     WHERE recipient_account_id = $1
       AND saved_at IS NOT NULL
       AND read_at IS NULL
     ORDER BY sent_at ASC, id ASC
     LIMIT 1`,
    [recipientAccountId],
  );
  return res.rows[0] ?? null;
}

/**
 * Mark a list of message IDs as delivered (sets delivered_at = now() when unset).
 * Safe to call with an empty array (no-op).
 */
export async function markDelivered(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await pool.query(
    `UPDATE messages
     SET delivered_at = COALESCE(delivered_at, now())
     WHERE id = ANY($1::int[])`,
    [ids],
  );
}

/**
 * Mark messages as saved for later terminal retrieval and ensure they count as delivered.
 */
export async function markSaved(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await pool.query(
    `UPDATE messages
     SET delivered_at = COALESCE(delivered_at, now()),
         saved_at = COALESCE(saved_at, now())
     WHERE id = ANY($1::int[])`,
    [ids],
  );
}

/**
 * Mark messages as read and ensure they also count as delivered.
 */
export async function markRead(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await pool.query(
    `UPDATE messages
     SET delivered_at = COALESCE(delivered_at, now()),
         read_at = COALESCE(read_at, now())
     WHERE id = ANY($1::int[])`,
    [ids],
  );
}
