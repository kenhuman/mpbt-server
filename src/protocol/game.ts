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

/** Encode v with FUN_00402be0(3, v) → 4 raw bytes (range 0..52,200,624). */
export function encodeB85_3(v: number): Buffer {
  const MAX = 85 ** 4 - 1; // 52,200,624
  if (v < 0 || v > MAX) throw new RangeError(`encodeB85_3: value ${v} out of range 0..${MAX}`);
  const d0 = Math.floor(v / (85 * 85 * 85));
  let r    = v % (85 * 85 * 85);
  const d1 = Math.floor(r / (85 * 85));
  r %= 85 * 85;
  const d2 = Math.floor(r / 85);
  const d3 = r % 85;
  return Buffer.from([d0 + 0x21, d1 + 0x21, d2 + 0x21, d3 + 0x21]);
}

/** Encode v with FUN_00402be0(4, v) → 5 raw bytes (range 0..4,437,053,124). */
export function encodeB85_4(v: number): Buffer {
  const MAX = 85 ** 5 - 1; // 4,437,053,124
  if (v < 0 || v > MAX) throw new RangeError(`encodeB85_4: value ${v} out of range 0..${MAX}`);
  const digits = new Array<number>(5);
  let current = v;
  for (let i = 4; i >= 0; i -= 1) {
    digits[i] = current % 85;
    current = Math.floor(current / 85);
  }
  return Buffer.from(digits.map(digit => digit + 0x21));
}

/** Encode v with FUN_00402f40 encoding → 1 raw byte. */
export function encodeAsByte(v: number): Buffer {
  return Buffer.from([v + 0x21]);
}

/**
 * Encode a string via FUN_00403160 wire format:
 *   [length_byte = len + 0x21]  [raw bytes]
 * Strings must be ≤ 84 bytes (length byte would hit 0x75 max; ESC = 0x1B never reached).
 *
 * Used for cmd-26 (mech list) strings read by FUN_0040c0d0.  NOT for cmd-20 text
 * (which uses buildCmd20Args with a base-85 length prefix via FUN_0040c130).
 *
 * The only byte that MUST NOT appear in text is 0x1B (ESC), which would prematurely
 * terminate the ARIES inner frame in the client's ESC accumulator (FUN_00429510).
 */
export function encodeString(s: string): Buffer {
  const raw = Buffer.from(s, 'latin1');
  if (raw.includes(0x1b)) throw new RangeError('encodeString: text must not contain ESC (0x1B)');
  if (raw.length > 84) throw new RangeError(`encodeString: string too long (${raw.length} > 84)`);
  return Buffer.concat([Buffer.from([raw.length + 0x21]), raw]);
}

/**
 * Encode a raw latin1 string using the base-85(1) length prefix used by
 * FUN_0040c130 / FUN_00403100. This is distinct from encodeString().
 */
function encodeB85LengthString(s: string): Buffer {
  const raw = Buffer.from(s, 'latin1');
  if (raw.includes(0x1b)) {
    throw new RangeError('encodeB85LengthString: text must not contain ESC (0x1B)');
  }
  if (raw.length > (85 * 85 - 1)) {
    throw new RangeError(`encodeB85LengthString: string too long (${raw.length} > 7224)`);
  }
  return Buffer.concat([encodeB85_1(raw.length), raw]);
}

// ── CRC algorithm ─────────────────────────────────────────────────────────────
// CONFIRMED from FUN_00402e30 (server→client validator in MPBTWIN.EXE).
// Inbound seeds confirmed by cross-reference with RazorWing/solaris repo
// (INBOUND_SEED_RPS=795941=0x0C2525, INBOUND_SEED_COMBAT=804165=0x0C4545).
//
// Direction | Mode  | Seed      | Hex
// ----------|-------|-----------|----------
// S→C       | Lobby | 678949    | 0x0A5C25   (0xFFFFFFE0 + 0x0A5C45) & mask
// S→C       | Combat| 678981    | 0x0A5C45
// C→S       | Lobby | 795941    | 0x0C2525
// C→S       | Combat| 804165    | 0x0C4545

// Server → Client seeds (used when generating CRC for outbound frames)
const CRC_OUTBOUND_LOBBY  = 0x0A5C25; // (0xFFFFFFE0 + 0x0A5C45) & 0xFFFFFFFF
const CRC_OUTBOUND_COMBAT = 0x0A5C45;

// Client → Server seeds (used when verifying CRC on inbound frames)
const CRC_INBOUND_LOBBY   = 0x0C2525; // 795941 — confirmed: RazorWing INBOUND_SEED_RPS
const CRC_INBOUND_COMBAT  = 0x0C4545; // 804165 — confirmed: RazorWing INBOUND_SEED_COMBAT

/** Core 19-bit LFSR CRC with explicit seed (matches FUN_00402e30 in MPBTWIN.EXE). */
function computeGameCRCWithSeed(data: Buffer, seed: number): number {
  let crc = seed;

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

/**
 * Compute the 19-bit CRC for an outbound (server → client) frame buffer.
 * @param data   All bytes to checksum (seq_byte + cmd_byte + args + 0x20 terminator).
 * @param combat false = lobby seed (default), true = combat seed.
 */
export function computeGameCRC(data: Buffer, combat = false): number {
  return computeGameCRCWithSeed(data, combat ? CRC_OUTBOUND_COMBAT : CRC_OUTBOUND_LOBBY);
}

/**
 * Verify the CRC of an inbound (client → server) game frame.
 *
 * Expected payload layout (as received in the ARIES SYNC packet):
 *   [0x1B] [seq+0x21] [cmd+0x21] [args...] [0x20] [crc0] [crc1] [crc2] [optional 0x1B]
 *
 * CRC input covers bytes from seq_byte through (and including) the 0x20 terminator.
 * The three CRC bytes are base-85 decoded into the expected 19-bit value.
 *
 * @param payload  Raw ARIES payload starting with 0x1B.
 * @param combat   false = lobby seed (default), true = combat seed.
 * @returns true if the CRC matches, false otherwise.
 */
export function verifyInboundGameCRC(payload: Buffer, combat = false): boolean {
  if (payload.length < 5 || payload[0] !== 0x1B) return false;

  // Trailing 0x1B may or may not be present (RESEARCH.md §3 note).
  const hasTrailingEsc = payload[payload.length - 1] === 0x1B;
  const frameEnd = hasTrailingEsc ? payload.length - 1 : payload.length;

  // Need at least 3 CRC bytes after the leading ESC + at least one data byte.
  if (frameEnd < 5) return false;

  // Last 3 bytes of the frame (before optional trailing ESC) are the CRC.
  const crcOffset = frameEnd - 3;
  const d0 = payload[crcOffset]     - 0x21;
  const d1 = payload[crcOffset + 1] - 0x21;
  const d2 = payload[crcOffset + 2] - 0x21;
  const receivedCRC = d0 * 85 * 85 + d1 * 85 + d2;

  // CRC input: everything from seq_byte (payload[1]) up to (not including) CRC bytes.
  const crcData = payload.slice(1, crcOffset);
  const expectedCRC = computeGameCRCWithSeed(
    crcData,
    combat ? CRC_INBOUND_COMBAT : CRC_INBOUND_LOBBY,
  );

  return expectedCRC === receivedCRC;
}

/**
 * Split one ARIES SYNC payload into one or more ESC-delimited inner game frames.
 *
 * Some client paths can batch multiple inner frames into a single ARIES type-0
 * payload. Each frame still uses the normal layout:
 *   [0x1B] [seq] [cmd] ... [crc x3] [optional 0x1B]
 *
 * If no complete trailing ESC-delimited subframes are found, returns the
 * original payload as a single candidate frame.
 */
export function splitInboundGameFrames(payload: Buffer): Buffer[] {
  if (payload.length === 0 || payload[0] !== 0x1B) return [payload];

  const frames: Buffer[] = [];
  let start = 0;

  while (start < payload.length && payload[start] === 0x1B) {
    const nextEsc = payload.indexOf(0x1B, start + 1);
    if (nextEsc === -1) break;
    const frame = payload.subarray(start, nextEsc + 1);
    if (frame.length >= 5) {
      frames.push(frame);
    }
    start = nextEsc + 1;
  }

  if (frames.length === 0) {
    return [payload];
  }

  if (start < payload.length) {
    const tail = payload.subarray(start);
    if (tail.length > 0) {
      frames.push(tail);
    }
  }

  return frames;
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
  id:             number;   // mech_id: stored in DAT_004dc560[i]
  mechType:       number;   // 1-byte type: stored in DAT_004e2dc0[i]
  slot:           number;   // slot_info: stored in DAT_004dc510[i]
  typeString:     string;   // e.g. "SDR-5V" → DAT_004dc5b8[i]
  variant:        string;   // e.g. "Spider"  → DAT_004dc1d0[i]
  name:           string;   // player name or ""  (empty = use FUN_00438280 lookup)
  /**
   * Extra crit-slot count from the mech's .MEC file (signed 16-bit at offset
   * 0x3c after decryption).  The Cmd72 handler reads `extraCritCount + 21`
   * crit bytes when `extraCritCount != -21 && extraCritCount >= -20`.
   * CONFIRMED via RE of Combat_ReadLocalActorMechState_v123 @ 0x004456c0.
   */
  extraCritCount: number;
  /**
   * Walk speed magnitude derived from mec_speed at offset 0x16:
   *   walkSpeedMag = mec_speed * 300
   * CONFIRMED by RE of Combat_InitActorRuntimeFromMec_v123 @ 0x00433910.
   */
  walkSpeedMag: number;
  /**
   * Maximum forward speed magnitude derived from mec_speed at offset 0x16:
   *   maxSpeedMag = round(mec_speed * 1.5) * 300
   * CONFIRMED by RE of Combat_InitActorRuntimeFromMec_v123 @ 0x00433910.
   */
  maxSpeedMag: number;
  /**
   * Mech mass in tons, read from .MEC offset 0x18 (uint16 LE after decryption).
   * Used to compute per-section internal-structure maxima for Cmd72 bootstrap.
   * CONFIRMED from RESEARCH.md §20 cross-validation table.
   */
  tonnage: number;
  /**
   * Armor-like section maxima read from decrypted .MEC offsets 0x1a..0x2c.
   * Order matches Cmd66/67 class-1 codes 0x15..0x1e:
   * [LA, RA, LL, RL, CT front, LT front, RT front, CT rear, LT rear, RT rear]
   */
  armorLikeMaxValues: number[];
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
  if (mechs.length > 20) {
    throw new RangeError(
      `buildMechListArgs: mechs.length=${mechs.length} exceeds 20 — ` +
      'FUN_0043A370 writes into parallel static arrays (stride 4/40/20 bytes). ' +
      'Array gap analysis: DAT_004dc510→DAT_004dc560 = 0x50 = 20 int slots. ' +
      'Entry 21 writes slot_info[20] into mech_id[0], corrupting the first mech. ' +
      'Cap the sender at 20 mechs.',
    );
  }
  const parts: Buffer[] = [
    encodeB85_1(typeFlag),          // 2 bytes: type_flag
    encodeAsByte(mechs.length),     // 1 byte:  count (FUN_00402f40 confirmed by capture; max 20)
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
 * Decode 3-byte type-2 value from client args buffer at given offset.
 * Encoding: FUN_00402be0(2, v) → 3 bytes, big-endian base-85.
 */
export function decodeArgType2(buf: Buffer, offset: number): [val: number, next: number] {
  const d0 = buf[offset]     - 0x21;
  const d1 = buf[offset + 1] - 0x21;
  const d2 = buf[offset + 2] - 0x21;
  return [d0 * 85 * 85 + d1 * 85 + d2, offset + 3];
}

/**
 * Decode 4-byte type-3 value from client args buffer at given offset.
 * Encoding: FUN_00402be0(3, v) → 4 bytes, big-endian base-85.
 */
export function decodeArgType3(buf: Buffer, offset: number): [val: number, next: number] {
  const d0 = buf[offset]     - 0x21;
  const d1 = buf[offset + 1] - 0x21;
  const d2 = buf[offset + 2] - 0x21;
  const d3 = buf[offset + 3] - 0x21;
  return [d0 * 85 ** 3 + d1 * 85 ** 2 + d2 * 85 + d3, offset + 4];
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

/**
 * Parse a client-sent world cmd-4 free-text frame.
 * RPS sender path: FUN_0040d280 -> FUN_00403100
 * Wire layout (args after cmd byte):
 *   [type1 2B: textLen] [raw text bytes]
 * Returns null if the frame is malformed or truncated.
 */
export function parseClientCmd4(
  payload: Buffer,
): { seq: number; text: string } | null {
  if (payload.length < 9 || payload[0] !== 0x1B) return null;
  const seq = payload[1] - 0x21;
  const cmd = payload[2] - 0x21;
  if (cmd !== 4) return null;

  const [textLen, offset] = decodeArgType1(payload, 3);
  const textEnd = offset + textLen;
  // Client frames end with 3 CRC bytes; trailing ESC is optional (verifyInboundGameCRC §3).
  if (textLen < 0 || textEnd + 3 > payload.length) return null;

  return {
    seq,
    text: payload.subarray(offset, textEnd).toString('latin1'),
  };
}

/**
 * Parse a client-sent world cmd-5 scene/action button frame.
 *
 * CONFIRMED from MPBTWIN.EXE FUN_00413790 / FUN_0040d2d0:
 *   server-provided Cmd4 scene option buttons call FUN_0040d2d0(option_type)
 *
 * Wire layout:
 *   [byte actionType]
 */
export function parseClientCmd5SceneAction(
  payload: Buffer,
): { seq: number; actionType: number } | null {
  // Client frames end with 3 CRC bytes; trailing ESC is optional
  // (verifyInboundGameCRC §3), so accept both CRC-only and CRC+ESC forms.
  if (payload.length < 7 || payload[0] !== 0x1B) {
    return null;
  }
  const seq = payload[1] - 0x21;
  const cmd = payload[2] - 0x21;
  if (cmd !== 5) return null;

  return {
    seq,
    actionType: payload[3] - 0x21,
  };
}

/**
 * Parse a client-sent world cmd-23 scene-location action.
 *
 * CONFIRMED from MPBTWIN.EXE FUN_00419390:
 *   the four main scene location icons send FUN_00403030(0x17) plus one
 *   encoded byte. Values 0..3 select an already-loaded target slot; values
 *   4..7 select the same slot but tell the server the target scene was not
 *   cached locally yet.
 */
export function parseClientCmd23LocationAction(
  payload: Buffer,
): { seq: number; action: number; slot: number; targetCached: boolean } | null {
  if (payload.length < 7 || payload[0] !== 0x1B || !verifyInboundGameCRC(payload)) {
    return null;
  }
  const seq = payload[1] - 0x21;
  const cmd = payload[2] - 0x21;
  if (cmd !== 23) return null;

  const action = payload[3] - 0x21;
  if (action < 0 || action > 7) return null;

  return {
    seq,
    action,
    slot: action & 3,
    targetCached: action < 4,
  };
}

// ── Combat client frames (cmd8 / cmd9 / cmd10 / cmd12) ───────────────────────

/** Raw decoded fields from client cmd8 (coasting: no throttle and no turning). */
export interface ClientCmd8Coasting {
  seq: number;
  xRaw: number;
  yRaw: number;
  headingRaw: number;
  turnMomRaw: number;
  rotationRaw: number;
}

/** Raw decoded fields from client cmd9 (moving: throttle or turning active). */
export interface ClientCmd9Moving extends ClientCmd8Coasting {
  neutralRaw: number;
  throttleRaw: number;
  legVelRaw: number;
}

/** Raw decoded fields from client cmd10 weapon-fire geometry. */
export interface ClientCmd10WeaponFire {
  seq: number;
  /** Weapon slot/source slot written by Combat_WriteCmd10ShotGeometry_v123. */
  weaponSlot: number;
  /** Target server slot, or -1 when no target is locked. */
  targetSlot: number;
  /** Target attachment site, or -1 when no attachment was resolved. */
  targetAttach: number;
  angleSeedA: number;
  angleSeedB: number;
  impactXRaw: number;
  impactYRaw: number;
  impactZ: number;
}

/** Raw decoded fields from client cmd12 combat action. */
export interface ClientCmd12Action {
  seq: number;
  action: number;
}

/** Parse a client-sent combat cmd8 coasting movement frame. */
export function parseClientCmd8Coasting(payload: Buffer): ClientCmd8Coasting | null {
  if (payload.length < 21 || payload[0] !== 0x1B) return null;
  if (payload[2] - 0x21 !== 8) return null;
  let off = 3;
  let xRaw: number, yRaw: number, headingRaw: number, turnMomRaw: number, rotationRaw: number;
  [xRaw,       off] = decodeArgType3(payload, off);
  [yRaw,       off] = decodeArgType3(payload, off);
  [headingRaw, off] = decodeArgType2(payload, off);
  [turnMomRaw, off] = decodeArgType1(payload, off);
  [rotationRaw,   ] = decodeArgType1(payload, off);
  return { seq: payload[1] - 0x21, xRaw, yRaw, headingRaw, turnMomRaw, rotationRaw };
}

/** Parse a client-sent combat cmd9 moving frame. */
export function parseClientCmd9Moving(payload: Buffer): ClientCmd9Moving | null {
  if (payload.length < 27 || payload[0] !== 0x1B) return null;
  if (payload[2] - 0x21 !== 9) return null;
  let off = 3;
  let xRaw: number, yRaw: number, headingRaw: number;
  let turnMomRaw: number, neutralRaw: number, throttleRaw: number, legVelRaw: number, rotationRaw: number;
  [xRaw,        off] = decodeArgType3(payload, off);
  [yRaw,        off] = decodeArgType3(payload, off);
  [headingRaw,  off] = decodeArgType2(payload, off);
  [turnMomRaw,  off] = decodeArgType1(payload, off);
  [neutralRaw,  off] = decodeArgType1(payload, off);
  [throttleRaw, off] = decodeArgType1(payload, off);
  [legVelRaw,   off] = decodeArgType1(payload, off);
  [rotationRaw,    ] = decodeArgType1(payload, off);
  return {
    seq: payload[1] - 0x21,
    xRaw, yRaw, headingRaw,
    turnMomRaw, neutralRaw, throttleRaw, legVelRaw, rotationRaw,
  };
}

/** Parse one bundled shot subrecord inside a client-sent combat cmd10 frame. */
function parseClientCmd10WeaponFireRecord(
  payload: Buffer,
  seq: number,
  offset: number,
): [ClientCmd10WeaponFire, number] | null {
  let off = offset;
  if (off + 18 > payload.length) return null;
  const weaponSlot = payload[off] - 0x21; off += 1;
  const targetSlot = payload[off] - 0x22; off += 1;
  const targetAttach = payload[off] - 0x22; off += 1;
  let angleSeedA: number, angleSeedB: number, impactXRaw: number, impactYRaw: number, impactZ: number;
  [angleSeedA, off] = decodeArgType1(payload, off);
  [angleSeedB, off] = decodeArgType1(payload, off);
  [impactXRaw, off] = decodeArgType3(payload, off);
  [impactYRaw, off] = decodeArgType3(payload, off);
  [impactZ, off] = decodeArgType2(payload, off);
  return [{
    seq,
    weaponSlot,
    targetSlot,
    targetAttach,
    angleSeedA,
    angleSeedB,
    impactXRaw,
    impactYRaw,
    impactZ,
  }, off];
}

/** Parse a client-sent combat cmd10 weapon-fire frame, including bundled TIC subrecords. */
export function parseClientCmd10WeaponFire(payload: Buffer): ClientCmd10WeaponFire[] | null {
  if (payload.length < 24 || payload[0] !== 0x1B) return null;
  if (payload[2] - 0x21 !== 10) return null;

  const seq = payload[1] - 0x21;
  const hasTrailingEsc = payload[payload.length - 1] === 0x1B;
  const crcOffset = payload.length - (hasTrailingEsc ? 4 : 3);
  if (crcOffset <= 3) return null;

  const shots: ClientCmd10WeaponFire[] = [];
  let off = 3;
  while (off < crcOffset) {
    const parsed = parseClientCmd10WeaponFireRecord(payload, seq, off);
    if (!parsed) return null;
    const [shot, next] = parsed;
    shots.push(shot);
    off = next;
    if (off === crcOffset) break;
    if (payload[off] !== 0x2B) return null;
    off += 1;
  }

  return shots.length > 0 ? shots : null;
}

/** Parse a client-sent combat cmd12 action frame. */
export function parseClientCmd12Action(payload: Buffer): ClientCmd12Action | null {
  if (payload.length < 7 || payload[0] !== 0x1B) return null;
  if (payload[2] - 0x21 !== 12) return null;
  return {
    seq: payload[1] - 0x21,
    action: payload[3] - 0x21,
  };
}

/**
 *
 * CONFIRMED from MPBTWIN.EXE FUN_0042dbf0 -> FUN_0040d400:
 *   [subcmd byte == 1] [encodeString typed_name] [selected-index byte]
 */
export function parseClientCmd9CharacterCreationReply(
  payload: Buffer,
): { seq: number; subcmd: number; displayName: string; selection: number } | null {
  // Trailing ESC is optional — accept both CRC-only and CRC+ESC endings.
  if (payload.length < 10 || payload[0] !== 0x1B) {
    return null;
  }
  const seq = payload[1] - 0x21;
  const cmd = payload[2] - 0x21;
  if (cmd !== 9) return null;

  const subcmd = payload[3] - 0x21;
  const textLen = payload[4] - 0x21;
  const textStart = 5;
  const textEnd = textStart + textLen;
  // Selection byte + 3 CRC bytes must remain; trailing ESC is optional.
  if (textLen < 0 || textEnd + 4 > payload.length) return null;

  return {
    seq,
    subcmd,
    displayName: payload.subarray(textStart, textEnd).toString('latin1'),
    selection: payload[textEnd] - 0x21,
  };
}

/**
 * Parse a client-sent cmd-10 map/location reply.
 *
 * CONFIRMED from MPBTWIN.EXE MapOpenInnerSphere / MapOpenSolaris:
 *   map selection sends FUN_0040d360(contextId, selectedRoomId + 1)
 *   cancel sends FUN_0040d360(contextId, 0)
 *
 * Wire layout:
 *   [type1 context/list id] [type4 selection value]
 */
export function parseClientCmd10MapReply(
  payload: Buffer,
): { seq: number; contextId: number; selection: number; selectedRoomId?: number } | null {
  // Trailing ESC is optional — accept both CRC-only and CRC+ESC endings.
  if (payload.length < 13 || payload[0] !== 0x1B) {
    return null;
  }
  const seq = payload[1] - 0x21;
  const cmd = payload[2] - 0x21;
  if (cmd !== 10) return null;

  const [contextId, o1] = decodeArgType1(payload, 3);
  const [selection, _o] = decodeArgType4(payload, o1);
  return {
    seq,
    contextId,
    selection,
    selectedRoomId: selection > 0 ? selection - 1 : undefined,
  };
}

/**
 * Parse a client-sent cmd-21 editable-text reply.
 *
 * CONFIRMED by MPBTWIN.EXE:
 *   local compose builder FUN_00416db0 submits cmd 21 via FUN_00418760:
 *     [type4 dialog_id] [raw-string via FUN_00403100]
 *
 * The dialog itself may be opened locally by the `listId=1000` inquiry submenu
 * or by server command 37 (`FUN_00416d40`), which wraps FUN_00416db0.
 */
export function parseClientCmd21TextReply(
  payload: Buffer,
): { seq: number; dialogId: number; text: string } | null {
  // Client game frames arrive here without a decoded inner 0x20 separator byte.
  // The packet body is:
  //   [0x1B ESC] [seq] [cmd] [type4 dialog/count] [type1 text_len] [text] [crc x3] [0x1B ESC]
  // A live first-login Cmd37(0) probe on 2026-04-06 confirmed that zero-target
  // cmd-21 replies end exactly with CRC+ESC after the text payload.
  // Trailing ESC is optional — accept both CRC-only and CRC+ESC endings.
  if (payload.length < 14 || payload[0] !== 0x1B) {
    return null;
  }
  const seq = payload[1] - 0x21;
  const cmd = payload[2] - 0x21;
  if (cmd !== 21) return null;

  let offset = 3;
  let textLen = 0;
  let dialogId = 0;
  [dialogId, offset] = decodeArgType4(payload, offset);
  [textLen, offset] = decodeArgType1(payload, offset);

  const textEnd = offset + textLen;
  // 3 CRC bytes must remain after the raw text bytes; trailing ESC is optional.
  if (textLen < 0 || textEnd + 3 > payload.length) return null;

  return {
    seq,
    dialogId,
    text: payload.subarray(offset, textEnd).toString('latin1'),
  };
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

// ── Command 36 — Read / Reply message view (server→client) ──────────────────
// CONFIRMED from MPBTWIN.EXE FUN_004161a0:
//
// Wire layout (args after seq+cmd bytes):
//   [type4 5B: dialog_id]
//   [strlen 2B: text_len via FUN_00402be0(1)]
//   [text_len bytes: raw text]
//
// dialog_id == 0:
//   opens a read-only text page with Enter / optional paging controls.
// dialog_id != 0:
//   opens the same page but adds Reply; pressing R reopens the local compose
//   builder FUN_00416db0(dialog_id, NULL), and that later emits cmd 21.

export function buildCmd36MessageViewArgs(dialogId: number, text: string): Buffer {
  return Buffer.concat([
    encodeB85_4(dialogId),
    encodeB85LengthString(text),
  ]);
}

export function buildCmd36MessageViewPacket(
  dialogId: number,
  text: string,
  seq = 0,
): Buffer {
  return buildGamePacket(36, buildCmd36MessageViewArgs(dialogId, text), false, seq);
}

// ── Command 37 — Open ComStar compose editor (server→client) ─────────────────
// CONFIRMED from FUN_00416d40 (Cmd37_OpenCompose) RE (RESEARCH.md §18 table).
//
// Wire layout: [type4 5B: target_id]
// If 0 < target_id < 1000 → count mode.  For >= 1000 → single target identifier.
// All our comstarIds are 100000+ so single-target is always the right path.

/** Build a Cmd37 packet to open the local ComStar compose editor pre-addressed to `targetId`. */
export function buildCmd37OpenComposePacket(targetId: number, seq = 0): Buffer {
  return buildGamePacket(37, encodeB85_4(targetId), false, seq);
}

// ── Command 20 — Text dialog (server→client) ──────────────────────────────────
// CONFIRMED from Cmd20_ParseTextDialog (FUN_00411D90) + FUN_00411a10 RE.
// See RESEARCH.md §14.
//
// Wire layout (args after seq+cmd bytes):
//   [type1  2B: dialog_id]   FUN_0040d4c0 → FUN_00402b10(1)  — base-85(1)
//   [byte   1B: mode]        FUN_00402f40                     — (mode + 0x21)
//   [strlen 2B: text_len]    FUN_0040c130 → FUN_00403200 → FUN_00402b10(1)
//   [text_len bytes: raw text content]                        — latin1, use 0x5C ('\\') as line separator
//
// IMPORTANT: the string uses base-85(1) length prefix (encodeB85_1), NOT the
// 1-byte encodeString prefix.  encodeString is only correct for cmd-26 strings
// read by FUN_0040c0d0, which uses a different 1-byte reader (FUN_00402f40).
// Using encodeString here makes the client decode 2 bytes as a huge length (>1700)
// and immediately return -1 ("RPS command 20 failed.").
//
// Modes (confirmed by FUN_00411a10 decompile):
//   mode=0 → "Yes"/"No" dialog variant A (NOT for stats; do not use)
//   mode=1 → "Yes"/"No" dialog variant B (NOT for stats; do not use)
//   mode=2 → text dialog with "Ok" button — use this for mech stats
//
// Mode=2 behaviour (FUN_00411a10, param_4==2 branch):
//   • If text[0]=='#', expands NNN digits → DAT_00473ad8[n] → MPBT.MSG line
//   • Sets DAT_004dde61 = 0x5C (line separator used by FUN_00433310)
//   • Passes text to FUN_00433310 which renders it, splitting on 0x5C ('\\')
//     (0x8D is wrong: FUN_00431e00 treats it as signed-char −115 → font-width
//      table index −460 → memory corruption / hang)
//   • Creates "Ok" button; sets dialog flags=9, callback=FUN_00419370
//
// One packet is all that is needed — send mode=2 with the complete text directly.

/** Build args for a single server cmd-20 (text-dialog) frame. */
export function buildCmd20Args(dialogId: number, mode: number, text: string): Buffer {
  const raw = Buffer.from(text, 'latin1');
  if (raw.includes(0x1b)) throw new RangeError('buildCmd20Args: text must not contain ESC (0x1B)');
  if (raw.length > 84) throw new RangeError(`buildCmd20Args: text too long (${raw.length} > 84)`);
  return Buffer.concat([
    encodeB85_1(dialogId),  // 2 bytes: dialog_id  via FUN_0040d4c0 → FUN_00402b10(1)
    encodeAsByte(mode),     // 1 byte:  mode        via FUN_00402f40
    encodeB85_1(raw.length), // 2 bytes: text length via FUN_0040c130 → FUN_00402b10(1)
    raw,                    // N bytes: raw text; use 0x5C ('\\') as line separator
                            // FUN_00433310 NULs '\\' in staging buf before FUN_00431f10;
                            // 0x8D is wrong: FUN_00431e00 treats it as signed-char -115
                            // → font-width table index -460 → bad memory / hang
  ]);
}

/**
 * Build a full ARIES packet for server command 20 (text dialog).
 * @param dialogId  Dialog/panel identifier for this cmd-20 frame (see RE notes / §14).
 *                  Do not apply cmd-7 list_id reserved-ID guidance here; cmd-20 reserved
 *                  IDs are separate and not yet fully confirmed by RE.
 * @param mode      Dialog mode (confirmed by FUN_00411a10 RE):
 *                  0 and 1 create Yes/No dialog variants (not for stats display);
 *                  2 creates a single-packet Ok-style text dialog — use this for mech stats.
 * @param text      Dialog text payload. For mode 2 this is the stats text (use 0x5C
 *                  '\\' as line separator); modes 0/1 produce Yes/No dialogs and this
 *                  field is not used for stats display.
 * @param seq       Sequence number 0..42.
 */
export function buildCmd20Packet(
  dialogId: number,
  mode:     number,
  text:     string,
  seq      = 0,
): Buffer {
  return buildGamePacket(20, buildCmd20Args(dialogId, mode, text), false, seq);
}

// ── REDIRECT (ARIES type 0x03) ────────────────────────────────────────────────
// CONFIRMED by COMMEG32.DLL REDIRECT dispatch case 3:
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
