/**
 * Auth handler — ARIES login sequence.
 *
 * Protocol (CONFIRMED by RE of COMMEG32.DLL):
 *
 *   1. Server sends LOGIN_REQUEST (type 0x16) immediately on connect.
 *      Payload: empty (0 bytes).
 *
 *   2. Client calls FUN_10001420 which builds and sends a LOGIN packet
 *      (type 0x15) with a 12-byte ARIES header + payload from DAT_1001f888.
 *
 *   3. Server parses the payload:
 *        +0x000  username      null-terminated, field width ~112 bytes
 *        +0x070  client ver    80-byte field; v1.06: "Kesmai Comm Engine 3.22"
 *                              v1.23: "Kesmai CommEngine 3.29" (no space; version bump)
 *        +0x0C0  email handle  40 bytes
 *        +0x0E8  service id    SetInternet() value, 80 bytes (e.g. "BATTLETECH")
 *        +0x13C  product port  htons(product_code), 2 bytes
 *        +0x13E  0x39          constant written by FUN_100011c0
 *        +0x13F  server ident  SetServerIdent() first byte
 *        +0x140  4 × 0x00      cleared by FUN_100011c0
 *        +0x142  pw_len        htons(strlen(password)), 2 bytes
 *        +0x144  password      null-terminated password string
 *      Total payload = strlen(password) + 325 bytes.
 *
 *   4. After verifying credentials the server sends a SYNC packet (type 0x00)
 *      with a 4-byte timestamp tag.  The client's FUN_100014e0 case-0 handler
 *      forwards raw recv-buffer contents to the game window via WM 0x7f0.
 */

import type { ClientSession } from '../state/players.js';
import { hexDump, buildPacket } from './aries.js';
import { Msg } from './constants.js';
import type { Logger } from '../util/logger.js';

// ── Layout constants (payload offsets) ────────────────────────────────────────
// All CONFIRMED by RE of COMMEG32.DLL Set*() export functions and FUN_10001420.
const OFF_USERNAME   = 0x000; // null-terminated, up to 64 chars, field ~112 bytes wide
const OFF_CLIENT_VER = 0x070; // 80-byte client version string field
                              // v1.06: "Kesmai Comm Engine 3.22"
                              // v1.23: "Kesmai CommEngine 3.29" (no space; COMMEG32 bump)
const OFF_EMAIL      = 0x0C0; // SetUserEmailHandle() value — 40-byte field
const OFF_SERVICE    = 0x0E8; // SetInternet() value — 80-byte field
const OFF_PORT       = 0x13C; // htons(product_code) as uint16
const OFF_PW_LEN     = 0x142; // htons(strlen(password)) as uint16
const OFF_PASSWORD   = 0x144; // password string, null-terminated

/** Minimum sane payload size (header written even for very short passwords). */
const MIN_PAYLOAD = OFF_PASSWORD + 1; // at least 1 byte for null terminator

export interface LoginPacket {
  username:   string;
  password:   string;
  clientVer:  string;
  email:      string;
  serviceId:  string;
  productPort: number;
}

export type AuthResult =
  | { ok: true;  login: LoginPacket }
  | { ok: false; reason: string };

/**
 * Parse a type-0x15 login packet payload.
 *
 * Returns null if the payload is too short (wait for more data).
 * Returns AuthResult once a structurally complete packet is present.
 */
export function parseLoginPayload(
  payload: Buffer,
  log: Logger,
): AuthResult | null {
  log.debug('[auth] login payload len=%d\n%s', payload.length, hexDump(payload));

  if (payload.length < MIN_PAYLOAD) {
    log.debug('[auth] payload too short (%d < %d), waiting', payload.length, MIN_PAYLOAD);
    return null;
  }

  const readStr = (offset: number, maxLen: number): string => {
    const end = Math.min(offset + maxLen, payload.length);
    let nullPos = payload.indexOf(0, offset);
    if (nullPos < 0 || nullPos > end) nullPos = end;
    return payload.subarray(offset, nullPos).toString('ascii');
  };

  const username   = readStr(OFF_USERNAME,   112);
  const clientVer  = readStr(OFF_CLIENT_VER, 80);
  const email      = readStr(OFF_EMAIL,      40);
  const serviceId  = readStr(OFF_SERVICE,    80);
  const productPort = payload.length > OFF_PORT + 1
    ? payload.readUInt16BE(OFF_PORT) // stored as htons (big-endian on wire)
    : 0;

  // Password: htons(strlen) at OFF_PW_LEN, followed by null-terminated string.
  let password = '';
  if (payload.length > OFF_PW_LEN + 1) {
    const pwLenBE = payload.readUInt16BE(OFF_PW_LEN); // htons value
    const pwLen   = ((pwLenBE & 0xff) << 8 | (pwLenBE >> 8)) & 0xffff; // ntohs
    password = readStr(OFF_PASSWORD, Math.max(pwLen, 4096));
  }

  log.info('[auth] login from "%s" ver="%s" service="%s" pwLen=%d',
    username, clientVer, serviceId, password.length);

  return {
    ok: true,
    login: { username, password, clientVer, email, serviceId, productPort },
  };
}

/**
 * Build the LOGIN_REQUEST packet (type 0x16).
 * Server sends this immediately on connect; COMMEG32 responds by calling
 * FUN_10001420 which builds and sends the type-0x15 LOGIN packet.
 */
export function buildLoginRequest(): Buffer {
  return buildPacket(Msg.LOGIN_REQUEST, Buffer.alloc(0));
}

/**
 * Build a SYNC packet (type 0x00) used as login acknowledgment.
 * COMMEG32 case-0 handler reads the "tag" field as a timestamp and forwards
 * the raw payload to the game window via WM 0x7f0.
 */
export function buildSyncAck(timestampMs: number): Buffer {
  return buildPacket(Msg.SYNC, Buffer.alloc(0), timestampMs >>> 0);
}

/**
 * The welcome escape string the game's FUN_00429a00 expects after SYNC.
 *
 * CONFIRMED by Ghidra inspection of DAT_00474d48 in MPBTWIN.EXE:
 *   hex: 1B 3F 4D 4D 57 20 43 6F 70 79 72 69 67 68 74 20
 *        4B 65 73 6D 61 69 20 43 6F 72 70 2E 20 31 39 39 31
 *
 * When FUN_00429a00 accumulates these bytes and the buffer matches DAT_00474d48,
 * it sets DAT_004e2de8 = 1, which unlocks the main game loop (calls FUN_00433ef0,
 * FUN_00429580, etc.).  The "MMW" variant is the normal Windows login path;
 * the "MMC" variant (DAT_00474d70) triggers FUN_00429620 instead.
 *
 * Delivered as a type-0x00 (SYNC/data) packet so COMMEG32 fires WM 0x7f0.
 */
export const WELCOME_ESCAPE = '\x1b?MMW Copyright Kesmai Corp. 1991';

/**
 * Build the welcome packet (type 0x00, payload = WELCOME_ESCAPE).
 * Sent immediately after the initial empty SYNC to advance the game past
 * the escape-sequence gate in FUN_00429a00.
 */
export function buildWelcomePacket(): Buffer {
  return buildPacket(Msg.SYNC, Buffer.from(WELCOME_ESCAPE, 'ascii'));
}
