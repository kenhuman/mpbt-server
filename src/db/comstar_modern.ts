/**
 * ComStar modern-client message persistence.
 *
 * Uses the separate `comstar_modern` table so there is zero overlap with the
 * ARIES-oriented `messages` table consumed by the retail client adapter.
 */

import { pool } from './client.js';

export interface ComstarModernRow {
  id: number;
  from_account_id: number;
  to_account_id: number;
  from_name: string;
  subject: string;
  body: string;
  sent_at: Date;
  read_at: Date | null;
  deleted_at: Date | null;
}

/** Maximum inbox depth returned per request. */
export const COMSTAR_INBOX_LIMIT = 50;

/**
 * Insert a new message.  Returns the inserted row or null when the sender or
 * recipient account is invalid (FK constraint violation).
 */
export async function sendComstarModern(
  fromAccountId: number,
  toAccountId: number,
  fromName: string,
  subject: string,
  body: string,
): Promise<ComstarModernRow | null> {
  try {
    const res = await pool.query<ComstarModernRow>(
      `INSERT INTO comstar_modern
         (from_account_id, to_account_id, from_name, subject, body)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, from_account_id, to_account_id, from_name,
                 subject, body, sent_at, read_at, deleted_at`,
      [fromAccountId, toAccountId, fromName, subject, body],
    );
    return res.rows[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * List the inbox for a recipient — non-deleted rows, newest-first, capped at
 * COMSTAR_INBOX_LIMIT.
 */
export async function listInbox(toAccountId: number): Promise<ComstarModernRow[]> {
  const res = await pool.query<ComstarModernRow>(
    `SELECT id, from_account_id, to_account_id, from_name,
            subject, body, sent_at, read_at, deleted_at
     FROM comstar_modern
     WHERE to_account_id = $1 AND deleted_at IS NULL
     ORDER BY sent_at DESC, id DESC
     LIMIT $2`,
    [toAccountId, COMSTAR_INBOX_LIMIT],
  );
  return res.rows;
}

/**
 * Count unread (non-deleted) messages for a recipient.
 */
export async function countUnread(toAccountId: number): Promise<number> {
  const res = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM comstar_modern
     WHERE to_account_id = $1
       AND read_at IS NULL
       AND deleted_at IS NULL`,
    [toAccountId],
  );
  return Number(res.rows[0]?.count ?? '0');
}

/**
 * Mark a message as read.  Only updates if the caller is the recipient.
 * Returns true when a row was updated, false when not found / wrong owner.
 */
export async function markReadById(
  messageId: number,
  toAccountId: number,
): Promise<boolean> {
  const res = await pool.query(
    `UPDATE comstar_modern
     SET read_at = COALESCE(read_at, now())
     WHERE id = $1 AND to_account_id = $2 AND deleted_at IS NULL
     RETURNING id`,
    [messageId, toAccountId],
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * Soft-delete a message.  Only the recipient may delete.
 * Returns true when a row was updated, false when not found / wrong owner.
 */
export async function softDelete(
  messageId: number,
  toAccountId: number,
): Promise<boolean> {
  const res = await pool.query(
    `UPDATE comstar_modern
     SET deleted_at = COALESCE(deleted_at, now())
     WHERE id = $1 AND to_account_id = $2
     RETURNING id`,
    [messageId, toAccountId],
  );
  return (res.rowCount ?? 0) > 0;
}
