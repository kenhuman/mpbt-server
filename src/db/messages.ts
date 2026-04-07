/**
 * ComStar message persistence helpers.
 *
 * Messages are stored when the recipient is offline and delivered the next
 * time they enter the game world.  Online delivery goes directly over the
 * socket and bypasses this table entirely.
 */

import { pool } from './client.js';

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
}

/**
 * Persist an offline ComStar message.
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
): Promise<MessageRow> {
  const res = await pool.query<MessageRow>(
    `INSERT INTO messages
       (sender_account_id, recipient_account_id, sender_comstar_id, body)
     VALUES ($1, $2, $3, $4)
     RETURNING id, sender_account_id, recipient_account_id,
               sender_comstar_id, body, sent_at, delivered_at`,
    [senderAccountId, recipientAccountId, senderComstarId, body],
  );
  return res.rows[0]!;
}

/**
 * Fetch all undelivered messages for a recipient account, oldest first.
 * Returns an empty array when there are no pending messages.
 */
export async function fetchUndeliveredMessages(
  recipientAccountId: number,
): Promise<MessageRow[]> {
  const res = await pool.query<MessageRow>(
    `SELECT id, sender_account_id, recipient_account_id,
            sender_comstar_id, body, sent_at, delivered_at
     FROM messages
     WHERE recipient_account_id = $1 AND delivered_at IS NULL
     ORDER BY sent_at ASC`,
    [recipientAccountId],
  );
  return res.rows;
}

/**
 * Mark a list of message IDs as delivered (sets delivered_at = now()).
 * Safe to call with an empty array (no-op).
 */
export async function markDelivered(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await pool.query(
    `UPDATE messages SET delivered_at = now() WHERE id = ANY($1::int[])`,
    [ids],
  );
}
