/**
 * ARIES protocol constants for Multiplayer BattleTech: Solaris.
 *
 * All values here are PROVISIONAL until confirmed by Ghidra analysis of
 * COMMEG32.DLL and INITAR.DLL.  Mark each constant with its confidence level:
 *   CONFIRMED  — verified by Ghidra cross-reference or packet capture
 *   LIKELY     — strongly inferred from strings / error messages
 *   UNKNOWN    — placeholder; must be determined by RE
 */

// ── Network ──────────────────────────────────────────────────────────────────

/**
 * TCP port the client connects to.
 * CONFIRMED — port is read from play.pcgi [launch] product = <N> by INITAR.DLL,
 * which calls _atoi(product) and passes the integer to COMMEG32.SetProductCode(N),
 * which stores htons(N) in sockaddr_in.sin_port. play.pcgi is set to 2000 for dev.
 * (Original Kesmai server port unknown; the client connects to whatever is in play.pcgi.)
 */
export const ARIES_PORT = 2000; // CONFIRMED — controlled by play.pcgi product field

/**
 * TCP port chosen for the game-world connection (post-REDIRECT).
 *
 * CONFIRMED by RE of Aries_OpenSocket (COMMEG32.DLL func_0x10001d80):
 *   func_0x10005ee0(addr, 0x3a) = strchr(addr, ':')   // splits "host:port"
 *   If ':' not found → returns -1 immediately (connection fails silently)
 *   Port string is parsed via func_0x10011012 (strings → number)
 *
 * The addr field in REDIRECT must be in "host:port" format.
 * CONFIRMED — src/server-world.ts listens on this port; lobby REDIRECT carries "host:2001".
 */
export const WORLD_PORT = 2001; // CONFIRMED — world server listener; value comes from REDIRECT addr field

/**
 * Maximum raw receive buffer per read.
 */
export const RECV_BUFFER_SIZE = 4096;

// ── Packet framing ────────────────────────────────────────────────────────────
// CONFIRMED — 12-byte fixed header followed by variable-length payload.
//
//   Bytes [0-3]   uint32 LE  message type
//   Bytes [4-7]   uint32 LE  "tag" — timestamp or sequence; 0 in most client msgs
//   Bytes [8-11]  uint32 LE  payload length (byte count following the header)
//   Bytes [12...]            payload (payload_length bytes)
//
// Confirmed by RE of COMMEG32.DLL FUN_10003600 (build header) and
// FUN_100036d0 (parse header) and FUN_10003680 (finalise length field).
// The parser also handles a legacy 4-byte format (type[3] != 0) returning 0x1e.

// ── Message types (bidirectional) ─────────────────────────────────────────────
// All values CONFIRMED by COMMEG32.DLL FUN_100014e0 switch() dispatch table
// and FUN_10001420 (login packet sender).
export enum Msg {
  // Server → Client
  SYNC          = 0x00, // CONFIRMED — timing sync; triggers WM 0x7f0 in game
  CONN_CLOSE    = 0x01, // CONFIRMED — server closes connection gracefully
  CONN_ERROR    = 0x02, // CONFIRMED — server signals error
  REDIRECT      = 0x03, // CONFIRMED — redirect: 120-byte payload [addr40|internet40|pw40]
  KEEPALIVE     = 0x05, // CONFIRMED — keepalive/ping (echoed back by client)
  LOGIN_REQUEST = 0x16, // CONFIRMED — server requests login; client sends LOGIN in response
  TEXT_MSG      = 0x1a, // CONFIRMED — server text; shows as "MPBT Fatal Error" dialog then quit
  CHAR_LIST     = 0x1e, // CONFIRMED — 12-byte char/world list header; WM 0x7f1

  // Client → Server
  LOGIN         = 0x15, // CONFIRMED — login packet, sent by FUN_10001420 in COMMEG32.DLL
                        //             12-byte header + payload starting at DAT_1001f888
                        //             Payload layout (offsets from payload start):
                        //               +0x000 (wire+12): username    (null-padded, field ~112 bytes)
                        //               +0x070 (wire+124): client version string, 80 bytes
                        //                                   v1.06: "Kesmai Comm Engine 3.22"
                        //                                   v1.23: "Kesmai CommEngine 3.29"
                        //               +0x0C0 (wire+204): email handle (40 bytes)
                        //               +0x0E8 (wire+244): internet/service id (80 bytes)
                        //               +0x13C (wire+328): htons(product_code) 2 bytes
                        //               +0x13E (wire+330): 0x39 constant
                        //               +0x13F (wire+331): SetServerIdent byte
                        //               +0x140 (wire+332): 4 bytes = 0
                        //               +0x142 (wire+334): htons(strlen(pw)) 2 bytes
                        //               +0x144 (wire+336): password (strlen+1 bytes, null-terminated)
                        //             Total wire length: 12 + strlen(pw) + 325
}

// ── Auth ──────────────────────────────────────────────────────────────────────
// Username:  play.pcgi [identification] user=, forwarded via WM 0x855 → SetUserName
// Password:  play.pcgi [identification] password=, via WM 0x856 → SetUserPassword
// Service:   play.pcgi [launch] ServiceIdent=, via WM 0x859 → SetInternet
// AuthServ:  play.pcgi [launch] AuthServ= (optional), via WM 0x85b → SetServerIdent.
export const AUTH_ENCODING = 'UNKNOWN' as const;
