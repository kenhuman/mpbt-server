/**
 * Game-level protocol encoder — MPBT Solaris inner wire format.
 *
 * CONFIRMED by Ghidra RE of MPBTWIN.EXE:
 *
 *   Transport:  ARIES type 0x00 (SYNC / game-data channel)
 *   Inner frame (server→client):
 *     [seq_byte]  [cmd_byte = index+0x21]  [encoded_args...]  [0x20]  [3-byte CRC]  [0x1B ESC]
 *   seq_byte: (seq + 0x21) where seq ∈ [0..42]; consumed by FUN_0040C2A0 (PTR_FUN_00470190)
 *     before command dispatch. val = seq_byte - 0x21. If val > 42 → treated as ACK, not data.
 *   Encoding:
 *     - Single byte:  raw_value + 0x21   (FUN_00402f40 / FUN_00403030)
 *     - N-digit b85:  N+1 raw bytes via base-85 (each digit + 0x21)  (FUN_00402be0/b10)
 *     - String:       [len+0x21] + raw ASCII bytes  (FUN_00403160 / FUN_0040c0d0)
 *   CRC: 19-bit shift register (FUN_00402e30)
 *     - Lobby init = 0x0A5C25, Combat init = 0x0A5C45
 *     - Computed over [cmd_byte + args + 0x20]
 *     - Finalization: 3 extra shift/XOR rounds
 *     - Output encoded as base-85(2) = 3 bytes
 *
 *  Command table (lobby mode, DAT_00470198):
 *    Index 26 (0x3B) = FUN_0043A370  → mech/character list
 *   (others TBD)
 */

import { buildPacket } from './aries.js';
import { Msg } from './constants.js';

// ── Base-85 encoding ──────────────────────────────────────────────────────────
// CONFIRMED: FUN_00402be0(n, v) encodes v using n+1 raw bytes (base 85).
// Each digit d is stored as (d + 0x21).

/** Encode v with FUN_00402be0(1, v) → 2 raw bytes. */
export function encodeB85_1(v: number): Buffer {
  const d0 = Math.floor(v / 85);
  const d1 = v % 85;
  return Buffer.from([d0 + 0x21, d1 + 0x21]);
}

/** Encode v with FUN_00402be0(2, v) → 3 raw bytes (range 0..614124). */
export function encodeB85_2(v: number): Buffer {
  const d0 = Math.floor(v / (85 * 85));
  const r   = v % (85 * 85);
  const d1  = Math.floor(r / 85);
  const d2  = r % 85;
  return Buffer.from([d0 + 0x21, d1 + 0x21, d2 + 0x21]);
}

/** Encode v with FUN_00402f40 encoding → 1 raw byte. */
export function encodeAsByte(v: number): Buffer {
  return Buffer.from([v + 0x21]);
}

/**
 * Encode a string via FUN_00403160 wire format:
 *   [length_byte = len + 0x21]  [raw ASCII bytes]
 * Strings must be ≤ 84 bytes (length byte would hit 0x6D max; ESC = 0x1B never reached).
 */
export function encodeString(s: string): Buffer {
  const raw = Buffer.from(s, 'ascii');
  if (raw.length > 84) throw new RangeError(`encodeString: string too long (${raw.length}>`);
  return Buffer.concat([Buffer.from([raw.length + 0x21]), raw]);
}

// ── CRC algorithm ─────────────────────────────────────────────────────────────
// CONFIRMED from FUN_00402e30 (server→client validator in MPBTWIN.EXE).
// The server must produce CRC bytes that FUN_00402e30 will accept.

const CRC_INIT_LOBBY  = 0x0A5C25; // (0xFFFFFFE0 + 0x0A5C45) & 0xFFFFFFFF
const CRC_INIT_COMBAT = 0x0A5C45;

/**
 * Compute the 19-bit CRC value for a data buffer.
 * @param data   All bytes to checksum (cmd_byte + args + 0x20 terminator).
 * @param combat false = lobby init (default), true = combat init.
 */
export function computeGameCRC(data: Buffer, combat = false): number {
  let crc = combat ? CRC_INIT_COMBAT : CRC_INIT_LOBBY;

  for (const b of data) {
    crc = crc * 2;
    if (crc & 0x80000) crc = (crc & 0x7FFFE) | 1;
    crc ^= b;
  }

  // Finalization — 3 extra shift + XOR rounds (matches FUN_00402e30 exactly).
  let s = crc * 2;
  if (s & 0x80000) s = (s & 0x7FFFE) | 1;

  s = (s ^ (crc & 0xFF)) * 2;
  if (s & 0x80000) s = (s & 0x7FFFE) | 1;

  s = (s ^ ((crc >> 8) & 0xFF)) * 2;
  if (s & 0x80000) s = (s & 0x7FFFE) | 1;

  return s ^ ((crc & 0x70000) >> 16);
}

/** Encode a CRC value as 3 base-85 bytes (FUN_00402be0(2, crc)). */
function encodeCRC(crc: number): Buffer {
  return encodeB85_2(crc);
}

// ── Inner-frame builder ───────────────────────────────────────────────────────

/**
 * Build one inner game data frame:
 *   \x1b [seq+0x21] [cmdIndex+0x21] [args] [0x20] [3-byte CRC] \x1b
 *
 * CONFIRMED: FUN_00402cf0 (dispatcher) first calls PTR_FUN_00470190 = FUN_0040C2A0,
 * which calls FUN_00402f40() to consume ONE byte from the parse buffer as a
 * "sequence" byte (val = byte - 0x21). If val ≤ 42 it stores it and returns 0
 * (proceed); if val > 42 it's an ACK request (not for us to send).
 * The CRC (FUN_00402e30) covers ALL bytes between the ESCs including the seq byte.
 *
 * @param cmdIndex  Command table index (0-based).
 * @param args      Pre-encoded argument bytes.
 * @param combat    CRC mode (default: lobby).
 * @param seq       Sequence number 0..42 (default 0; val ≤ 42 → normal data frame).
 */
export function buildGameFrame(cmdIndex: number, args: Buffer, combat = false, seq = 0): Buffer {
  const seqByte = (seq & 0x7f) + 0x21;   // val = seq ≤ 42; FUN_0040C2A0 consumes this
  const cmdByte = cmdIndex + 0x21;
  // data = seq + cmd + args + 0x20 terminator
  // FUN_00402e30 CRCs everything here; FUN_00402cf0 skips past seq then reads cmds.
  const data = Buffer.concat([Buffer.from([seqByte, cmdByte]), args, Buffer.from([0x20])]);
  const crc  = computeGameCRC(data, combat);
  // Full frame: leading ESC + data + CRC×3 + trailing ESC
  return Buffer.concat([Buffer.from([0x1B]), data, encodeCRC(crc), Buffer.from([0x1B])]);
}

/** Wrap a game frame in an ARIES type-0 packet ready to write to the socket. */
export function buildGamePacket(cmdIndex: number, args: Buffer, combat = false, seq = 0): Buffer {
  return buildPacket(Msg.SYNC, buildGameFrame(cmdIndex, args, combat, seq));
}

// ── Command 26 — Mech/character list ─────────────────────────────────────────
// CONFIRMED: FUN_0043A370 reads this format from the server stream.
//
// Wire layout (after the command byte 0x3B):
//   [2 bytes: type_flag via FUN_00402b10(1) = encodeB85_1]
//   [1 byte:  count    via FUN_00402f40    = encodeAsByte]  CONFIRMED by capture analysis:
//              the working 1-mech session sent 0x22 here (count=1); b85_1 would have given
//              count=85 and produced garbage — encodeAsByte is definitively correct.
//   Per mech (repeat count times):
//     [3 bytes: mech_id via FUN_00402b10(2) = encodeB85_2]
//     [1 byte:  type via FUN_00402f40]
//     [3 bytes: slot via FUN_00402b10(2)]
//     [string:  type_string  via FUN_0040c0d0, e.g. "SDR-5V"]
//     [string:  variant_str  via FUN_0040c0d0]
//     [string:  name_str     via FUN_0040c0d0 (empty = looked up via FUN_00438280)]
//   [string: footer via FUN_0040c0d0]
//
// type_flag 0x00  → no special buttons (DAT_004dbd84 stays 0)
// type_flag 0x20 or 0x3E → extended buttons shown

export interface MechEntry {
  id:         number;   // mech_id: stored in DAT_004dc560[i]
  mechType:   number;   // 1-byte type: stored in DAT_004e2dc0[i]
  slot:       number;   // slot_info: stored in DAT_004dc510[i]
  typeString: string;   // e.g. "SDR-5V" → DAT_004dc5b8[i]
  variant:    string;   // e.g. "Spider"  → DAT_004dc1d0[i]
  name:       string;   // player name or ""  (empty = use FUN_00438280 lookup)
}

/**
 * Build command-26 (mech list) args buffer.
 * @param typeFlag  0 = normal, 0x20/'>' = show extended buttons.
 * @param mechs     Array of mech entries.
 * @param footer    Optional footer string.
 */
export function buildMechListArgs(
  mechs:     MechEntry[],
  typeFlag = 0,
  footer   = '',
): Buffer {
  const parts: Buffer[] = [
    encodeB85_1(typeFlag),          // 2 bytes: type_flag
    encodeAsByte(mechs.length),     // 1 byte:  count (FUN_00402f40 confirmed by capture)
  ];

  for (const m of mechs) {
    parts.push(encodeB85_2(m.id));
    parts.push(encodeAsByte(m.mechType));
    parts.push(encodeB85_2(m.slot));
    parts.push(encodeString(m.typeString));
    parts.push(encodeString(m.variant));
    parts.push(encodeString(m.name));
  }

  parts.push(encodeString(footer));
  return Buffer.concat(parts);
}

/** Build the full ARIES packet for command 26 (mech list). */
export function buildMechListPacket(
  mechs:     MechEntry[],
  typeFlag = 0,
  footer   = '',
  seq      = 0,
): Buffer {
  const CMD_MECH_LIST = 26;
  const args = buildMechListArgs(mechs, typeFlag, footer);
  return buildGamePacket(CMD_MECH_LIST, args, false, seq);
}

// ── Client frame decoders ─────────────────────────────────────────────────────
// Client frames: \x1b [seq+0x21] [cmd+0x21] [args] [CRC×3] \x1b
// Args use the same base-85 types as server args.

/**
 * Decode 2-byte type-1 value from client args buffer at given offset.
 * Encoding: FUN_00402be0(1, v) → [d0+0x21, d1+0x21] where d0=v/85, d1=v%85.
 */
export function decodeArgType1(buf: Buffer, offset: number): [val: number, next: number] {
  const d0 = buf[offset]     - 0x21;
  const d1 = buf[offset + 1] - 0x21;
  return [d0 * 85 + d1, offset + 2];
}

/**
 * Decode 5-byte type-4 value from client args buffer at given offset.
 * Encoding: FUN_00402be0(4, v) → 5 bytes, big-endian base-85.
 */
export function decodeArgType4(buf: Buffer, offset: number): [val: number, next: number] {
  let val = buf[offset]     - 0x21;
  val = val * 85 + (buf[offset + 1] - 0x21);
  val = val * 85 + (buf[offset + 2] - 0x21);
  val = val * 85 + (buf[offset + 3] - 0x21);
  val = val * 85 + (buf[offset + 4] - 0x21);
  return [val, offset + 5];
}

/**
 * Parse a client-sent cmd-7 frame (mech select or menu confirm reply).
 * Wire layout (args after cmd byte):
 *   [type1 2B: listId]  [type4 5B: selectionOrSlot]
 * selectionOrSlot = 0 → cancel/ESC; N → item N picked (1-indexed).
 * For mech window (listId=typeFlag=0): selectionOrSlot = mech.slot + 1.
 * Returns null if frame is too short or malformed.
 */
export function parseClientCmd7(
  payload: Buffer,
): { seq: number; listId: number; selection: number } | null {
  // payload[0]=0x1B, [1]=seq, [2]=cmd, [3..4]=type1, [5..9]=type4, [10..12]=CRC, [13]=0x1B
  if (payload.length < 14 || payload[0] !== 0x1B) return null;
  const seq = payload[1] - 0x21;
  const cmd = payload[2] - 0x21;
  if (cmd !== 7) return null;
  if (payload.length < 10) return null;
  const [listId,    o1] = decodeArgType1(payload, 3);
  const [selection, _o] = decodeArgType4(payload, o1);
  return { seq, listId, selection };
}

// ── Command 7 — server menu/dialog ───────────────────────────────────────────
// CONFIRMED by FUN_004112b0: server sends cmd 7, client shows a numbered menu.
//
// Wire layout (args after seq+cmd bytes):
//   [type1 2B: list_id]        — stored as DAT_00472c94[0x512] for callback lookup
//   [string:   title]          — dialog window title (FUN_0040c0d0 format)
//   [1 byte:   N]              — number of items (FUN_00402f40 format)
//   [string × N: item texts]   — each item is shown as " k. <text>"
//
// When user picks item k (key '1'..'N') the client sends:
//   cmd 7: type1(list_id) + type4(item_data[k-1] + 1)
// item_data[i] = i  (FUN_004112b0 stores loop index iVar11=0,1,2,...)
// So user picking item 1 → sends type4(0+1) = type4(1).
//
// list_ids to avoid (have special client-side behaviour):
//   0x22=34, 0x34=52, 0x0c=12, 0x25=37, 8  — dialog stays open on pick
//   0x3E8=1000                               — special sub-menu logic

/**
 * Build args for server command 7 (menu dialog).
 * @param listId  Arbitrary ID echoed back in client's cmd-7 reply.
 * @param title   Dialog window title string.
 * @param items   List of item label strings (≤ 84 items).
 */
export function buildMenuDialogArgs(
  listId: number,
  title:  string,
  items:  string[],
): Buffer {
  const parts: Buffer[] = [
    encodeB85_1(listId),
    encodeString(title),
    encodeAsByte(items.length),
    ...items.map(encodeString),
  ];
  return Buffer.concat(parts);
}

/** Build a full ARIES packet for server command 7 (menu dialog). */
export function buildMenuDialogPacket(
  listId: number,
  title:  string,
  items:  string[],
  seq    = 0,
): Buffer {
  return buildGamePacket(7, buildMenuDialogArgs(listId, title, items), false, seq);
}

// ── REDIRECT (ARIES type 0x03) ────────────────────────────────────────────────
// CONFIRMED by COMMEG32.DLL FUN_100014e0 case 3:
//   Payload is exactly 120 bytes: addr[40] | internet[40] | password[40]
//   All fields are null-terminated ASCII strings.
//   addr → CString → FUN_100011c0 (establish new TCP connection)
//   internet → SetInternet()
//   password → SetUserPassword()

/**
 * Build an ARIES type-0x03 REDIRECT packet.
 * @param addr      Target server address string (null-terminated in 40 bytes).
 * @param internet  "Internet" address passed to SetInternet (default = addr).
 * @param password  Session password passed to SetUserPassword (default = empty).
 */
export function buildRedirectPacket(
  addr:     string,
  internet  = '',
  password  = '',
): Buffer {
  const payload = Buffer.alloc(120, 0);
  // Each field is null-terminated; copy at most 39 bytes to leave room for NUL.
  Buffer.from(addr,                  'ascii').copy(payload,  0, 0, 39);
  Buffer.from(internet || addr,      'ascii').copy(payload, 40, 0, 39);
  Buffer.from(password,              'ascii').copy(payload, 80, 0, 39);
  return buildPacket(Msg.REDIRECT, payload);
}
