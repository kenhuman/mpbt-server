/**
 * World-server protocol encoder — game world (RPS) commands.
 *
 * Commands in the RPS dispatch table (DAT_00470198) that the server sends
 * after the world handshake to initialize and operate the game world.
 *
 * Frame format:  identical to lobby (see src/protocol/game.ts buildGameFrame).
 * CRC mode:      RPS — seed 0x0A5C25 (DAT_004e2cd0 = 0 on MMW path; never changes).
 * Command index: 0-based; wire byte = index + 0x21.
 *
 * Confirmed by Ghidra RE of MPBTWIN.EXE; individual handlers documented below.
 */

import {
  buildGamePacket,
  encodeAsByte,
  encodeB85_1,
  encodeString,
} from './game.js';

function encodeB85_4(v: number): Buffer {
  const digits = new Array<number>(5);
  let current = v;
  for (let i = 4; i >= 0; i -= 1) {
    digits[i] = current % 85;
    current = Math.floor(current / 85);
  }
  return Buffer.from(digits.map(digit => digit + 0x21));
}

// ── Cmd 3 — Text Broadcast ────────────────────────────────────────────────────
// CONFIRMED: FUN_0040C190 handler; RPS mode only.
//
// Wire args (after seq+cmd bytes):
//   [FUN_0040c130 format: encodeB85_1(len) + raw bytes]
//
// Displays the text in the chat scroll-window (g_chatScroll, DAT_00472c90).
// Only effective after g_chatReady = 1, which is set at the end of Cmd4_SceneInit.
// Use after Cmd4 to deliver a welcome message.

function buildCmd3Args(text: string): Buffer {
  const raw = Buffer.from(text, 'latin1');
  if (raw.includes(0x1b)) throw new RangeError('buildCmd3Args: text must not contain ESC (0x1B)');
  return Buffer.concat([encodeB85_1(raw.length), raw]);
}

/** Build a Cmd3 TextBroadcast packet (chat message to client). */
export function buildCmd3BroadcastPacket(text: string, seq = 0): Buffer {
  return buildGamePacket(3, buildCmd3Args(text), false, seq);
}

// ── Cmd 4 — Scene Init ────────────────────────────────────────────────────────
// CONFIRMED by decompiling FUN_00414B70 in MPBTWIN.EXE.
//
// This is the principal "enter arena" command.  It creates the main game window
// (DAT_004ddf60), the chat scroll-window (DAT_00472c90), the scoreboard boxes,
// and mech-slot buttons for any opponents.  Sets g_chatReady = 1 at completion.
// Cmd3_TextBroadcast and most other world commands are silently dropped before
// g_chatReady is set, so Cmd4 MUST be sent before any chat/game commands.
//
// Wire args layout (immediately after seq+cmd bytes; CRC seed 0x0A5C25):
//
//   [type1 2B: match_id]          FUN_00402b10(1)  → DAT_004812e0
//   [byte:     session_flags]     FUN_00402f40     → DAT_0048a068
//                                  bit 0x10 = has-opponents (controls branch below)
//                                  bit 0x20 = clear arena data (memsets DAT_00481a48 region)
//   [byte:     player_score_slot] FUN_00402f40     → DAT_00472c8c (row in score table)
//   [type1 2B: player_mech_id]    FUN_00402b10(1)  → (&DAT_00481a4c)[slot * 0xaa]
//
//   IF session_flags & 0x10 (has-opponents branch):
//     [byte × 4: opp_type[i] + 1]        FUN_00402f40 ×4 → stored as (val - 1)
//                                          "no opponent" → stored -1 → wire byte 0x21
//     [type1 2B × 4: opp_mech_id[i] + 1] FUN_00402b10(1) ×4 → stored as (val - 1)
//                                          "no opponent" → stored -1 → wire [0x21, 0x21]
//     [Frame_ReadArg: callsign]           FUN_0040c0d0 = encodeString format (1B len + raw)
//     [Frame_ReadString: scene_name]      FUN_0040c130 = encodeB85_1(len) + raw bytes
//   ELSE (no-opponents branch):
//     (no additional wire bytes — callsign copied from prev stored data in DAT_00481a70)
//
//   [byte: arena_option_count]    FUN_00402f40 → DAT_004e6a70
//   [loop arena_option_count times:
//     [byte: option_type]         FUN_00402f40
//     [Frame_ReadArg: option_str] FUN_0040c0d0 = encodeString format
//   ]
//
// Opponent slot handling:
//   After parsing, (&DAT_00481a60)[slot * 0xaa + i] == -1 → FUN_0042ffb0 hides button.
//   Otherwise the slot is populated with mech icon + callsign + scoreboard row.
//   For M3 (solo connection) send all 4 opponent slots as "no opponent".

export interface OpponentEntry {
  /** Opponent type (0-based; stored on client as val - 1; wire = type + 1). */
  type: number;
  /** Opponent mech ID (0-based; stored on client as val - 1; wire = mechId + 1). */
  mechId: number;
}

export interface Cmd4Options {
  /**
   * Match/connection identifier sent as type1(2B).
   * Purpose unknown; use 0 until RE clarifies.
   */
  matchId?: number;
  /**
   * Session flags byte:
   *   0x10 = has-opponents (triggers opponent/callsign/scene reads from wire)
   *   0x20 = clear arena data (client memsets its arena data block on receipt)
   * Default: 0x30 (both flags; fresh arena entry with opponent reads enabled).
   */
  sessionFlags?: number;
  /** Player's row in the score table (0-based, DAT_00472c8c). Default: 0. */
  playerScoreSlot?: number;
  /** Player's mech ID (type1 2B, sent to (&DAT_00481a4c)[slot * 0xaa]). */
  playerMechId: number;
  /**
   * Opponent entries (up to 4).
   * Missing/extra entries are zero-padded → stored as -1 → button hidden.
   * Only used when sessionFlags & 0x10 is set.
   */
  opponents?: OpponentEntry[];
  /**
   * Player callsign string (FUN_0040c0d0 / encodeString format; max 84 bytes).
   * Required when sessionFlags & 0x10 is set.
   * Displayed as the window title alongside the scene name.
   */
  callsign?: string;
  /**
   * Arena / scene name string (FUN_0040c130 / encodeB85_1 format).
   * Required when sessionFlags & 0x10 is set.
   * Displayed as the window title alongside the callsign.
   */
  sceneName?: string;
  /**
   * Arena option entries (displayed as action buttons; mostly unknown for M3).
   * Default: empty.
   */
  arenaOptions?: Array<{ type: number; label: string }>;
}

function buildCmd4Args(opts: Cmd4Options): Buffer {
  const matchId   = opts.matchId ?? 0;
  const flags     = opts.sessionFlags ?? (0x10 | 0x20);
  const scoreSlot = opts.playerScoreSlot ?? 0;
  const hasOpps   = (flags & 0x10) !== 0;

  const parts: Buffer[] = [
    encodeB85_1(matchId),           // [type1 2B: match_id]
    encodeAsByte(flags),            // [byte:     session_flags]
    encodeAsByte(scoreSlot),        // [byte:     player_score_slot]
    encodeB85_1(opts.playerMechId), // [type1 2B: player_mech_id]
  ];

  if (hasOpps) {
    // 4 × opponent type (wire = type+1; FUN_00402f40 decodes → stored as val-1)
    // "no opponent" entry: type -1 intended → stored -1 → wire val = 0 → encodeAsByte(0)
    for (let i = 0; i < 4; i++) {
      const opp = opts.opponents?.[i];
      // opp.type is 0-based; stored = wire_val - 1; wire_val = opp.type + 1
      // "no opponent": we want stored = -1 → wire_val = 0 → encodeAsByte(0)
      parts.push(encodeAsByte(opp ? opp.type + 1 : 0));
    }
    // 4 × opponent mech_id (wire = mechId+1; stored as val-1)
    // "no opponent": mechId -1 → stored -1 → wire val = 0 → encodeB85_1(0) = [0x21,0x21]
    for (let i = 0; i < 4; i++) {
      const opp = opts.opponents?.[i];
      parts.push(encodeB85_1(opp ? opp.mechId + 1 : 0));
    }
    // Callsign via FUN_0040c0d0 (encodeString: 1B length + raw bytes)
    parts.push(encodeString((opts.callsign ?? '').slice(0, 84)));
    // Scene name via FUN_0040c130 (encodeB85_1(len) + raw bytes)
    const sceneRaw = Buffer.from((opts.sceneName ?? ''), 'latin1');
    if (sceneRaw.includes(0x1b)) throw new RangeError('buildCmd4Args: scene name must not contain ESC');
    parts.push(encodeB85_1(sceneRaw.length), sceneRaw);
  }

  // Arena options
  const arenaOpts = opts.arenaOptions ?? [];
  parts.push(encodeAsByte(arenaOpts.length));
  for (const ao of arenaOpts) {
    parts.push(encodeAsByte(ao.type));
    parts.push(encodeString(ao.label.slice(0, 84)));
  }

  return Buffer.concat(parts);
}

/**
 * Build a Cmd4 (SceneInit) packet.
 *
 * This creates the arena window, chat window, and scoreboard on the client.
 * Must be sent before Cmd3, Cmd9, or any other in-world commands.
 * g_chatReady is set to 1 at the END of the client's Cmd4 handler.
 */
export function buildCmd4SceneInitPacket(opts: Cmd4Options, seq = 0): Buffer {
  return buildGamePacket(4, buildCmd4Args(opts), false, seq);
}

// ── Cmd 5 — Cursor Normal ────────────────────────────────────────────────────
// CONFIRMED: FUN_0040C2F0 → FUN_00433ec0 → loads IDC_ARROW cursor (0x7f00).
// No wire args.

/** Restore cursor to IDC_ARROW (normal). Send when world loading completes. */
export function buildCmd5CursorNormalPacket(seq = 0): Buffer {
  return buildGamePacket(5, Buffer.alloc(0), false, seq);
}

// ── Cmd 6 — Cursor Busy ──────────────────────────────────────────────────────
// CONFIRMED: FUN_0040C300 → FUN_00433ef0 → loads IDC_WAIT cursor (0x7f02).
// No wire args.

/** Switch cursor to IDC_WAIT (hourglass). Send before world init to signal loading. */
export function buildCmd6CursorBusyPacket(seq = 0): Buffer {
  return buildGamePacket(6, Buffer.alloc(0), false, seq);
}

// ── Cmd 9 — Room Player List ─────────────────────────────────────────────────
// CONFIRMED: FUN_0040C310.
//
// Wire args:
//   [byte: sentinel]          FUN_00402f40 — must be 1 to trigger processing
//   [byte: count]             FUN_00402f40
//   [count × Frame_ReadArg]   FUN_0040c0d0 = encodeString format per entry
//
// Each entry is stored into DAT_004de000[i] as a null-terminated string in a
// 40-byte slot. FUN_0042daa0 later formats the entries as "%d. %s", so the
// initial room list is a plain string roster rather than a richer binary
// struct.

/**
 * Build a Cmd9 (RoomPlayerList) packet.
 * @param entries  Raw player entry strings (format TBD; leave empty for M3).
 */
export function buildCmd9RoomPlayerListPacket(entries: string[] = [], seq = 0): Buffer {
  const parts: Buffer[] = [
    encodeAsByte(1),              // sentinel = 1 (gate: == '\x01')
    encodeAsByte(entries.length), // count
  ];
  for (const e of entries) {
    parts.push(encodeString(e.slice(0, 84)));
  }
  return buildGamePacket(9, Buffer.concat(parts), false, seq);
}

// ── Cmd 11 — Player Event ────────────────────────────────────────────────────
// CONFIRMED: FUN_0040C6C0.
//
// Wire args:
//   [type4: roster/session id]
//   [byte: status]
//   [Frame_ReadArg: callsign]
//
// Minimal useful status for M4:
//   0 = left room / departed

/** Build a Cmd11 player-event packet. */
export function buildCmd11PlayerEventPacket(
  rosterId: number,
  status: number,
  callsign: string,
  seq = 0,
): Buffer {
  return buildGamePacket(
    11,
    Buffer.concat([
      encodeB85_4(rosterId),
      encodeAsByte(status),
      encodeString(callsign.slice(0, 84)),
    ]),
    false,
    seq,
  );
}

// ── Cmd 13 — Player Arrival ──────────────────────────────────────────────────
// CONFIRMED: FUN_0040C920.
//
// Wire args:
//   [type4: roster/session id]
//   [Frame_ReadArg: callsign]

/** Build a Cmd13 player-arrival packet. */
export function buildCmd13PlayerArrivalPacket(
  rosterId: number,
  callsign: string,
  seq = 0,
): Buffer {
  return buildGamePacket(
    13,
    Buffer.concat([
      encodeB85_4(rosterId),
      encodeString(callsign.slice(0, 84)),
    ]),
    false,
    seq,
  );
}
