# MPBT Solaris — Reverse Engineering Research

This document records every confirmed protocol detail found through static analysis
of the original game binaries using Ghidra. It is intended as a reference for
contributors who want to extend or audit the server emulator.

---

## Table of Contents

1. [Binary Targets](#1-binary-targets)
2. [ARIES Transport Layer](#2-aries-transport-layer)
3. [Inner Game Frame](#3-inner-game-frame)
4. [Base-85 Encoding](#4-base-85-encoding)
5. [CRC Algorithm](#5-crc-algorithm)
6. [Authentication Flow](#6-authentication-flow)
7. [Welcome / Gate Sequence](#7-welcome--gate-sequence)
8. [Lobby Command Dispatcher](#8-lobby-command-dispatcher)
9. [Sequence-Byte Pre-Handler and ACK](#9-sequence-byte-pre-handler-and-ack)
10. [Command 26 — Mech List](#10-command-26--mech-list)
11. [Command 7 — Menu Dialog](#11-command-7--menu-dialog)
12. [REDIRECT (ARIES type 0x03)](#12-redirect-aries-type-0x03)
13. [play.pcgi Configuration File](#13-playpcgi-configuration-file)
14. [Command 20 — Text Dialog (Server→Client)](#14-command-20--text-dialog-serverclient)
15. [MPBT.MSG — Mech String Table](#15-mpbtmsg--mech-string-table)
16. [Open Questions](#16-open-questions)
17. [COMMEG32.DLL — Secondary Connection Protocol (M2 RE)](#17-commeg32dll--secondary-connection-protocol-m2-re)
18. [Game World Protocol — MPBTWIN.EXE RE](#18-game-world-protocol--mpbtwinexe-re)
19. [Client v1.23 Migration Notes](#19-client-v123-migration-notes)
20. [MEC File Binary Format](#20-mec-file-binary-format)
21. [MAP File Leading Room Table](#21-map-file-leading-room-table)
22. [Windowed Mode — DirectDraw Rendering Architecture](#22-windowed-mode--directdraw-rendering-architecture)
23. [Combat Match-End State Machine](#23-combat-match-end-state-machine--confirmed-issue-79)

---

## 1. Binary Targets

| File | Role | Tool |
|------|------|------|
| `MPBTWIN.EXE` | Main game client (Win32, x86) | Ghidra |
| `COMMEG32.DLL` | ARIES network library used by client | Ghidra |
| `INITAR.DLL` | Launcher that reads `play.pcgi` and starts `MPBTWIN.EXE` | Ghidra |
| `play.pcgi` | Config file: server address, credentials, port | text editor |

All three PE files are 32-bit Windows x86, targeting roughly Windows 95/NT era.  
Ghidra's auto-analysis is sufficient; no custom loaders are required.

---

## 2. ARIES Transport Layer

### Packet Header Format (CONFIRMED)

Every packet — in both directions — starts with a fixed 12-byte header:

```
Offset  Size  Field
──────  ────  ──────────────────────────────────────────────────────────────────
 0      4     message_type    uint32 LE
 4      4     tag             uint32 LE  (timer / sequence, usually 0 from client)
 8      4     payload_length  uint32 LE  (byte count of data that follows)
12      ...   payload
```

**Ghidra references:**

| Canonical Name | Binary Address | Role |
|----------------|---------------|------|
| `Aries_PacketAlloc` | `FUN_10003600` | Allocates outgoing packet, writes type + 12-byte header |
| `Aries_PacketSetLen` | `FUN_10003680` | Finalises header: fills `payload_length` field at offset 8 |
| `Aries_PacketParse` | `FUN_100036d0` | Receive-side parser: validates header, returns type + payload slice |

The parser also handles a legacy 4-byte format; if `type[3] != 0` it returns `0x1E`
(treated as `CHAR_LIST`).

### Message Types (CONFIRMED)

All types confirmed from the `switch()` dispatch table in `Aries_RecvDispatch` (`FUN_100014e0`) in COMMEG32.DLL.

| Value | Direction | Name | Notes |
|-------|-----------|------|-------|
| `0x00` | Both | `SYNC` / game data | After auth, all game frames travel inside this type |
| `0x01` | S→C | `CONN_CLOSE` | Server closes connection gracefully |
| `0x02` | S→C | `CONN_ERROR` | Server signals error |
| `0x03` | S→C | `REDIRECT` | Redirect to game-world server; 120-byte payload |
| `0x05` | Both | `KEEPALIVE` | Server pings; client replies with the same type |
| `0x15` | C→S | `LOGIN` | Client login packet, ~325 + pwLen bytes |
| `0x16` | S→C | `LOGIN_REQUEST` | Server sends immediately on connect; empty payload |
| `0x1a` | S→C | `TEXT_MSG` | Displays fatal error dialog; client quits |
| `0x1e` | S→C | `CHAR_LIST` | 12-byte character/world list header; fires WM `0x7F1` |

---

## 3. Inner Game Frame

Once authenticated, all game-level communication is carried inside ARIES type `0x00`
(`SYNC`) packets, as a custom ESC-framed binary format.

### Server → Client Frame Layout (CONFIRMED)

```
\x1B  [seq_byte]  [cmd_byte]  [encoded_args...]  \x20  [crc_byte0]  [crc_byte1]  [crc_byte2]  \x1B
```

| Field | Size | Encoding | Notes |
|-------|------|----------|-------|
| `\x1B` | 1 | literal | Leading ESC / frame-start sentinel |
| `seq_byte` | 1 | `seq + 0x21` | Sequence counter 0–42; consumed by seq pre-handler |
| `cmd_byte` | 1 | `cmdIndex + 0x21` | Command table index (0-based) |
| encoded args | N | base-85 | Command-specific payload (see below) |
| `\x20` | 1 | literal | Argument terminator |
| CRC | 3 | base-85 type-2 | 19-bit CRC over everything from `seq_byte` onwards |
| `\x1B` | 1 | literal | Trailing ESC / frame-end sentinel |

### Client → Server Frame Layout (CONFIRMED)

The client sends the same format but **without a trailing ESC** in most observed
captures. The server-side reader (`Lobby_RecvDispatch` / `FUN_00402cf0`) consumes the leading ESC and
delegates the rest.

```
\x1B  [seq_byte]  [cmd_byte]  [encoded_args...]  \x20  [crc_byte0]  [crc_byte1]  [crc_byte2]  \x1B
```

`cmd_byte` is written by `Frame_WriteCmdByte` (`FUN_00403030`) which stores `param + 0x21`.

---

## 4. Base-85 Encoding

All integer arguments in game frames use a custom base-85 encoding where each
digit `d` is stored as the raw byte `d + 0x21`.  The number of bytes used
depends on the "type" argument passed to the encoder.

**Confirmed from `Frame_EncodeArg` (`FUN_00402be0`, encoder) and `Frame_DecodeArg` (`FUN_00402b10`, decoder) in MPBTWIN.EXE.**

| API | Canonical Name | Bytes | Max value | Notes |
|-----|---------------|:---:|---:|-------|
| `type1` (n=1) | `Frame_EncodeArg(1,v)` | **2** | 7,224 | `d0 = v / 85`, `d1 = v % 85` |
| `type2` (n=2) | `Frame_EncodeArg(2,v)` | **3** | 614,124 | Three base-85 digits |
| `type3` (n=3) | `Frame_EncodeArg(3,v)` | **4** | 52,200,624 | Four base-85 digits |
| `type4` (n=4) | `Frame_EncodeArg(4,v)` | **5** | 4,437,053,124 | Five base-85 digits |
| single byte | `Frame_ReadByte` (`FUN_00402f40`) | **1** | 84 | `val = *ptr++ - 0x21` |
| cmd byte write | `Frame_WriteCmdByte` (`FUN_00403030`) | **1** | — | `*ptr++ = param + 0x21` |
| string | `Frame_ReadString` (`FUN_00403160`) | 1 + N | — | `[len + 0x21][raw ASCII bytes]` |

### String Encoding (CONFIRMED)

Strings use the output of `Frame_ReadString` (`FUN_00403160`) / `Frame_CopyString` (`FUN_0040c0d0`):

```
[1 byte: string_length + 0x21]  [string_length bytes: raw ASCII]
```

Maximum string length is 84 characters (so `len + 0x21 ≤ 0x6D`; never reaches
`0x1B` = ESC, which would corrupt the frame).

### TypeScript Reference

```typescript
// type1 — 2 bytes
function encodeB85_1(v: number): Buffer {
  return Buffer.from([Math.floor(v / 85) + 0x21, (v % 85) + 0x21]);
}

// type2 — 3 bytes
function encodeB85_2(v: number): Buffer {
  const d0 = Math.floor(v / (85 * 85));
  const r  = v % (85 * 85);
  return Buffer.from([d0 + 0x21, Math.floor(r / 85) + 0x21, (r % 85) + 0x21]);
}

// Single byte
function encodeAsByte(v: number): Buffer { return Buffer.from([v + 0x21]); }

// String
function encodeString(s: string): Buffer {
  const raw = Buffer.from(s, 'ascii');
  return Buffer.concat([Buffer.from([raw.length + 0x21]), raw]);
}
```

---

## 5. CRC Algorithm

**Confirmed from `Frame_VerifyCRC` (`FUN_00402e30`) in MPBTWIN.EXE.**

The CRC is a 19-bit linear-feedback shift register.

### Parameters

The CRC seed depends on **both** the connection mode (RPS/Combat) **and** the direction of the frame.

**Server → Client** (outbound; seed used when generating CRC to send):

| Context | Init value | Notes |
|---------|-----------|-------|
| Lobby / RPS | `0x0A5C25` | Derived: `(0xFFFFFFE0 + 0x0A5C45) & 0xFFFFFFFF` |
| Combat       | `0x0A5C45` | Read directly from `Frame_VerifyCRC` (`FUN_00402e30`) |

**Client → Server** (inbound; seed used to validate received frames):

| Context | Init value | Notes |
|---------|-----------|-------|
| Lobby / RPS | `0x0C2525` (795,941) | Confirmed by independent RE — RazorWing/solaris `INBOUND_SEED_RPS` |
| Combat       | `0x0C4545` (804,165) | Confirmed by independent RE — RazorWing/solaris `INBOUND_SEED_COMBAT` |

Both pairs follow the same nibble-rotation pattern:
- Outbound RPS: `0xA5C25` → Inbound RPS: `0xC2525`
- Outbound Combat: `0xA5C45` → Inbound Combat: `0xC4545`

The algorithm is **identical** in both directions; only the initial seed differs.

### Coverage

The CRC covers **all bytes from `seq_byte` through the `\x20` terminator** —
i.e., everything between (but not including) the two `\x1B` sentinels except
the three CRC bytes themselves.

```
CRC input = [seq_byte, cmd_byte, arg_byte_0, ..., arg_byte_N, 0x20]
```

### Algorithm

```typescript
function computeGameCRC(data: Buffer, combat = false): number {
  let crc = combat ? 0x0A5C45 : 0x0A5C25;

  for (const b of data) {
    crc = crc * 2;
    if (crc & 0x80000) crc = (crc & 0x7FFFE) | 1;
    crc ^= b;
  }

  // 3 finalization rounds (identical shift + XOR pattern)
  let s = crc * 2;
  if (s & 0x80000) s = (s & 0x7FFFE) | 1;

  s = (s ^ (crc & 0xFF)) * 2;
  if (s & 0x80000) s = (s & 0x7FFFE) | 1;

  s = (s ^ ((crc >> 8) & 0xFF)) * 2;
  if (s & 0x80000) s = (s & 0x7FFFE) | 1;

  return s ^ ((crc & 0x70000) >> 16);
}
```

The resulting integer is encoded as **type2 (3 bytes)** using `Frame_EncodeArg(2, crc)` (`FUN_00402be0`).

---

## 6. Authentication Flow

**All offsets confirmed by RE of `Aries_SendLoginPacket` (`FUN_10001420`) and `Set*()` exports in COMMEG32.DLL.**

### Sequence

```
Server  ──── LOGIN_REQUEST (0x16, empty) ────►  Client
Server  ◄─── LOGIN (0x15, ~330 bytes)   ────── Client
Server  ──── SYNC ack (0x00, empty)     ────►  Client
Server  ──── SYNC welcome (0x00, escape)────►  Client
```

### LOGIN Payload Layout (type 0x15, C→S)

| Offset (decimal) | Field | Width | Notes |
|:---:|-------|:---:|-------|
| +0 | `username` | 112 | Null-padded ASCII `(play.pcgi [identification] user=)` |
| +112 | `client_version` | 80 | `"Kesmai Comm Engine 3.22"` (hardcoded) |
| +192 | `email_handle` | 40 | `play.pcgi [identification] email=` |
| +232 | `service_id` | 80 | `play.pcgi [launch] ServiceIdent=` (e.g. `"BATTLETECH"`) |
| +316 | `product_port` | 2 | `htons(product_code)` — port from `play.pcgi [launch] product=` |
| +318 | `0x39` | 1 | Constant written by `Aries_Connect` (`FUN_100011c0`) |
| +319 | `server_ident` | 1 | First byte of `SetServerIdent()` value |
| +320 | `0x00 × 4` | 4 | Cleared by `Aries_Connect` (`FUN_100011c0`) |
| +324 | `pw_len` | 2 | `htons(strlen(password))` |
| +326 | `password` | pw_len+1 | Null-terminated ASCII |

**Total payload length = `strlen(password) + 325` bytes** (minimum 325, no password).

### Parsing in the Server

The server reads the LOGIN payload and extracts:
- `username` at offset `+0`, null-terminated within 112 bytes
- `client_version` at offset `+112`
- `email` at offset `+192`
- `service_id` at offset `+232`
- `product_port` = `ntohs(payload[316..317])`
- `pw_len` = `ntohs(payload[324..325])`
- `password` at offset `+326`, `pw_len` bytes, null-terminated

---

## 7. Welcome / Gate Sequence

**Confirmed from `Lobby_WelcomeGate` (`FUN_00429a00`) and `g_lobby_WelcomeStrMMW` (`DAT_00474d48`) in MPBTWIN.EXE.**

After the SYNC ack, the server sends a special escape string as a type-0x00
payload.  The client's `Lobby_WelcomeGate` (`FUN_00429a00`) accumulates received bytes and compares
the buffer against `g_lobby_WelcomeStrMMW` (`DAT_00474d48`):

```
hex:  1B 3F 4D 4D 57 20 43 6F 70 79 72 69 67 68 74 20 4B 65 73 6D 61 69 20 43 6F 72 70 2E 20 31 39 39 31
text: \x1b?MMW Copyright Kesmai Corp. 1991
```

When the match succeeds:
- `g_lobby_WelcomeGateOpen` (`DAT_004e2de8`) = 1 — unlocks the main game loop
- `Lobby_OnWelcomeA` (`FUN_00433ef0`), `Lobby_OnWelcomeB` (`FUN_00429580`), etc. are called — lobby UI initialises

A second variant at `g_lobby_WelcomeStrMMC` (`DAT_00474d70`) (`"MMC"` instead of `"MMW"`) triggers
`Lobby_OnDirectConnect` (`FUN_00429620`) — the direct-connection path.  The `"MMW"` variant is the
normal Windows login path.

### Correct Send Order

```
1. Send SYNC ack   — buildPacket(0x00, empty, timestamp_ms)
2. Send WELCOME    — buildPacket(0x00, "\x1b?MMW Copyright Kesmai Corp. 1991")
```

The welcome string **must** be in a separate type-0x00 packet; the client gate
function `Lobby_WelcomeGate` (`FUN_00429a00`) is called once per WM `0x7f0` message (one message per
ARIES `0x00` packet).

---

## 8. Lobby Command Dispatcher

**Confirmed from `Lobby_RecvDispatch` (`FUN_00402cf0`), `g_lobby_DispatchTable` (`DAT_00470198`), and `g_combat_DispatchTable` (`DAT_00470408`) in MPBTWIN.EXE.**

`Lobby_RecvDispatch` (`FUN_00402cf0`) serves as the main receive loop for **both** the lobby and the in-combat phase.
It selects between two command tables based on `g_combat_Mode` (`DAT_004e2cd0`):

- When `g_combat_Mode == 0` → uses `g_lobby_DispatchTable` (`DAT_00470198`) — 0x4C entries — RPS/lobby commands
- When `g_combat_Mode != 0` → uses `g_combat_DispatchTable` (`DAT_00470408`) — 0x4F entries — in-combat commands

For each arriving inner frame it:

1. Calls `g_lobby_SeqHandlerPtr` (`PTR_FUN_00470190`) = `Lobby_SeqHandler` (`FUN_0040C2A0`) (seq pre-handler — see §9)
2. If pre-handler returns 1 (ACK frame), skip dispatch
3. Otherwise reads the next byte as `cmdIndex` (via `Frame_ReadByte` / `FUN_00402f40`)
4. Looks up the active table at `cmdIndex`
5. If entry is NULL → logs "Invalid RPS command: N" crash
6. Otherwise calls the function pointer with the parse context

### Lobby Command Table (`g_lobby_DispatchTable` / `DAT_00470198`) — Key Entries

Full table: 0x4C (76) entries × 4 bytes = 304 bytes.  Confirmed non-null entries:

| Index | Canonical Name | Binary Address | Role |
|:---:|---------|---------|------|
| 0 | — | `NULL` | Crashes with "Invalid RPS command: 0" |
| 3 | `Cmd3_TextBroadcast` | `FUN_0040C190` | Server text message → displays string in chat window (see §18 correction note) |
| 7 | `Cmd7_ParseMenuDialog` | `FUN_004112B0` | Server menu dialog renderer |
| 20 | `Cmd20_ParseTextDialog` | `FUN_00411D90` | Server text dialog with mech stats (see §14) |
| 26 | `Cmd26_ParseMechList` | `FUN_0043A370` | Mech list parser → `MechWin_Create` (`FUN_00439f70`) |

### Combat Command Table (`g_combat_DispatchTable` / `DAT_00470408`) — Key Entries

| Index | Binary Address | Notes |
|:---:|---------|------|
| 0x40 | `FUN_00401390` | Seeds/creates a remote combatant slot: reads server player id, strings, mech id, then allocates/fills the per-player mech structures |
| 0x41 | `FUN_00401820` | Strongest current position-sync handler: reads player id, X/Y/Z, rotation/heading-ish bytes, and speed/throttle-ish byte into per-player motion fields |
| 0x44 | `FUN_00402380` | Combat effect/attack update: reads source/target ids plus angle and X/Y/Z fields, then calls effect helpers |
| 0x45 | `FUN_00402530` | Combat effect/sound/projectile update with X/Y/Z fields and local-distance checks |
| 0x46 | `FUN_004026D0` | Combat state/animation control; action byte drives animation/flag helper calls |
| 0x48 | `FUN_00406140` | Local combat scene/self init: loads scene/mech metadata, local callsign/mech strings, origin coordinates, arena counts, and marks combat scene active |
| 0x49 | `FUN_004022D0` | Stores two scaled short control/aim/offset values into the per-player combat table |

### Client Command 3 — Client-Ready (CONFIRMED)

The first packet the client sends after the WELCOME escape is command 3.  Its
args are four single bytes: `[0x22, 0x27, 0x24, 0x21]`, which decode as
`[1, 6, 3, 0]` (capability/version flags).

```
\x1B  [seq+0x21]  \x24  \x22 \x27 \x24 \x21  \x20  [CRC×3]  \x1B
                  ^^^   ^^^^^^^^^^^^^^^^^^^^^^^^^^
                  cmd=3 args = [1, 6, 3, 0]
```

---

## 9. Sequence-Byte Pre-Handler and ACK

**Confirmed from `Lobby_SeqHandler` (`FUN_0040C2A0`) and `Lobby_SendAck` (`FUN_0040c280`) in MPBTWIN.EXE.**

`Lobby_SeqHandler` (`FUN_0040C2A0`) is stored at `g_lobby_SeqHandlerPtr` (`PTR_FUN_00470190`) and called before every command
dispatch.

### Logic

```c
int Lobby_SeqHandler(parse_ctx* ctx) {  // FUN_0040C2A0
    int val = Frame_ReadByte(ctx);       // FUN_00402f40 — *ptr++ - 0x21
    if (val <= 42) {
        g_lobby_LastSeq = val;           // DAT_004e2da4 — store seq; proceed
        return 0;
    }
    // val > 42: this is an ACK request, not a data frame
    Lobby_SendAck(val - 0x2b);          // FUN_0040c280 — send [0x22, val+0x2b]
    return 1;                            // tell dispatcher: skip command
}
```

### ACK Packet Format

When the client sends a seq byte with `val > 42`, it is requesting an ACK.
The server replies with a 2-byte frame:

```
\x22  [val + 0x2b]
```

(`Lobby_SendAck` / `FUN_0040c280` writes exactly these two bytes via the send buffer.)

### Server Sequence Counter

The server's own outgoing seq counter (`serverSeq`) runs 0–41.  Values 0–42
are all valid data frames (`val ≤ 42 → proceed`).  The emulator increments
`serverSeq` on each sent frame and wraps at 42.

---

## 10. Command 26 — Mech List

**Confirmed from `Cmd26_ParseMechList` (`FUN_0043A370`) and `MechWin_Create` (`FUN_00439f70`) in MPBTWIN.EXE.**

The server sends command 26 in response to the client's command 3 (client-ready).
`Cmd26_ParseMechList` (`FUN_0043A370`) parses it and `MechWin_Create` (`FUN_00439f70`) creates the 640×480 mech selection window.

### Wire Format (Server → Client, args after cmd byte)

```
[type1  2B]  type_flag
[byte   1B]  count              (number of mech entries)
─── repeated `count` times ──────────────────────────────────────────────────
  [type2  3B]  mech_id          → g_cmd26_MechIdArr[i]   (DAT_004dc560)
  [byte   1B]  mech_type        → g_cmd26_MechTypeArr[i]  (DAT_004e2dc0)
  [type2  3B]  slot             → g_cmd26_SlotArr[i], g_cmd26_SlotArrAlt[i]  (DAT_004dc510, DAT_004dbd88)
  [string    ] type_string      → g_cmd26_TypeStrArr[i]   (DAT_004dc5b8)  (e.g. "SDR-5V")
  [string    ] variant          → g_cmd26_VariantArr[i]   (DAT_004dc1d0)  (e.g. "Spider")
  [string    ] name             → g_cmd26_NameArr[i]      (DAT_004dc028)  (empty → MechWin_LookupMechName)
─────────────────────────────────────────────────────────────────────────────
[string    ]  footer
```

### type_flag Values

| Value | Meaning |
|:---:|---------|
| `0x00` | Normal: no special buttons (`g_mechWin_ShowExtButtons` / `DAT_004dbd84` = 0) |
| `0x20` (`'>'`) | Extended buttons shown |
| `0x3E` | Also triggers extended button path |

### After Parsing

- `MechWin_Create` (`FUN_00439f70`) is called — creates the 640×480 mech window, sets graphics mode `0x13`
- `MechWin_HighlightSlot` (`FUN_004394b0`) — highlights the first mech slot
- `MechWin_ScrollCallback` (`FUN_00439580`) — scroll/repaint callback, highlights `g_mechWin_HighlightIdx` (`DAT_004dbd80`)

### Mech Window Key Bindings (`MechWin_KeyHandler` / `FUN_0043a990`)

| Key | Action |
|-----|--------|
| `S` / `Enter` | Select mech → sends client cmd 7 with `slot + 1` |
| `X` | Examine mech → sends client cmd 20 (server should respond with stats) |
| `n` / `p` | Navigate down / up |
| Arrow keys | Navigate |

---

## 11. Command 7 — Menu Dialog

**Confirmed from `Cmd7_ParseMenuDialog` (`FUN_004112b0`), `Cmd7_OnMenuPick` (`FUN_00412190`), `Cmd7_OnMenuEsc` (`FUN_004122d0`) in MPBTWIN.EXE.**

### Server → Client Format (args after cmd byte)

```
[type1  2B]  list_id       (arbitrary; stored at g_cmd7_ListIdTable[0x512] / DAT_00472c94)
[string    ] title         (dialog window title)
[byte   1B]  count         (number of items)
─── repeated `count` times ────────────────────────
  [string  ] item_label    (shown as " k. <label>")
───────────────────────────────────────────────────
```

### Client → Server Reply Format (client cmd 7)

When the user picks item `k` (key `'1'` through `'N'`):

```
startCmd('\a')             → cmd byte 0x28 in frame (cmd index 7)
[type1  2B]  list_id       (echoed from server's list_id)
[type4  5B]  selection     0 = cancel/ESC;  N = item N picked (1-indexed)
```

The logic in `Cmd7_OnMenuPick` (`FUN_00412190`):
```
item_data[i] = i   (loop index: 0, 1, 2, ...)
sends type4(item_data[k-1] + 1)
→ picking item 1 sends type4(1), picking item 2 sends type4(2), etc.
```

### Special list_id Values / Shared Callback Cases

The numbered-list selection callback family used by `Cmd7`, `Cmd16`, `Cmd19`,
`Cmd44`, and `Cmd48` has a few hard-coded `list_id` branches. The later
`Cmd44` pass now confirms the ordinary keyed-single-string picker still routes
normal row picks through the same plain outbound `Cmd7` helper (`FUN_0043eb80`),
with the keep-open behavior controlled only by these list-id checks:

| Value (decimal) | Hex | Notes |
|:---:|:---:|-------|
| 8 | `0x08` | Shared keep-open path; exact feature still unresolved. |
| 12 | `0x0c` | Shared keep-open path; exact feature still unresolved. |
| 34 | `0x22` | Shared keep-open path; additionally, the `Cmd44` picker appends a synthetic local `item_id = 100` row labeled `Exit to online service` (`MPBT.MSG[139]`) and, when that row is chosen, opens an exit-confirmation MessageBox via `FUN_00444af0()` instead of sending a wire request. |
| 37 | `0x25` | Shared keep-open path; exact feature still unresolved. |
| 46 | `0x2e` | `Cmd48`-specific builder special case: installs `FUN_00411e00`, which just synthesizes an Enter/close path (`FUN_0042ffe0(..., 0x0d)` -> `FUN_00419370()`). This looks like modal boilerplate, not the KP5 inquiry fork. |
| 52 | `0x34` | Shared keep-open path; exact feature still unresolved. |
| 1000 | `0x3E8` | Local synthetic `Personal inquiry on:` submenu built by `FUN_00412980()`, not a proven server-assigned `Cmd48` list id. |

Use any other positive integer as `list_id` to get a simple dismiss-on-pick dialog.

Current implication for Solaris work: the downstream **tier chooser itself**
still does not need any special submit opcode beyond plain `Cmd7`, and the
still-unresolved **top-level** terminal/ranking opener now fits the shared
keep-open `Cmd44` keyed-list family better than before because `FUN_0040fe80()`
now has a clean wire-contract readback: `list_id + title + count + repeated
(item_id + one display string)`.

### Local Inquiry Submenu (`list_id = 1000`)

`FUN_00412980()` builds a two-option local submenu using:

- `MPBT.MSG[0x90]` = `Personal inquiry on:`
- `MPBT.MSG[0x91]` = `Send a ComStar message`
- `MPBT.MSG[0x92]` = `Access personnel data`

The follow-up actions are now confirmed:

- Option 1 (`Send a ComStar message`) opens the editable dialog builder
  `FUN_00416db0(target_id, NULL)`. Pressing its `Send` button (`MPBT.MSG[0xA5]`)
  emits client `cmd 21` with `type4(target_id)` followed by the typed message
  string via `FUN_00416b90()`.
- Option 2 (`Access personnel data`) emits `Cmd7(0x3f2, target_id + 1)` from
  `FUN_00412190()`.

### Correction on Earlier `Cmd7` ESC Attribution

The earlier note that labeled `FUN_004122d0` as a generic `Cmd7` ESC/cancel
handler should no longer be relied on.

- Re-reading `FUN_00411e20()` shows the `LAB_00412190` / `LAB_004122d0` callback
  pair is installed by the denser keyed triple-string list family, not by the
  simple `Cmd44` keyed single-string picker and not yet by a proven plain
  top-terminal `Cmd7` menu.
- That means this callback pair is no longer valid evidence for the exact cancel
  semantics of the unresolved terminal/ranking opener.
- The current safe statement is narrower: the proven `Cmd44` chooser path uses
  plain outbound `Cmd7` for ordinary row selection, while the exact generic
  plain-`Cmd7` terminal cancel path remains unresolved.

---

## 12. REDIRECT (ARIES type 0x03)

**Confirmed from `Aries_RecvDispatch` (`FUN_100014e0`) case 3 in COMMEG32.DLL.**

### Payload Layout

```
Bytes [  0 –  39]  addr        null-terminated ASCII, 40-byte field
Bytes [ 40 –  79]  internet    null-terminated ASCII, 40-byte field
Bytes [ 80 – 119]  password    null-terminated ASCII, 40-byte field
Total: 120 bytes exactly
```

### Client Handler Behaviour (case 3 of `FUN_100014e0`)

1. Copies `payload[0..39]` → local `addr` string
2. Copies `payload[40..79]` → calls `SetInternet(internet)`
3. Copies `payload[80..119]` → calls `SetUserPassword(password)`
4. If `g_aries_GameWorldConn` (`DAT_1001a080`) != NULL: tears down existing secondary connection first
5. Calls `Aries_Connect` (`FUN_100011c0`) — opens a **new TCP connection** to `addr`
6. Sends `WM 0x7fe(1, ...)` before and `WM 0x7fe(0, 0)` after connecting

### Secondary Connection

After REDIRECT, `g_aries_GameWorldConn` (`DAT_1001a080`) is set to the new connection object.  This is
the "game world" connection; the lobby connection may be torn down.  The game
world protocol has not yet been reverse-engineered.

---

## 13. play.pcgi Configuration File

**Confirmed from RE of `INITAR.DLL`.**

`INITAR.DLL` reads `play.pcgi` from disk, parses both sections, then launches
`MPBTWIN.EXE` with the extracted values injected via Windows messages.

### File Format

```ini
[launch]
product=2000
server=127.0.0.1:2000
ServiceIdent=BATTLETECH
AuthServ=g

[identification]
user=Player
password=password
email=player@mpbt.local
```

### Field Mapping

| Section | Field | Destination | Notes |
|---------|-------|-------------|-------|
| `[launch]` | `product` | `atoi(product)` → `htons(N)` → `sockaddr_in.sin_port` | **Server TCP port** |
| `[launch]` | `server` | `SetHostname()` + TCP connect | `host:port` or just `host` |
| `[launch]` | `ServiceIdent` | `SetInternet()` → LOGIN `+232` | e.g. `"BATTLETECH"` |
| `[launch]` | `AuthServ` | `SetServerIdent()` → LOGIN `+319` | First byte only |
| `[identification]` | `user` | WM `0x855` → `SetUserName()` → LOGIN `+0` | Username |
| `[identification]` | `password` | WM `0x856` → `SetUserPassword()` → LOGIN `+326` | Password |
| `[identification]` | `email` | `SetUserEmailHandle()` → LOGIN `+192` | Email handle |

### Notes

- After INITAR reads `play.pcgi` it **deletes** the file as a basic
  anti-replay measure.  Recreate it before each launch.
- The `gen-pcgi` script in `src/scripts/gen-pcgi.ts` generates this file
  with a single command.

---

## 14. Command 20 — Text Dialog (Server→Client)

**Confirmed from `Cmd20_ParseTextDialog` (`FUN_00411D90`) and inner handler
`FUN_00411a10` in MPBTWIN.EXE.  Packet capture of the T1 test session confirmed
the client-side payload format.**

Command 20 is sent by the **server** to display a stats panel in the mech selection UI.
When the player presses `X` (examine) in the mech window, the server responds with
**exactly one** cmd-20 packet.

### Wire Format (Server → Client, args after cmd byte)

```
[type1  2B]  dialog_id     base-85(1) — arbitrary id; avoid 13/30/35/39 (trigger printf via MPBT.MSG)
[byte   1B]  mode          (mode + 0x21) — 2 = create/show stats panel with Ok button
[type1  2B]  text_len      base-85(1) — byte length of the following raw text
[N bytes ]  text           raw latin1; use 0x5C ('\') as line separator
```

The text is sent as a raw latin1 byte string (NOT `#NNN`). `buildCmd20Args()` uses
`encodeB85_1(raw.length)` for the length prefix — **not** `encodeString()`'s 1-byte
prefix, which `FUN_0040c130` would misread as a large length (≈1732) and immediately
return -1 ("RPS command 20 failed.").

### `#NNN` Text Format — Broken with This MPBT.MSG

The client's `FUN_00411a10` inspects `text[0]`:
- If `text[0] == '#'` (0x23): decodes a 3-digit decimal mech_id from `text[1..3]`
  using the formula `(d1-'0')*100 + (d2-'0')*10 + (d3-'0')`, looks up
  `DAT_00473ad8[mech_id]` (a table of MPBT.MSG line numbers), fetches the
  pre-formatted stats string via `FUN_00405840`, copies it over `text`, and
  uses the expanded string as the dialog content.
- If `text[0] != '#'`: the text is used as-is (arbitrary string in the dialog).

**T1 Bug Root Cause:** The `#NNN` path relies on the correct MPBT.MSG having
pre-formatted mech stats at specific line numbers (pointed to by `DAT_00473ad8`).
In our distribution, `DAT_00473ad8[156]` (ANH-1A) = 252, but MPBT.MSG line 252
= `"Mechs now in use:"` — not the mech stats.  The original MPBT.MSG would have
had the actual stats at that line; our copy is incomplete.

**Fix Applied:** The server now sends the stats text directly (not as `#NNN`).
`buildMechExamineText()` in `src/server.ts` builds a compact stats string from
`MECH_STATS` (src/data/mech-stats.ts).  Lines are separated with `0x5C` (`\`) —
`FUN_00433310` NULs this byte in its staging buffer before calling `FUN_00431f10`,
so it acts as a clean line break.  (`0x8D` is wrong: `FUN_00431e00` treats it as
signed char −115, producing font-width table index −460 → memory corruption / hang.)
The text is sent as raw latin1 with a 2-byte base-85 length prefix via
`encodeB85_1()`, NOT via `encodeString()` (which uses a 1-byte prefix misread by
`FUN_0040c130` as length 1732, triggering "RPS command 20 failed.").  The only
forbidden byte in text content is `0x1B` (ESC), which would prematurely terminate
the ARIES ESC accumulator (`FUN_00429510`); both `encodeString()` and
`buildCmd20Args()` now encode to a Buffer first and then check `raw.includes(0x1B)`
to catch characters whose latin1 encoding truncates to 0x1B.

### Mode Values — Independent Dialog Objects

`FUN_00411a10` is called **once per cmd-20 packet** and creates a **new independent
dialog object** each call.  Modes do NOT accumulate into one shared panel:

| mode | Dialog content | Buttons | Flags |
|------|---------------|---------|-------|
| 0 | `text` (arbitrary) | MPBT.MSG[1]="Yes" + MPBT.MSG[2]="No" | 0xf |
| 1 | `text` (arbitrary) | MPBT.MSG[1]="Yes" + MPBT.MSG[2]="No" | 0xf |
| 2 | `text` (arbitrary) | MPBT.MSG[3]="Ok" | 9 (persistent) |

For mech stats, **only mode=2 should be sent**.  Sending mode=0 or mode=1 first
creates extra "Yes/No" dialogs that stack beneath the stats dialog and must each
be dismissed separately; this was the root cause of the T1 freeze.

The mode=2 dialog (flags=9) sets callback `FUN_00419370` as the Ok handler.
`FUN_00419370` → `FUN_00411200` pops the dialog stack and, when the stack is
empty and the lobby gate is open, calls `FUN_00410dc0` to restore the mech
selection window.  No server communication is required to close the stats panel.

### Notes

- `FUN_00401c90` (previously misidentified as the cmd-20 handler) is the
  **combat frame tick mover**, called every frame by the combat loop (`FUN_00408080`).
  It is unrelated to cmd 20.
- Special dialog_ids 13 (0xd), 30 (0x1e), 35 (0x23), 39 (0x27) route `text` through
  a `sprintf`-style formatter using MPBT.MSG format strings (0x8c–0x8f).  Other ids
  (including 5, our emulator's id) pass text directly.

---

## 15. MPBT.MSG — Mech String Table

**Confirmed by RE of `Mech_VariantLookup` (`FUN_00438280`) and
`Mech_ChassisLookup` (`FUN_004382b0`), and by verifying all 161 `.MEC`
filenames against the table.**

`MPBT.MSG` is a plain-text file (CRLF, 1164 lines) shipped with the game
containing all in-game strings indexed by 1-based line number.

### Variant Designation Table (mech_id → typeString)

- **Lines (1-based):** 942–1102  (base offset `0x3AE`)
- Line `942 + id` = typeString for `mech_id = id` (161 entries, id 0–160)

| mech_id | typeString |
|:---:|--------|
| 0 | FLE-4 |
| 24 | SDR-5V |
| 79 | SHD-2H |
| 141 | ZEU-6T |
| 156 | ANH-1A |
| 160 | MAD-4A |

`Mech_VariantLookup` (`FUN_00438280`) = `FUN_00405840(id + 0x3AE)`.
Out-of-range `id` falls back to `"HBK-4G"` (guard in FUN_00438280).

### Chassis Name Table (chassis_id → name)

- **Lines (1-based):** 876–941  (base offset `0x36C`)
- 66 entries, chassis_id 0–65

`Mech_ChassisLookup` (`FUN_004382b0`) = `FUN_00405840(id + 0x36C)`.
Out-of-range id falls back to `"HUNCHBACK"`.

### Implementation

The emulator loads the variant table at startup in `loadVariantIdMap()`
(`src/data/mechs.ts`) and uses it to assign the correct `mech_id` to each
`.MEC` file found in `mechdata/`.

---

## 16. Open Questions

These areas have not yet been reverse-engineered.

### Command 20 — Client→Server Examine Request (RESOLVED)

**Confirmed by packet capture of the T1 test session (session `22096a84`, 2026-04-05).**

- Client frame payload (args after seq+cmd): `type4(slot + 1)` = 5 bytes (big-endian base-85)
- `slot` is the 0-based highlight index in the mech window (= `g_mechWin_HighlightIdx`)
- The 1-indexed encoding matches cmd-7 mech-selection exactly: `selection = slot + 1`
- Decoded by server as `decodeArgType4(payload, 3)` → value, then `slot = value - 1`

Capture evidence: client sent `21 21 21 21 22` at payload[3..7] for mech at slot 0
→ `decodeArgType4` → 1 → slot = 0 (ANH-1A, s first sorted mech).

**Server response:** ONE cmd-20 packet, mode=2.  The emulator now sends the
stats text directly from `buildMechExamineText()` (see §14) rather than the
legacy `"#NNN"` shortcode, because our MPBT.MSG does not have the correct
pre-formatted stats at the expected line numbers.

### Post-Redirect Game World Protocol — RESOLVED (see §18)

### Secondary Connection (`DAT_1001a080`) — RESOLVED (see §17–§18)

### Client cmd-5 — Allegiance Selection — RESOLVED

**Confirmed by decompiling `FUN_00413790` (arena-window click handler) and
`FUN_0040d2d0` in MPBTWIN.EXE.**

When the player clicks an allegiance button in the Cmd4 arena UI:

| Button ID | Source | Action |
|-----------|--------|--------|
| `0x100` | `FUN_00413790` | Intercepts as **Help**: calls `FUN_00404450` → opens `SOLARIS.HLP` |
| `0x101`–`0x105` | `FUN_00413790` | Allegiance selection: calls `FUN_0040d2d0(option_type_byte)` |

`FUN_0040d2d0`:
```c
void FUN_0040d2d0(char type_byte) {
    FUN_00403030('\x05');  // write cmd index 5 (wire 0x26)
    FUN_00403050(type_byte); // write type_byte raw (type_byte + 0x21 on wire)
    FUN_00429440();          // flush / finalize frame
}
```

### Client cmd-5 Wire Format (Client → Server)

```
\x1B  [seq+0x21]  \x26  [type_byte+0x21]  \x20  [CRC×3]  \x1B
                  ^^^   ^^^^^^^^^^^^^^^^
                  cmd=5 allegiance type index
```

`type_byte` = the `type` field the SERVER wrote into the Cmd4 arena-option entry
for that button:
- `type = 0` → `ALLEGIANCES[0]` = `'Davion'`
- `type = 1` → `ALLEGIANCES[1]` = `'Steiner'`
- `type = 2` → `ALLEGIANCES[2]` = `'Liao'`
- `type = 3` → `ALLEGIANCES[3]` = `'Marik'`
- `type = 4` → `ALLEGIANCES[4]` = `'Kurita'`

### Cmd4 Arena-Options — Character-Creation Allegiance Buttons — RESOLVED

**Confirmed by decompiling `FUN_00414b70` (Cmd4_SceneInit handler) in MPBTWIN.EXE.**

The `arena_option_count` + option entries at the end of the Cmd4 wire format
create the allegiance-picker buttons in the character-creation UI:

- Count stored in `DAT_004e6a70`.
- Option strings (40 bytes each) stored in `DAT_004816e8`.
- Each option creates a button with ID `option_index + 0x100`.
- **Button 0x100 is always intercepted as a Help button** (opens `SOLARIS.HLP`).
  The first option in the list must therefore be a dummy placeholder.
- Effective allegiance buttons: IDs **0x101–0x105** (options 1–5).

**Server sends 6 options** (dummy at index 0, five houses at indices 1–5);
client displays six buttons but only five are selectable as allegiances.

Button width: `0x78` (120 px) if ≤ 5 options; `0x4f` (79 px) if > 5 (max 6).

### Command 0x1D (Cancel/Close) — RESOLVED

- Sent by the client when ESC is pressed in a menu dialog
- Format: `[byte(p1), type1(p2), type4(p3)]`
- **Server must re-send the mech list frame.** The client uses the incoming
  frame to dismiss the dialog and return to mech selection; sending nothing
  leaves the client frozen indefinitely.
- Implemented in `handleGameData()` (`src/server.ts`): re-sends
  `buildMechListPacket` and resets `session.awaitingMechConfirm`.
  Verified by T7 in the M1 test pass.

### CRC for Combat Frames

- Combat init is `0x0A5C45` vs lobby's `0x0A5C25`
- The server currently always uses lobby init; the crossover point is unknown

### ACK Mechanism During Heavy Traffic

- Seq values > 42 trigger an ACK reply rather than command dispatch
- The exact flow for reliable delivery under lag is not implemented

---

## 17. COMMEG32.DLL — Secondary Connection Protocol (M2 RE)

**Confirmed by decompiling COMMEG32.DLL exports and internal functions in Ghidra,
informed by packet capture from the T1 test session (2026-04-05).**

### DLL Exported API (relevant subset)

| Export | Address | Role |
|--------|---------|------|
| `FilterDllMsg` | `100041d0` | Windows msg handler; dispatches to vtable[0x18] (method 24) of lobby-conn obj |
| `ProcessDllIdle` | `10004260` | Per-frame idle; loops calling vtable[0x1a] (method 26) on the lobby-conn obj |
| `MakeTCPConnection` | `100043e0` | Calls `Aries_Connect(1, param_2)` to open the primary ARIES connection |
| `SetInternet` | `100048e0` | Stores the "internet" address field from the REDIRECT payload |
| `SetUserPassword` | `10004840` | Stores the session password field from the REDIRECT payload |

### Aries_RecvHandler (`FUN_100014e0` / `100014e0`)

The central ARIES packet switch.  Called (via vtable) with each parsed ARIES packet.

```c
int __thiscall Aries_RecvHandler(int conn_obj, int packet_ctx)
```

| Case | ARIES type | Action |
|------|-----------|--------|
| 0 | `SYNC` (0x00) | `SendMessageA(game_hwnd, WM_0x7f0, payload_len, payload_ptr)` — raw data to MPBTWIN.EXE |
| 1 | `CONN_CLOSE` | Disconnect; sets conn flag at `conn_obj+0x154` |
| 2 | `CONN_ERROR` | Same as case 1 |
| 3 | `REDIRECT` (0x03) | **See below** |
| 5 | `KEEPALIVE` | Sends ARIES type-5 response; forwards to game-world conn if it exists; sends `WM_0x7f7` if no game-world conn (triggers graceful exit) |
| 0x16 | `LOGIN_REQUEST` | Calls `func_0x10001420()` which sends the ARIES LOGIN (type 0x15) response |
| 0x1a | text | `SendMessageA(game_hwnd, WM_0x7f9, len, ptr)` — async text command dispatch |
| 0x1e | Unknown | `SendMessageA(game_hwnd, WM_0x7f1, 0xc, ptr)` — unknown event |
| 0x21 | File download | XOR-decode binary payload; `GetProcAddress(0, fn_name_from_payload)` → execute (remote exec) |
| 0x22 | Dir change + file | `SetCurrentDirectoryA` + XOR-decode file content |

### Case 3 — REDIRECT (CONFIRMED)

When the client receives type 0x03 (REDIRECT):

1. `SendMessageA(game_hwnd, WM_0x7fe, 1, status_msg)` — notifies UI of redirect
2. Copies 120 bytes from packet (30 DWORDs = `addr[40]|internet[40]|pw[40]`)
3. Parses via `func_0x10010fea`: splits into addr, internet, pw fields
4. Calls `SetInternet(internet)` and `SetUserPassword(pw)`
5. Closes any existing game-world connection (`g_aries_GameWorldConn = NULL`)
6. Calls `Aries_Connect(1, addr_string)` to open the new secondary connection
7. If connection fails: `SendMessageA(game_hwnd, WM_0x7f9, 0xcd, error_msg)`

### Aries_Connect (`func_0x100011c0`) — CONFIRMED

```c
int __thiscall Aries_Connect(int conn_type, char *addr_string)
```

- Validates the address and calls `Aries_OpenSocket` to create the socket
- Creates `g_aries_GameWorldConn` (`DAT_1001a080`) via `func_0x10002610(conn_type, 0x7e9)`
- On success: stores socket handle at `conn_obj[0x44]`, returns 1

### Aries_OpenSocket (`func_0x10001d80`) — CONFIRMED

```c
int __thiscall Aries_OpenSocket(int conn_obj, int *addr_string_ptr)
```

**Critical behaviour:**
```c
puVar1 = strchr(*addr_string_ptr, ':');   // find ':' in addr
if (puVar1 == NULL) return -1;            // FAIL if no port separator
*puVar1 = 0;                              // null-terminate host part
// puVar1+1 = port string
port = atoi(puVar1 + 1);                  // parse port number from string
connect(host, port);                      // TCP connect
```

**The addr field in the REDIRECT payload MUST be in `"host:port"` format.**
Sending just `"127.0.0.1"` (no colon) causes `Aries_OpenSocket` to return -1
immediately, silently failing the secondary connection.

**Current emulator behavior:** REDIRECT sends `"127.0.0.1:2000"` (the
`ARIES_PORT` value in `constants.ts`). This is intentional until a separate
world listener exists on a distinct port.

### Secondary Connection Handshake — CONFIRMED

After `Aries_OpenSocket` succeeds, the secondary connection uses the **same
ARIES auth sequence** as the primary (lobby) connection:

```
Server → Client: ARIES LOGIN_REQUEST (type 0x16, empty payload)
Client → Server: ARIES LOGIN (type 0x15, same 333-byte payload, same username/pw)
Server → Client: ARIES SYNC (type 0x00, empty)
Server → Client: ARIES SYNC with WELCOME escape sequence
Client → Server: ARIES SYNC with cmd-3 capabilities
Server → Client: [game world initialization packets]
```

Evidence: `Aries_RecvHandler` case 0x16 unconditionally calls `func_0x10001420()` (the LOGIN responder) — this fires on BOTH the primary and secondary connections.  The secondary connection is authenticated independently.

### cmd-26 Count Encoding Limit — CONFIRMED

**Confirmed by RE of `Cmd26_ParseMechList` (`FUN_0043a370`) in MPBTWIN.EXE:**

```c
uVar3 = FUN_00402f40();          // read raw byte from stream (returns B - 0x21)
iVar4 = (int)(char)uVar3;        // SIGNED CHAR CAST
if (0 < iVar4) { /* loop */ }   // skips all entries if iVar4 ≤ 0
```

`encodeAsByte(N)` writes `N + 0x21` to the wire.  The client decodes to N, then
casts N to a **signed char**.  For N ≥ 128, signed char becomes negative and the
loop is skipped — no mechs are stored.

**Maximum safe count: 127** (encoded as raw byte 0xA0; `(char)127` = 127 > 0).

Our current safe sender limit is `MECH_SEND_LIMIT = 20` (raw byte 0x35), which is
safely within this encoding range and matches the client's static mech-list array
capacity enforced by `buildMechListArgs`.

---

## 18. Game World Protocol — MPBTWIN.EXE RE

**Confirmed by decompiling `FUN_00428920` (WndProc), `FUN_00429870` (WM_0x7f0 handler),
`FUN_00429510` (world accumulator), `FUN_004294c0` (world dispatcher),
`FUN_00402cf0` (Lobby_RecvDispatch), `FUN_00402e30` (Frame_VerifyCRC), and
`FUN_00429a00` (lobby welcome gate).**

### Summary

The game world protocol after REDIRECT is **identical to the lobby protocol**:
same ESC-delimited frame format, same 19-bit LFSR CRC, same `Lobby_RecvDispatch`
function, two sub-tables switched by one flag.

### WndProc — `FUN_00428920` (WM table) — CONFIRMED

| WM value | Purpose |
|---------|---------|
| `0x7f0` | ARIES raw data received → `FUN_00429870(data, len)` |
| `0x7f7` | Disconnecting (graceful) → `FUN_00433f30()` (quit) |
| `0x7f8` | Communications error → display message + quit |
| `0x7f9` | Fatal error/winsock error → display message + quit |
| `0x7fa` | Lost TCP connection → display message + quit |
| `0x7fe` | Redirect-in-progress → `DAT_00474d14 = (param_3 == 1)` (status flag) |
| `0x855` | INITAR `Ordinal_11(data)` |
| `0x856` | INITAR `Ordinal_9(data)` |
| `0x857` | Copy string to `DAT_004e2500`; `Ordinal_4(1, &dat)` → `MakeTCPConnection` |
| `0x858` | INITAR `Ordinal_12(param_3)` |
| `0x859` | INITAR `Ordinal_13(data)` |
| `0x85a` | INITAR `Ordinal_14(data)` |
| `0x85b` | INITAR `Ordinal_10(param_3)` |

### WM_0x7f0 Handler — `FUN_00429870` — CONFIRMED

Demultiplexes lobby vs game world data using `DAT_004e2de8`:

1. **`DAT_004e2de8 < 1`** (pre-welcome, lobby gate): → `FUN_00429a00` (welcome gate)
2. **`DAT_004e2de8 >= 1`** (post-welcome):
   a. If data starts with `'\x1b?'`: compare to welcome strings:
      - Matches `"\x1b?MMW Copyright Kesmai Corp. 1991"`: world-MMW init sequence
      - Matches `"\x1b?MMC Copyright Kesmai Corp. 1991"`: world-MMC (direct combat) init
   b. Otherwise: `FUN_00429510(data, len)` — world ESC accumulator

### Two Welcome Strings — CONFIRMED

| String | Address | Mode set | Combat? |
|--------|---------|----------|---------|
| `"\x1b?MMW Copyright Kesmai Corp. 1991"` | `DAT_00474d48` | `DAT_004e2cd0=0` (RPS) | No |
| `"\x1b?MMC Copyright Kesmai Corp. 1991"` | `DAT_00474d70` | `DAT_004e2cd0=1` (Combat) | Yes |

Our game world server MUST send **MMW** as the welcome string. MMC activates
combat-only dispatch and loads `scenes.dat` — it is the original dedicated
combat server path (never needed for standard emulation).

### Frame Accumulator and Dispatch — CONFIRMED

```
Raw ARIES SYNC bytes
    ↓ FUN_00429510 (ESC accumulator)
    ↓   Collects bytes; on ESC('\x1b') → null-terminate + dispatch
    ↓   Skips '\r' and '\n'; ESC resets buffer ptr to DAT_004d5b34
    ↓ FUN_004294c0 (world dispatcher)
    ↓   Null-terminates at buf[0xFFF] (max 4095 B)
    ↓   FUN_00402e30 → Frame_VerifyCRC(buf) → 19-bit LFSR check
    ↓   If OK: FUN_00402cf0 → Lobby_RecvDispatch → command table lookup
    ↓   If BAD: Frame_WriteCmdByte(2) → send NACK byte; FUN_00429400
    ↓ FUN_00429440 (post-dispatch ACK)
```

### CRC Seed Crossover — CONFIRMED

Inside `Frame_VerifyCRC` (`FUN_00402e30`):

```c
uVar4 = (-(uint)(DAT_004e2cd0 == 0) & 0xFFFFFFE0) + 0x0a5c45;
// RPS mode  (DAT_004e2cd0==0): 0xFFFFFFE0 + 0x0a5c45 = 0x0a5c25
// Combat mode (DAT_004e2cd0!=0): 0x00000000 + 0x0a5c45 = 0x0a5c45
```

| Mode | `DAT_004e2cd0` | CRC seed |
|------|--------------|---------|
| RPS (lobby + world MMW) | `0` | `0x0a5c25` |
| Combat (MMC direct-connect) | `≠ 0` | `0x0a5c45` |

**Implication**: For our server (MMW path), CRC seed is always `0x0a5c25`.
No seed change happens mid-session in standard gameplay.

### Dual Dispatch Tables — CONFIRMED

`Lobby_RecvDispatch` selects one of two command tables based on `DAT_004e2cd0`:

**RPS table** (`DAT_00470198`): `DAT_004e2cd0 == 0`; max index 0x4c (cmd 0–76)
**Combat table** (`DAT_00470408`): `DAT_004e2cd0 != 0`; max index 0x4f (cmd 0–79)

| Cmd | Wire byte | RPS dispatch address | Notes |
|-----|-----------|---------------------|-------|
| 0 | — | NULL | unused |
| 1 | `0x22` | `FUN_0040C030` | Seq/ACK check |
| 2 | `0x23` | `FUN_0040C060` | |
| 3 | `0x24` | `0x0040C190` | `Cmd3_ThunkSendCapabilities` |
| 4 | `0x25` | `0x00414B70` | |
| 5 | `0x26` | `0x0040C2F0` | |
| 6 | `0x27` | `0x0040C300` | |
| 7 | `0x28` | `0x004112B0` | `Cmd7_ParseMenuDialog` |
| 8 | `0x29` | `0x00413960` | |
| 9 | `0x2a` | `0x0040C310` | |
| 10 | `0x2b` | `0x0040C370` | |
| 11 | `0x2c` | `0x0040C6C0` | |
| 12 | `0x2d` | `0x0040C5C0` | |
| 13 | `0x2e` | `0x0040C920` | |
| 14 | `0x2f` | `0x00415700` | `Cmd14_PersonnelRecord` | Reads `type4 comstar_id`, `type3 battles_to_date`, then two legacy/unused `type4` values, followed by six `Frame_ReadArg` strings. Opens a type-2 text window and formats the visible record as: current selected roster handle via `MPBT.MSG[0x98]` (`Handle  : %s`), formatted ComStar ID, `MPBT.MSG[0xa0]` (`Battles to date: %ld`), then the six server-supplied strings verbatim as additional lines. The dialog installs `FUN_00415690` as its key handler: Enter/ESC close the view, while Space emits `Cmd7(0x95, 2)` and flushes, strongly suggesting a built-in `More` / next-page request for personnel records. |
| 15 | `0x30` | `0x004139C0` | |
| 16 | `0x31` | `0x00411DE0` | same addr as cmd 19 |
| 17 | `0x32` | `0x0041E2C0` | Mid-function entry inside the bilateral scene-offer / duel-review family. This address lands in the accept/choice path that ultimately emits client `cmd 29`; it is not a clean standalone parser start. |
| 18 | `0x33` | `0x00420780` | `Cmd18_SceneOfferStatus` | Reads one type1 mode/status value and routes into the shared scene-offer panel builder `FUN_00413800(...)`. Confirmed string anchors from `MPBT.MSG`: mode `0` shows `Contract accepted.` (`449`), while mode `6` builds the `Contract Accepted` / `What name should it be filed under?` (`450` / `451`) filing-under prompt. This is part of the agreement / subcontract acceptance UI family, not a ranking surface. |
| 19 | `0x34` | `0x00411DE0` | same as cmd 16 |
| 20 | `0x35` | `0x00411D90` | `Cmd20_ParseTextDialog` |
| 21 | `0x36` | `0x004208C0` | |
| 22 | `0x37` | `0x00420940` | |
| 23 | `0x38` | `0x00420990` | |
| 24 | `0x39` | `0x00420A10` | |
| 25 | `0x3a` | `0x00411590` | |
| 26 | `0x3b` | `0x0043A370` | `Cmd26_ParseMechList` |
| 27 | `0x3c` | `0x0043A6B0` | |
| 28 | `0x3d` | `0x00413D20` | |
| 29 | `0x3e` | `0x00427710` | |
| 30 | `0x3f` | `0x0043B4E0` | |
| 31 | `0x40` | `0x0043C190` | |
| 32 | `0x41` | `0x0043A520` | Alternate list parser / extended ranking-style list. Reads `type1 list_id`, `byte count`, then per row a numeric `item_id`, a second numeric field, and a `type3` score-like value before formatting the visible text partly from local lookups rather than three free-form wire strings. Only list ids `0x20` and `0x3e` flip the shared dialog into its multi-select submit mode; other list ids still behave like ordinary single-pick lists. This remains a candidate for Solaris ranking / match-results style data, but it is no longer the strongest row-shape match. |
| 33 | `0x42` | `0x00419360` | `FUN_00419370` — Ok-dialog callback |
| 34 | `0x43` | `0x00413FF0` | |
| 35 | `0x44` | `0x00429C80` | |
| 36 | `0x45` | `0x004161A0` | `Cmd36_MessageView` | Reads `type4 reply_target_id` plus a `Frame_ReadString` body. Creates a type-4 read-message window. `reply_target_id == 0` gives a plain read-only page; nonzero adds `Reply` and `Enter`, and the installed key handler reopens the local compose builder `FUN_00416db0(reply_target_id, NULL)` when the user presses `R`. This is a received-message / reply view, not the compose editor itself. |
| 37 | `0x46` | `0x00416D40` | `Cmd37_OpenCompose` | Reads one `type4` count-or-target value; if `0 < value < 1000`, reads that many additional `type4` ids into a local array; otherwise treats the first value as the single target identifier. Then calls `FUN_00416db0(value, ids)` to open the local editable compose window. This is the server-side wrapper around the same compose builder used locally by the inquiry submenu. Passing `0` still lands in that same ComStar-specific editor; this pass did not uncover any separate generic first-login name-entry mode behind `Cmd37`. |
| 38 | `0x47` | `0x00419250` | |
| 39 | `0x48` | `0x0043DAE0` | Scene-status text / toast family. Dispatch lands inside `FUN_0043da70`, which either appends text into `g_world_SceneStatusTextWidget` or pushes a short transient status update depending on the current local scene-status mode. |
| 40 | `0x49` | `0x0040ECB0` | |
| 41 | `0x4a` | `0x00415AF0` | |
| 42 | `0x4b` | `0x00412680` | |
| 43 | `0x4c` | `0x0040EED0` | |
| 44 | `0x4d` | `0x00410000` | `Cmd44_KeyedSingleStringList` (mid-function entry into `FUN_0040fe80`) | Reads a `type1 list_id`, a title string, a count, then per row a `type4 item_id` plus one wire string. Builds a numbered selection list while preserving the wire `item_id` for later `Cmd7(listId, item_id + 1)` replies. The ordinary callback (`LAB_00410a70`) sends plain `Cmd7` for ESC / row pick, then only skips the close helper `FUN_0040faf0()` for keep-open list ids `0x08`, `0x0c`, `0x22`, `0x25`, and `0x34`. Special case: `list_id == 0x22` appends a synthetic `item_id = 100` row labeled `Exit to online service` (`MPBT.MSG[139]`) locally, and picking that row opens `FUN_00444af0()` instead of sending a wire request. An alternate callback (`LAB_00410bb0`) exists but uses `cmd29` control-family `2` for both ESC and row pick, so it should not be treated as the ordinary terminal-picker path. Strong current candidate for compact chooser menus such as **Choose a ranking tier** / **Choose a mech class**. |
| 45 | `0x4e` | `0x0040CEF0` | `Cmd45_ScrollListShell` | Reads a 1-byte mode and a `Frame_ReadString` title/body string into `DAT_004e1844`, normalizing `\` to newlines. Creates/reuses a type-6 scroll-list window backed by `DAT_004e2620`, installs callbacks `FUN_0040ce70` / `FUN_0040ca70`, and copies the previously latched list-id from `DAT_00472a34` into `window[0x512]` so later Enter/ESC actions can emit `Cmd7(listId, selection)` replies. Enter on a populated row goes straight to `Cmd7(listId, item_id + 1)`; only `listId == 0` diverts into the local `Personal inquiry on:` submenu. Mode `0/1` creates a plain list shell, `2/4` add Space/ESC footer controls, and `3` adds a Space-only footer. Crucial paging clue: in `FUN_0040ca70`, pressing **Space** while `mode != 3` sends raw outbound byte `0x1c` (client `cmd28`), flushes, and clears the shared row store, which is the strongest current match for a built-in **MORE / next-page** action. New hard proof from `FUN_00433310`: when the long string is rendered into a real window it feeds each line through `FUN_00431f10`, so the `|NN|%id` / `|NN|$text` row-feed grammar can ride **inline inside the same Cmd45 body string** rather than requiring a separate visible carrier command. |
| 46 | `0x4f` | `0x00414130` | Rich record / info panel (mid-function entry inside `World_HandleInfoPanelPacket_v123`) | The containing handler reads one `type4` id, one `type3` numeric value, skips two additional `type4` fields, then reads **six wire strings** and renders a modal text/info page. The proven title/label format hardcodes `MPBT.MSG` fields including `Handle`, `ID`, and `Battles to date`, making this the strongest current candidate for richer Solaris ranking/personnel detail beyond the simpler `Cmd14` page. Follow-up xrefs show it also pushes the client-global room-presence buffer `004f4238` for its visible `Handle` line, so it is **not** an escape hatch from the same local-handle dependency that affects `Cmd14`. |
| 47 | `0x50` | `0x004192F0` | |
| 48 | `0x51` | `0x00411DF0` | `Cmd48_KeyedTripleStringList` | Wrapper to `FUN_00411e20(1)`. Reads `type1 list_id`, a `Frame_ReadArg` title string, a 1-byte count, then per row: `type4 item_id` + three `Frame_ReadArg` strings. Builds a type-4 numbered selection window where each line formats as `N. <item_id> <str1> <str2> <str3>` when `item_id != 0`. Selecting an entry later emits `Cmd7(list_id, item_id + 1)` via `FUN_00412190`. This is the strongest current candidate for the real global all-roster / KP5 response, because the payload naturally fits `ComStar ID + handle + sector + location` style rows. |
| 49 | `0x52` | `0x0040F980` | Solaris map connector / path overlay. Reads one compact type3 value, resolves two map-node indices plus a color/style value, and draws a line between the corresponding Solaris map locations. |
| 50 | `0x53` | `0x00410460` | |
| 51 | `0x54` | `0x00410480` | |
| 52 | `0x55` | `0x00401000` | |
| 53 | `0x56` | `0x004010C0` | |
| 54 | `0x57` | `0x00419320` | |
| 55 | `0x58` | `0x00419340` | |
| 56 | `0x59` | `0x0040FD60` | Solaris map room-marker overlay. Reads a compact type2 bitfield, resolves one map location plus color/style, and draws a small highlight box over that room on the Solaris map. |
| 57 | `0x5a` | `0x004168E0` | |
| 58 | `0x5b` | `0x0040CEE0` | `Cmd58_SetScrollListId` | Reads one `type1` value via `FUN_0040d4c0()` and stores it in `DAT_00472a34`. `Cmd45_ScrollListShell` later copies that value into `window[0x512]`, making `Cmd58` a companion “set list-id for the scroll-list shell” packet rather than a visible UI command on its own. |
| 59 | `0x5c` | `0x0040D4E0` | |
| 60 | `0x5d` | `0x0040FEB0` | Solaris map room-marker overlay (wide-range variant). Same visual family as `Cmd56`, but with wider packed bitfields for room/style indices. |
| 61 | `0x5e` | `0x0040FA00` | Mid-function entry inside `World_RefreshSceneLocationIcons_v123`. Refreshes / rebuilds the per-location icon buttons for the current Solaris scene after the location table has been populated. |
| 62–75 | — | NULL | unused in RPS mode |
| 76 | `0x61` | `0x0040C0A0` | in both tables |

Combat-only entries (cmd 62–79, only non-null in combat table):

| Cmd | Wire byte | Combat dispatch address |
|-----|-----------|------------------------|
| 62 | `0x63` | `0x004017E0` |
| 63 | `0x64` | `0x00406880` |
| 64 | `0x65` | `0x00401390` |
| 65 | `0x66` | `0x00401820` |
| 66 | `0x67` | `0x00401E40` |
| 67 | `0x68` | `0x00401E70` |
| 68 | `0x69` | `0x00402380` |
| 69 | `0x6a` | `0x00402530` |
| 70 | `0x6b` | `0x004026D0` |
| 71 | `0x6c` | `0x00402A90` |
| 72 | `0x6d` | `0x00406140` |
| 73 | `0x6e` | `0x004022D0` |
| 74 | `0x6f` | `0x004069F0` |
| 75 | `0x70` | `0x00406840` |
| 76 | `0x71` | `0x0040C0A0` | (same as RPS 76) |
| 77 | `0x72` | `0x00401F80` |
| 78 | `0x73` | `0x004069E0` |
| 79 | `0x74` | `0x00402AB0` |

### 12.1 World UI / display-family map (2026-04-14)

Not every RPS/world dispatch address is a real function start. Several entries
(`17`, `21`–`24`, `44`, `46`–`47`, `50`–`51`, `61`) jump into interior labels of
larger handlers. Even with that limitation, the inbound world-command table now
clusters into a few concrete UI families:

| Family | Commands | Display family | Notes |
|--------|----------|----------------|-------|
| Modal text / record pages | `14`, `20`, `36`, candidate `46` | text page / info panel | `Cmd14` is the currently proven personnel-record page; `Cmd20` is a generic text dialog; `Cmd36` is read-message / reply view. |
| Scene-offer / duel-review pages | `17`, `18`, `21`–`24` | bilateral review / accept-cancel panel family | Uses agreement / subcontract / duel-specific `MPBT.MSG` text and local callbacks that emit `cmd29`, `cmd11`, `cmd13`, `cmd15`, `cmd30`, or `cmd32` depending on subtype and mode. |
| Numbered selection lists | `26`, `32`, `44`, `48` | numbered list | `Cmd26` is the basic list/mech-list family; `Cmd32` is the extended numeric/list family; `Cmd44` is a keyed single-string chooser; `Cmd48` is the keyed triple-string list. |
| Scroll-list shell | `45`, `58` plus row-feed helpers | scrollable list with optional `Space` / `ESC` footer controls | Backed by `DAT_004e2620`. `Cmd58` latches the list id; `Cmd45` opens the shell; Enter on a populated row emits `Cmd7(listId, item_id + 1)`. |
| Solaris map / scene overlays | `40`, `43`, `49`, `56`, `60`, `61` | map / overlay family | `Cmd40` / `Cmd43` open the Inner Sphere / Solaris maps; `Cmd49`, `Cmd56`, and `Cmd60` draw connectors/markers; `Cmd61` refreshes scene location icons after map/scene state changes. |
| Scene status text | `39` | inline world status text | Updates the status/toast text region in the current world scene. |

### 12.2 Sanctioned-duel ranking and results display-family inference

This remains partly inferential because no live packet capture has yet shown the
retail Solaris ranking/result screens, but the client-side evidence is now strong
enough to narrow the likely packet families and, for Tier Rankings, the visible
page opener itself:

- **Tier Rankings exact opener (current best proved flow)**:
  1. **Tier chooser step** — a `Cmd44` keyed single-string chooser is the best fit for the
     manual's "menu of the seven tiers appears" behavior, using title text such as
     `Choose a ranking tier:` (`MPBT.MSG[1138]`) and the tier rows in
     `MPBT.MSG[1124..1131]`.
     `FUN_0040fe80()` now pins the exact packet shape for that family as
     `list_id + title + count + repeated (item_id + one display string)`, and
     the picker's normal row-selection path is concretely tied to plain
     outbound `Cmd7`, not `cmd10`/`cmd16`.
  2. **Results-page opener** — the actual rankings page opens through the
     **`Cmd45` scroll-list shell**, preceded by `Cmd58` to latch its list id.
     The remaining row-feed question is now much narrower: `FUN_00433310`
     proves the shared `|NN|%id` / `|NN|$text` grammar can be embedded directly
     in the same long string that Cmd45 renders into the shell window.
  3. **Why this is now strong** — `BT-MAN.txt` says Tier Rankings use
     **MORE** / **DONE**, and `FUN_0040ca70` shows the `Cmd45` shell is the only current
     ranking candidate with a dedicated **Space => outbound `cmd28` next-page** path plus
     ESC cancellation semantics.
  4. **Still unresolved hop** — the *top terminal option* that leads into this chooser
     is not yet packet-capture-proven. Current best inference now leans more
     strongly toward a shared keep-open `Cmd44` keyed-list family than toward an
     ordinary plain-`Cmd7` menu, because the older contrary `Cmd7` callback
     evidence was misattributed to the triple-string list family.

- **Top terminal / facility menu (strongest current candidate, still inferential)**:
  - The best current fit is now a **`Cmd44` one-string keyed menu with `list_id = 0x22` and title/prompt `Choose option:` (`MPBT.MSG[192]`)**.
  - Why `Cmd44` fits:
    - `FUN_0040fe80()` now explicitly proves the family contract is
      `list_id + title + count + repeated (item_id + one display string)`, which
      matches a terminal utility chooser closely
    - terminal/facility options in `MPBT.MSG` are predominantly **single-line labels**, e.g.
      - `Send a ComStar message` (`145`, `178`)
      - `Receive a ComStar message` (`179`)
      - `Check News Grid` (`180`)
      - `Solaris Match Results` (`266`)
      - `View Personal Tier Rankings` (`1118`)
      - `Tier Rankings` (`1121`)
      - `Class Rankings` (`1122`)
    - that shape matches `Cmd44` much better than `Cmd48` or the paged `Cmd45` shell
    - the ordinary `Cmd44` callback path (`LAB_00410a70`) still reports both
      normal picks and ordinary ESC through plain outbound `Cmd7`
    - after a pick, that same ordinary callback only keeps the dialog open for
      list ids `0x08`, `0x0c`, `0x22`, `0x25`, and `0x34`; all other `Cmd44`
      list ids fall through the close helper `FUN_0040faf0()`
    - the separate `LAB_00410bb0` / `cmd29` path is an alternate callback and
      should not be treated as the default terminal-pick behavior
    - the broader service-option block in `MPBT.MSG[178..190]`
      (`Send a ComStar message`, `Receive a ComStar message`, `Check News Grid`,
      `Examine Planetary Info`, `Set News Agent Options`, `Move without any Mechs`,
      `General news`, `Access Newsgrid`, `Transfer funds to someone`,
      `Change Handle`, `Review Personal Status`, `Examine my Contract`,
      `Review Unit Status`) reads like one coherent terminal / facility utility menu
    - the immediately adjacent `MPBT.MSG[192] = Choose option:` is the best current
      title/prompt match for that broader option block
    - unlike the proven local inquiry submenu (`MPBT.MSG[144..146]`), this
      `178..192` cluster currently has **no direct local menu-builder xrefs** in
      the client (`FUN_00405840(...)` / `FUN_004397c0(...)` search), which fits a
      server-fed `Cmd44` menu much better than a client-local dialog
  - Why `list_id = 0x22` currently fits best:
    - it is one of the shared **keep-open** list ids
    - the `Cmd44` builder appends a synthetic local `item_id = 100` row only for
      `list_id = 0x22`, and that row is explicitly labeled
      `Exit to online service` (`MPBT.MSG[139]`)
    - its callback keeps the dialog open after normal picks, which matches a reusable
      terminal utility menu better than a single-shot selection dialog
    - semantically, `Exit to online service` fits a broad utility / facility / terminal
      menu much better than it fits a narrow chooser such as tiers, mech classes, or
      other focused pickers
  - Current best solved mapping:
    - **family**: `Cmd44` keyed single-string menu
    - **list id**: strongest candidate `0x22`
    - **title/prompt**: strongest candidate `Choose option:` (`MPBT.MSG[192]`)
    - **body options**: strongest candidate block `MPBT.MSG[178..190]`
    - **local synthetic tail row**: `Exit to online service` (`MPBT.MSG[139]`)
  - This is still not packet-capture-proven, but it is now the tightest coherent
    model the client evidence supports.

- **Room/category typing from manual + client RE**
  - The late-1990s manual gives **strong category-level semantics**, but not a full
    authoritative room-by-room type table for every location.
  - What is strongly supported:
    - **Bars** are real room/category concepts.
      - Manual: bars have **booths and terminals**.
      - Client RE: the social-room roster/booth flow is proven
        (`All`, `Stand`, `New Booth`, `Join`; booth statuses `5..12`).
    - **Terminals / ComStar facilities** are real room/category concepts.
      - Manual: every bar booth has a terminal, and **ComStar facilities function
        like a terminal in a bar**.
      - Client RE: the strongest current terminal menu fit is the server-fed
        `Cmd44` service menu described above.
    - **Arenas / ready rooms / battlegrounds** are real room/category concepts.
      - Manual: arenas, ready rooms, sanctioned arenas, and battleground entry are explicit.
      - Client/server RE: arena scenes get special scene options like
        `Fight`, `Mech`, and `Duel Terms`.
    - **Tram / monorail travel** is real, but currently looks more like a
      **travel interaction/system** than a distinct packet family or proven universal
      room enum.
      - Manual: tram/monorail is the access path to arena districts.
      - Client RE: tram uses the same `cmd5 actionType 4 -> Cmd43` Solaris travel-map
        flow as ordinary Solaris travel; no tram-specific world command was found.
    - **Global ComStar access** is also a real gameplay concept, separate from
      physically being inside a bar or facility.
      - Manual (`BT-MAN.txt` 398-423): players can send ComStar messages by clicking
        the lower-left ComStar logo, and the manual explicitly says that clicking it
        "will provide the same functions as a ComStar terminal."
      - Deeper world-scene RE now shows a fixed lower-left scene control path in
        `World_HandleSceneWindowInput_v123`: widget id `1` bypasses the server-supplied
        `Cmd4` roster table and directly sends `cmd5 actionType 4`.
      - Manual (`BT-MAN.txt` 586-609): the terminal section explicitly documents at
        least `Send a ComStar message`, `Receive a ComStar message`, and
        `Tier rankings`.
      - Strong current inference: the always-available ComStar icon is likely meant
        to expose the same broad terminal family as a bar / ComStar-facility terminal,
        even though the exact local opener path is still not packet-capture-proven.
  - Current practical interpretation for server world-map typing:
    - `bar` and `terminal` should remain **separate semantic tags**
    - but **bars should also expose terminal behavior**, because the manual explicitly
      says terminals exist at bar booths
    - dedicated `terminal` rooms likely correspond to **ComStar facilities / service buildings**
    - `tram` is better treated as a **travel-access behavior/context** unless stronger
      room-level proof appears
  - Current `world-map.json` graph evidence strengthens that interpretation:
    - the existing `bar` rooms are **not adjacent** to the dedicated `terminal` rooms
    - current shortest same-sector bar-to-terminal paths are:
      - `Riverside (155) -> Lyran Building (153)`: **4 steps**
      - `Marina (170) -> Government House (148)`: **7 steps**
      - `White Lotus (149) -> Government House (148)`: **9 steps**
      - `Waterfront (150) -> Government House (148)`: **9 steps**
    - so the current map does **not** support modeling bar terminal access as merely
      "walk to the nearby terminal room"
    - if the manual is followed, bars need their **own terminal interaction surface**
      even when a separate `terminal` room also exists in the same sector
    - and independently of room type, the client/game design also wants a
      **global ComStar access surface** available from anywhere
  - Important caution:
    - the server's current `RoomType` union
      (`bar | arena | hub | terminal | bank | street | sector | path`)
      is a **useful server taxonomy**, not yet a fully RE-proven client enum
    - `world-map.json` already includes dedicated `terminal` rooms, but
      `buildSceneInitForSession()` currently only branches on `room.type === 'arena'`
      for special scene actions, so the world-map data is ahead of the playable
      terminal UI right now
    - current emulator behavior is even narrower than the manual:
      - it does support **ComStar compose** and **message delivery/reply**
      - but the main entry surface is currently the all-roster inquiry submenu
        (`Send a ComStar message` / `Access personnel data`)
      - there is no proven retail-faithful always-available ComStar icon/menu yet,
        and no surfaced bar/facility terminal utility menu yet

- **Solaris Match Results exact opener (strongest current fit, still inferential)**:
  - Best current fit is a **direct `Cmd45` scroll-list shell page**, again with `Cmd58`
    plus row-feed data before the visible shell opens.
  - The most likely title is `Solaris Match Results` (`MPBT.MSG[266]`).
  - Unlike Tier Rankings, no manual text yet proves `MORE` / `DONE` paging for this
    screen, so the family fit is strong but the exact mode/title pairing is still not
    packet-capture-proven.

- **Alternate `Cmd44` callback (`LAB_00410bb0`)**
  - ESC sends `cmd29(family = 2, list_id, 0)`.
  - Row selection sends `cmd29(family = 2, list_id, item_id + 1)`.
  - Because the ordinary `Cmd44` callback already covers plain `Cmd7` picker
    behavior, this alternate callback is now best treated as a separate
    control/panel path rather than evidence about the top terminal menu.

- **Tier Rankings** — current best fit: **`Cmd45` scroll-list shell family**
  (`Cmd58` + row feed + `Cmd45`).
  - Strongest reason: the manual explicitly says the ranking list shows **MORE**
    for the next page and **DONE** to cancel.
  - `Cmd45` is the only currently mapped world list family with native
    `Space` / `ESC` footer-control modes, a persistent scrollable row store, and a
    concrete Space handler that emits outbound raw byte `0x1c` for the next page.
  - This makes it a better fit for paged rank listings than `Cmd48`, even though
    `Cmd48` matches the row *shape* very cleanly.

- **Tier Rankings row shape** — secondary candidate: **`Cmd48` keyed triple-string list**.
  - `BT-MAN.txt` says each row shows:
    - ComStar ID
    - Handle
    - rank score
    - win/loss ratio
  - `Cmd48` natively carries exactly `item_id + 3 strings`, so it remains the
    cleanest structured-table match if later capture disproves the pager path.

- **Tier / class chooser menus** — current best fit: **`Cmd44` keyed single-string list**.
  - `MPBT.MSG` already contains the exact compact chooser prompts and option sets:
    - `Choose a ranking tier:` (`1138`) with tier labels `Unranked`, `Novice`, `Amateur`,
      `Professional`, `Veteran`, `Master`, `BattleMaster`, `Champion`
    - `Choose a mech class:` (`1139`) with `Light`, `Medium`, `Heavy`, `Assault`
  - `Cmd44` is the cleanest currently mapped family for **one string per row** plus a
    preserved numeric item id, which matches a tier/class picker much better than the
    denser `Cmd48` or paged `Cmd45` result displays.
  - This is now the strongest current candidate for the *first visible screen* after
    selecting the Tier Rankings terminal option, before the paged rank table opens.

- **View Personal Tier Rankings / richer ranking detail** — strongest current
  detail-page candidate: the **rich info-panel family** at dispatch `46/0x4f`.
  - The containing handler family reads:
    - one `type4` id
    - one `type3` numeric value
    - six wire strings
  - and hardcodes `MPBT.MSG` personnel/ranking labels such as:
    - `Handle  : %s` (`152`)
    - `ID      : %ld` (`153`)
    - `Battles to date: %ld` (`160`)
  - This makes it a strong candidate for the richer Solaris ranking/personnel
    summary page that goes beyond the simpler, already-proven `Cmd14` personnel record.
  - `BT-MAN.txt` also says this option shows the player's current tier rank and rank
    score **and** presents the seven-tier menu. The current server now follows that
    manual-backed compatibility shape by sending the `Cmd46` personal panel and then
    immediately opening the proven `Cmd44` tier chooser. The remaining uncertainty is
    only whether retail kept both surfaces visible concurrently or sequenced them in a
    slightly different UI arrangement.

- **Solaris Match Results** — current best fit: also the **`Cmd45` scroll-list shell family**.
  - Best current inference is that match results are presented as a paged list or
    scroll surface rather than a single modal page.
  - No direct handler has yet been tied to the title string `Solaris Match Results`
    (`MPBT.MSG[266]`), so this remains an informed hypothesis rather than a
    packet-capture-confirmed fact.

- **Current end-to-end ranking-flow hypothesis**
  - `Cmd44` family opens the compact chooser (`tier` / `class` filter).
  - `Cmd45` scroll-list family presents the paged result set (`MORE` / `DONE`).
  - `Cmd46` rich info-panel family presents the per-player ranking/personnel detail page.
  - `Cmd48` remains the best structured row-shape fallback if later capture shows the
    results list is not actually using the scroll-list shell.

- **What is *not* currently favored**
  - The richer client submit path `Cmd16` is **not** a global requirement.
    Current RE narrows it to special numbered-list ids `0x20` and `0x3e`.
  - For the current Solaris ranking/result candidate flow, the practical working
    conclusion is now: `Cmd44` chooser + `Cmd45` / `Cmd58` scroll shell still
    submits ordinary row picks through `Cmd7`, while **MORE** stays on raw
    outbound `cmd28`. No current evidence ties sanctioned rankings or match
    results to the `Cmd16` multi-select path.

Combat-handler revalidation against the local `MPBTWIN.EXE` on 2026-04-06 gives the
first useful M7 position-sync lead, but it is **combat-mode only** and should not be
copied into M4/M5 world navigation:

- RPS/world `cmd 3` remains `Cmd3_TextBroadcast`. In combat mode, the same handler
  reads and XOR-processes an argument, but it is not the primary position packet.
- Combat `cmd 65` / wire `0x66` (`FUN_00401820`) is the strongest local match for the
  third-party "Type P" position note: `player-id`, encoded X/Y as 3-byte integers,
  encoded Z as a 2-byte integer, then four 1-byte rotation/speed fields.
- The local X/Y offset is `0x18e4258` (decimal `26002008`), not RazorWing's documented
  `26100312`; rotation/speed scaling also differs from the simplified external notes.
- Combat `cmd 64` (`FUN_00401390`) seeds remote combatants, `cmd 72` (`FUN_00406140`)
  seeds the local combat scene/self, `cmd 68`/`69` are effect/projectile-like updates,
  `cmd 70` drives combat animation/state, and `cmd 73` stores two scaled per-player
  control/aim/offset values.

### World Handshake Sequence — CONFIRMED

After the client receives the REDIRECT packet and `Aries_Connect` succeeds:

```
[Secondary TCP connection established]
Server → Client: ARIES LOGIN_REQUEST  (type 0x16)
Client → Server: ARIES LOGIN          (type 0x15, same format as lobby LOGIN)

[Server sends welcome as raw ARIES SYNC type-0x00 payload:]
Server → Client: ARIES SYNC "\x1b?MMW Copyright Kesmai Corp. 1991"

[Client FUN_00429870 ≥1 path, '\x1b?' match, world init fires:]
  - sets DAT_004e2cd0 = 0 (stays RPS)
  - calls FUN_00432fb0, Lobby_OnWelcomeB, FUN_00403070
  - calls Cmd3_SendCapabilities (FUN_0040d3c0) ← CLIENT SENDS CMD-3
  - calls FUN_00429440 (post-dispatch ACK)
  - sets DAT_004d5b30=1, runs game world rendering init

[Normal world command dispatch loop begins]
Client → Server: cmd-3 capabilities frame (same 4-byte payload as lobby)
Server → Client: game world command frames (RPS table, cmd 0–76)
```

### Server-Side Implications for M3

1. **Listen on `WORLD_PORT` (2001)**; use the same ARIES packet wrapping
2. **Send `LOGIN_REQUEST`** (type `0x16`, empty payload) after TCP accept
3. **Receive `LOGIN`** packet from client; validate (same format as lobby)
4. **Send welcome** as ARIES SYNC (type `0x00`) containing the raw bytes:
   `"\x1b?MMW Copyright Kesmai Corp. 1991"` (exactly 33 bytes + null if needed)
5. **Receive cmd-3** from client (capabilities, 4 bytes: `[1, 6, 3, 0]`)
6. **Send world initialization commands** via same ESC-framed format with CRC seed `0x0a5c25`
7. All subsequent data: same frame encoding as lobby (ESC‐framed, 19-bit LFSR CRC)

### World Command Semantics — RPS Table (Confirmed First 13 Entries)

**Confirmed by decompiling each handler in MPBTWIN.EXE via Ghidra (M2 RE).**
Frame-reading helpers referenced below:

| Helper | Address | Role |
|--------|---------|------|
| `Frame_ReadByte` | `FUN_00402f40` | Read one decoded byte (raw − 5) |
| `Frame_ReadInt(n)` | `FUN_00402b10` | Read n-byte integer |
| `Frame_ReadArg(buf)` | `FUN_0040c0d0` | Read variable-length encoded arg into buffer |
| `Frame_ReadString(buf)` | `FUN_0040c130` | Read base-85-decoded text string into buffer |

| Cmd | Wire | Handler | Canonical Name | Semantics |
|-----|------|---------|----------------|-----------|
| 1 | `0x22` | `FUN_0040C030` | `Cmd1_PingAck` | Reads one seq byte; if it matches `g_expectedSeq` (`DAT_004e2c44`): records RTT elapsed (`FUN_004292b0`) and advances the round-robin seq slot (`FUN_00429380`). Silently drops frame on seq mismatch. |
| 2 | `0x23` | `FUN_0040C060` | `Cmd2_PingRequest` | If `g_expectedSeq ≠ 0`: records current RTT, then calls `FUN_00429280(connObj, newSeq)` which sets a new expected-ack value, fires `COMMEG32.Ordinal_7` to send the reply packet to the server, and resets the RTT timer. Server is requesting a latency probe reply. |
| 3 | `0x24` | `FUN_0040C190` | `Cmd3_TextBroadcast` | **Corrects §8 label.** In RPS mode: `Frame_ReadString` → display received text in chat scroll-window (`DAT_00472c90`); only effective after `g_chatReady` (`DAT_00472c84 ≠ 0`). In combat mode: reads data and XOR-processes it. Server sends a plain text announcement to the client. |
| 4 | `0x25` | `FUN_00414B70` | `Cmd4_SceneInit` | Large UI-initialization command (~2836 bytes). Reads: `type1` context/scene id, 1-byte session flags (`0x10` = read scene slot/name payload, `0x20` = clear cached scene table, low nibble enables four scene-location icons), 1-byte current client scene slot, and `type1` current scene visual id; optionally reads four target scene-slot bytes plus four target visual ids, then **two scene-header strings** (a `Frame_ReadArg` string plus a counted string). `World_HandleSceneInitPacket_v123` formats those two strings into the visible world header as `"          %s\\\\%s"`, so this path is packet-text driven rather than a proven automatic room-description lookup from the local map table. The packet then reads a 1-byte scene-option count plus option type/string pairs, creates the main world window, chat scroll-window, location icons, action buttons, and status boxes, and sets `g_chatReady = 1` at completion. Earlier docs described the four slots as opponent/mech entries; `FUN_00419390` confirms they are also the ordinary scene location-icon targets for world navigation. |
| 5 | `0x26` | `FUN_0040C2F0` | `Cmd5_CursorNormal` | Calls `FUN_00433ec0` → loads `IDC_ARROW` cursor (`0x7f00`), clears `DAT_00474d00`. Server signals "loading complete; restore normal cursor". |
| 6 | `0x27` | `FUN_0040C300` | `Cmd6_CursorBusy` | Calls `FUN_00433ef0` → loads `IDC_WAIT` cursor (`0x7f02`), sets `DAT_00474d00 = 1`. Server signals "processing; show hourglass". |
| 7 | `0x28` | `FUN_004112B0` | `Cmd7_ParseMenuDialog` | Menu dialog renderer — documented in §11. |
| 8 | `0x29` | `FUN_00413960` | `Cmd8_SessionData` | Reads connection object (`FUN_0040d4c0`), then `Frame_ReadArg` into `DAT_0048a070`. Passes buffer to `FUN_00413800(conn, buf, NULL)` — loads per-session binary data (mech load-out / team assignment). Updates two input-handler jump-table entries. |
| 9 | `0x2a` | `FUN_0040C310` | `Cmd9_CharacterNameAllegiancePrompt` | Reads sentinel byte; if `0x01`: reads a 1-byte count, then that many `Frame_ReadArg` string entries into `DAT_004de000` (40-byte slots). Earlier notes mislabelled this as a room-player list. A tighter `FUN_00405840` xref sweep shows the handler calls `FUN_0042da40`, which opens `FUN_00413800(0x3fd, FUN_00405840(5), NULL)` using local `MPBT.MSG[5]` = `"Enter your character's name"`. When the player presses Enter, `FUN_00413a60` copies the typed text into `DAT_004ddfd0` and calls `FUN_0042daa0`, which opens a numbered type-3 selector titled with `FUN_00405840(6)` = `"Choose your allegiance:"` and formats each server-supplied entry as `"%d. %s"`. The numbered selection callback `FUN_0042dbf0` emits outbound bytes `0x09, 0x01, <DAT_004ddfd0 string>, <selected-index byte>` via `FUN_0040d400`, then flushes. This is now the strongest candidate for the original first-login callsign + allegiance flow; it is not the passive room-entry roster sync and not the KP5/global all-roster path. |
| 10 | `0x2b` | `FUN_0040C370` | `Cmd10_RoomPresenceSync` | Clears the live room roster table at `DAT_004e1870`, then reads a batch of roster records into that same structure used by `Cmd11`/`Cmd12`/`Cmd13`: first record is `type4 session-id`, `byte status`, `Frame_ReadArg callsign`; subsequent records repeat `type4 session-id`, `byte status`, `Frame_ReadArg callsign` until a sentinel status byte `0x54` is read after a final ignored `type4`. The first record selects roster index `0` via `DAT_004e2608 = 0`. Status bytes are stored as `status - 5`, which matches `Cmd13` using zero for a normal present occupant. After seeding the table, the handler appends a natural-language occupant list to the world chat window using message ids `0x0f`..`0x12`. This is the strongest current candidate for the initial same-room presence sync that should precede later incremental `Cmd13` arrivals and `Cmd11` status/leave updates. Hybrid GUI+socket validation on 2026-04-06 confirmed a socket client entering while `MPBTWIN.EXE` was already in-world received `Cmd10` entries for itself and the live GUI occupant (`Pilot_mnnw67n7`). |
| 11 | `0x2c` | `FUN_0040C6C0` | `Cmd11_PlayerEvent` | Reads 4-byte session-ID + 1-byte status code + callsign string. Finds/creates roster slot via `FUN_0040c590`. Status: `0` removes the occupant from the live room table; `1–4` format the status through `DAT_00472a34[status]`; `0x54` is a special terminal/update case; and other values store `status - 5` into the same `DAT_004e1872` presence-state field used by the room roster UI. The social-room roster path (`FUN_00412e60`) groups that field as `0 = Standing`, `1..7 = Booth 1..7`, so wire statuses `5..12` are the concrete standing/booth states used by current world-room presence work. Appends a formatted event line to chat. |
| 12 | `0x2d` | `FUN_0040C5C0` | `Cmd12_PlayerRename` | Reads 4-byte session-ID + new callsign string. Looks up existing roster slot, formats "{old} is now {new}" message (MSG `0x13`), overwrites stored name in player table, appends to chat. |
| 13 | `0x2e` | `FUN_0040C920` | `Cmd13_PlayerArrival` | Reads 4-byte session-ID + callsign string. Searches player table for matching session-ID (update) or first free slot (insert). Sets active flag, stores callsign, resets timer field to 0, appends "{callsign} entered" line (MSG `0x19`) to chat. |
| 14 | `0x2f` | `FUN_00415700` | `Cmd14_PersonnelRecord` | Reads payload: `type4 comstar_id`, `type3 battles_to_date`, two additional `type4` values currently unused by the display code, then six `Frame_ReadArg` strings. Creates a type-2 modal text page. The visible header lines are formatted locally as selected-handle (`MPBT.MSG[0x98]` / `Handle  : %s`), ComStar ID, and `MPBT.MSG[0xa0]` (`Battles to date: %ld`); the six payload strings are appended verbatim as the remaining body lines. The installed key handler closes on Enter/ESC, but pressing Space sends `Cmd7(0x95, 2)` and flushes, making `0x95` the strongest current candidate for the personnel-record `More` / next-page request. |

---

## 18b. Cmd36 — User Creation Wizard (`FUN_004161A0`) — RESOLVED

**Confirmed by decompiling `FUN_004161A0` (Cmd36 handler) in MPBTWIN.EXE.**

Cmd36 is the **original Kesmai new/returning player detection command**, sent by the real
server early in the RPS session to present either a "Create New Pilot" wizard or a
"Continue as Existing Pilot" dialog.

### Wire Format

```
[B85_4 int: iVar3 / accountId]  [B85 string: dialog display text]
```

| Field | Type | Purpose |
|-------|------|---------|
| `iVar3` | B85_4 (5 bytes) | `0` = new user; non-zero = returning accountId |
| string | B85 string | Player callsign or prompt text shown in dialog |

### Client Behaviour

`FUN_004161A0` reads `iVar3` from the wire and branches:

**`iVar3 == 0` — New player:**
- Creates a medium-width dialog (`FUN_004145a0(4)`) at position (0, 0xdd)–(0x280, 0x103)
- Adds two clickable buttons:
  - Button `0x0d` — "Proceed as new pilot" (always present)
  - Button `0x6d` — scroll/more (only if dialog text > 10 lines: `uVar6 != 0`)
- Sets `DAT_004ddfc0+0x44 = 0x21` (roster ready flag)
- Keyboard handler at `LAB_00415f50` (scroll up/down, Escape → dismiss)
- Clicking button `0x0d` → `FUN_004160c0` + `FUN_00411200` → closes dialog, shows arena

**`iVar3 != 0` — Returning player:**
- Same dialog but adds a third button:
  - Button `0x72` — "Continue as existing pilot"
  - Button `0x0d` — "Create new pilot instead"
  - Button `0x6d` — scroll (if text > 10 lines)
- Keyboard handler at `LAB_00415f50` (same scroll)
- `DAT_00472c94[0x50d]` set to `LAB_00416170` (ESC/Space → remap to button press)
- Clicking button `0x72` — "Continue": closes dialog, **then** calls `FUN_00416db0(iVar3, 0)`
  which opens a second confirm dialog with the player's character data
- Clicking button `0x0d` — "New": closes dialog, shows arena directly (same as new-user path)

### Second Dialog — `FUN_00416db0` (Returning-User Confirm)

Opened after clicking "Continue" with `param_1 = accountId`:
- Creates another dialog with two buttons: `0x132` (OK/confirm) and `0x1b` (cancel)
- Loads up to 1000 character data entries from a supplied array; if >999, stores as a single int
- Keyboard at `LAB_00416b90`; scroll at `LAB_00417460`; Escape at `LAB_00416d10`
- Pressing OK → confirm account → enter arena
- Pressing Cancel → closes this dialog, returns to the wizard (account selection)

### Bypass Conditions

The wizard is triggered **entirely by receiving Cmd36**. There is no client-side allegiance
or callsign state that prevents it from firing, and there is no prior-message path that
stores callsign/allegiance into globals checked here.

**The only way to bypass the wizard is to never send Cmd36.** Our emulator does not send
Cmd36, which correctly skips both the new-user and returning-user dialog flows entirely.

### Emulator Notes

- We do **not** send Cmd36. Client proceeds from welcome → cmd-3 → Cmd4 arena without
  any user-creation dialog.
- The allegiance picker and character name our server previously showed via Cmd7 was our
  own addition (not related to Cmd36). In the current implementation, character creation
  happens in the lobby flow when processing the Cmd9 reply and inserting the record into
  the database; `handleWorldLogin` only consumes `launchRegistry` state for world entry
  and does not create character data.
- `FUN_00415f50` (keyboard handler at `LAB_00415f50`) and `FUN_00416170` (ESC/Space remap)
  are inline label targets inside the Cmd36 dialog; they are not independently reachable
  from the dispatch table.

---

**Correction note for §8**: The lobby dispatch table entry at index 3 was previously labelled
`Cmd3_Thunk — Calls Cmd3_SendCapabilities (FUN_0040d3c0)`.  Decompilation of `FUN_0040C190`
confirms it does **not** call `FUN_0040d3c0`.  `FUN_0040d3c0` is called directly from the welcome
gate handlers `FUN_00429870` and `FUN_00429a00` — it fires when the client receives the
`"\x1b?MM[WC]..."` welcome string, not in response to a server cmd-3 frame.

Additional world-client senders confirmed after the first real-client M4 pass:

- `FUN_0040d280` is the outbound world `cmd-4` free-text sender. In RPS mode (`DAT_004e2cd0 == 0`) it emits `cmd 4` followed by `FUN_00403100(param_1)`, which is `type1(length) + raw text`. Caller `FUN_00405080` feeds it from a local line-edit buffer when `DAT_004f3648 == 1`.
- The room roster menu uses `FUN_00412e60` + `FUN_004134f0`. Corrected against the local `MPBT.MSG`, message ids `0x120..0x128` are `All`, `Stand`, `New Booth`, `Join`, `Mech Warriors at the current location:`, `Hit ESC to cancel, A for roster of all Mech Warriors.`, `Standing`, `Booth %2d`, `Hit ESC to cancel, n to grab a new booth, s to stand.`.
- In that menu, `FUN_004134f0` emits `Cmd7(listId=3, selection=1)` for `All`, `selection=2` for `Stand`, `selection=0` for `New Booth`, and `selection = booth + 2` when joining a listed booth entry. Combined with `Cmd11` storing `status - 5` into `DAT_004e1872`, this pins the live social-room presence encoding as `5 = Standing`, `6..12 = Booth 1..7`.
- The `selection=1` (`All`) path does **not** have a direct local client continuation. The strongest current server-side candidate is still `Cmd48_KeyedTripleStringList` (`0x51`), which is self-contained and carries `item_id + three strings` per row.
- Tracing the shared list callback further narrows the downstream behavior: the proven `Send a ComStar message` / `Access personnel data` fork is the local synthetic `list_id = 1000` submenu from `FUN_00412980()`, not hidden logic inside `Cmd48` itself. That submenu does **not** need a server round-trip to open compose: option 1 directly calls the local editor `FUN_00416db0(target_id, NULL)`, whose submit path emits client `cmd 21` (`type4(target_id) + string`). Option 2 sends `Cmd7(0x3f2, target_id + 1)` for personnel data.
- Follow-up RE on world commands `36` / `37` corrects an earlier assumption: `Cmd36` (`FUN_004161a0`) is the received-message / reply viewer, while `Cmd37` (`FUN_00416d40`) is the server-side wrapper that opens the local compose editor. `Cmd36` with a nonzero `reply_target_id` installs `FUN_00415f50`, whose `R` key path calls `FUN_00416db0(reply_target_id, NULL)`. This strongly suggests inbound ComStar mail is not a plain `Cmd3` chat line in the original client.
- Additional issue #26 boundary from the `Cmd36`/`Cmd37` pass: `FUN_00416db0` still has only three confirmed callers (`FUN_00412190` inquiry submenu, `FUN_00415f50` reply, and `Cmd37_OpenCompose`), and its buttons/messages remain ComStar-specific even when invoked as `FUN_00416db0(0, NULL)`. A later `FUN_00405840` xref sweep corrected the low-id picture: `Cmd9` does have live direct callers for `MPBT.MSG[5]` (`"Enter your character's name"`) and `MPBT.MSG[6]` (`"Choose your allegiance:"`), while no direct `MPBT.MSG[4]` (`"Character Generation"`) or `[7]` (`"Enter choice:"`) caller was found. Strongest current inference: `Cmd9`, not `Cmd36`/`Cmd37`, is the likely authentic online callsign + allegiance prompt; `Cmd37(0)` remains only a workable compatibility bridge discovered by probe.
- Live GUI packet-capture follow-up on 2026-04-06 narrows that boundary further. For an instrumented first-login probe, forcing `Cmd37(0)` immediately after lobby `cmd 3` produced a real client `cmd 21` reply with `dialogId=0` and a free-text body, then cleanly advanced into the normal House `Cmd7` dialog and `REDIRECT` flow. Capture `1775516456379_e042e0b9-f205-49f1-9880-bd204826dce9.txt` shows the first proven zero-target submit shape:
  `1b 21 36 [type4 zero] [type1 text_len] [raw text] [crc x3] 1b`
  with no decoded inner `0x20` separator byte after the text payload. The captured sample begins `1b 21 36 21 21 21 21 21 21 67 ... 63 33 3b 1b`, so `0x67 - 0x21 = 70` bytes of submitted text.
- Important caveat from that same probe: the resulting editor still behaved like the existing ComStar compose window, not a clearly distinct `Character Generation` / `Enter your character's name` page. So `Cmd37(0)` is now proven as a workable compatibility bridge for first-login text entry, but it is still not evidence that the original online callsign prompt reused `Cmd37` unchanged.
- Live GUI `Cmd9` follow-up on 2026-04-06 confirms the stronger first-login hypothesis. An instrumented server sent `Cmd9` with entries `Davion`, `Steiner`, `Liao`, `Marik`, `Kurita` after the first lobby `cmd 3`; `MPBTWIN.EXE` rendered the local `MPBT.MSG[5]`/`[6]` flow and replied:
  `1b 21 2a 22 2b 4d 6f 6f 73 69 6e 67 74 6f 6e 25 27 2c 26 1b`
  Decoded: `seq=0`, `cmd=9`, `subcmd=1`, string length `10`, text `"Moosington"`, selected index `4`. The probe persisted `display_name="Moosington"`, `allegiance="Marik"`, then redirected to world. Lobby capture: `1775518868442_2e0cf05d-0986-4971-bd8f-df4ea8fcc43a.txt`; world follow-up capture: `1775518908694_13dc7a16-2abd-49f6-933b-01844f7473b8.txt`. Caveat: the local probe did not yet seed a launch record before REDIRECT, so the world-side init still fell back to username/mech defaults; that is a probe integration gap, not a `Cmd9` UI failure.
- Clean implementation follow-up: the server now uses `Cmd9` for normal first-login character creation, persists the typed display name and selected House directly from the `cmd 9 / subcmd 1` reply, and carries `accountId`, `displayName`, `allegiance`, and the default mech launch context across REDIRECT via `launchRegistry`. Socket smoke confirmed first-login and returning-account world init both render the typed callsign in `Cmd4`.
- That `Cmd7(0x3f2, target_id + 1)` personnel-data request now has a concrete reply: world `Cmd14_PersonnelRecord` (`0x2f`, `FUN_00415700`). The handler renders a modal text page using the currently selected roster handle, a payload `type4 comstar_id`, a payload `type3 battles_to_date`, and six server-supplied text lines. The local `Mpbt.msg` / `MPBT.MSG` files now confirm the exact adjacent personnel labels at indices `154..160`: `Rank`, `Standing with`, `Unit`, `Earnings`, `Wealth`, `Stable`, `Battles to date`.
- Additional client disassembly around the unlabeled `Cmd14` build path strengthens the current server limitation note: the dialog's visible header is split across two sources. The `ID` / battles values come from packet payload fields, but the `Handle` line still depends on the client-local room-presence roster state rather than a server-supplied handle string. That means the current server cannot show both the real target handle and the real target ComStar ID in the `Cmd14` header simultaneously without a deeper roster-table manipulation or a different record path.
- The strongest alternate-path candidate, `Cmd46`, does **not** avoid that dependency: `World_HandleInfoPanelPacket_v123` also formats its visible `Handle` line from the room-presence-backed global `004f4238`, which is updated by `World_HandleRoomPresenceSync_v123` / rename / event handlers. So the clean current fix is not "switch from `Cmd14` to `Cmd46`"; it is to align authenticated world presence IDs with real ComStar IDs.
- Server-side follow-up on 2026-04-15 now applies that cleaner fix directly. Lobby and world login both reject duplicate sessions for the same account, and authenticated world sessions now set `worldRosterId = 100000 + accountId`. That lets the room-presence table and the `Cmd14`/`Cmd46` header `ID` payload speak the same identifier for normal pilots, so the client can resolve the correct target handle without giving up the real ComStar ID. The remaining body `ID` line in the server is now only a compatibility fallback for non-authenticated/legacy edge cases until live GUI validation confirms the header is correct in practice.
- `Cmd14_PersonnelRecord` is paged. Its dialog callback `FUN_00415690` closes on Enter/ESC, but Space emits `Cmd7(0x95, 2)` before flushing. This is the strongest current candidate for the follow-up `More` request that advances to a second personnel-record page.
- Follow-up trace on `Cmd7(0x95, 2)`: no separate second-page reply handler has been identified so far. `FUN_00415690` is only installed by `Cmd14_PersonnelRecord`, and this pass did not uncover another world-command parser dedicated to a later personnel page. Strongest current inference: the server answers `Cmd7(0x95, 2)` with another `Cmd14_PersonnelRecord` page carrying a different set of six lines, rather than switching to a distinct command code.
- The only `Cmd48`-specific hard-coded `list_id` branch found so far is `0x2e`, which installs modal close boilerplate (`FUN_00411e00`) rather than a personal-inquiry action split. Inference: if KP5/all-roster really reuses `Cmd48`, the first row pick likely goes straight back to the server as `Cmd7(list_id, item_id + 1)`, and any later `ComStar vs personnel` split is either server-driven or implemented as a separate local follow-up packet sequence.
- Two-GUI validation follow-up on 2026-04-07: separate sandbox directories under
  `C:\Users\moose\mpbt-client-a` and `C:\Users\moose\mpbt-client-b` avoid the shared
  `play.pcgi` deletion/race. Client A consumed its launch file, authenticated as
  `GuiA_0407`, redirected to world, and received `Cmd4`/`Cmd10` normally with
  callsign `PilotA_0407`. Initial Client B attempts did not reach the server: renamed
  executables tripped the startup check `MPBTWIN string not found in command line`,
  while the in-place `MPBTWIN.EXE` copy tripped
  `MPBT Fatal Error (SetDisplayMode): Action not supported` with Client A active.
  A runtime-only sandbox-B patch then made the second GUI reach the server: patch
  `FUN_00428f60` at VA `00428f88` / file offset `0x28388` from `74` to `EB` to bypass
  the `FindWindowA("MPBattleTech", "Multiplayer BattleTech")` single-instance guard,
  and patch `FUN_00403250` at VA `00403351` / file offset `0x2751` from `74` to `EB`
  to continue past the second client's `SetDisplayMode(640,480,8)` failure. With those
  two patches applied only to `C:\Users\moose\mpbt-client-b\MPBTWIN.EXE`, Client B
  consumed `play.pcgi`, authenticated as `GuiB_0407`, redirected to world as
  `PilotB_0407`, received `Cmd4`, received `Cmd10 RoomPresenceSync (2 entries)`, and
  notified Client A's room of arrival. This is a test harness workaround, not a
  production client patch recommendation. The repeatable helper for applying this to
  a local sandbox copy is `tools/patch-mpbtwin-two-gui.ps1`.
- Follow-up on the 120-second GUI session timeouts: COMMEG32.DLL
  `FUN_100014e0` case `5` confirms server-initiated ARIES `Msg.KEEPALIVE` (`0x05`)
  is the right transport-level ping. The client responds by building a type-`0x05`
  packet with `FUN_10003600(..., 5)` / `FUN_10003680(...)` and writing it back on
  the socket. The server now sends configurable keepalive pings via
  `ARIES_KEEPALIVE_INTERVAL_MS` and keeps `SOCKET_IDLE_TIMEOUT_MS` configurable for
  long real-GUI validation runs.
- Real two-GUI keepalive validation on 2026-04-07: with Client B's sandbox copy
  patched as above and the server running with the default 30-second
  `ARIES_KEEPALIVE_INTERVAL_MS`, both GUI clients stayed connected past the old
  120-second idle cutoff. The server log showed repeated world `Msg.KEEPALIVE`
  pings and client type-`0x05` responses for both `PilotA_0407` and `PilotB_0407`,
  with no `session timed out` close. During the same run Client B emitted a real
  world `cmd-4` text frame (`Hello! Is it me you're looking for?!`), which the
  server parsed as room-local text from `PilotB_0407`.

---

## 18c. 2D World-Entry Commands — Cmd4, Cmd9, Cmd10, Cmd11, Cmd13 (M4 RE)

**Confirmed by decompiling handlers in MPBTWIN.EXE via Ghidra.**

This section corrects §18's command-table semantics for Cmd10/11/13 (the entry-game
world-room commands) and documents the confirmed wire formats used in our M4 server init.

---

### Dispatcher Confirmed

`Lobby_RecvDispatch` (`FUN_00402cf0`) converts the incoming command wire byte with
`iVar2 = wire_byte - 0x21` before indexing `g_lobby_DispatchTable` (`DAT_00470198`).
The **CmdN** label always means `iVar2 = N`, i.e. `wire_byte = N + 0x21`.

---

### Cmd4 — SceneInit (`FUN_00414B70`) — 2D World Frame

Cmd4 creates the **main game window** used for both the 2D game-world view and the
arena ready-room.  The distinction is controlled by the `arena_option_count` field:

| `arena_option_count` | Result |
|:---:|---------|
| 0 | 2D world mode: chat/text scroll-window (no mech buttons or scoreboard) |
| 1+ | Arena ready-room mode: mech-slot buttons and scoreboard |

`FUN_00414b70` calls `FUN_00414160` first (teardown/create the static main window struct
at `DAT_004ddf60`), then creates sub-windows via `FUN_00431880`:

| Global | Sub-window | Description |
|--------|-----------|-------------|
| `DAT_00472ca4` | 40-byte scroll area | Player header (callsign + mech type title) |
| `DAT_00472c90` | 600×144 scroll area | Main chat / text broadcast area |
| `DAT_00472c98` | Input box | Chat input field |

At completion: `g_chatReady` (`DAT_00472c84`) is set to `1`.  Cmd3 text-broadcast messages
are silently discarded if `g_chatReady == 0`.

**Sanctioned-duel implication (new):**

- The remembered world-visible duel winner/loser marquee is most likely plain `Cmd3`
  text written into this `DAT_00472c90` world scroll area rather than a separate
  duel-only widget.
- Current server state now matches that strongest fit: first persisted sanctioned
  duel results fan out a plain world `Cmd3` line to all `world`-phase sessions,
  while the same persisted row also feeds the terminal-side `Solaris Match Results`
  browser.

**Wire format (M4 impl):**
```
[B85_1 2B: match_id]           always 0
[byte  1B: session_flags]      0x30 = has-opponents | clear-arena
[byte  1B: player_score_slot]  0
[B85_1 2B: player_mech_id]     from launch record
-- if flags & 0x10 --
[byte × 4: opp_type + 1]       0x21 = "no opponent" for all 4 slots
[B85_1 × 4: opp_mech_id + 1]  0x2121 = "no opponent" for all 4
[string: scene_header]         first `%s` in the world-header format
[string: scene_detail]         second `%s` in the world-header format. The
                               ordinary world `Cmd4` / cache-row path is
                               packet-text-driven; current RE now shows no call
                               path from `World_HandleSceneInitPacket_v123` or
                               `World_ParseSceneInitCacheRow_v123` into the
                               local `SOLARIS.MAP` room-description renderer
                               (`FUN_0041fa30`). The client-local room lookup
                               exists in the travel/map UI state machine, not
                               in the ordinary world header path.
[byte: arena_option_count]     0 → 2D world mode, no arena buttons
```

---

### Cmd9 — RoomRoster (`FUN_0040C310`)

Sets the roster ready flag (`DAT_004ddfc0+0x44 = 8`) which gates several UI elements.
Send immediately after Cmd4 with count = 0 for an empty lobby.

**Wire format:**
```
[byte: gate]   must be 0x01 (wire 0x22) to activate
[byte: count]  number of roster entries
[count × string] callsign strings (stored in DAT_004de000, 40-byte slots)
```

---

### Cmd10 — RoomPresence ("Here you see…") (`FUN_0040C370`) — CORRECTED

§18's `Cmd10_TextFeed` description was incorrect.  Decompilation confirms:

`FUN_0040c370` reads a list of player records and:
1. Clears the entire player-presence table (`DAT_004e1870` region, 40-byte slots)
2. Reads the **first record unconditionally** (slot 0 = the receiving player themselves)
   — slot 0 is stored but **not** shown in the "Here you see…" display
3. Reads additional records in a loop until status byte == `0x75` (sentinel `T` + 0x21)
4. For occupied slots 1+: formats `"Here you see Alice, Bob and Charlie."` using
   MPBT.MSG strings: `0x0f` = "Here you see ", `0x10` = " and ", `0x11` = ", ", `0x12` = "."

**Wire format:**
```
─── Slot 0 (self — stored, not displayed) ──────────────────────────────────
[B85_4 5B: player_id]
[byte  1B: status + 0x21]    5 (standing) = wire 0x26
[string: name]
─── Loop: additional occupants (displayed), until sentinel ──────────────────
[B85_4 5B: player_id]
[byte  1B: status + 0x21]    0x75 = sentinel (loop ends; no name follows)
[string: name]               only read if status byte != 0x75
─── etc. ────────────────────────────────────────────────────────────────────
```

**Status values** (raw value before + 0x21 encoding):

| Raw status | Stored (status − 5) | Meaning |
|:---:|:---:|--------|
| 5 | 0 | Standing (not at a booth; omitted from display loop) |
| 6 | 1 | At booth 1 |
| 7 | 2 | At booth 2 |
| … | … | … |
| 0x54 ('T') | — | Sentinel / loop terminator |

For an empty room (only self): send slot 0 then the sentinel immediately.

---

### Cmd11 — PlayerStatus (`FUN_0040C6C0`) — CORRECTED

§18's `Cmd11_PlayerEvent` semantics were partially wrong.  Actual strings used are all
**room navigation** events, not arena-level events:

| Raw status | MPBT.MSG index | String |
|:---:|:---:|---------|
| 0 | 0x14 | `%s leaves.` |
| 1 | 0x15 | `%s leaves heading %s.` (direction from `DAT_00472a34[1]`) |
| 2 | 0x15 | `%s leaves heading %s.` (direction from `DAT_00472a34[2]`) |
| 3 | 0x15 | `%s leaves heading %s.` (direction from `DAT_00472a34[3]`) |
| 4 | 0x15 | `%s leaves heading %s.` (direction from `DAT_00472a34[4]`) |
| 5 | 0x16 | `%s stands.` |
| 0x54 | 0x17 | `%s leaves for battle.` |
| 6…N | 0x18 | `%s goes to booth %d.` (booth = status − 5) |

**Wire format:**
```
[B85_4 5B: player_id]   must match id from prior Cmd10 or Cmd13
[byte  1B: status + 0x21]
[string: name]
```

---

### Cmd13 — PlayerArrival (`FUN_0040C920`) — CONFIRMED

Reads player_id + callsign, finds or allocates a player-table slot, and appends
`"%s enters the room."` (MPBT.MSG index `0x19`) to the chat area if `g_chatReady`.

**Wire format:**
```
[B85_4 5B: player_id]
[string: callsign]
```

---

### Server World-Init Sequence (M4: Cmd4 → Cmd9 → Cmd10 → Cmd3 → Cmd5)

Confirmed correct order for entering the 2D game world with no arena slots:

```
Server → Client: Cmd6  CursorBusy      (hourglass)
Server → Client: Cmd4  SceneInit       (world frame; the lower scene panel is
                                       fed by the second native scene-header
                                       string in the ordinary world path)
Server → Client: Cmd9  RoomRoster      (count=0; sets ready flag)
Server → Client: Cmd10 RoomPresence    (self slot + sentinel; empty room)
Server → Client: Cmd3  TextBroadcast   (room description / welcome message)
Server → Client: Cmd5  CursorNormal    (restore cursor)
```

**Why Cmd4 is correct for the 2D world:** Cmd4 with `arena_option_count = 0` creates exactly
the main text/chat panel without any arena buttons.  The distinction between "2D world" and
"arena ready room" is purely the arena option count — `0` gives the 2D world frame.

---



### Tools Used

- **Ghidra 11** — primary disassembler / decompiler
- **Wireshark** — originally considered but private server was unavailable;
  analysis was done purely through static RE
- **Custom TypeScript server** (`src/server.ts`) — used to trigger client paths
  and observe what the binary did next

### Third-Party Cross-Reference — RazorWing/solaris

An independent MPBT RE project at [https://github.com/RazorWing/solaris](https://github.com/RazorWing/solaris)
cross-validates several findings in this document. **Important caveat**: it analyses
a different build of `Mpbtwin.exe` (MD5: `60c8febf6b4e0a319367e3c6557d705e`) — function
addresses and dispatch table offsets do not match our binary's. The **protocol wire
format** (base-85 encoding, 19-bit LFSR checksum, ESC framing) is identical.

Specific confirmed findings from that repo:

| Finding | Our RESEARCH.md | RazorWing source |
|---------|----------------|-----------------|
| Outbound CRC seeds | `0x0A5C25` / `0x0A5C45` | `calculate_checksum()` seeds 678949/678981 ✓ |
| **Inbound CRC seeds (NEW)** | `0x0C2525` / `0x0C4545` | `INBOUND_SEED_RPS=795941`, `INBOUND_SEED_COMBAT=804165` |
| COMMEG32 queue msg type=0 | §17 — all game packets use type 0 | `build_queue_message()` confirms |
| Short-format flag byte non-zero | §17 — `buffer[3] != 0` for short msg | `flag = 0x01` in `build_short_message()` |
| Cmd7 wire format | §11 | `build_cmd7_packet()` matches exactly |
| ESC `0x1B` frame delimiter | §3 | `encode_final_packet()` suffix `b'\x1B'` |

The repo also documents COMMEG32 ARIES message types 0/27/28/29 (heartbeat/ping/timing
configuration) in detail — not covered in this file because the server does not currently
implement COMMEG32-level timing; see `commeg32_message_types.md` in that repo for the
full `ParseProtocolMessage` switch-table and timing histogram structures.

Fresh audit on 2026-04-06 against `RazorWing/solaris` `main` at commit
`bcf5913` (`Solaris Prototype Server`) confirms the repo is small and source-only:
`solaris_server.py` plus four RE notes (`mpbtwin_protocol.md`, `mpbtwin_state.md`,
`commeg32_connection_analysis.md`, `commeg32_message_types.md`). Two caveats matter
before importing anything else:

- The RazorWing `MPBTWIN.EXE` hash (`MD5 60c8febf6b4e0a319367e3c6557d705e`) does not
  match the local target (`MD5 8735070e8f3eaa387d43db2223bca5cc`, SHA256
  `118dd4267e5bcfa762f511b8f7488afd03d090d48653fdffaf327d02effe13df`). Its COMMEG32
  hash also differs from ours (`RazorWing MD5 fdd292992368094a3f2da589c5fd1da3` vs
  local `MD5 6b6694d4647d61afcc018bd5058bb1ca`). Treat handler addresses and command
  table semantics as hints only.
- Their direct-launch path (`MPBTWIN.EXE /S=127.0.0.1:2001`) is not the same as our
  `play.pcgi`/INITAR/lobby/REDIRECT flow. It is still useful as a possible future
  direct-connect test harness, especially for the `MMC` combat banner path, but it
  bypasses the account and world-launch context that our server now emulates.

Useful follow-up leads from the fresh audit:

- The COMMEG timing model is the main unexplored transport-level value: type `28`
  configures `TargetTime`, `SendFreq`, and `PingFreq`; type `27` records ping RTT; type
  `29` sends a 168-byte latency histogram report. This is not needed for current M3/M4
  stability, but it is the best starting point if later long-running GUI sessions expose
  timing warnings or disconnects.
- `commeg32_message_types.md` also documents type `26` as UI text/error delivery via
  WM `0x7F6`. Our server should continue avoiding `Msg.TEXT_MSG` for normal gameplay
  because current local RE already shows it behaves like a fatal/error text path, not
  a chat primitive.
- The RazorWing `mpbtwin_protocol.md` combat/position command notes (`Type P/D/S`,
  position offset `26100312`, rotation multiplier `182`) may be useful for M5/M7 RE,
  but only after revalidating the corresponding handlers in our binary. In our current
  RPS/world table, cmd `3` is already proven to be text broadcast, not position sync.
  A follow-up Ghidra pass against the local binary found the closest position-sync
  match in the **combat** table at cmd `65` / wire `0x66` (`FUN_00401820`), with a
  different X/Y offset (`0x18e4258`) and different rotation/speed scaling from the
  RazorWing note. Treat this as an M7 combat lead, not an M5 world-navigation packet.

### RE Process

1. Open `COMMEG32.DLL` in Ghidra.  Run auto-analysis.
2. Find the main recv loop via xref to `recv` / `WSARecv`.  This leads to
   `Aries_RecvDispatch` (`FUN_100014e0`) — the ARIES packet dispatcher.
3. From the switch cases, map all message types.
4. Trace each case to find payload field readers → confirm LOGIN layout.
5. Open `MPBTWIN.EXE` in Ghidra.  Find `g_lobby_DispatchTable` (`DAT_00470198`)
   by searching for the "Invalid RPS command" string xref.
6. Read the 0x4C × 4 bytes of function pointers from the Bytes window.
7. For each non-NULL pointer: create the function, decompile, name it.
8. Trace argument readers (`Frame_DecodeArg` / `FUN_00402b10`, `Frame_ReadByte` / `FUN_00402f40`,
   `Frame_ReadString` / `FUN_00403160`) to confirm base-85 encoding sizes.
9. Trace `Frame_VerifyCRC` (`FUN_00402e30`) to confirm LFSR polynomial and init values.
10. Implement each protocol element in TypeScript, run the server, observe
    the client, repeat.

### Key Ghidra Tips for This Binary

- The lobby dispatcher `Lobby_RecvDispatch` (`FUN_00402cf0`) allocates a local "parse context" struct
  on the stack; a global pointer tracks the current parse position.
- `Frame_ReadByte` (`FUN_00402f40`) advances the global parse pointer by one and returns `*ptr - 0x21`.
- Nearly all arg-reading functions are wrappers around `Frame_DecodeArg` (`FUN_00402b10`) with
  different `n` values — always check what integer is passed to identify the wire width.
- String reader `Frame_ReadString` (`FUN_00403160`) reads one length byte then copies that many raw
  bytes; `Frame_CopyString` (`FUN_0040c0d0`) is the caller that also null-terminates the destination.

---

## 20. MEC File Binary Format

**Source**: `mechdata/*.MEC` (161 files, 552 bytes each)  
**Loader**: v1.23 `FUN_00433d10` (`MecFile_Load`) @ `0x00433d10`, MPBTWIN.EXE
**Confirmed against**: AS7-D (Atlas 100t), BJ-1 (Blackjack 45t), SDR-5V (Spider 30t), plus a full local v1.23 `mechdata/*.MEC` offset spot-check

### 20.1 Encryption

Every `.MEC` file is XOR-encrypted with a deterministic pseudo-random key stream
derived from the mech's variant name (the filename stem, lowercased).

**Seed derivation** (`FUN_0042f5a0`, "GetSeedID"):
1. Lowercase the stem (e.g. `"AS7-D.MEC"` → stem `"as7-d"`)
2. Take the last 4 characters of the stem, in reverse order: `'d', '-', '7', 's'`
3. Pack them as a little-endian uint32 → seed = `0x73372D64` for AS7-D

**PRNG step** (`FUN_0042f690`):
```python
def prng_step(state: int) -> int:          # all arithmetic mod 2^32
    uvar1    = (state * 0xF0F1 + 1) & 0xFFFFFFFF
    rotated  = ((uvar1 << 16) | (uvar1 >> 16)) & 0xFFFFFFFF
    return   (uvar1 + rotated) & 0xFFFFFFFF
```
The new state is returned in EAX and stored back to `DAT_00479980`.

**XOR decryption loop** (`FUN_0042f660`):
```python
def decrypt_mec(data: bytes, seed: int) -> bytearray:
    buf   = bytearray(data)
    state = seed
    n     = len(buf)          # 552
    for k in range(n - 3):   # 549 iterations (0 … 548)
        state = prng_step(state)
        for j in range(4):   # XOR 4 bytes at 1-byte stride
            if k + j < n:
                buf[k + j] ^= (state >> (8 * j)) & 0xFF
    return buf
```
This is an overlapping 4-byte XOR stream: each interior byte is XORed 4 times
by different PRNG outputs, giving a strong obfuscation.  Inner bytes 3–548 each
receive 4 XOR contributions; the first 3 and last 3 bytes receive fewer.

**Post-load transform** (inside `MecFile_Load`):
```c
struct->speed_raw = (struct->speed_raw * 2) / 3;
```
The field at offset `0x2E` is scaled down immediately after decryption; the stored
file value is the *raw* speed-related parameter.

### 20.2 Struct Layout

All fields are little-endian.  Offsets are from the start of the decrypted buffer.

| Offset | Size | Field | Notes |
|--------|------|-------|-------|
| `0x00` | u32  | `unk_combat_rating_a` | Bounded check: must be ≤ 0xAA (170); purpose unknown; correlates with mech capability |
| `0x04` | u32  | `unk_combat_rating_b` | Companion value to `0x00`; purpose unknown |
| `0x08` | u32  | `unk_point_value`     | Unknown large value (varies widely by mech) |
| `0x0C` | u32  | `unk_battle_value`    | Correlates with mech BV (~1800 Atlas, ~800 Spider) |
| `0x10` | u32  | `unk_modified_bv`     | Slightly lower than `0x0C`; purpose unknown |
| `0x14` | u16  | *(reserved/zero)*     | Always `0` in all tested files |
| `0x16` | u16  | `walk_mp`             | Walk hexes-per-turn (tabletop MP) |
| `0x18` | u16  | `tonnage`             | Mech mass in tons |
| `0x1A` | u16  | `armor_la`            | Left Arm armor |
| `0x1C` | u16  | `armor_ra`            | Right Arm armor |
| `0x1E` | u16  | `armor_ll`            | Left Leg armor |
| `0x20` | u16  | `armor_rl`            | Right Leg armor |
| `0x22` | u16  | `armor_ct_front`      | Center Torso front armor |
| `0x24` | u16  | `armor_lt_front`      | Left Torso front armor |
| `0x26` | u16  | `armor_rt_front`      | Right Torso front armor |
| `0x28` | u16  | `armor_ct_rear`       | Center Torso rear armor |
| `0x2A` | u16  | `armor_lt_rear`       | Left Torso rear armor |
| `0x2C` | u16  | `armor_rt_rear`       | Right Torso rear armor |
| `0x2E` | u16  | `speed_raw`           | Speed parameter, scaled to `speed_raw × 2/3` by loader |
| `0x30` | u16  | *(zero)*              | — |
| `0x32` | u16  | *(zero)*              | — |
| `0x34` | u16  | `heat_sinks`          | Total heat sink count |
| `0x36` | u16  | *(zero)*              | — |
| `0x38` | u16  | `jump_mp`             | Jump hexes-per-turn (0 if no jump jets) |
| `0x3A` | u16  | `weapon_count`        | Number of weapon slots |
| `0x3C` | i16  | `crit_state_extra_count` | v1.23 correction: used by `Combat_ClassifyDamageCode_v123` as the signed bound for a post-weapon class-0 damage-code range; this is **not** `weapon_ids[0]` |
| `0x3E` | u16[] | `weapon_ids[weapon_count]` | Array of weapon type IDs (see §20.3) |
| `0x8E` | u16[] | `weapon_mount_is_index[weapon_count]` | Internal-structure slot gate per weapon slot. `FUN_0042c200` reads `mec[0x8e + slot*2]`, then blocks firing if the actor's matching internal-state entry at `+0x20e` is zero. Index order matches the 8 local internal slots consumed by `Combat_ReadLocalActorMechState_v123`: `[LA, RA, LT, RT, CT, LL, RL, Head]`. |
| *var*  | …    | *(unknown fields)*    | Critical-hit slot data, ammo tracking; see §20.4 |
| `0xDE` | u16[45] | `crit_slot_table` | Critical-hit slot assignments; 0xFFFF = empty |
| `0x1EC` | u16 | `ammo_bin_count`      | Number of ammo bin records that follow |
| `0x1EE` | u16[] | `ammo_bin_qty[ammo_bin_count]` | Quantity per ammo bin |
| `0x202` | u16[] | `ammo_bin_type[ammo_bin_count]` | Weapon type ID for each ammo bin |

**Not stored in the file** (computed or hardcoded at runtime):
- Head armor: hardcoded as `9` for all mechs (`FUN_00438750` case 7)
- Internal structure per section: computed from `tonnage` via lookup table (`FUN_00438750`)
- Run MP: not stored; standard BattleTech formula `⌊walk_mp × 5/3⌋` applies

### 20.3 Weapon Type IDs

| ID | Weapon | Evidence |
|----|--------|---------|
| `0`  | Flamer | Local v1.23 roster fit is strongest on flamer-heavy variants (`FS9-H`, `FLE-4`, `WSP-1D`, `VTR-9A/9D`, `WHM-6L`, etc.); BT-MAN fixes `Dly = 3s` and `Max = 90m`, and `MPBTWIN.EXE.c` helper `FUN_0043b3f0` pins flamer damage to `3` via its 17-entry damage-potential table. `C:\MPBT\tools-local\weapon-range-smoke.mjs` now live-proves both the `100m` range gate (`stub-flamer:WSP-1D:none`) and a close-range hit (`stub-flamer-close:WSP-1D:cmd66:25/3`). |
| `1`  | Machine Gun | Documented multiset fit across BLR-1D, CPLT-K2, LCT-1V, PXH-1, and similar MG-equipped variants. `C:\MPBT\tools-local\weapon-damage-smoke.mjs` now live-proves current server resolution `Machine Gun:2`. |
| `2`  | Small Laser | Unique all-small-laser fits on CGR-1A1 and WSP-1W; also matches the non-missile energy filler on CPLT-C4 / HBK-4G. `weapon-damage-smoke.mjs` live-proves `Small Laser:3`. |
| `3`  | Medium Laser | Present in Atlas x4, Blackjack x4, Spider x2/x4; most ubiquitous energy weapon in 3025. `weapon-damage-smoke.mjs` live-proves `Medium Laser:5`. |
| `4`  | Large Laser | Resolved by AWS-8R/AWS-8T/AWS-8V once ids `2` and `15` are fixed. `weapon-damage-smoke.mjs` live-proves current server resolution `Large Laser:8`. |
| `5`  | PPC (Particle Projector Cannon) | Resolved by AWS-8V / CPLT-K2 / OTL-4F multiset fits. `weapon-damage-smoke.mjs` live-proves `Particle Projector Cannon:10`. |
| `6`  | AC/2 (Autocannon/2) | Appears in BJ-1 weapon list and matched ammo bin type. `weapon-damage-smoke.mjs` live-proves `Autocannon/2:2`. |
| `7`  | AC/5 (Autocannon/5) | Resolved by DRG-1N / JM6-S / RFL-3N / SHD-2H multiset fits. `weapon-damage-smoke.mjs` live-proves `Autocannon/5:5`. |
| `8`  | AC/10 (Autocannon/10) | Resolved by CN9-A / HBK-4H / ON1-K / RFL-3C multiset fits. `weapon-damage-smoke.mjs` live-proves `Autocannon/10:10`. |
| `9`  | AC/20 (Autocannon/20) | Resolved by AS7-D / BNC-3Q / HBK-4G / Victor variant multisets. `weapon-damage-smoke.mjs` live-proves `Autocannon/20:20`. |
| `10` | SRM-2 | Resolved by LCT-1S / DV-6M / SHD-2H / WSP-1A fits. `weapon-damage-smoke.mjs` live-proves current server resolution `SRM-2:4`, but retail-side missile interpretation is still blocked on stronger evidence than `FUN_0043b3f0` alone. |
| `11` | SRM-4 | Resolved by JR7-D, COM-2D, and Catapult/Orion/Victor fits. `weapon-damage-smoke.mjs` live-proves current server resolution `SRM-4:8`, with the same retail-side caveat as the other missile families. |
| `12` | SRM-6 | Resolved by AS7-D plus JVN-10N / HBK-4SP / WHM-6K fits. `weapon-damage-smoke.mjs` live-proves current server resolution `SRM-6:12`, with the same retail-side caveat as the other missile families. |
| `13` | LRM-5 | Resolved by GHR-5H / GRF-1S / LCT-1M / SHD-2H fits. `weapon-damage-smoke.mjs` live-proves current server resolution `LRM-5:5`, with the same retail-side caveat as the other missile families. |
| `14` | LRM-10 | Resolved by CN9-A / CP10-Q / DV-6M / WTH-1 fits. `weapon-damage-smoke.mjs` live-proves current server resolution `LRM-10:10`, with the same retail-side caveat as the other missile families. |
| `15` | LRM-15 | Resolved by AWS-8R / CPLT-C1 / CRD-3D / ZEU-6S fits. `weapon-damage-smoke.mjs` live-proves current server resolution `LRM-15:15`, with the same retail-side caveat as the other missile families. |
| `16` | LRM-20 | AS7-D weapon index 1; CPLT-C4 x2 and matching ammo bins confirm the family. `weapon-damage-smoke.mjs` live-proves current server resolution `LRM-20:20`, with the same retail-side caveat as the other missile families. |

Current coverage: family name/range/cooldown and direct damage are now pinned across all `774 / 774` weapon slots. The flamer / type-id-`0` gap is closed; the remaining caution is interpretive, not missing data — `FUN_0043b3f0` appears to use average cluster damage for missile families, so that helper alone should not be used to remap missile damage without stronger retail confirmation.

Additional client weapon-table follow-up from `MPBTWIN.EXE.c`:
- `FUN_004382e0` reads the per-weapon string ids from `DAT_00477b08` / `DAT_00477b0c`, which is enough to justify surfacing recovered `.MEC` weapon names in server-side `Cmd20` examine text even for BT-MAN stub variants.
- `C:\MPBT\tools-local\weapon-damage-smoke.mjs` now runs one labeled live combat case for every non-Flamer weapon family and reads the matching `cmd10 weapon fire accepted` line back out of `C:\Users\moose\mpbt-server.out.log`. Current live pass on the rebuilt server:
  - `PASS weapon-damage-smoke mg:Machine Gun:2 small-laser:Small Laser:3 medium-laser:Medium Laser:5 large-laser:Large Laser:8 ppc:Particle Projector Cannon:10 ac2:Autocannon/2:2 ac5:Autocannon/5:5 ac10:Autocannon/10:10 ac20:Autocannon/20:20 srm2:SRM-2:4 srm4:SRM-4:8 srm6:SRM-6:12 lrm5:LRM-5:5 lrm10:LRM-10:10 lrm15:LRM-15:15 lrm20:LRM-20:20`
- That smoke also exposed a coupled server bug: `getWeaponNameForSlot(...)` had still preferred BT-MAN `armament[slot]` text even when `.MEC` `weaponTypeIds` were present, while `getWeaponSpecForSlot(...)` already preferred `.MEC`. Variants with mismatched slot orderings (for example `AWS-8R`) could therefore log nonsense pairs like `LRM-15:8`. Combat slot-name lookup now prefers recovered `.MEC` type ids first, so name/range/cooldown/damage resolution stays aligned.
- Deeper pass on `FUN_0043b3f0` / missile interpretation:
  - Ghidra ref-manager scan on the current `Mpbtwin.exe` found **no code or data references** to `FUN_0043b3a0` (`0043b3a0`) or `FUN_0043b3f0` (`0043b3f0`) in this binary.
  - The adjacent `FUN_0043b4a0` **is** referenced, but only from fall/destruction / `Cmd70` animation-state paths (`FUN_00448d80`, `Combat_Cmd70_ActorAnimState_v123`), not from weapon-damage application. That makes the `0043b3f0` table look more like leftover or currently-unused helper code than an active damage resolver.
  - The active nearby numeric field is `DAT_00477b54`, not `FUN_0043b3f0` itself:
    - `FUN_004106b0` sums `DAT_00477b54` across mounted/available weapons
    - `FUN_00410790` folds that into a normalized current-strength / effectiveness value for an actor
    - `FUN_00410870` compares those strength values between two actors
    - `FUN_00410a20` then combines that comparison with range checks (`FUN_00410960`, which uses `DAT_00477b40` max range) to choose one of several coarse response/action codes
  - Interpretation: the same missile values that resemble average cluster damage are actively suitable as **combat-power / target-evaluation weights**, even if they are not direct per-shot missile damage. That is a better fit for the `2,6,8,3,6,9,12` missile rows than for literal salvo totals.
  - Practical conclusion:
    - flamer `3` remains a safe promotion because the non-missile rows line up with direct per-shot damage and there is no flamer-specific ambiguity
    - missile rows in `FUN_0043b3f0` are now even weaker as retail direct-damage proof than before: the helper appears unreferenced, and the matching active field is being used in a strength/threat-style path where average-cluster weighting makes sense
- `C:\MPBT\tools-local\mech-examine-smoke.mjs` now live-proves the world mech-picker **variant-step** `Cmd20` path on the rebuilt server:
  - `WSP-1D` examine text includes recovered `Flamer` / `Small Laser`
  - `ANH-1A` examine text includes recovered `Autocannon/10`
- `FUN_0043b3f0` embeds the following damage-potential values by weapon type id:
  - `0:3`, `1:2`, `2:3`, `3:5`, `4:8`, `5:10`, `6:2`, `7:5`, `8:10`, `9:20`, `10:2`, `11:6`, `12:8`, `13:3`, `14:6`, `15:9`, `16:12`
  - non-missile rows match direct per-shot damage
  - missile rows match classic average cluster damage rather than full salvo totals
  - that makes flamer `3` safe to promote without forcing a broader missile reinterpretation
- `FUN_0043b3a0` / the HUD helper at `00436449` confirm `DAT_00477b40` is the weapon max-range field in meters, and `DAT_00477b24` is a minimum-range threshold used by the local combat HUD to mark targets inside minimum range.
- Current negative result: this pass did **not** find a corresponding client fire-block path on the minimum-range field. The known xrefs only drive range-band / HUD feedback, so server-side min-range rejection would still be speculative.

Prior notes treated `0x3C+` as the weapon-id array. v1.23 `FUN_00433910` reads weapon ids from `0x3E + slot*2`, and `Combat_ClassifyDamageCode_v123` reads `0x3C` separately as a signed count/bound for damage-state codes. Local decode examples:
AS7-D `field_0x3c=8`, weapons `[9,16,3,3,3,3,12]`; BJ-1 `field_0x3c=8`, weapons `[6,6,3,3,3,3]`; SDR-5V `field_0x3c=9`, weapons `[3,3]`.

### 20.4 Cross-Validation Table

| Field | AS7-D (Atlas 100t) | BJ-1 (Blackjack 45t) | SDR-5V (Spider 30t) |
|-------|--------------------|----------------------|---------------------|
| Seed  | `0x73372D64` | `0x626A2D31` | `0x722D3576` |
| `tonnage` (0x18) | **100** | **45** | **30** |
| `walk_mp` (0x16) | **3** | **4** | **8** |
| `jump_mp` (0x38) | **0** | **4** | **8** |
| `heat_sinks` (0x34) | **20** | **11** | **10** |
| `crit_state_extra_count` (0x3C) | 8 | 8 | 9 |
| `speed_raw` (0x2E) | 27 → 18 | 27 → 18 | 18 → 12 |
| `armor_la` (0x1A) | **34** | **12** | **5** |
| `armor_ra` (0x1C) | **34** | **12** | **5** |
| `armor_ll` (0x1E) | **41** | **17** | **6** |
| `armor_rl` (0x20) | **41** | **17** | **6** |
| `armor_ct_front` (0x22) | **47** | **18** | **8** |
| `armor_lt_front` (0x24) | **32** | **15** | **6** |
| `armor_rt_front` (0x26) | **32** | **15** | **6** |
| `armor_ct_rear` (0x28) | **14** | **9** | **4** |
| `armor_lt_rear` (0x2A) | **10** | **6** | **2** |
| `armor_rt_rear` (0x2C) | **10** | **6** | **2** |
| `weapon_count` (0x3A) | 7 | 6 | 2 |
| `weapon_ids` (0x3E+) | `[9,16,3,3,3,3,12]` | `[6,6,3,3,3,3]` | `[3,3]` |
| `ammo_bin_count` (0x1EC) | 5 | 1 | 0 |

**Variant name**: sourced from `MechWin_LookupMechName` (§Appendix A) which reads the
mech string table at `MPBT.MSG` offset `(mech_id + 0x3AE) * 2` (§15).  The loader
uses this name both to construct the filename `mechdata\<name>.MEC` and as the
encryption seed source.

Additional weapon-loss proof from the client fire gate (`FUN_0042c200`, 2026-04-15):

- The function rejects a weapon slot immediately when:
  - `slot < 0` or `slot >= weapon_count`
  - the per-slot cooldown is active
  - the mounted internal section referenced by `mec[0x8e + slot*2]` is zero
- This is the concrete retail section-loss gate behind hardpoint loss: the client does
  not just look at generic weapon names or the visible HUD; it checks the slot's
  `.MEC`-encoded mounted section before allowing the shot.
- The visible HUD disable is a second, adjacent path: class-3 damage codes
  (`0x28 + weaponSlot`) feed `Combat_UpdateWeaponDamageState_v123` (`0x0042bd10`),
  which stores a non-zero weapon state and refreshes the local weapon/TIC HUD through
  `FUN_00422860` and `FUN_00424f80`. So retail "weapon lost" behavior is:
  internal section reaches zero -> shot gate fails, and a weapon-state update can grey
  the slot out in the HUD.
- Sample decrypted mount refs:
  - `CPLT-C1`: slot refs `[RA, LA, RL, LL, CT, CT]` for `[LRM-15, LRM-15, Medium Laser, Medium Laser, Medium Laser, Medium Laser]`
  - `CPLT-C4`: slot refs `[RA, LA, CT, CT]` for `[LRM-20, LRM-20, Small Laser, Small Laser]`
  - `CPLT-K2`: slot refs `[RA, LA, RL, LL, RL, LL]` for `[PPC, PPC, Medium Laser, Medium Laser, Machine Gun, Machine Gun]`
- This matches the remembered Catapult behavior closely enough to implement authoritative
  server-side hardpoint loss from `.MEC` mount refs instead of guessing from chassis lore.

---

## 21. MAP File Leading Room Table

**Source**: `IS.MAP`, `SOLARIS.MAP` (local licensed installation; not committed)
**Parser**: `src/data/maps.ts`, runnable via `npm run map:dump -- --rooms`
**Client loader**: `Map_LoadFile` (`FUN_004100c0`) via `Map_InitSpace` (`FUN_00410340`)

The earlier map-file note that treated the first bytes as a room record was off
by one field. Both local map files start with a little-endian `u16` record count,
followed by exactly that many leading room records. The trailing bytes after the
leading table are still not decoded; they may contain palette, graphics, or
topology data.

Leading table layout:

```
[u16 room_record_count]
repeat room_record_count times:
  [u16 room_id]
  [u16 flags]
  [u16 x1] [u16 y1] [u16 x2] [u16 y2]
  [u16 aux0] [u16 aux1] [u16 aux2]
  [u16 name_len_including_nul] [name bytes]
  [u16 desc_len_including_nul] [description bytes]
```

Local parser validation on 2026-04-07:

| File | Count | Parsed room IDs | First / last | Room-table end | Trailing bytes |
|------|------:|-----------------|--------------|---------------:|---------------:|
| `IS.MAP` | 271 | `1-271` | `1 Luthien` / `271 New Westin` | `0x4F28` | 19771 |
| `SOLARIS.MAP` | 32 | `146-171`, `1-6` | `146 Solaris Starport` / `6 Black Hills Sector` | `0x2123` | 180826 |

Notable correction: the local `IS.MAP` is not only rooms `1-145`; its leading
room table covers the full global namespace through `271`, including Solaris
entries. The local `SOLARIS.MAP` leading table is a 32-row Solaris subset plus
six sector rows, followed by a much larger undecoded section.

The current parser intentionally preserves `flags` and the three auxiliary
fields as numeric values. Their semantics are not yet confirmed. The next M5
RE step is to identify where exits and movement topology live: either in the
trailing map sections or in a separate client-side table.

Ghidra follow-up on 2026-04-07 confirms the runtime loader shape:

- `Map_LoadFile` reads the record count, allocates `count * 0x1a` bytes, and
  converts each variable-length on-disk room row into a fixed 26-byte in-memory
  record. String pointers are stored at offsets `+0x12` (name) and `+0x16`
  (description).
- The first 18 bytes of each in-memory record are copied directly from disk.
  That matches the parser fields: `room_id`, `flags`, four coordinate words,
  and three auxiliary words.
- After the room table, `Map_LoadFile` calls `Picture_ReadFromFile`
  (`FUN_00428770`) and stores the returned pointer at map object offset `+8`.
  That means the large trailing section is currently better treated as a map
  picture/resource blob, not an exit graph, until proven otherwise.
- `Map_InitSpace` loads `IS.MAP` when `DAT_00472a54 == 0`, filters out room IDs
  `0x92..0xAB` (`146..171`) while building its sorted list, and sorts the
  remaining pointers by `*(byte *)(record + 2)` then case-insensitive room name.
  This supports the observed split: `IS.MAP` carries the global location table,
  while the Solaris arena subset is handled specially.

### 21.1 Map UI Commands

Two server command handlers now have concrete map semantics:

| Cmd | Wire | Handler | Semantics |
|-----|------|---------|-----------|
| 40 | `0x49` | `MapOpenInnerSphere` (`0x0040ecb0`) | Reads `type1 contextId`, `type1 currentRoomId`, `type4 value/cost`, then opens the Inner Sphere map. |
| 43 | `0x4c` | `MapOpenSolaris` (`0x0040eed0`) | Reads `type1 contextId`, `type1 currentRoomIdPlusOne`, then 26 `type1` values used to populate Solaris room/sector counters before opening the Solaris map. |

The context id controls local button text / behavior. Confirmed cases from the
handler conditionals and `MPBT.MSG`:

| Context | Observed UI labels |
|---------|--------------------|
| `0x08` | `Travel`, `Planet`, `Cancel`; shows `Wealth`, `Cost`, `Tonnage` |
| `0x03`, `0x6c`, `0x6f`, `0x78` | `Ship`, `Planet`, `Cancel`; shows cost/wealth fields |
| `0x67` | `Attack`, `Planet`, `Cancel` |
| other Inner Sphere contexts | `Info`, `Planet`, `Done` |
| Solaris context `0xc6` | `Travel`, `Cancel` |

When the user confirms or cancels from either map, the client sends
`FUN_0040d360(contextId, selection)`, which emits client command `10`:

```
cmd 10 args: [type1 contextId] [type4 selection]
selection == 0: cancel / close
selection > 0: selected room id + 1
```

The follow-up branch now uses successful map replies to change server-side room
state and send a full scene refresh sequence for the destination:
`Cmd6 -> Cmd4 -> Cmd10 -> Cmd3 -> Cmd5`. The `Cmd4` refresh is important because
it updates the visible room title, scene location icons, and action buttons
instead of only changing backend presence.

Engineering follow-up on this branch adds a prototype trigger and state update:
typing `/map` or `/travel` into the world chat sends `Cmd43` with Solaris
travel context `0xc6`; a returned `cmd 10` selection moves the session into a
server-side `map_room_<roomId>` grouping, sends the scene refresh sequence above,
and notifies occupants in the target room with `Cmd13`. This is a validation
bridge, not yet the authentic terminal or tram request path.

Follow-up trace of the world scene UI found a more authentic entry point:
`Cmd4_SceneInit` action buttons carry a server-supplied `type` byte, and
`FUN_00413790` sends client `cmd 5` with that byte through `FUN_0040d2d0`.
Real-GUI validation on 2026-04-07 corrected one detail: button id `0x100` is
always intercepted by `FUN_00413790` as the local Help action (`FUN_00404450`),
so the first Cmd4 option cannot be used for server round-trips. The branch now
emits a placeholder `Help` option first and puts `Travel` in the second slot
(`0x101`) with type `4`; that is the earliest option slot expected to send
client `cmd 5 / action 4` and open the same `Cmd43` Solaris travel map. This
still does not prove the final terminal/tram trigger, but it uses the client's
normal scene-action button path instead of chat text.

Real GUI follow-up in the same session confirmed the corrected layout end to
end: `Help` rendered in the first slot, `Travel` rendered in the second slot,
manual Travel click emitted client `cmd 5 / action 4`, the server replied with
`Cmd43` (`context=0xc6`, current room 146), the map selection emitted client
`cmd 10` with `selection=148` (`selectedRoomId=147`), and the refreshed scene
displayed `Travel complete: Ishiyama Arena.` plus the room label `Ishiyama
Arena`.

Deeper client RE now clarifies the split between the ordinary world scene and
the travel-map UI:

- `World_HandleSceneWindowInput_v123` only sends scene actions / `cmd 23`
  location-clicks and can write the unavailable-location message into
  `g_world_SceneStatusTextWidget`; it does **not** call the local map renderer.
- The local `SOLARIS.MAP` room description path is the dedicated map window:
  `FUN_00420690` builds the map UI and immediately calls `FUN_0041f350`
  (Inner Sphere) or `FUN_0041f7d0` (Solaris), both of which call
  `FUN_0041fa30` to render the selected room's local name/description.
- The map table itself is loaded by `FUN_00421f40` during client startup and
  mode reset, so the data is available globally, but the ordinary world header
  still has no discovered path that rewrites itself from that local room table.

Adjacent scene location icons take a different path: `FUN_00419390` sends
client `cmd 23` (`0x38` wire command) with one encoded byte selecting one of
four location slots. Values `0..3` select slots whose target scene is already
cached on the client; values `4..7` select the same slots but indicate the
target scene was not cached locally yet. The branch now parses this as
`slot = action & 3`, looks up the server-advertised exit for the current room,
updates `map_room_<roomId>`, and sends the same `Cmd6 -> Cmd4 -> Cmd10 -> Cmd3
-> Cmd5` scene refresh sequence. The provisional topology currently uses valid
`SOLARIS.MAP` scene indices and conservative neighboring rooms; the full
authentic exit graph is still unresolved.

---

## Appendix A — Confirmed Function Reference

Canonical names follow the convention `Module_VerbNoun` for functions and
`g_module_description` for globals.  Apply them in Ghidra via **Edit → Rename
Symbol** to make cross-references readable.  The binary address (Ghidra default)
is listed alongside each canonical name.  The machine-readable dictionary is
in [`symbols.json`](symbols.json).

### COMMEG32.DLL

| Canonical Name | Binary Address | Role |
|----------------|---------------|------|
| `Aries_RecvDispatch` | `FUN_100014e0` | Main recv loop; switch on ARIES packet type |
| `Aries_SendLoginPacket` | `FUN_10001420` | Builds + sends type-`0x15` LOGIN packet |
| `Aries_PacketAlloc` | `FUN_10003600` | Allocates outgoing packet; writes type + 12-byte header |
| `Aries_PacketSetLen` | `FUN_10003680` | Finalises header: fills `payload_length` field at offset 8 |
| `Aries_PacketParse` | `FUN_100036d0` | Validates 12-byte header; extracts type + payload |
| `Aries_Connect` | `FUN_100011c0` | Opens new TCP connection; parses "host:port" addr, creates `g_aries_GameWorldConn` |
| `Aries_OpenSocket` | `FUN_10001d80` | Low-level socket open; `strchr(addr,':')` — returns -1 if ':' absent |
| `Aries_RawWrite` | `FUN_10002b10` | Sends raw bytes on active socket |
| `FilterDllMsg` | `FUN_100041d0` | Export: Windows msg handler; vtable[24] dispatch on lobby-conn obj |
| `ProcessDllIdle` | `FUN_10004260` | Export: Per-frame idle; loops vtable[26] until it returns 0 |
| `MakeTCPConnection` | `FUN_100043e0` | Export: `Aries_Connect(1, addr)` — opens primary lobby connection |
| `SetInternet` | `FUN_100048e0` | Export: Stores the "internet" address from REDIRECT payload |
| `SetUserPassword` | `FUN_10004840` | Export: Stores the session password from REDIRECT payload |

### MPBTWIN.EXE — Frame layer

| Canonical Name | Binary Address | Role |
|----------------|---------------|------|
| `Frame_VerifyCRC` | `FUN_00402e30` | 19-bit LFSR CRC validator (server→client frames) |
| `Frame_EncodeArg` | `FUN_00402be0` | Base-85 arg encoder: `Frame_EncodeArg(n, value)` emits `n+1` bytes |
| `Frame_DecodeArg` | `FUN_00402b10` | Base-85 arg decoder, symmetric to `Frame_EncodeArg` |
| `Frame_ReadByte` | `FUN_00402f40` | Read one encoded byte from parse buffer: `*ptr++ - 0x21` |
| `Frame_WriteCmdByte` | `FUN_00403030` | Write command byte to send buffer: `param + 0x21` |
| `Frame_ReadString` | `FUN_00403160` | Read length-prefixed string: `[len+0x21][ASCII]` |
| `Frame_CopyString` | `FUN_0040c0d0` | Calls `Frame_ReadString`, null-terminates destination |

### MPBTWIN.EXE — Lobby layer

| Canonical Name | Binary Address | Role |
|----------------|---------------|------|
| `Lobby_RecvDispatch` | `FUN_00402cf0` | Inner frame processor; calls seq pre-handler + `g_lobby_DispatchTable` |
| `Lobby_SeqHandler` | `FUN_0040C2A0` | Seq-byte pre-handler; ACK path if decoded val > 42 |
| `Lobby_SendAck` | `FUN_0040c280` | Send 2-byte ACK frame: `[0x22, val+0x2b]` |
| `Lobby_WelcomeGate` | `FUN_00429a00` | Accumulates recv bytes; strcmp to `g_lobby_WelcomeStrMMW`; unlocks game loop |
| `Lobby_OnWelcomeA` | `FUN_00433ef0` | Called after welcome gate passes (path A — lobby UI init) |
| `Lobby_OnWelcomeB` | `FUN_00429580` | Called after welcome gate passes (path B) |
| `Lobby_OnDirectConnect` | `FUN_00429620` | MMC alternate welcome path (direct-connect mode) |

### MPBTWIN.EXE — Commands

| Canonical Name | Binary Address | Cmd | Role |
|----------------|---------------|:---:|------|
| `Cmd3_Thunk` | `FUN_0040C190` | 3 | Dispatch table entry; calls `Cmd3_SendCapabilities` |
| `Cmd3_SendCapabilities` | `FUN_0040d3c0` | 3 | Client-ready handler; sends capability flags `[1,6,3,0]` |
| `Cmd7_ParseMenuDialog` | `FUN_004112b0` | 7 | Parses server menu dialog payload; renders numbered choices |
| `Cmd7_OnMenuPick` | `FUN_00412190` | 7 | User picks menu item; calls `Cmd7_SendReply(listId, item_data[k-1]+1)` |
| `Cmd7_OnMenuEsc` | `FUN_004122d0` | 7 | User presses ESC in menu; calls `Cmd1d_Send` |
| `Cmd7_SendReply` | `FUN_0040d2f0` | 7 | Send cmd 7 reply: `startCmd('\a') + type1(listId) + type4(val)` |
| `Cmd1d_Send` | `FUN_00410cc0` | 0x1d | Send cancel frame: `byte(p1) + type1(p2) + type4(p3)` |
| `Cmd20_ParseTextDialog` | `FUN_00411D90` | 20 | Parses server text dialog: `type1(id) + byte(mode 0/1/2) + string(text)` |
| `CombatTick_Mover` | `FUN_00401c90` | — | Combat frame tick mover; called every frame by combat loop (`FUN_00408080`) |
| `Cmd26_ParseMechList` | `FUN_0043A370` | 26 | Parse mech list payload; populate `g_cmd26_*` arrays |
| `Cmd26_ReadTypeFlag` | `FUN_0040d4c0` | 26 | Read 2-byte type_flag via `Frame_DecodeArg(1)` |

### MPBTWIN.EXE — Mech Selection Window

| Canonical Name | Binary Address | Role |
|----------------|---------------|------|
| `MechWin_Create` | `FUN_00439f70` | Create 640×480 mech selection window; set graphics mode `0x13` |
| `MechWin_HighlightSlot` | `FUN_004394b0` | Highlight a mech row in selection window |
| `MechWin_ScrollCallback` | `FUN_00439580` | Repaint callback; highlights `g_mechWin_HighlightIdx` |
| `MechWin_KeyHandler` | `FUN_0043a990` | Keyboard: S/Enter=select, X=examine, n/p=navigate |
| `Mech_VariantLookup` | `FUN_00438280` | `FUN_00405840(id + 0x3AE)` — variant typeString from MPBT.MSG; fallback "HBK-4G" |
| `Mech_ChassisLookup` | `FUN_004382b0` | `FUN_00405840(id + 0x36C)` — chassis name from MPBT.MSG; fallback "HUNCHBACK" |

### MPBTWIN.EXE — World Protocol (confirmed §18)

| Canonical Name | Binary Address | Role |
|----------------|---------------|------|
| `WndProc_Main` | `FUN_00428920` | Main window procedure; WM_0x7f0→data, WM_0x7f7→disconnect, WM_0x7f9→fatal error |
| `Recv_Handler` | `FUN_00429870` | WM_0x7f0 handler; demuxes lobby vs world via `g_welcomeGateOpen`; checks `'\x1b?'` strings |
| `World_Accumulator` | `FUN_00429510` | Post-welcome ESC accumulator; collects bytes, dispatches frame on ESC |
| `World_Dispatcher` | `FUN_004294c0` | CRC-verify then call `Lobby_RecvDispatch`; NACK on bad CRC |
| `World_PostDispatch` | `FUN_00429440` | Seq-counter ACK after successful dispatch; `DAT_004e2ce0` gate check |

### Key Data Labels — MPBTWIN.EXE

| Canonical Name | Binary Label | Value / Role |
|----------------|-------------|------|
| `g_lobby_DispatchTable` | `DAT_00470198` | RPS (lobby/world) command fn-pointer table; 77 entries; active when `g_combatMode==0` |
| `g_combat_DispatchTable` | `DAT_00470408` | Combat command fn-pointer table; 80 entries; active when `g_combatMode!=0` |
| `g_lobby_SeqHandlerPtr` | `PTR_FUN_00470190` | Points to `Lobby_SeqHandler`; installed as pre-handler |
| `g_lobby_LastSeq` | `DAT_004e2da4` | Stores last seen seq value from client frame |
| `g_welcomeGateOpen` | `DAT_004e2de8` | 0=pre-welcome (lobby gate), 1=post-welcome (world active) |
| `g_combatMode` | `DAT_004e2cd0` | 0=RPS mode (CRC seed `0x0a5c25`), ≠0=Combat mode (CRC seed `0x0a5c45`) |
| `g_worldActiveFlag` | `DAT_004e2d84` | Set to 1 on world welcome (MMW path); 0 on MMC path |
| `g_lobbyConnActive` | `DAT_004e2ce0` | Gate for post-dispatch ACK sender in `World_PostDispatch` |
| `g_frameBuf` | `DAT_004d5b34` | Shared 4096-byte ESC-frame accumulation buffer |
| `g_frameBufPtr` | `DAT_004d6b44` | Write pointer into `g_frameBuf`; reset to start on ESC |
| `g_welcomeStrMMW` | `DAT_00474d48` | `"\x1b?MMW Copyright Kesmai Corp. 1991"` — standard welcome |
| `g_welcomeStrMMC` | `DAT_00474d70` | `"\x1b?MMC Copyright Kesmai Corp. 1991"` — direct-combat welcome |
| `g_lobby_WelcomeStrMMW` | `DAT_00474d48` | `"\x1b?MMW Copyright Kesmai Corp. 1991"` (normal Windows login) |
| `g_lobby_WelcomeStrMMC` | `DAT_00474d70` | `"\x1b?MMC ..."` (direct-connect alternate path) |
| `g_cmd7_ListIdTable` | `DAT_00472c94` | Per-list-id callback/state array; index `[0x512]` for menu dialog |
| `g_cmd26_TypeFlag` | `DAT_004dc8dc` | Set by `Cmd26_ParseMechList` to received `typeFlag` |
| `g_cmd26_MechIdArr` | `DAT_004dc560` | mech_id array, indexed by entry i |
| `g_cmd26_MechTypeArr` | `DAT_004e2dc0` | mech_type array, indexed by entry i |
| `g_cmd26_SlotArr` | `DAT_004dc510` | slot array (primary copy), indexed by entry i |
| `g_cmd26_SlotArrAlt` | `DAT_004dbd88` | slot array (alternate copy), indexed by entry i |
| `g_cmd26_TypeStrArr` | `DAT_004dc5b8` | type_string array (e.g. `"SDR-5V"`), indexed by entry i |
| `g_cmd26_VariantArr` | `DAT_004dc1d0` | variant string array (e.g. `"Spider"`), indexed by entry i |
| `g_cmd26_NameArr` | `DAT_004dc028` | pilot name array (empty → `Mech_VariantLookup(mech_id)` fallback at `FUN_00438280`) |
| `g_mechWin_ShowExtButtons` | `DAT_004dbd84` | Non-zero when typeFlag triggers extended button display |
| `g_mechWin_HighlightIdx` | `DAT_004dbd80` | Currently highlighted slot index |

### Key Data Labels — COMMEG32.DLL

| Canonical Name | Binary Label | Value / Role |
|----------------|-------------|------|
| `g_aries_GameWorldConn` | `DAT_1001a080` | Pointer to secondary/game-world connection object |
| `g_aries_LoginBuf` | `DAT_1001f888` | Outgoing LOGIN packet data buffer |

---

## Appendix B — Lobby Command Table Raw Dump

92 bytes read from `DAT_00470198` in Ghidra (little-endian 32-bit pointers):

```
Offset  Ptr (LE32)   Resolved
──────  ──────────   ─────────────────────────────
  0     00000000     NULL (crash)
  4     30C04000     0x0040C030
  8     60C04000     0x0040C060
 12     90C14000     0x0040C190  ← cmd 3: client-ready
 16     704B4100     0x00414B70
 20     F0C24000     0x0040C2F0
 24     00C34000     0x0040C300
 28     B0124100     0x004112B0  ← cmd 7: server menu dialog
 32     60394100     0x00413960
 36     10C34000     0x0040C310
 40     70C34000     0x0040C370
 ...   (entries 11–19 not all confirmed)
 80     90 1D 41 00  0x00411D90  ← cmd 20: text-dialog handler (`Cmd20_ParseTextDialog`)
...
104     70 A3 43 00  0x0043A370  ← cmd 26: mech list
```

---

## 19. Client v1.23 Migration Notes

> **Branch:** `feat/client-1.23` — all RE below is being re-verified against the 1.23 Ghidra project.
> All function addresses throughout §1–§18 are from the **v1.06** binaries unless explicitly noted here.

### Binary metadata

| Binary | v1.06 | v1.23 | Delta |
|--------|-------|-------|-------|
| `MPBTWIN.EXE` | 577,536 bytes · Nov 21 1996 | 621,568 bytes · Oct 24 1997 | +44,032 (+7.6%) |
| `COMMEG32.DLL` | 148,480 bytes · Oct 17 1996 | 144,896 bytes · Apr 9 1997 | −3,584 (−2.4%) |
| `INITAR.DLL` | 104,960 bytes · Jul 30 1996 | 117,248 bytes · Mar 6 1997 | +12,288 (+11.7%) |

Source debug paths embedded in v1.23 `MPBTWIN.EXE`: `D:\btech\Source123\Combat.c`, `D:\btech\Source123\Commwnd.c`, `D:\btech\Source123\Makemech.c`.

### Protocol-relevant changes confirmed by string diff

**COMMEG32.DLL — version string changed (breaks naive version checks):**
- **Removed:** `"Kesmai Comm Engine 3.22"` (v1.06 LOGIN payload at offset `+0x070`)
- **Added:** `"Kesmai CommEngine 3.29"` (note: no space between "Comm" and "Engine")
- New exported symbols in v1.23 COMMEG32: `CE_VersionNumber`, `CE_VersionString`
- Class name `"Kesmai Comm Engine"` (MFC class table, unrelated to the version string) is unchanged.

**Server impact:** `parseLoginPayload()` reads `clientVer` as a raw string and logs it but does not enforce a specific value — no server code change required. Comments in `src/protocol/auth.ts` and `src/protocol/constants.ts` updated on this branch to document both strings.

### COMMEG32 v1.23 Ghidra revalidation

2026-04-07 follow-up in the v1.23 Ghidra project confirms the login wire layout is unchanged, but the key functions moved:

- `CE_VersionString` at `10005300` returns `s_Kesmai_CommEngine_3_29_1001a220`.
- `CE_VersionNumber` at `10005310` writes major `3`, minor `0x1d` (`29`).
- `MakeTCPConnection` export `10004920` calls `FUN_10001b20`, which copies the version literal into the login block at `DAT_10021848` (`DAT_100217d8 + 0x70`), sets the `0x39` marker at `DAT_10021916`, clears `DAT_10021918`, and opens the socket.
- v1.23 LOGIN sender is `FUN_10001de0`, not `FUN_10001420`. It initializes ARIES packet type `0x15`, copies `strlen(password) + 0x145` bytes from `DAT_100217d8`, writes `htons(strlen(password))` at `DAT_1002191a`, finalizes the ARIES header, and sends via `writebinary`.
- v1.23 login payload field setters line up with the existing parser: `SetUserName` -> `DAT_100217d8`, version -> `DAT_10021848`, `SetUserEmailHandle` -> `DAT_10021898`, `SetInternet` -> `DAT_100218c0`, `SetProductCode` -> `DAT_10021914`, `SetServerIdent` -> `DAT_10021917`, `SetUserPassword` -> `DAT_1002191a`/`DAT_1002191c`.
- v1.23 receive dispatcher is `FUN_10001eb0`; case `0` still forwards the raw SYNC payload to `MPBTWIN.EXE` via `WM_0x7f0`, and case `0x16` still sends LOGIN by calling `FUN_10001de0`.
- `FUN_10001420` in v1.23 is now timing/failure telemetry, not LOGIN; it builds ARIES packet type `0x1b`.

Server impact: no runtime change is required. The existing parser accepts both version strings and the payload offsets are unchanged. The docs/comments should avoid using `FUN_10001420` as a v1.23 login-builder address.

**MPBTWIN.EXE — new combat state machine strings:**

The v1.23 binary contains new debug/state-label strings absent from v1.06:

| String | Implication |
|--------|------------|
| `"Solaris RPS"` | Explicit state name for the 2D world (RPS = role-playing shell) |
| `"Solaris COMBAT"` | Explicit state name for the combat engine |
| `"Transition to combat - even"` | New combat-entry state; "even" = equal-side match |
| `"Combat - advantage - up/down"` | In-match advantage tracking |
| `"Combat - disadvantage - up/down"` | Symmetrical disadvantage path |
| `"Combat - pursuit"` / `"run away"` | Explicit pursuit/retreat states |
| `"Combat - victory"` / `"defeat"` | Match-end states |
| `"Combat - imminent victory/defeat"` | Pre-end warning states |
| `"Combat - winning/losing - up/down"` | Gradient win/loss states |
| `"Unknown state attempting to enter SOLARIS COMBAT"` | Assertion / guard string |
| `"Unknown state attempting to send the version"` | Version handshake guard |
| `"Version not initialized"` | Login-phase guard |

These point to a substantially richer state machine governing the lobby→world→combat transition in v1.23. The v1.06 binary had none of these labels (they appeared as a single hardcoded string `"BattleTech II Version BTOC 1.06"`).

#### MPBTWIN v1.23 state-machine trace

Ghidra revalidation against `C:\MPBT\Mpbtwin.exe` v1.23:

| Function | Role |
|----------|------|
| `FUN_00435b20` | Main network/game tick: drains queued COMMEG payloads via `FUN_00401310`, calls `FUN_00435ed0`, then dispatches by `DAT_0047d05c` (`3` = RPS tick, `4` = combat tick). |
| `FUN_00435ed0` | Mode-packet dispatcher after RPS has started; classifies incoming handshake payloads and routes RPS vs combat transitions. |
| `FUN_00435ff0` | Initial mode/welcome gate; accepts the first `MMW` welcome, sets RPS state, sends the client version frame, and only permits `MMC` combat entry after the client is already in RPS state. |
| `FUN_00436340` | Classifies raw welcome strings: `ESC ? MMW Copyright Kesmai Corp. 1991` returns `2`; `ESC ? MMC Copyright Kesmai Corp. 1991` returns `3`; non-handshake data returns `0`. |
| `FUN_00401d70` | Copies the visible mode name into the global mode descriptor: argument `0` = `"Solaris RPS"`; argument `1` = `"Solaris COMBAT"`. |
| `FUN_00435db0` | Combat-mode initializer after the `MMC` welcome: tears down RPS UI pieces, loads `scenes.dat`, resets combat globals, and enables the combat simulation state. |
| `FUN_00435eb0` | Combat tick; runs combat update work and, when music is enabled, calls `FUN_00428370`. |
| `FUN_00428370` | Combat music/proximity selector. It chooses a requested combat music state from opponent distance/visibility/advantage data and calls `FUN_0042a5f0`. |
| `FUN_0042a5f0` | Music state request mapper. External request `10` maps to internal state `6`. |
| `FUN_0042aa10` | KSND/Miles music-state tick. It applies pending state changes and invokes the selected state callback. |

Important correction: `"Transition to combat - even"` is not the COMMEG/server handshake string and does not by itself define a world→combat wire command. It is entry `6` in the music-state label table at `00479b10`, reached by `FUN_00428370 -> FUN_0042a5f0(10) -> internal state 6`, then applied by `FUN_0042aa10`. The protocol-relevant transition remains the `MMW`/`MMC` welcome-string classifier: `MMW` enters `"Solaris RPS"` and `MMC` enters `"Solaris COMBAT"` only after the RPS state has already been established.

Server impact: keep treating combat as a separate connection/session boundary. A future combat prototype should first reproduce the RPS-to-combat handoff by issuing a second `MMC`-style welcome on the combat-side connection after the client is already in RPS, then trace the combat command dispatch that follows. Do not attempt to send `"Transition to combat - even"` as a server payload; it is an internal audio label.

**MPBTWIN.EXE — new runtime behavior:**
- `GetVersionExA` added: v1.23 performs OS version checks at startup.
- Two registry keys for bypassing CPU checks: `Software\Kesmai\MultiPlayer Battletech Solaris\NoGameCPUCheck` and `NoSpeechCPUCheck`.
- `Speech32.dll` in v1.23 client directory: speech synthesis support added.

**INITAR.DLL — substantially rewritten (+11.7%):**
The launcher DLL grew by 12 KB. The additional RE on this binary is the highest priority since `INITAR.DLL` controls how `play.pcgi` is parsed and how the game is launched — any new fields in the config file or changes to the launch protocol would originate here.

### play.pcgi lookup strategy (both v1.06 and v1.23 INITAR.DLL)

String extraction from both INITAR binaries confirms the same Win32 API import set for file location:

| API | Purpose |
|-----|---------|
| `GetCommandLineA` | Read the pcgi path passed as a CLI argument |
| `GetModuleFileNameA` | Locate pcgi relative to the DLL/exe directory |
| `GetFullPathNameA` | Resolve relative paths to absolute |
| `GetModuleHandleA` | Self-reference for the above |

INITAR likely tries all three strategies in order. `MPBT.bat` is written to satisfy all of them:

1. `gen-pcgi` writes `C:\MPBT\play.pcgi` (default `--out` resolved 3 levels up from `src/scripts/`)
2. A `copy /Y` step places `play.pcgi` into `C:\MPBT\client-1.23\` (exe-relative lookup)
3. `cd /d C:\MPBT\client-1.23` sets cwd to the client dir before `start` (current-directory lookup)
4. The absolute path `C:\MPBT\client-1.23\play.pcgi` is passed as the CLI arg (CommandLine lookup)

The v1.23 import set is identical to v1.06, so no new pcgi fields have been confirmed yet — deeper RE (task 5 below) is needed to rule out format changes.

### RE tasks for this branch

The v1.23 Ghidra project has been created with all three binaries analyzed. Work these in order using the per-binary RVA lists in `tools/version_diffs/`:

| Priority | Task | Binary | Notes |
|----------|------|--------|-------|
| 1 | Re-verify LOGIN builder | COMMEG32 v1.23 | Done 2026-04-07: v1.23 sender is `FUN_10001de0`; payload layout unchanged; `CE_VersionString`/`CE_VersionNumber` are exports only and do not require server-side version enforcement |
| 2 | Re-verify `Aries_RecvHandler` / case 0 | COMMEG32 v1.23 | Done 2026-04-07: dispatcher is `FUN_10001eb0`; case `0` still forwards raw SYNC payload via `WM_0x7f0`; case `0x16` calls `FUN_10001de0` |
| 3 | Trace new state machine in `MPBTWIN` | MPBTWIN v1.23 | Find the handler for `"Solaris RPS"` → `"Transition to combat - even"` → `"Solaris COMBAT"` — this defines the world→combat REDIRECT flow |
| 4 | Re-verify world command dispatch table | MPBTWIN v1.23 | §18 addresses will have shifted; new entries may exist in v1.23 |
| 5 | Trace `INITAR.DLL` launcher changes | INITAR v1.23 | Win32 API surface identical to v1.06 (confirmed by string extraction). Deeper RE needed to confirm pcgi field format is unchanged given +12 KB growth. |
| 6 | Check `Speech32.dll` integration | MPBTWIN v1.23 | What events trigger speech? Any new server→client commands? |

---

### §19.1 — v1.23 Client→Server Frame Format (CONFIRMED)

Static analysis of `MPBTWIN.EXE` v1.23 confirms the client-side TCP frame construction.

**Buffer initialisation — `FUN_00401b90`:**
```
DAT_004f7278 = DAT_004f7274   // reset write-pointer to buffer start
*ptr++ = 0x1B                 // ESC literal
*ptr++ = 0x21                 // '!' literal
```

**Writing a data byte — `FUN_00401b50` / `FUN_00401b70` (identical twins):**
```c
*DAT_004f7278 = param_1 + 0x21;
DAT_004f7278++;
```
Every value (command ID, data field, etc.) is biased by `+0x21` before writing.

**TCP flush — `FUN_00435c10` (called via `thunk_FUN_00435c10`):**
```c
if (DAT_004f7278 - DAT_004f7274 > 2) {
    FUN_00401a70('\0', 0);                     // append CRC byte(s)
    if (DAT_0047d08c == 0)                     // skip if replay-mode flag set
        SendTCPData(DAT_004f7274, buf_len);    // actual Winsock send
    FUN_00401b90();                            // reset buffer (ESC+'!' written)
}
// flush skipped when buffer contains only the 2-byte ESC+'!' prefix
```

**Complete wire frame:**
```
0x1B  0x21  [cmd+0x21]  [field₁+0x21]  [field₂+0x21]  …  [CRC]
ESC    '!'   command      data byte(s)                     checksum
```

**Multi-word field helper — `FUN_00401470(n_words, value)` = `Frame_WriteType(n, val)`:**  
Encodes `value` into `2×n` bytes using base-85 (each pair of chars encodes one word). This is the frame-write primitive shared with v1.06.

---

### §19.2 — v1.23 Movement Protocol (CONFIRMED)

**Sender:** `FUN_0040dca0` — a timer-based polling function called from the main game loop.

**Rate limits:**
- Full packet every **100 ms** (`param_3 − _DAT_00478d90 ≥ 100`)
- Partial buffer flush at **50 ms** if output buffer already has pending bytes

**Velocity accumulators (written by keyboard input handlers):**

| Global | Divisor | Meaning |
|--------|---------|---------|
| `DAT_004f1f7a` | `÷ 0xb6 (182)` | `sVar1` — leg velocity (forward/back) |
| `DAT_004f1f7c` | `÷ 0xb6 (182)` | `sVar2` — throttle velocity |
| `DAT_004f1d5c` | `− 0x3ffc, ÷ 0xb6` | positional adjustment (`sVar4`) |

Accumulator clamp: `±0x1ffe` (±8190). Bias applied before encoding: `+0xe1c` (3612), which centres the signed range into `[0..7224]` (= 85²−1, the base-85 single-word range).

Rotation/heading value: `iVar5 = FUN_0042c7a0(...)` (fixed-point heading calculator).

**Keyboard input chain:**
```
KeyDown → FUN_0040d090 / FUN_0040d0f0 (key state readers)
         → FUN_0040d270 (leg accumulator → DAT_004f1f7a)
         → FUN_0040d2d0 (throttle accumulator → DAT_004f1f7c)
FUN_00447f70 (arrow-key dispatcher) also calls FUN_0043b110 to set dirty flag
```

**Cmd 8 — Coasting (`sVar1 == 0 AND sVar2 == 0`):**
```
Wire:  ESC '!'
       [0x08 + 0x21 = 0x29]            // command byte
       Frame_WriteType(3, x)            // 6 bytes — X position (base-85, 3 words)
       Frame_WriteType(3, y)            // 6 bytes — Y position
       Frame_WriteType(2, heading)      // 4 bytes — heading (2 words)
       Frame_WriteType(1, sVar4+0xe1c)  // 2 bytes — positional-adj velocity
       Frame_WriteType(1, iVar5+0xe1c)  // 2 bytes — rotation
       [CRC]
```

**Cmd 9 — Moving (`sVar1 ≠ 0 OR sVar2 ≠ 0`):**
```
Wire:  ESC '!'
       [0x09 + 0x21 = 0x2A]            // command byte
       Frame_WriteType(3, x)            // 6 bytes — X position
       Frame_WriteType(3, y)            // 6 bytes — Y position
       Frame_WriteType(2, heading)      // 4 bytes — heading
       Frame_WriteType(1, sVar4+0xe1c)  // 2 bytes — turn momentum
       Frame_WriteType(1, 0xe1c)        // 2 bytes — constant neutral (always 0xe1c)
       Frame_WriteType(1, sVar2+0xe1c)  // 2 bytes — throttle velocity
       Frame_WriteType(1, sVar1+0xe1c)  // 2 bytes — leg velocity
       Frame_WriteType(1, iVar5+0xe1c)  // 2 bytes — rotation
       [CRC]
```

---


### §19.3 — v1.23 Fire, Jump Jet, and Supplementary Commands (PARTIAL)

**Generic combat action sender — `Combat_SendCmd12Action_v123(action)` (`0x0040eb20`):**
```c
Frame_WriteByte(0x0c);   // client cmd 12
Frame_WriteByte(action);
Frame_Flush();
```

Confirmed call sites:

| Action | Caller | Current read |
|--------|--------|--------------|
| `0` | `Combat_InputActionDispatch_v123` (`0x004231c0`), case `0x15` | Primary selected-weapon fire request. It is gated by combat-ready state, selected target/weapon state (`DAT_004f1f42`/`DAT_004f1f44`), and heat/animation guards, then emits `cmd 12, action 0`. Live 2026-04-12 TIC-A captures showed no matching `cmd12/action0` on NumLock group fire, so treat action `0` as the selected-weapon path rather than a required TIC gate. |
| `4` | `Combat_JumpJetInputTick_v123` (`0x00422c50`) | Jump jet fire request. Requires jump input bit, remaining jump fuel/energy (`DAT_004f21a2 > 0x32`), no active jump flags, and not in a blocked animation state. |
| `6` | `FUN_00448d80` | Jump/landing transition request. Sent when an airborne actor reaches ground contact and the local jump-state flags are cleared. |

- Fresh 2026-04-18 caller audit: `Combat_SendCmd12Action_v123` still has only three live callers in the current `Mpbtwin.exe` (`action 0`, jump `action 4`, landing `action 6`), but the `action 0` interpretation is now narrower and more useful than the earlier "selected-fire" guess.
- Fresh 2026-04-18 input audit: `FUN_00434350` routes `WM_KEY*` through `FUN_0043d500 -> FUN_0040b700`, which resolves combat actions from four key tables (`DAT_004ef380`, `DAT_004eef70`, `DAT_004ef180`, `DAT_004eed70` for default / shift / ctrl / alt).
- Dumping those tables for `VK_HOME (0x24)` and `VK_F1..VK_F12 (0x70..0x7b)` returned `0` in all four tables on the current `Mpbtwin.exe`, and the special-key helper `FUN_0043d040` only tracks Shift/Ctrl/Alt state.
- Fresh 2026-04-18 fallback keymap confirmation: the compiled fallback action table at `DAT_00478c50` still has entry `0x15 = 0x58` (scan code `0x58`, i.e. F12 on the normal PC set), so `action 0x15` remains the strongest direct F12 candidate even though the late-built `VK_*` tables themselves are zero for `VK_F12`.
- Fresh 2026-04-18 recovery-gate correction: `Combat_InputActionDispatch_v123` case `0x15` still sends `Combat_SendCmd12Action_v123(0)` only when the local actor is in the down/recovery state (`DAT_004f208e != 0`, i.e. actor offset `+0x35e`), `DAT_004f1ee2 < 2`, and at least one of `DAT_004f1f42` / `DAT_004f1f44` is non-zero. But those globals are **not legs** once the initializer is traced through fully; they are the local copies of class-2 slots `2/3`, which the retail damage-state initializer still seeds as left/right torso. So this gate no longer proves the user-facing "both legs gone => no stand" rule.
- Fresh 2026-04-18 stand-helper follow-up: `FUN_0043b440` (generic stand/resume) clears actor offset `+0x35e`, while inbound `Cmd70` subcommands `6/8` set that same flag before driving the grounded/collapse helper path. That makes `DAT_004f208e` the strongest current candidate for the local "down / waiting to recover" flag.
- Fresh 2026-04-18 stand/fall-helper audit: `FUN_0043b470` (fall animation helper) is only called from inbound `Combat_Cmd70_ActorAnimState_v123` subcommand `1`, while `FUN_0043b440` / `FUN_0043b400` (stand/landing-to-stand helpers) are reached from inbound `Cmd70` and the local landing-state path `FUN_00448d80`.
- Fresh 2026-04-18 negative result: client-local damage/contact paths still do **not** call `FUN_0043b470`; `Cmd66`/`Cmd67` damage-state updates by themselves are therefore not enough to make a mech fall after leg loss.
- Fresh 2026-04-18 class-2 order reconciliation: `Combat_InitDamageStateFromMec_v123` writes the 8 internal-state entries at `damageState + 0xe8` by calling `Combat_GetInternalStructureForSection_v123(tonnage, sectionId)` for section ids `0..7` **in direct order**. That means the client's class-2 damage-state block and the retail helper use the same order: `[LA, RA, LT, RT, CT, LL, RL, Head]`.
- Fresh 2026-04-18 `+0xec/+0xee` resolution: because the class-2 block starts at `+0xe8`, the `Combat_ApplyDamageCodeValue_v123` zero check at `+0xec/+0xee` is checking entries `2/3` — **left/right torso**, not legs. So the earlier "local leg-loss trigger" interpretation was wrong. What that path actually means still needs follow-up, but it is no longer evidence for leg-destruction fall.
- Fresh 2026-04-18 leg-slot correction: the true leg entries in the class-2 block are `+0xf2/+0xf4`, i.e. actor `+0x218/+0x21a` (`DAT_004f1f48 / DAT_004f1f4a` for the local actor). The earlier `+0x216/+0x218` note was off by two bytes.
- Fresh 2026-04-18 `FUN_0040df80` correction: `FUN_0040df80` zeroes actor `+0x216`, which is the **center torso** class-2 slot (`+0xf0`), not a leg slot. It also forces actor state `+0x35a = 3`, zeros movement state, and matches the same hard-stop cleanup used by `Combat_UpdateCriticalDamageState_v123` when critical paths escalate into state `3`. That makes `FUN_0040df80` a destruction/cripple-style helper, not evidence for a recoverable leg-loss fall path.
- Fresh 2026-04-18 posture-state clarification:
  - actor state `+0x35a = 2` is written by `FUN_0042d0a0` from the heat accumulator path (`+0x37a`) and clears back to `0` when heat drops, so it is the shutdown / overheating posture
  - actor state `+0x35a = 3` is written by `Combat_UpdateCriticalDamageState_v123` and `FUN_0040df80`, and movement/input helpers treat it as a hard-blocking non-normal posture
  - this strengthens the read that state `3` is destruction/cripple, not a normal fallen-but-recoverable state
- Fresh 2026-04-18 real leg-slot status: `FUN_0040e000` still maps section ids `5/6` to dedicated local effect ids (`0x21/0x20`), but no direct fixed-address writer/reader has been recovered yet for actor `+0x218/+0x21a`. That suggests retail leg-loss handling is either fully index-driven or hidden behind a different packet/critical path than the torso-slot `Combat_ApplyDamageCodeValue_v123` check.
- Fresh 2026-04-18 index-driven leg-slot follow-up: the lack of direct xrefs to `DAT_004f1f48 / DAT_004f1f4a` now has a concrete explanation. Retail repeatedly reaches the internal-state block through tables/mappers instead of named LL/RL globals:
  - `FUN_0042e2f0` gates each weapon mount by reading the `.MEC` section-to-internal map at `mech + 0x8e + mount*2`, then testing `actor + 0x20e + mappedSlot*2`
  - `FUN_0042f2e0` maps display-section ids `8/9` to internal slots `5/6`, and downstream HUD helpers consume `damageState + 0xe8 + mappedSlot*2`
  - result: the true leg slots are definitely part of generic table-driven access, not a pair of easy fixed-global references
- Fresh 2026-04-18 leg-trigger follow-up: decompiling the exact local class-2 apply path removes another false lead. `Combat_ApplyDamageCodeValue_v123` does still react when local `+0xec/+0xee` reaches zero, but the side effects are `DAT_004f2094 = 1`, `FUN_0042d150(localActor, 0)`, and `FUN_004262d0(0)` — and `FUN_0042d150` recalculates runtime movement/rate fields from the mech's base speed while explicitly keying off torso internals `actor + 0x212/+0x214`, not the true leg slots. So that torso-zero path now reads as movement-limit/rate recalculation, not a proven leg-collapse helper.
- Fresh 2026-04-18 strongest leg-specific client path so far: `Combat_UpdateCriticalDamageState_v123` routes crit types `8..0xf` (the `MPBT.MSG` leg-actuator band from left-leg hip through right-leg foot) through the same `FUN_0042d150` movement-limit helper. That means the clearest recovered retail leg-side handling is still actuator/crit-driven degradation, while visible airborne/deferred-collapse/landing state remains on the separate `Cmd70 4/8/6` path.
- Fresh 2026-04-18 `Cmd73` priority check: the recovered `Combat_Cmd73_UpdateActorRateFields_v123` handler only writes the two actor-rate fields at `DAT_004f202a/+0x202e` (actor offsets `+0x2fa/+0x2fe`) and no direct read xrefs to those fields have been recovered yet in the current `Mpbtwin.exe` database or flat decomp. That does **not** prove `Cmd73` is irrelevant, but it weakens it as the first fall/recovery blocker compared with the already-confirmed crit-update and `Cmd70` gaps.
- Fresh 2026-04-18 server data-model follow-up: `mpbt-server` does **not** currently parse the `.MEC` critical-type table at `0xde`; it only loads `extraCritCount`, armor-like maxima, weapon mount IS refs, weapon ids, and ammo data. But because the installed retail `.MEC` roster's base crit table is now known to be the direct identity map `0..20`, that missing field is no longer a hard blocker for synthesizing the stable leg-actuator codes `8..15`.
- Fresh 2026-04-18 server experiment landed: `mpbt-server` now synthesizes the leg-actuator crit band conservatively when a leg's class-2 internal slot first drops to zero. The server raises the four actuator codes for that leg (`8..11` or `12..15`) to state `1` exactly once, matching the retail critical handler's monotonic `oldState < newState` gate without guessing any multi-hit escalation. In the same post-damage pass, the server now also emits a non-death `Cmd70/8` collapse for that actor (local or remote slots as appropriate in bot, duel, and arena combat), while still leaving `Cmd73` and stand-up/recovery handling untouched.
- Fresh 2026-04-19 live GUI validation: packet proof is now paired with a real retail-client windowed run. A small env-gated local probe hook (`MPBT_FORCE_VERIFICATION_ACCOUNT` + `MPBT_FORCE_VERIFICATION_MODE=legtest`) was added so the ordinary **Fight** button could arm the existing forced left-leg verifier for account `gui_leg_0419b` without relying on synthetic text entry, which the retail client did not accept reliably. On the rebuilt server, the Fight-button path logged the forced `legtest` override, then delivered the expected left-leg damage sequence through `0x25 = 0` plus actuator crits `0x08..0x0b = 1` and the non-death `Cmd70/8` collapse at `01:23:58`. But the captured client window stayed in the normal upright cockpit view before, during, and after that decisive packet, including a fresh post-collapse screenshot taken after the `Cmd70/8` event. No inbound `cmd12/action 0x15` or other obvious recovery-side request appeared in the same window. Practical read: the current minimum subset is wire-correct but still **not sufficient to produce visible retail fall**.
- Fresh 2026-04-19 `Cmd70` sequence follow-up: the next live probe added an opt-in `legseq` verifier that keeps the same left-leg destruction path but emits non-death `Cmd70 1 -> 8` instead of bare `8`, using a fresh per-launch `.pcgi` file for every retail-client launch (matching the launcher's contract; the client deletes/consumes the sandbox `play.pcgi` on use). Wire-side, the probe worked exactly as intended: the Fight button armed the forced `legseq` override, the client entered combat normally, left-leg internal reached `0`, actuator crits `0x08..0x0b = 1` landed, and the server logged `leg-loss transition slot=0 mode=fall-then-collapse sequence=1->8`. But the live `+12s` and `+22s` combat screenshots still showed an upright, stable cockpit view with no visible fall. Practical read: adding subcommand `1` before non-death `8` is **still visually insufficient**, so the next best `Cmd70` target has narrowed further toward the airborne / landing-resolution side (`4` / `6`) rather than the simple fall-helper path alone.
- Fresh 2026-04-19 `Cmd70 4->8->6` follow-up: the next opt-in verifier (`legair`) now drives the strongest currently recovered non-death airborne sequence for left-leg loss: `Cmd70/4` (airborne), `Cmd70/8` (deferred collapse while airborne), and `Cmd70/6` (landing resolution). Packet-side, the probe is live and exact: `fight-leg-airborne-sequence-smoke.mjs` passes with `cmd70=0/4,0/8,0/6`, and a real launcher-based GUI run using a fresh per-launch `.pcgi` plus a real Fight-button click logged `forced verification override: username=gui_leg_0419b mode=legair` followed by `leg-loss transition slot=0 mode=airborne-collapse-land sequence=4->8->6`. The timing matters: the new screenshots show the world ready room before click, an upright cockpit at `+12s`, and another upright cockpit at `+22s`; the final left-leg-zero event and `4->8->6` transition fired at `08:33:57.924Z`, and the `+22s` screenshot was taken at `08:34:00`, i.e. about two seconds **after** the transition had already landed. Practical read: even the recovered airborne / deferred-collapse / landing sequence is still **not producing an obvious sustained visible fall** on the retail client.
- Fresh 2026-04-19 `Cmd70 1->4->8->6` follow-up: the remaining plausible pure-`Cmd70` mix is now also wired as an opt-in verifier (`legfull`). This path adds the earlier fall-animation helper back in front of the airborne/deferred-collapse/landing chain and emits `Cmd70/1`, then delayed `Cmd70/4`, delayed `Cmd70/8`, and delayed `Cmd70/6`. Packet-side, the probe is exact: `fight-leg-full-sequence-smoke.mjs` passes with `cmd70=0/1,0/4,0/8,0/6`, while the older `fight-leg-smoke.mjs`, `fight-leg-sequence-smoke.mjs`, and `fight-leg-airborne-sequence-smoke.mjs` still pass unchanged. Live GUI validation is now in too: a launcher-driven run using account `Moose` reached Ishiyama Ready Room 1, clicked the normal Fight button, logged `forced verification override: username=Moose mode=legfull`, and then emitted `leg-loss transition slot=0 mode=fall-airborne-collapse-land sequence=1->4->8->6` at `09:58:17.637Z`. The saved screenshots (`mpbt-before-fight.png`, `2026-04-19 05_58_27-Multiplayer BattleTech.png`, `...05_58_39...`, `...05_58_51...`) line up as pre-fight plus roughly `+10s`, `+22s`, and `+34s` after the actual transition, and all three post-transition frames still show an ordinary upright cockpit/combat view. Practical read: even the strongest remaining `Cmd70`-only blend is **visually insufficient** on the retail client.
- Fresh 2026-04-18 Cmd70 refinement: `Combat_Cmd70_ActorAnimState_v123` is now better understood as a multi-state down/recovery dispatcher, not a flat helper enum:
  - subcommand `1` calls `FUN_0043b470`, which only plays the fall animation and clears actor `+0x35e`
  - subcommand `8` explicitly marks the actor down (`+0x35e = 1`), zeroes motion state, and drives `FUN_0043b4a0`
  - subcommand `6` is remote-only recovery/ground logic: if the actor is not already down, it either re-enters the same collapse path used by subcommand `8` when the pending flag bit is set, or else calls `FUN_0043b400` for a plain stand/resume
  - result: non-death fall / stand sync likely needs more than one Cmd70 state transition, not just a single magic packet value
- Fresh 2026-04-18 non-death Cmd70 sequence follow-up:
  - local jump start (`cmd12/action 4`) sets `DAT_004f21a6 |= 3` and immediately calls `FUN_0043b3e0`, i.e. the same `anim=4` helper that remote `Cmd70/4` uses after setting the remote actor's `0x80` airborne bit
  - local landing resolution in `FUN_00448d80` sends `Combat_SendCmd12Action_v123(6)` when the local airborne bit reaches ground contact
  - that same landing path then branches exactly like remote `Cmd70/6`: if the deferred-collapse bit (`actor + 0xdc`, bit `8`) is clear it calls `FUN_0043b400` to stand, and if bit `8` is set it flips the actor into the same down/collapse helper path as `Cmd70/8`
  - `Cmd70/8` itself is now clearly dual-purpose: when the actor is already airborne (`flags & 1` or `flags & 0x80`) it **does not collapse immediately** and instead only sets the deferred-collapse bit; once the actor is grounded, the same collapse path runs
  - practical read: retail remote fall/recovery is not a single `Cmd70` event. It is a sequence where airborne state (`4`), deferred/immediate collapse (`8`), and ground resolution (`6`) can all matter depending on when the fall happens
- Fresh 2026-04-18 local/remote symmetry point: `FUN_00449c60` is the bridge between position sync and fall state. During airborne descent it sets the same deferred-collapse bit that `Cmd70/6` and local landing logic consume, which explains why retail can postpone the visible collapse until touchdown instead of falling instantly the moment the triggering condition occurs.
- Fresh 2026-04-18 support-gate naming follow-up: decrypting the installed `C:\MPBT\mechdata\*.MEC` set with the repo's existing XOR decoder showed that the critical-type table at `.MEC + 0xde` is effectively the identity map `0..20` across the retail roster (with only `0xffff` gaps where a chassis omits a slot), so the previously unnamed `damageState + 0x86` / `+0x8e` checks in `FUN_0042bb00(actor + 0x126)` are literally crit types `16` and `20`, not mech-specific remaps. Reading `MPBT.MSG` ids `0x1e9` and `0x1ed` then names those crits directly as **Cockpit** and **Fusion Engine**. That means the retail landing/support gate is now concretely: `cockpitHits < 1`, `fusionEngineHits < 3`, `CT internal != 0`, and `head internal != 0`. This closes the naming blocker, but it also makes the gate look like a general "still-functional/upright-capable" guard rather than a direct raw-leg-loss rule.
- Fresh 2026-04-18 `mpbt-server` audit: the current server only emits Cmd70 from destruction flows (`8` collapse, then delayed `4` wreck), and `handleCombatActionPacket` still lets `cmd12/action 0x15` fall through the generic "no response" branch. So the live server is still missing both a non-death fall-state broadcast and the likely stand-request acknowledgement path.
- Fresh 2026-04-19 recovery-side correction from Ghidra MCP: the client does **not** appear to send wire `cmd12/action 0x15` for F12 stand-up. `Combat_InputActionDispatch_v123` case `0x15` is the local input action code, and when the local actor is already down (`DAT_004f208e != 0`) it calls `Combat_SendCmd12Action_v123(0)`, i.e. the same wire `cmd12/action 0` byte normally used for selected-weapon fire. That makes the real server-side problem narrower and trickier: a post-fall stand request likely arrives as **`cmd12/action0 without a following cmd10 shot`**, not as a distinct `0x15` wire opcode.
- Fresh 2026-04-19 recovery-ack correction from Ghidra MCP: `Combat_Cmd70_ActorAnimState_v123` cases `4` and `6` are effectively **remote-only** (`if (iVar8 != 0)`), so they do nothing for the local actor at slot `0`. That means the extra airborne/landing pieces in the earlier `legair` / `legfull` experiments were only meaningful for remote actors, not for the player’s own local mech. By contrast, inbound `Cmd70/0` runs for local actors too and its default helper `FUN_0043b440` explicitly clears the local down flag at actor `+0x35e`. Practical read: if the server needs to acknowledge a local stand-up request after non-death fall, the strongest current candidate is **slot-0 `Cmd70/0`**, not slot-0 `Cmd70/6`.
- Fresh 2026-04-19 live F12 follow-up: after a `legfull` GUI run, pressing F12 once produced **no** `cmd12/action0` or `cmd10` traffic on the server. The session only continued to emit idle `cmd8` coasting frames before disconnect. Practical read: either the client never entered the local down/recover-gated state that would let F12 send wire `action0`, or one of the remaining local gates still blocked the stand request before any server round-trip happened.
- Fresh 2026-04-19 server-side recovery probe: verifier-only `/fightlegrecover` now emits local `Cmd70 1->8->0`, and `C:\MPBT\tools-local\fight-leg-recovery-sequence-smoke.mjs` passes with `cmd70=0/1,0/8,0/0` while the prior `fight-leg-full-sequence-smoke.mjs` still passes unchanged. `handleCombatActionFrame(...)` now also treats inbound `cmd12/action0` as an ambiguous fire-or-recovery trigger and starts a short follow-up timer; if no `cmd10` arrives inside the normal fire window, the server logs and counts an `action0NoShot` event. Practical read: the next GUI run can directly test both "does slot-0 `Cmd70/0` change local posture?" and "does the retail client ever emit `cmd12/action0` without a shot after fall?".
- Fresh 2026-04-18 contradiction check: re-reading `Combat_GetInternalStructureForSection_v123` together with its backing table at `DAT_0047af7c` confirms the retail section-id order is still `[arm, arm, side, side, CT, leg, leg, head]`, i.e. section ids `2/3` return the side-torso column and `5/6` return the leg column. That matches the current server mapping and directly weakens the earlier "server is sending leg loss under the wrong class-2 codes" hypothesis.
- Practical takeaway for retail fall recovery: the earlier blanket "F12 -> cmd12 is weak" read was too pessimistic, but the later "just remap class-2 legs to `0x22/0x23`" theory is now **not justified**. The best current model is:
  - local stand-up request is still very likely the **context-sensitive** fallback-`F12` / `action 0x15 -> cmd12(0)` path,
  - server-side, that means a recovery request is more likely to appear as **`cmd12/action0` with no shot follow-up** than as a unique wire `0x15`,
  - but its currently recovered torso-slot gate does **not** yet explain the user-observed leg-based stand lockout,
  - the `Combat_ApplyDamageCodeValue_v123` `+0xec/+0xee` check is now resolved as a torso-slot check, not a leg-slot check,
  - `FUN_0040df80` is now ruled out as a leg helper because it targets CT and drives hard state `3`,
  - the true leg slots are reached through generic section/internal maps, which explains why direct fixed-global xrefs have been sparse,
  - the named `FUN_0042bb00` gate still is **not** leg-specific, so the next best evidence target is the dedicated handling around the real leg slots `+0xf2/+0xf4` (`+0x218/+0x21a` on the actor),
  - real GUI evidence now says the current four strongest non-death server-side `Cmd70` hypotheses all still leave the retail client visibly upright:
    - minimum subset: **leg internal zero + actuator crits + non-death `Cmd70/8`**
    - simple extension: **non-death `Cmd70 1->8`**
    - airborne extension: **non-death `Cmd70 4->8->6`**
    - mixed extension: **non-death `Cmd70 1->4->8->6`**
  - that shifts the likely blocker away from "just add the right `Cmd70` trio" and toward either:
    - longer / different timing around the same states, or
    - additional recovery-side/local-state work such as `cmd12/action 0x15`, `Cmd73`, or another still-missing local posture/input transition,
  - `mpbt-server` currently sends Cmd70 only for destruction and still treats all `cmd12/action0` frames as fire triggers,
  - slot-0 `Cmd70/6` is not a viable local stand-up ack candidate because the client ignores that subcommand for the local actor,
  - no live follow-up has yet shown `cmd12/action 0x15` firing from the minimal subset alone, which makes it look more like a later recovery-side piece than the first missing visible-fall trigger,
  - and `mpbt-server` should **not** be patched to remap leg damage codes until that contradiction is resolved with stronger evidence.

Additional jump-fuel findings from `FUN_0042cf60 -> FUN_0042c610`:

- `DAT_004f21a2` is capped at `0x78` (`120`) rather than `100`.
- The client only allows jump start when fuel is **strictly greater than** `0x32` (`50`).
- The local jump-ready indicator uses hysteresis: it flips back on when recharge crosses above `0x3c` (`60`) and flips off again once active fuel drops below `0x32` while still above `0x28` (`40`).
- Grounded recharge is continuous in the main movement/update loop (`+ dt * 10 / 100`), not a separate movement-frame bonus plus passive timer.
- The local jump input path also refuses start while jump state flags are already active, matching a server-side "ignore duplicate airborne start" guard more closely than the earlier prototype restart behavior.
- `Combat_JumpJetInputTick_v123` also refuses jump when the local mech data field at `*(actor->mec + 0x38)` is zero. `Combat_InitActorRuntimeFromMec_v123` copies decrypted `.MEC` offset `0x38` into actor runtime offset `0x486`, and local `.MEC` cross-checks matched retail expectations (`JR7-D=5`, `JVN-10F=6`, `BJ-1=4`, while `AS7-D`, `ANH-1A`, `LCT-1E`, and `AWS-8R` all read `0`). Treat `.MEC + 0x38` as the current best jump-capability / jump-jet-count gate.
- Live Moose/Cougar duel captures from 2026-04-15 showed repeated `cmd12/action 6` frames after later fuel-blocked `action 4` attempts while the actor was already grounded. Treat `action 6` as a jump-state transition that still needs local jump-state correlation, not as stand-alone proof that a real touchdown occurred.

**Current working jump model (2026-04-17):**

- `cmd12/action 4` should be treated as **jump start / airborne-entered**, not as a request for the server to synthesize a full local ascent/descent staircase.
- `cmd12/action 6` is the best current landing/ground-contact transition signal, but only in correlation with prior airborne state; by itself it is still not proof of a valid retail touchdown.
- The strongest current throttle-style analogy is **state ownership**, not scale: the client appears to keep local ownership of jump duration/landing timing after `action 4`, just as TAP-mode throttle keeps local ownership of `actor+0x372`.
- Practical server guidance: keep jump fuel/accounting and remote-peer visibility, but avoid forcing slot-0 local `Cmd65` jump arcs whose timing can overwrite or flatten the client's own jump state.
- Deeper RE on 2026-04-16 tightened the remaining failure mode: `FUN_0042c830` uses `globalA` (`DAT_004f56b4`) as the same `D` constant in both ground-throttle equilibrium and jump gravity. With the current bootstrap `globalA = 2800`, a `JR7-D`'s local jump thrust (`5 * 400 = 2000` during the short bit-2 phase, then `globalA / 2 = 1400` after the 500 ms transition to flags `0x160`) yields only a brief upward impulse before net downward acceleration. That matches the observed tiny-hop symptom much better than the old apex/`Cmd65` theory.
- Continued RE ruled out a hidden upper-Z clamp: `FUN_00449220` only floors altitude at `0`, and the `DAT_004f1d30` local-actor overlay confirmed the other jump/fall path still feeds the same `DAT_004f1da6` / `DAT_004f1db2` state. The strongest remaining decoupler in the retail-visible `Cmd72` schema is therefore `globalB` (`DAT_004f1d24`), because `FUN_0042cd20` applies it only while **grounded**, whereas jump-active damping switches to `globalC`.
- Current server trial (2026-04-17 late pass): `globalA = 1462`, `globalB = 39`, `globalC = 0`. This keeps full-throttle equilibrium near `speed_target` (`0.8 * 98000 / 1462 - 1462 / 100 ≈ 39`) while increasing the simple Jenner jump-height estimate by about **50%** versus the earlier `1600/33/0` bootstrap, pushing the live result toward the manual's `Jump: 150 meters` line.
- The later `Cmd72` `headingBias = 3` experiment was a false lead. `DAT_004f4210` feeds the heat path, not jump height, so the clean bootstrap should keep that field neutral again.

**Jump jet fire — `Combat_SendCmd12Action_v123('\x04')`:**
```
Wire:  ESC '!'  [0x0C+0x21=0x2D]  [0x04+0x21=0x25]  [CRC]
                 cmd = 12 (0x0C)    action = 4
```

**`cmd13` family follow-up — binary confirm vs combat contact report (NEW, PARTIAL):**

- Static RE on 2026-04-15 found that `cmd13` (`0x0d`) is **not collision-exclusive**:
  - `World_HandleBinarySceneOfferInput_v123` (`0x0041e2f0`) sends a **bare** `cmd13` on Enter / Return when confirming certain world opcode-17 binary offer panels.
  - `FUN_00448b50 -> FUN_0040ea60` sends a **payload-bearing** `cmd13` from the combat mech-contact path.
- So the useful distinction is **payload shape**, not the opcode byte alone.
- The combat contact branch still does **not** use `cmd12`.
- `FUN_004408f0` scans the active actor array rooted at `DAT_004f21cc` and returns the first actor whose:
  - horizontal distance from the candidate point is within that actor's radius, and
  - vertical span overlaps the candidate `z` against both actors' height bounds.
- `FUN_00448b50` is the only current caller of that overlap test, and is itself called from the landing / ground-contact resolver `FUN_00448d80`.
- On contact, `FUN_00448b50`:
  - plays a collision/contact sound path (`FUN_0043b5e0(0x32)` / `FUN_0043b7b0(0x32,100)`),
  - computes a short-lived response vector in `_DAT_004f203a/_004f203e/_004f2042`,
  - sets an expiry timestamp `_DAT_004f2046 = timeGetTime() + 300`, and
  - sends a tiny dedicated frame via `FUN_0040ea60`.
- `FUN_0040ea60` writes:

```text
cmd 13
  [contact actor id byte via DAT_00478dc0[index]]
  [type2 response term A]
  [type2 response term B]
  [type2 response term C]
```

- The three `type2` payload values come from the current local response-vector fields:
  - grounded path: `DAT_004f1d9e / DAT_004f1da2 / DAT_004f1da6`
  - airborne/jump path: `DAT_004f1daa / DAT_004f1dae / DAT_004f1db2`
- **Important:** this is strong evidence that retail has a real mech-contact report / feedback path, but the exact server-side semantics of the **payload-bearing combat `cmd13` variant** are still unresolved.
- Server follow-up on 2026-04-15: `mpbt-server` now decodes inbound combat `cmd13` as `[actorId][type2 A][type2 B][type2 C]` and logs the parsed tuple alongside current local/peer movement and recent landing state. A synthetic live probe (`actorId=1`, responses `123/456/789`) hit the new logger successfully, so future real duel captures can be checked for authentic contact-report traffic without guessing at damage semantics.
- Repo artifact follow-up on 2026-04-18: preserved captures/logs currently show only earlier **synthetic** `cmd13` probe traffic (for example `captures\\1776280192271_e5efd00a-e1ed-407e-b4d1-f88b33af4b5a.txt`, `captures\\1776280192573_7268de66-8722-49f7-b37e-6325b1b3ae43.txt`, and the older `logs\\server.log` entries where combat `cmd13` was still unhandled). No obviously authentic live duel collision/contact `cmd13` capture is preserved yet.


**Weapon/TIC local-selection paths — `Combat_InputActionDispatch_v123`:**

| Input action | Current read |
|--------------|--------------|
| `0x16`..`0x1f` | Select weapon slot `0`..`9` via `Combat_SelectWeaponSlot_v123`. |
| `0x20` / `0x21` | Previous / next weapon slot. |
| `0x23` / `0x24` / `0x25` | Toggle the currently selected weapon into TIC A/B/C (`DAT_004f2128`, `DAT_004f2150`, `DAT_004f2178`) and refresh the HUD via `FUN_00422860`. |
| `0x3c` / `0x3d` / `0x3e` | Call `Combat_FireSelectedTicGroup_v123(..., group 0/1/2)`. 2026-04-12 live TIC-A captures now confirm this path does reach the wire, but as one flushed `cmd10` bundle per volley rather than `cmd12/action0` plus one representative `cmd10`. |
| `0xb1`..`0xce` | Mouse/HUD grid toggles weapon membership for TIC columns; computes `weapon = (action - 0xb1) / 3`, `tic = (action - 0xb1) % 3`, updates the same TIC arrays, then reselects the weapon slot. |

**Live capture correction — bundled TIC volley format (2026-04-12):**

- Screenshot `2026-04-12 06_10_32-Multiplayer BattleTech.png` confirms all five Jenner weapons were grouped into TIC A in the client HUD.
- Live test input used NumLock (default TIC A fire); the client visibly rendered all Jenner weapons firing on each press.
- Capture `captures/1775989470814_47d2b0eb-f274-4f0c-ad7d-cee803dc9bc4.txt` shows each NumLock volley as one direct `cmd10` payload of length `101`, with no preceding `cmd12/action0`.
- The wire body is:

```text
ESC seq cmd10
  [shot slot=0]
  0x2b
  [shot slot=1]
  0x2b
  [shot slot=2]
  0x2b
  [shot slot=3]
  0x2b
  [shot slot=4]
  [crc x3]
  ESC
```

- Each bundled shot subrecord is 18 bytes:

```text
[byte weaponSlot]
[byte targetServerSlot + 1]
[byte targetAttach + 1]
[type1 angleSeedA]
[type1 angleSeedB]
[type3 impactX + COORD_BIAS]
[type3 impactY + COORD_BIAS]
[type2 impactZ]
```

- In the captured Jenner-vs-Jenner TIC-A volleys, the slot markers appear as `0x21 0x22 0x23 0x24 0x25`, confirming that one volley contained weapon slots `0..4` (SRM-4 + four Medium Lasers).

Current implication: `cmd12/action0` is the selected-weapon fire path, while TIC A/B/C fire can arrive as a direct bundled `cmd10` volley with one shot subrecord per grouped weapon. The correct server response path is therefore per-subrecord `Cmd68` projectile/effect spawn plus per-hit `Cmd66`/`Cmd67` damage updates, with optional `Cmd70` animation/status after destruction.

**Client shot-geometry writer — `Combat_WriteCmd10ShotGeometry_v123` (`0x0040e230`):**
```c
Frame_WriteByte(0x0a);                 // client cmd 10
Frame_WriteByte(sourceWeaponOrSlot);
Frame_WriteByte(targetServerSlot + 1);  // 0 if no target
Frame_WriteByte(targetAttach + 1);
Frame_WriteType(1, angleA / 0xb6 + 0x0e1c);
Frame_WriteType(1, angleB / 0xb6 + 0x0e1c);
Frame_WriteType(3, x + 0x18e4258);
Frame_WriteType(3, y + 0x18e4258);
Frame_WriteType(2, z);
```

This helper is only called through `Combat_FireSelectedTicGroup_v123` / `FUN_00449480` in the local fire-preview path, and it does **not** flush by itself. Treat it as a shot-geometry write helper until live capture proves when the frame is flushed relative to the compact `cmd 12/action 0` fire request.

**2026-04-12 live capture update:** TIC-group fire does flush this helper's output, but as a bundled `cmd10` payload containing multiple 18-byte shot subrecords separated by literal `0x2b` bytes. The captured NumLock/TIC-A volleys did **not** include `cmd12/action0`, so a server that only parses the first subrecord will undercount grouped fire badly (for example, treating a Jenner TIC A alpha as SRM-4 only).

**Attachment-table path behind `targetAttach` (2026-04-11 Ghidra pass):**

- `targetAttach` is not a gameplay body-section enum. It is a model attachment id selected by the client targeting hit-test and stored in `DAT_004f4218`.
- `FUN_00438e90` resets the current target globals, then repopulates:
  - `DAT_004f56a6` = current target actor slot
  - `DAT_004f4218` = current target attachment id
- `FUN_00438ad0` and `FUN_0043f210` both call `FUN_0044ac10`, which performs the actual target-model hit-test and writes `DAT_004f56a4`; successful callers then copy `DAT_004f56a4 -> DAT_004f4218`.
- `FUN_0044ac10` receives one attachment record plus the current aim ray / transform context. It does not return a Solaris damage code; it selects one attachment id and bounding extents for the hit geometry.

Current model-table reads:

- `FUN_0043b320(model, attachId, outXYZ)`:
  - searches the model attachment-id byte list at `*(short **)(model + 0x20) + 0x1b`
  - uses the per-attachment transform table at `*(int *)(model + 0x2c)` with stride `0x40`
  - returns attachment world coordinates from offsets `+0x30/+0x34/+0x38`
- `FUN_0043b2d0(model, attachId)`:
  - searches the same attachment-id byte list
  - uses a second per-attachment table at `*(int *)(model + 0x30)` with stride `10`
  - returns the dword at offset `+6`, used for attachment-specific metadata/effect selection
- `FUN_0043b210(model, attachId)`:
  - searches the same attachment-id list
  - checks the active-bit mask at `*(uint *)(model + 0x54)` for the matching attachment index

Per-attachment record layout used by the hit-test path:

- `FUN_00431df0` walks the record list pointed to by `*(short **)(model + 0x20)`.
- Record count is the first `short`.
- The per-record block starts at `*(int *)(base + 2)` and uses stride `100` bytes.
- The first `short` of each record is the attachment id.
- The hit-test code in `FUN_0044ac10` uses:
  - `record + 0x0a` as a pointer to per-record geometry points
  - `record + 0x04` as the point count
  - three orientation-specific polygon groups around `record + 0x30`

Practical implication:

- Attachment ids like `1`, `19`, `31`, `33` are mesh attachment ids and are model-specific.
- The networked remote-damage path still applies only the server-supplied `Cmd66` / `Cmd67` damage code/value pairs.
- There is no confirmed client-side `targetAttach -> damageCode` mapper on the multiplayer receive path.
- A server-side accuracy improvement should therefore be per-mech and spatial:
  - extract attachment ids plus their world-space attachment coordinates via the `FUN_0043b320`-style table layout
  - classify them into torso/arm/leg/head groups per chassis
  - then map those groups to `Cmd66` class-1 / class-2 section codes

**2026-04-18 deeper hit-selection pass:**

- `FUN_00438e90` is the main per-frame combat target refresh:
  - resets `DAT_004f56a4`, `DAT_004f56a6`, `DAT_004f5698`, and `DAT_004f4218`
  - sorts visible scene objects by distance
  - runs attachment hit-tests through `FUN_00438ad0` and `FUN_0043f210`
  - leaves the chosen actor slot in `DAT_004f56a6` / `DAT_004f5698` and the chosen attachment id in `DAT_004f4218`
- `FUN_00431df0` is the model-attachment candidate walker:
  - iterates the active attachment records from `model + 0x20`
  - skips masked-off attachments via `model + 0x54`
  - transforms each attachment anchor from the per-attachment table at `model + 0x2c`
  - sorts candidates by transformed distance before calling `FUN_0044ac10`
  - passes per-attachment metadata from the table at `model + 0x30` (same attach-id search, stride `10`, dword at `+6`)
- `FUN_0044ac10` is the actual per-attachment polygon hit-test:
  - `FUN_0044a890` computes a 3-bit orientation bucket from the transformed aim vector
  - that bucket indexes one of the attachment record's polygon-group lists (`record + 0x30` family)
  - `FUN_0044ab50` / `FUN_0044aab0` run the screen/polygon overlap tests for that bucket
  - on success, `FUN_0044ac10` writes the winning attachment id to `DAT_004f56a4` and the current polygon record id to `DAT_0047eb30`
- The chosen attachment survives all the way to the wire:
  - selected-weapon fire in `Combat_InputActionDispatch_v123` reads `DAT_004f4218`
  - TIC-group fire in `Combat_FireSelectedTicGroup_v123` also reads `DAT_004f4218`
  - both fire paths pass that id into `Combat_CalcProjectilePath_v123` and `FUN_00449480`
  - so the outbound `targetAttach` byte is the client-selected attachment id, not a later server-side remap
- Real asset dump from `C:\\MPBT\\3dobj.bin`, **model 13** (Jenner / JR7-D group), attach-id order:
  - `[37, 52, 54, 55, 38, 40, 41, 31, 1, 33, 18, 19, 32, 4, 5, 36, 35, 34]`
- The torso reference attachments in the real asset match the model-13 root split refs now used in `src/data/mech-attachments.ts`:
  - `18 -> [0, 0, 0]`
  - `19 -> [21, -24, -8]`
  - `4  -> [0, 24, -1]`
  - `5  -> [21, 24, -8]`
- The remaining model-13 mirrored low-body clusters are:
  - left cluster:
    - `52 -> center [9, -23, -96], span [90, 42, 252]`
    - `54 -> center [20, 0, -128], span [78, 50, 278]`
    - `55 -> center [-18, -11, -21], span [196, 94, 40]`
  - right cluster:
    - `38 -> center [13, 20, -101], span [90, 42, 252]`
    - `40 -> center [23, 0, -135], span [74, 50, 270]`
    - `41 -> center [-18, 0, -14], span [196, 94, 40]`
  - center / lower trunk cluster:
    - `34 -> center [-29, 0, -9.5], span [146, 86, 185]`
    - `35 -> center [0, 0.5, 0], span [88, 41, 166]`
    - `36 -> center [0, 0, 0], span [88, 40, 166]`
- Practical server impact:
  - the current shared server mapping (`38/40/41 -> right-arm`, `52/54/55 -> left-arm`, `34/35 -> right-leg`, `31 -> ct-front`) is not trustworthy for model 13
  - the live Jenner capture where a leg-aimed volley carried `targetAttach = 40` is at least consistent with a **low lower-body** attachment, not an obviously arm-only attachment
  - model-13 accuracy work should therefore start with an explicit per-model attachment table, not more shared-id guesses
  - server follow-up on 2026-04-18 landed the next explicit model-13 override slice in `src/data/mech-attachments.ts`:
    - `38 -> right-leg`
    - `40 -> right-leg`
    - `52 -> left-leg`
    - `54 -> left-leg`
    - `41/55` remain on their older arm-side mappings until more live shot correlation is gathered for those shallower mirrored cluster members
  - `C:\MPBT\tools-local\jr7-attachment-probe-smoke.mjs` now drives an explicit `JR7-D` vs `JR7-D` duel probe with forced `targetAttach` shots and live-proves the current rebuilt-server mapping:
    - `38 -> right-leg`
    - `40 -> right-leg`
    - `41 -> right-arm`
    - `52 -> left-leg`
    - `54 -> left-leg`
    - `55 -> left-arm`
  - this probe is useful for validating the server resolver path and future remap changes, but it does **not** replace fresh retail-client capture for deciding whether real leg-aims ever select `41/55`

**Channel / mode command — `FUN_0043d920()`:**
```
RPS mode    (DAT_0047d05c == 3):  cmd byte 0x21 ('!') + data byte 0x21 → raw 0x42
Combat mode (DAT_0047d05c == 4):  cmd byte 0x14 + data byte 0x21 → raw 0x35
```
This is the single-wire-byte mode-selection packet (no multi-word fields).

**Text send — `FUN_0043eb10(char *text)` (cmd 4):**
```
Wire prefix: [0x04 + 0x21 = 0x25]  // cmd byte
RPS:          Frame_WriteString(text) via FUN_00401c20  (length-prefixed, base-85)
Combat:       FUN_00401bc0(text):
                *ptr++ = len + 0x21   // length byte (max 0x54 = 84 chars)
                memcpy(ptr, text, len) // raw ASCII, NOT base-85
```

---

### §19.4 — v1.23 F7/F8 Key Behavior (CONFIRMED — NO NETWORK COMMAND)

F7 (action index 56) and F8 (action index 57) do **not** emit any network packet.

**Full dispatch chain (v1.23):**
1. `FUN_00434350` (WndProc) receives `WM_KEYDOWN`
2. `FUN_0043d500(vk, lParam)` → `FUN_0040b700(scancode)` → resolves to action index 56 or 57  
   *(keymap lookup at `DAT_00478c50`, 77 entries; F7 = scancode 0x41, F8 = scancode 0x42)*
3. `(*DAT_0047a37c[0x1434])(action_index)` → calls `FUN_0042ec60` (vtable slot `[0x50d]`)
4. `FUN_0042ec60` → calls `FUN_0042dc30(scene, action_index)` — UI button key matcher
5. `scene[0x50c]` is **0** (null secondary handler) in the combat scene  
   *(set by `FUN_0042f7c0`, the combat scene init: `piVar4[0x50c] = 0`, `piVar4[0x50d] = FUN_0042ec60`)*

**Result:** `FUN_0042dc30` maps action index 56/57 to a visual button state toggle (active chat-channel indicator). No `FUN_0040eb20` call and no `thunk_FUN_00435c10` call occurs. The actual chat text is transmitted only when the user presses **Enter**, via `FUN_0043eb10` (cmd 4, §19.3).

The ROADMAP items "F7 — team/lance channel" and "F8 — all-comm/chat-window toggle" have **no client→server wire format** in v1.23 because F7/F8 are local UI state only. The combat-scoped channel is selected implicitly by the mode command (`FUN_0043d920`, §19.3).

---

### §19.5 — v1.23 ACK Mechanism (CONFIRMED — STUB IN v1.23)

`FUN_0040eb40` decompiles to:
```c
undefined4 FUN_0040eb40(void) { return 0; }
```
This is the function called by `FUN_0040de90` (sequence + ACK handler) when `param_1 < 0`.  
In v1.23 it is a **no-op stub** — no ACK packet is constructed or sent.

The ROADMAP "ACK reply for seq > 42" item applies historically. In v1.23 the client simply does not ACK the sequence byte; the server must therefore not require ACKs from the combat client in this version.

---

### §19.6 — v1.23 Dispatch Table Addresses (CONFIRMED)

| Table | Address | Entry count | Usage |
|-------|---------|-------------|-------|
| RPS command dispatch | `DAT_00478070` | 77 | Cmds 0–76 (server→client) |
| Combat command dispatch | `DAT_004782d8` | 82 | Cmds 0–81 (server→client) |

**Mode flag:** `DAT_0047d05c` — `3` = RPS (Solaris social), `4` = Combat.  
*(v1.06 used `DAT_004e2cd0`; the flag value semantics are unchanged.)*

**CRC seed selection:** `FUN_004018e0` reads `DAT_0047d05c` to pick the CRC seed, same formula as v1.06 but referencing the new global address.

**Key globals (v1.23 addresses):**

| Global | Address | Meaning |
|--------|---------|---------|
| Mode flag | `DAT_0047d05c` | 3 = RPS, 4 = Combat |
| Map type | `DAT_0047d048` | 0 = IS.MAP, 1 = SOLARIS.MAP |
| Input bitmask | `DAT_004ef174` | Live held-key state (bits 0–20) |
| Leg vel accumulator | `DAT_004f1f7a` | ±8190, leg velocity (forward/back) |
| Throttle vel accumulator | `DAT_004f1f7c` | ±8190, throttle |
| Third vel accumulator | `DAT_004f1d5c` | positional adjust |
| TCP outbuf start | `DAT_004f7274` | Buffer base address |
| TCP outbuf write ptr | `DAT_004f7278` | Current write position |

#### §19.6.0 — v1.23 World Dispatch Pipeline (CONFIRMED)

Follow-up RE against `C:\MPBT\Mpbtwin.exe` v1.23 tightened the receive path for
world-mode packets:

- `FUN_00435cb0` = `Comm_AccumulateEscapedPacketLine_v123`
  - Accumulates inbound `ESC`-delimited packet lines into `DAT_004dcd1c`
- `FUN_00435c60` = `Comm_ProcessAccumulatedPacketLine_v123`
  - Terminates the accumulated line, verifies/decodes it, then dispatches the
    decoded packet stream
- `FUN_004018e0` = `Comm_VerifyDecodedPacketCrc_v123`
  - Replays decoded bytes into `DAT_004f727c..DAT_004f7270`
  - Uses mode-specific CRC seeds:
    - world (`DAT_0047d05c == 3`) -> `0x0A5C25`
    - combat (`DAT_0047d05c == 4`) -> `0x0A5C45`
- `FUN_00401580` = `Comm_DispatchDecodedPacket_v123`
  - Reads the command byte, indexes the active dispatch table selected by
    `FUN_00401d70` / `Main_SetModeName_v123`, checks the row's minimum payload
    length, and calls the handler

Important correction: the v1.23 dispatch rows are not `(selector, handler)` pairs.
Each 8-byte row is:

```c
struct PacketDispatchRow {
  uint32 minPayloadBytesAfterCmd;
  void (*handler)(void);
};
```

`FUN_00401d70` / `Main_SetModeName_v123` installs:

- world mode -> `DAT_00478070`, count `0x4d`
- combat mode -> `DAT_004782d8`, count `0x52`

Confirmed world-mode rows from `DAT_00478070`:

| Cmd | Row address | Min payload | Handler | Notes |
|-----|-------------|-------------|---------|-------|
| 3 | `0x00478088` | `1` | `FUN_0043da70` | Generic status-text packet; writes to `g_world_SceneStatusTextWidget` in world mode |
| 4 | `0x00478090` | `2` | `FUN_00413410` | `World_HandleSceneInitPacket_v123` — true outer world scene-init packet entry |
| 5 | `0x00478098` | `0` | `FUN_0043dc40` | Simple UI clear/close helper |
| 6 | `0x004780A0` | `0` | `FUN_0043dc50` | Simple UI helper |
| 9 | `0x004780B8` | `1` | `FUN_0043dc60` | Counted-list packet feeding a world UI panel |
| 10 | `0x004780C0` | `1` | `World_HandleRoomPresenceSync_v123` | Seeds the live room-presence table and appends the `Here you see ...` summary |
| 11 | `0x004780C8` | `2` | `World_HandleRoomPresenceRename_v123` | Replaces the callsign for an existing tracked entry and appends `%s becomes %s.` |
| 12 | `0x004780D0` | `1` | `World_HandleRoomPresenceEvent_v123` | Applies leave/booth/battle/heading events and appends the matching room-status text |
| 13 | `0x004780D8` | `1` | `World_HandleRoomPresenceArrival_v123` | Adds/refreshes one tracked entry and appends `%s enters the room.` |
| 14 | `0x004780E0` | `10` | `FUN_004140B0` | Info-panel packet |
| 15 | `0x004780E8` | `11` | `FUN_00412280` | Detail-panel packet |
| 16 | `0x004780F0` | `3` | `FUN_004106C0` | List/dialog packet family |
| 17 | `0x004780F8` | `5` | `FUN_0041BE90` | Scene-action response packet family |
| 20 | `0x00478110` | `0` | `FUN_0041E410` | Modal message packet |
| 21 | `0x00478118` | `0` | `FUN_0041E490` | Modal/popup reset packet |
| 22 | `0x00478120` | `0` | `FUN_0041E4E0` | Modal message packet with decoded string |

This also confirms that scene-init remains command 4 in v1.23. Earlier scratch
notes that treated the leading dword in each row as an opcode selector were wrong.

#### §19.6.0a — World Opcode 17 Scene-Action Family (CONFIRMED — STATIC)

Follow-up RE on `FUN_0041BE90` / `World_HandleSceneActionResponsePacket_v123`
shows that world opcode `17` is the main non-travel `cmd5` response family for
contracts / offers / duel terms.

**Packet shape (high level):**
- byte 0: subtype
- byte 1: shared panel-mode byte
- remaining fields: strings and numeric fields whose layout depends on subtype

**Shared panel-mode byte (`byte 1`)**

| Mode | Meaning |
|------|---------|
| `0` | Editable offer state |
| `1` | Readonly details |
| `2` | Counter-offer / share-revision editor state for subtype `1/5` |
| `3` | Binary accept / decline review |

**Confirmed subtype model**

| Subtype | Current meaning | Outbound follow-up |
|---------|------------------|--------------------|
| `1` | Base **Agreement** editor (non-subcontract) | submit `cmd 12` |
| `2` | Binary review / acceptance variant paired with subtype `1` | Enter `cmd 13`, ESC `cmd 11` |
| `3` | Duel stakes/details panel | Enter `cmd 15`, ESC `cmd 11` |
| `4` | Membership-bid editor | submit `cmd 17` |
| `5` | Subcontract offer/details editor | submit `cmd 14` |
| `6` | Binary review / acceptance variant paired with subtype `5` | Enter `cmd 13`, ESC `cmd 11` |
| `7` | Subcontract terms editor | submit `cmd 30`, ESC `cmd 32` |

**Structural distinction that matters**
- Subtypes `1/2` are the **base Agreement** family — a C-bill contract between two
  Successor State parties (confirmed by `MPBT.MSG[0x19e]` = `"Details of Agreement between"`).
- Subtypes `5/6/7` are the **subcontract-specific** family.
- Subtype `4` is separate and centered on membership bidding.
- Subtype `3` is the duel branch.

### Arena ready-room staging semantics (2026-04-15)

Manual re-read plus follow-up static client RE tightened the current arena-room picture:

- `BT-MAN.txt` explicitly identifies the **arena ready room** as the staging room from
  which players enter combat.
- The ready-room crossbar is documented as `MECH`, `SIDE`, and `STATUS`.
- `SIDE` is documented as a menu of the **eight sides**; players on the same side are
  teammates, and players may not all enter the arena while on the same side.
- `STATUS` is documented as listing **every player in the arena ready room** together
  with each player's side and whether that player has picked a BattleMech.

**What this does and does not prove**

- This is strong evidence for a side-based multiplayer staging room and makes an
  eight-way free-for-all interpretation plausible if one player occupies each side.
- The manual does **not** state a hard numeric player cap for the ready room.
- For current server work, an **8-participant cap** is a practical implementation
  assumption derived from the eight-side model, not a historically proven maximum.

**Current client-RE implication**

- Follow-up work on `FUN_0041BE90` / `World_HandleSceneActionResponsePacket_v123`
  still points opcode `17` at agreement / duel / membership / subcontract panels.
- No static evidence has yet shown a distinct arena-room-creation form with custom
  room naming, an explicit room-size selector, or explicit `FFA` / `team play`
  labels in `Mpbtwin.exe`.

### Scene-action vs room-presence split (2026-04-15)

Deeper tracing now makes the client structure look less like "arena room creation is
hiding inside opcode 17" and more like "the world scene is a generic server-driven
shell with separate presence/state feeds":

- `World_ParseSceneInitCacheRow_v123` shows `Cmd4` carries a per-scene table of
  **action ids + display text**. These become the clickable scene buttons shown in the
  world window.
- `World_HandleSceneRosterAction_v123` confirms those buttons are not hardwired to
  special arena forms, but the dispatch window is narrower than the UI suggests:
  button `0x100` is still local Help, only `0x101`–`0x105` forward as `cmd 5` using the
  server-supplied scene action id from `g_world_SceneRosterEntryTable`, and `0x106+`
  falls through the local default handler.
- `World_HandleSceneWindowInput_v123` confirms the scene window is a generic shell:
  location buttons send `cmd 23`, scene-action buttons dispatch through
  `World_HandleSceneRosterAction_v123`, and the special roster key/button path at
  widget id `0x121` opens the separate room-roster UI.
- The same handler also has at least one **fixed** scene control outside the `Cmd4`
  roster table: widget id `1` sends `cmd 5` action `4` directly instead of reading
  from `g_world_SceneRosterEntryTable`.
- `World_HandleRoomPresenceSync_v123`, `World_HandleRoomPresenceRename_v123`,
  `World_HandleRoomPresenceEvent_v123`, and `World_HandleRoomPresenceArrival_v123`
  maintain a **live room-presence table** completely outside opcode `17`.
  This is currently the strongest client-side machinery for STATUS-like occupant lists.
- The existing local roster consumer `FUN_00411750` / `FUN_00411da0` is the
  already-documented **social-room booth roster** (`All`, `Stand`, `New Booth`,
  `Join`) backed by that presence table plus `Cmd7(listId = 3, ...)`. That confirms at
  least one room-roster surface is built from presence/state commands, not from opcode
  `17`.

**Current best inference**

- Arena `MECH` / `SIDE` / `STATUS` are most likely ordinary **scene actions**
  advertised by `Cmd4`, with server-selected follow-up replies.
- The client does **not** currently show a proven bespoke "create named arena room"
  modal in the same way it shows agreement / subcontract / duel opcode-17 panels.
- If custom arena rooms existed, the strongest remaining candidates are:
  1. server-defined scene-action flows opened after `cmd 5 <actionId>`
  2. room-presence / roster command families (`Cmd10`-`Cmd13`)
  3. string resources loaded from `MPBT.MSG` rather than literal `Mpbtwin.exe` text

### Sanctioned-duel follow-on clues (2026-04-14)

These findings do **not** fully map the sanctioned-duel ranking flow yet, but they
narrow the missing public-results layer substantially:

- `World_HandleCmd5SceneActionSubtype3_v123 @ 0x0041e5b0` is the duel stakes/details
  panel. Its wire contract is:
  - `subtype`
  - `mode`
  - `participantA`
  - `participantB`
  - `stakeA`
  - `stakeB`
  - `contextA`
  - `contextB`
  - `flagA`
  - `flagB`
- In editable mode, `World_HandleDuelTermsEditorInput_v123 @ 0x0041eac0` submits
  `cmd 15` with the two type-4 stake values and shows `MPBT.MSG[0x115]`
  (`Duel submitted`).
- `MPBT.MSG` contains public-ranking and results labels that the current server does
  not yet back:
  - `266` — `Solaris Match Results`
  - `1118` — `View Personal Tier Rankings`
  - `1121` — `Tier Rankings`
  - `1122` — `Class Rankings`
  - `154` — `Rank    : %s`
  - `155` — `Standing with %s : %s`
  - `156` — `Unit    : %s`
  - `157` — `Earnings: %10ld`
  - `158` — `Wealth  : %10ld`
  - `159` — `Stable  : %s (%s)`
  - `160` — `Battles to date: %ld`
- `BT-MAN.txt` confirms the intended sanctioned-match behavior:
  - sanctioned arena results are fed immediately into **SCentEx** (Solaris central
    information exchange)
  - SCentEx recalculates duelist rankings
  - duel rebroadcasting is part of Solaris' public spectacle
- `BT-MAN.txt` also describes the tier-ranking listing shape:
  - rows show **ComStar ID**, **Handle**, **rank score**, and **win/loss ratio**
  - this maps cleanly onto the client's generic keyed list layout (`itemId + 3 columns`)
- Manual constraints on the ranking model are still directional rather than formula-complete:
  - SCentEx compares **BattleMech effectiveness** and **MechWarrior rankings**
  - rank gain is explicitly tied to **damage inflicted vs damage sustained**
  - fighting a **lower-ranked** opponent or a **less-effective mech** reduces the gain
  - the manual does **not** publish weights, thresholds, or the exact rank-score formula
- Additional client request-path clue:
  - `FUN_0040d2f0()` is the concrete outbound **`Cmd7`** writer:
    `startCmd('\a') + type1(list_id) + type4(selection)`
  - simple keyed lists use `Cmd7(list_id, item_id + 1)` on selection
  - `Cmd44`, `Cmd45`, and `Cmd48` all preserve the server-supplied numeric `item_id`
    and route ordinary selection through that same `Cmd7` path
  - `Cmd45` only deviates when its latched `list_id == 0`, where Enter opens the
    local synthetic `Personal inquiry on:` submenu instead of sending a wire request
  - there is also a distinct outbound **`cmd 10`** bitmask submit path:
    `FUN_0040d360()` emits `startCmd('\n') + type1(list_id) + type4(bitmask_plus_1)`,
    and `FUN_00412580()` uses it for checkbox-style local multi-select pages
  - the client also has a separate richer list-submit path `FUN_0040d430()` that emits
    outbound command `0x10` (**`cmd 16`**) with a list id plus multiple
    `(selector, value)` pairs
  - narrowed further: the shared `Cmd26` / `Cmd32` numbered-list UI only flips into
    that richer submit mode for list ids `0x20` and `0x3e`; other numbered lists stay
    on the ordinary single-pick path
  - the separate `Cmd45` scroll-list family (`Cmd58` sets its list id) also submits via
    plain `Cmd7(list_id, item_id + 1)` on Enter
  - current best inference is now strong enough to guide the server: the current
    Solaris ranking/result candidates (`Cmd44` chooser -> `Cmd45` paged results
    -> optional `Cmd46` detail page) stay on ordinary `Cmd7` selection plus
    `cmd28` for page advance, and do **not** require either `cmd 10` or
    `cmd 16` unless future capture/RE proves the result set actually uses one of
    the special `Cmd26` / `Cmd32` multi-select list ids
- Additional client-side negative evidence for `duel-ranking-model`:
  - `World_HandleInfoPanelPacket_v123` (`004140b0`) reads one numeric
    `Battles to date` field plus six server-supplied strings and formats the
    personnel/ranking detail window; it does not derive a rank score locally
  - `FUN_0040fe80()` (`0040fe80`) builds keyed ranking/result lists from
    server-supplied `item_id + row string` entries and preserves those ids for
    later `Cmd7` selection; again no local score math was found there
  - nearby helpers `FUN_00415810()`, `FUN_00415a40()`, and `FUN_00415cf0()`
    appear to be generic window/list/text-page helpers rather than SCentEx logic
  - Ghidra string searches for ranking labels such as `Class Rankings`,
    `Tier Rankings`, `Standing with`, and `Rank    :` produced no literal hits in
    `Mpbtwin.exe`, which is consistent with those labels coming from `MPBT.MSG`
  - current best inference: the retail client ranking UI is consuming
    **server-provided rank values/strings**, and the actual SCentEx formula may be
    entirely server-side

### Open sanctioned-duel questions

- Which world command(s) populate the **Solaris Match Results** and **Tier Rankings**
  views?
- The current best-supported sanctioned-results model is now: **global `Cmd3`
  rebroadcast for the live public winner/loser marquee, plus persisted data that
  later populates `Solaris Match Results` / ranking views on demand**. No direct
  evidence yet shows an additional server-pushed list/record refresh packet at
  duel completion.
- Are tier/class rankings delivered through `Cmd48`, `Cmd32`, or another world list
  family?
- If rankings use `Cmd32`, do they specifically use list id `0x20` or `0x3e`, or do
  they remain on the ordinary `Cmd7` single-pick path?

**Subtype 1/2 — Agreement field layout (`MPBT.MSG` 1-based indices)**

The handler references the following `MSG` strings to build the opcode-17 display
panels for subtypes `1` and `2`.  All indices are 1-based (i.e., `FUN_0040eff0(N)`
returns the string on line `N` of `MPBT.MSG`).

| MSG index | String |
|-----------|--------|
| `0x19e` | `Details of Agreement between` |
| `0x19f` | `%s and the %s` |
| `0x1a0` | `Signing Bonus in thousands of C-bills:` |
| `0x1a1` | `%s's shares in the unit:` |
| `0x1a2` | `Starting Shares Percent:` |
| `0x1a3` | `Mission: %s` |
| `0x1a4` | `Planet: %s` |
| `0x1a5` | `Cooperating With: %s` |
| `0x1a6` | `Opposing House: %s` |
| `0x1a7` | `Opposing Mechs:` |
| `0x1a8` | `%d heavy mech` |
| `0x1a9` | `%d medium mech` |
| `0x1aa` | `%d light mech` |
| `0x1ab` | `Mechs Provided:` |
| `0x1ac` | `Final Payoff: %7ld K C-bills` |
| `0x1ad` | `Up Front Money: %7ld K C-bills` |
| `0x1ae` | `Payment upon Start: %7ld K C-bills` |
| `0x1af` | `Initial Payment: %7ld shares` |
| `0x1b0` | `Final Payment: %7ld shares` |
| `0x1b1` | `Subcontract Shares: %7ld` |
| `0x1b2` | `Submit` |
| `0x1b3` | `Description: operate in cooperation with the %s military` |
| `0x1b4` | `Initial planet:` |

**Subtype 3 — Duel terms editor (`0x0041e5b0` / `0x0041eac0`)**

Follow-up Ghidra tracing on 2026-04-14 confirms that opcode-17 subtype `3` is not
just a generic accept/decline panel. The retail client has a dedicated duel-terms
UI and a dedicated outbound submit path.

Key functions:

| Function | Address | Role |
|----------|---------|------|
| `World_HandleCmd5SceneActionSubtype3_v123` | `0x0041e5b0` | Builds the subtype-3 duel modal from the server payload |
| `World_HandleDuelTermsEditorInput_v123` | `0x0041eac0` | Editable duel-stakes input callback |
| `World_SendCmd29SceneOfferChoice_v123` | `0x0041e2a0` | Generic world-opcode-17 choice helper used by non-duel offer/review panels |

Observed subtype-3 payload shape:

- byte `0`: panel mode
- string `A`
- string `B`
- `type4` stake/value `A`
- `type4` stake/value `B`
- string `C`
- string `D`
- byte `flagA`
- byte `flagB`

Static UI behavior from `0x0041e5b0`:

- The handler renders two participant-oriented lines using server-provided strings,
  then two independent numeric wager/stake lines using the two `type4` values.
- The panel tracks exactly two editable numeric fields in `DAT_004d9988` and
  `DAT_004d998c`.
- Mode `0` enters an editable duel-terms state (`panelState = 0x12`) and installs
  `World_HandleDuelTermsEditorInput_v123`.
- Mode `1` is read-only details / review and installs a close-only callback instead
  of the duel editor.

`World_HandleDuelTermsEditorInput_v123` confirms the duel-specific client submit path:

- Enter sends `cmd15` by calling `FUN_00401b50(0x0f)`.
- The payload is exactly two `type4` values, written via:
  - `FUN_00401470(4, DAT_004d9988)`
  - `FUN_00401470(4, DAT_004d998c)`
- After sending `cmd15`, the client shows `MPBT.MSG[0x115]`, which is the local
  “duel submitted” confirmation text.
- ESC closes the modal and sends `cmd11`, not `cmd29`.

Input affordances in the duel editor:

- direct digit entry and Backspace edit the active stake
- the numeric value is clamped to `0..9,999,999`
- an ANSI-arrow sequence (`ESC [ A/B/C/D`) is handled locally:
  - `C` / `D` switch between the two duel stake fields
  - `A` / `B` add or subtract `100` from the active field

Current implication for server work:

- Supporting the retail duel-terms UX requires a real `cmd15` handler with two
  submitted wager values.
- A subtype-3 implementation that only models a yes/no accept path will not match
  the client's actual sanctioned-duel editor behavior.
- This RE pass did **not** yet reveal a separate sanctioned-vs-casual branch beyond
  the duel-terms panel itself; that distinction likely lives in the server-driven
  `cmd5 actionId -> opcode17 subtype` mapping and/or the follow-up server responses.

**Remaining open item**
The concrete scene-specific mapping from outbound `cmd5 actionId` values to opcode
`17` subtypes cannot be resolved by static RE alone — the server embeds the action
type in `Cmd4`, the client echoes it in `cmd5`, and the server dispatches on it.
A live capture is needed to establish the `actionId → subtype` table.  This item
is deferred from M5 scope (the static model is sufficient for milestone
verification).


#### §19.6.1 — v1.23 Combat Server→Client Position Path (PARTIAL)

Follow-up Ghidra pass against `C:\MPBT\Mpbtwin.exe` v1.23, starting from the combat dispatch table at `DAT_004782d8`.

Combat dispatch entries use the same 8-byte row format as world mode:
`{ minPayloadBytesAfterCmd, handler }`. The allocated combat table spans
commands 0–81, but most entries are null; the non-null combat-only cluster is 59–81.

Key handlers for combat bootstrap and position sync:

| Cmd | Wire byte | Handler | Current read |
|-----|-----------|---------|--------------|
| 64 | `0x65` | `FUN_0040d390` | Remote actor/mech add. Reads a server slot byte, maps it through `DAT_00478d98`, copies multiple identity strings into the per-mech struct at `DAT_004f1d30 + index*0x49c`, reads a mech id via `FUN_004013a0(2)`, loads the local `.MEC`/mech data, and marks the actor active. |
| 65 | `0x66` | `FUN_0040d830` | Primary server→client combat position/velocity sync. Reads one server slot byte, then `type3 x`, `type3 y`, `type2 z/altitude`, and four `type1` motion fields now mapped to facing/heading accumulator, throttle velocity, leg velocity, and a forward/speed magnitude term. It writes `DAT_004f1d4c/50/54`, `DAT_004f1d5c`, `DAT_004f1f7c`, `DAT_004f1f7a`, `DAT_004f20a2`, `DAT_004f1d9e`, and the corresponding delta/absolute-delta fields under the same per-mech struct. |
| 66 | `0x67` | `FUN_0040de50` | Actor damage-state update. Reads an actor slot byte, maps it through `DAT_00478d98`, then reads a `damageCode` byte and `damageValue` byte through the shared damage helper. If a current projectile/effect is active for that actor, the pair can be queued onto the effect; otherwise it applies directly to the actor mech state. |
| 67 | `0x68` | `FUN_0040de80` | Local actor damage-state update. No actor slot is present; it applies the next `damageCode` and `damageValue` byte pair to local actor index 0 through the same shared helper as cmd 66. |
| 68 | `0x69` | `FUN_0040e390` | Projectile/effect spawn. Reads source actor, source weapon slot, optional target actor/attachment, two angle/offset seed fields, and fallback `type3/type3/type2` impact coordinates. It resolves source muzzle geometry, target attachment or fallback impact coordinates, allocates a transient projectile/effect object, and records the new effect id in `DAT_00478df8` for later follow-up. This is visual/effect sync, not yet a decoded damage result. |
| 69 | `0x6a` | `FUN_0040e570` | Impact/effect at coordinate. Reads an actor slot, skips one byte, reads target/attachment-like bytes and fallback `type3/type3/type2` coordinates, then triggers impact audio/visual helpers. It does not apply mech damage state directly. |
| 70 | `0x6b` | `FUN_0040e700` | Actor animation/status transition. Reads actor slot + subcommand and fans into animation helpers (`FUN_0043b400`/`470`/`4a0`/`4e0`/`500`/`520`/`540`) for stand/fall/jump/destruction-style transitions. |
| 71 | `0x6c` | `FUN_0040eae0` | Resets the current projectile/effect globals by setting `DAT_00478df8` and `DAT_00478dfc` to `-1`. This likely brackets or clears the effect context used by cmd 66/67 follow-up damage pairs. |
| 72 | `0x6d` | `FUN_00445110` | Local combat bootstrap. Reads the scenario/title, local actor slot, terrain/resource point lists, actor identity strings, initial coordinates, and local mech/damage-state block via `Combat_ReadLocalActorMechState_v123`; then sets `DAT_0047ef60 |= 1` and initializes local actor state at `DAT_004f1d30`. This is now traced enough for a conservative prototype builder, but several identity/status fields still need live capture labels. |
| 73 | `0x6e` | `FUN_0040e2f0` | Actor rate/bias-field update. Reads actor slot plus two bytes, stores each as `(value - 0x2a) * 0x38e` into per-actor fields near `DAT_004f202a`/`DAT_004f202e`, and marks `_DAT_00478df4 = 1`. Exact combat meaning still needs dynamic capture. |

#### §19.6.1a — v1.23 Mech Contact / Collision Response (NEW, PARTIAL)

Follow-up Ghidra pass on 2026-04-15 traced the retail client's ordinary mech-contact path.

**Confirmed local contact detection / response chain:**

```text
FUN_00449220             // per-actor movement tick
  -> FUN_00448d80        // landing / ground-contact resolver
     -> FUN_00448b50     // actor-contact branch
        -> FUN_004408f0  // overlap detector against active actors
        -> FUN_0040ea60  // payload-bearing cmd13 contact report
        -> FUN_0043b5e0 / FUN_0043b7b0  // contact sound
        -> writes _DAT_004f203a/_3e/_42 + _DAT_004f2046
           -> FUN_0042c830 consumes those globals as a short-lived rebound / slide impulse
```

`FUN_004408f0` contact test:

- iterates active actor slots
- checks 2D radius overlap using actor center/radius
- checks Z overlap using both actors' height bounds
- returns the contacted actor struct when both conditions hold

`FUN_0042c830` response behavior:

- reads the temporary vector written by `FUN_00448b50`
- applies it only while `timeGetTime() < _DAT_004f2046`
- accumulates the result into the local movement delta fields
- behaves like a short bump / rebound / slide response rather than a damage routine

2026-04-18 follow-up on the same branch:

- `FUN_00448d80` calls `FUN_00448b50` **before** the rest of its terrain / landing resolution, and when that contact helper returns non-zero the function skips the ordinary ground-contact branch for that tick.
- `FUN_00448b50` only emits the packet when `param_1 == 0`, i.e. the local actor path; remote actors do not independently send this report.
- `FUN_0040ea60` chooses between two response-vector banks based on the local airborne flag:
  - grounded: `DAT_004f1d9e / DAT_004f1da2 / DAT_004f1da6`
  - airborne/jump: `DAT_004f1daa / DAT_004f1dae / DAT_004f1db2`
- that makes the combat `cmd13` payload look more like a compact **contact response / rebound vector report** than an inline damage event.

Follow-up airborne-state check:

- `FUN_00449c60` (called from `FUN_00448d80` and `Combat_Cmd70_ActorAnimState_v123` subcommand `6`) only:
  - checks an airborne/falling state,
  - integrates a vertical response term into `*(param_1 + 0x82)`,
  - sets bit `0x08` in `*(param_1 + 0xdc)`,
  - and returns.
- `Combat_Cmd70_ActorAnimState_v123` subcommands now read more concretely:
  - `0` → generic stand / resume helper family (`FUN_0043b440`, with state-specific wrappers)
  - `1` → explicit fall animation helper (`FUN_0043b470`)
  - `4`, `6`, `8` → airborne / collapse / landing-style transitions that call helpers such as `FUN_0043b3e0`, `FUN_0043b400`, `FUN_0043b4a0`, and `FUN_00419100`
- Current implementation impact: the client still appears to rely on server `Cmd70` for non-death falls. Our server already tracks LL/RL internal depletion via `Cmd66`/`Cmd67` state, but live play keeps leg-destroyed mechs upright because current server code only emits `Cmd70` on death/collapse and `isActorDestroyed(...)` only treats center-torso or head loss as fatal.
- This branch still does **not** enter `Combat_ApplyDamageCodeValue_v123`; so even the jump/landing-specific animation path currently looks like state sync + impulse + audio, not client-local DFA/collision damage.

**Most important negative result:** this ordinary collision/contact branch still does **not** call the real damage applicators:

- `Combat_ApplyDamagePairOrQueueEffect_v123` (`0040de90`)
- `Combat_ApplyDamageCodeValue_v123` (`0040e100`)
- `Combat_UpdateCriticalDamageState_v123` (`0042bd90`)

The only non-packet caller now confirmed for `Combat_ApplyDamageCodeValue_v123` is the projectile/effect path:

```text
FUN_004409f0 -> FUN_00440c50 -> FUN_00441130 -> Combat_ApplyDamageCodeValue_v123
```

Effect / allocator follow-up:

- `Combat_AllocateProjectileEffect_v123` (`0x00427400`) is only called by:
  - `Combat_Cmd68_SpawnWeaponEffect_v123`
  - `Combat_InputActionDispatch_v123`
  - `Combat_FireSelectedTicGroup_v123`
- `FUN_00424120` (the local immediate-impact helper for non-allocated / instant-hit weapon paths) is only called by:
  - `Combat_InputActionDispatch_v123`
  - `Combat_FireSelectedTicGroup_v123`
- `FUN_00449480` (local `cmd10` shot-geometry writer) is likewise only called by:
  - `Combat_InputActionDispatch_v123`
  - `Combat_FireSelectedTicGroup_v123`
- `FUN_00424120` can produce local impact FX + sound with no damage application when there is no valid actor / attachment target, but it still does **not** call `Combat_ApplyDamageCodeValue_v123`.
- So far, the client's named damage-carrying effect machinery is still weapon-fire-specific, not collision-specific.

So far, static RE supports:

- **yes:** ordinary mech bumping/contact, impact sound, effect/report packet, and rebound response
- **not yet found:** a client-local damage rule for ordinary mech-to-mech collision
- **still open:** whether DFA / ram-style damage is server-decided from `cmd13`, or lives in a distinct branch not yet identified

`Combat_Cmd72_InitLocalActor_v123` field flow:

```c
scenarioTitle = Frame_ReadString();      // copied to DAT_004ee830, max 159 bytes
localSlot     = Frame_ReadByte();        // DAT_00478d98[localSlot] = 0
unknownByte0  = Frame_ReadByte();        // consumed, currently unused
terrainId     = Frame_ReadByte();        // later passed to Combat_SelectTerrainFileSet_v123

// Combat_ReadTerrainPointList_v123
terrainResourceId = Frame_ReadType(2);
terrainPointCount = Frame_ReadByte();
repeat terrainPointCount {
  pointX = Frame_ReadType(3) - 0x18e4258;
  pointY = Frame_ReadType(3) - 0x18e4258;
  pointZ = Frame_ReadType(2);
}

// Combat_ReadArenaPointList_v123
arenaPointCount = Frame_ReadByte();
repeat min(arenaPointCount, 10) {
  arenaPointX = Frame_ReadType(3) - 0x18e4258;
  arenaPointY = Frame_ReadType(3) - 0x18e4258;
}
repeat remaining arena points { Frame_ReadType(3); Frame_ReadType(3); } // consumed/discarded

globalA       = Frame_ReadType(2);
globalB       = Frame_ReadType(2);
globalC       = Frame_ReadType(2);
headingBias   = Frame_ReadType(1) - 0x0e1c;   // better current label: heat-bias seed (DAT_004f4210), not jump height
identity0     = Frame_ReadString();      // max 11 bytes; trailing digits parsed into DAT_004f1ff6
identity1     = Frame_ReadString();      // max 31 bytes
identity2     = Frame_ReadString();      // max 39 bytes
identity3     = Frame_ReadString();      // max 15 bytes
identity4     = Frame_ReadString();      // max 31 bytes
statusByte    = Frame_ReadByte();
initialX      = Frame_ReadType(3) - 0x18e4258;
initialY      = Frame_ReadType(3) - 0x18e4258;
boundsFlag    = Frame_ReadByte();
if (boundsFlag != 0) {
  boundsX = Frame_ReadType(3) - 0x18e4258;
  boundsY = Frame_ReadType(3) - 0x18e4258;
}
extraType2Count = Frame_ReadByte();
repeat extraType2Count { Frame_ReadType(2); } // consumed, currently unlabeled
remainingActorCount = Frame_ReadByte();       // if zero, DAT_0047ef60 |= 4
unknownType1        = Frame_ReadType(1);
Combat_ReadLocalActorMechState_v123(localActor);
```

`Combat_ReadLocalActorMechState_v123` then appends the local player's mech-specific state:

```c
mechId = Frame_ReadType(2);              // loads mechdata\<variant>.MEC
if (crit_state_extra_count >= -20 && crit_state_extra_count != -21) {
  repeat 0x15 + crit_state_extra_count { criticalStateByte = Frame_ReadByte(); }
}
extraStateCount = Frame_ReadByte();
repeat extraStateCount { extraStateByte = Frame_ReadByte(); }
repeat 11 { armorLikeStateByte = Frame_ReadByte(); }
repeat 8  { internalStateByte = Frame_ReadByte(); }
ammoStateCount = Frame_ReadByte();
repeat ammoStateCount { ammoStateValue = Frame_ReadType(1); }
actorDisplayName = Frame_ReadString();   // max 31 bytes
```

The static initializer `Combat_InitDamageStateFromMec_v123` copies the `.MEC` maxima into the actor state before those server-supplied bytes arrive: 11 values from `.MEC` offsets `0x1a..0x2e`, one zeroed weapon damage state per weapon, critical-slot defaults from the `.MEC` table at `0xde`, ammo-bin caps from `.MEC` ammo types, and 8 internal-structure maxima from `Combat_GetInternalStructureForSection_v123`. This means a minimal `Cmd72` builder should not omit the variable-length local damage block; it seeds the same state that later `Cmd66`/`Cmd67` mutate.

`FUN_0040d830` field transforms:

```c
slot     = Frame_ReadByte();       // FUN_00401a60(), maps via DAT_00478d98[slot]
x        = Frame_ReadType(3) - 0x18e4258;
y        = Frame_ReadType(3) - 0x18e4258;
z        = Frame_ReadType(2);
facing   = (Frame_ReadType(1) - 0x0dc2) * 0xb6; // target DAT_004f1d5c; client sends (facing - 0x3ffc) / 0xb6 + 0x0e1c
throttle = (0x0e1c - Frame_ReadType(1)) * 0xb6; // target DAT_004f1f7c; sign-inverted relative to cmd9 client send
legVel   = (Frame_ReadType(1) - 0x0e1c) * 0xb6; // target DAT_004f1f7a
speedMag = Frame_ReadType(1) - 0x0e1c;          // DAT_004f20a2 and DAT_004f1d9e
```

Dynamic capture is still needed for signed direction conventions, but the four trailing `type1` fields are no longer generic: the client derives interpolation deltas toward the decoded facing/throttle/leg targets and `FUN_004488e0` applies them into `DAT_004f1d5c`, `DAT_004f1f7c`, and `DAT_004f1f7a`, while `FUN_0042c830` consumes the `DAT_004f20a2`/`DAT_004f1d9e` forward/speed magnitude term. This is no longer an unknown server→client packet family: cmd 65 is the combat position/motion update that complements the client→server cmd 8/9 movement packets in §19.2.

Live RE/capture correlation from 2026-04-17 adds one practical animation rule: `Combat_Cmd65_UpdateActorPosition_v123` also uses `abs(speedMag)` to decide whether a remote actor stays in idle or enters a moving gait. When the mirrored `Cmd65` keeps updating `x/y` but sends neutral `speedMag` (`0x0e1c` on the wire, decoded to `0`), the mech can visibly slide across the arena without walk/run animation. Remote coasting updates therefore need to preserve the client's current nonzero `speedMag` until a true stop frame arrives.

Implementation impact: a minimal combat prototype likely needs the `MMC` welcome/state handoff, then `Cmd72` to seed the local player, `Cmd64` for remote actors/bots, and periodic `Cmd65` actor position updates. `Cmd68`, `Cmd66`/`Cmd67`, and `Cmd70` are the current strongest server-response chain for firing, projectile effects, damage-state updates, and destruction/animation states.

Jump-jet caveat from the 2026-04-17 live pass: this does **not** mean the server should continuously drive the **local** actor's airborne path with synthetic slot-0 `Cmd65` ascent/descent steps. Current evidence points to `Cmd65` being appropriate for remote actor sync and landing/state confirmation, while the local client keeps ownership of jump duration after `cmd12/action 4`.

`Combat_Cmd68_SpawnWeaponEffect_v123` field flow:

```c
sourceActor = DAT_00478d98[Frame_ReadByte()];
weaponSlot  = Frame_ReadByte();

targetRaw   = Frame_ReadByte();
targetActor = targetRaw - 1;
if (targetActor == 9) {
  targetActor = 0;                       // special local-actor encoding
} else if (targetActor != -1) {
  targetActor = DAT_00478d98[targetActor];
}

targetAttach = Frame_ReadByte() - 1;
angleSeedA   = Frame_ReadType(1);        // transformed before helper call; helper recomputes angles from source/target geometry
angleSeedB   = Frame_ReadType(1);
impactX      = Frame_ReadType(3) - 0x18e4258;
impactY      = Frame_ReadType(3) - 0x18e4258;
impactZ      = Frame_ReadType(2);
```

Helper chain:

| Helper | Current read |
|--------|--------------|
| `Combat_CalcProjectilePath_v123` (`0x00427300`) | Resolves the source weapon's muzzle position from the actor mech model, resolves a target attachment if present, otherwise preserves the server-provided impact coordinates, then calls the angle calculator. |
| `Combat_CalcProjectileAngles_v123` (`0x004271d0`) | Calculates pitch and bearing from source position to target/impact position. |
| `Combat_CalcProjectileDistance_v123` (`0x004272c0`) | Computes source-to-impact distance when the projectile flags indicate a ranged path. |
| `Combat_AllocateProjectileEffect_v123` (`0x00427400`) | Allocates a projectile/effect object from `DAT_0047eb10`, stamps source/target actors, weapon slot, angles, coordinates, timing, effect class, and target impact metadata. |
| `Combat_GetLastProjectileEffectId_v123` (`0x004276e0`) | Returns `DAT_004da2dc`, the projectile/effect slot selected by the allocator. |

`Cmd66` / `Cmd67` damage-state update flow:

```c
// Cmd66 / wire 0x67
actorSlot   = Frame_ReadByte();
actorIndex  = DAT_00478d98[actorSlot];
damageCode  = Frame_ReadByte();
damageValue = Frame_ReadByte();
Combat_ApplyDamagePairOrQueueEffect_v123(actorIndex, actorStruct);

// Cmd67 / wire 0x68
damageCode  = Frame_ReadByte();
damageValue = Frame_ReadByte();
Combat_ApplyDamagePairOrQueueEffect_v123(0, localActorStruct);
```

The shared helper first checks whether the current projectile/effect id in `DAT_00478df8` is active, owned by the target actor, and has fewer than `0x14` queued pairs. If so, `Combat_QueueProjectileDamagePair_v123` (`0x004276a0`) appends the `(damageCode, damageValue)` pair to the effect object's small pair arrays. Otherwise it applies the pair directly through `Combat_ApplyDamageCodeValue_v123` (`0x0040e100`). Local-actor damage also triggers HUD/audio feedback through `FUN_004461c0(7)` and `FUN_00422260(DAT_00478dfc, 100)`.

`Combat_ClassifyDamageCode_v123` (`0x00407bc0`) partitions the `damageCode` byte relative to the loaded `.MEC` struct:

| Class | Code range / basis | Current read |
|-------|--------------------|--------------|
| `0` | `0x00..0x14`, plus `0x28 + weaponCount .. 0x27 + weaponCount + crit_state_extra_count` | Critical/system/mech state update through `Combat_UpdateCriticalDamageState_v123` (`0x0042bd90`). The early range indexes the `.MEC` critical-slot table at `0xde + index*2`; the post-weapon range is bounded by the signed field at `.MEC` offset `0x3c`. |
| `1` | `0x15..0x1f` | `.MEC` offset-backed section state under the actor struct near offset `0x28`. Indexes map to `.MEC` offsets `0x1a..0x2e`; the first ten match the documented armor fields, while index 10 uses the v1.23 speed parameter at `0x2e`, so it should not be called head armor. The client keeps the lower value when a new value is smaller. |
| `2` | `0x20..0x27` | Internal-structure state under the actor struct near offset `0xe8`; indexes are written in direct section-id order `[LA, RA, LT, RT, CT, LL, RL, Head]`. It can trigger local critical/death flags and visual hit feedback, but the recovered explicit post-apply zero check is `+0xec/+0xee` = **LT/RT torso slots**, not the real leg slots at `+0xf2/+0xf4`. |
| `3` | `0x28..0x28 + weaponCount - 1` | Weapon damage/state update through `Combat_UpdateWeaponDamageState_v123` (`0x0042bd10`) and local weapon/TIC HUD refresh. v1.23 weapon ids start at `.MEC` offset `0x3e`, not `0x3c`. |
| `4` | `0x28 + weaponCount + crit_state_extra_count .. total-1` | Ammo-bin update through `Combat_UpdateAmmoBinState_v123` (`0x0042c020`); local refresh also updates weapons using the same ammo type. The total upper bound is `weaponCount + crit_state_extra_count + 0x28 + ammo_bin_count`. |

The exact labels for the early code ranges still need correlation against `.MEC` fields and live hit capture, but cmd 66/67 are now the first strong server→client damage-result packet path. `Cmd68` makes clients see the shot/effect, `Cmd66`/`Cmd67` carry the damage code/value pairs, and `Cmd70` covers actor animation/status transitions such as stand/fall/jump/destruction-style state changes without itself carrying damage numbers.

2026-04-18 fall-specific follow-up on class `2` and the true leg path:

- `Combat_ApplyDamageCodeValue_v123` writes class-2 values to `actor + 0xe8 + index*2`.
- After a **local** update, it explicitly checks `*(short *)(actor + 0xec) == 0 || *(short *)(actor + 0xee) == 0`.
- Those offsets are now reconciled as **LT/RT torso slots**, not legs.
- The resulting side effects are `DAT_004f2094 = 1`, `FUN_0042d150(localActor, 0)`, and `FUN_004262d0(0)`.
- `FUN_0042d150` recalculates runtime rate/movement fields from the mech's base speed and explicitly keys one branch off torso internals `actor + 0x212/+0x214`, so this path currently reads as movement-limit/rate recomputation rather than a proven fall helper.
- The strongest recovered **leg-specific** client path is instead critical types `8..0xf` in `Combat_UpdateCriticalDamageState_v123`; those are the leg-actuator crits, and they all funnel into the same `FUN_0042d150` movement-limit helper.
- Retail visible fall/recovery state still sits on the separate `Cmd70` sequence: `4` airborne, `8` immediate/deferred collapse, `6` landing resolution.
- Server implication: `mpbt-server` now mirrors the minimum retail-fall experiment by sending class-2 internal updates, head criticals, conservative leg-actuator critical updates on first leg destruction, and a non-death `Cmd70/8` collapse transition. It still does **not** emit `Cmd73` rate-field packets or handle stand-up / `cmd12 action 0x15`, so recovery fidelity remains the next open slice.

---

### §19.7 — v1.23 IS.MAP / SOLARIS.MAP Binary Format (CONFIRMED)

Both map files share the same binary layout (confirmed from `MPBTWIN.EXE` v1.23 loader).

**File header (2 bytes):**
```
Offset  Size  Field
──────  ────  ──────────────────────────────────────────
 0      2     record_count   uint16 LE
```

**Per-record layout (fixed prefix, then variable-length strings):**
```
Offset  Size  Field
──────  ────  ──────────────────────────────────────────
 0      2     room_id        uint16 LE
 2      2     faction        uint16 LE  (house allegiance)
 4      2     raw_x          int16 LE   (map coordinate)
 6      2     raw_y          int16 LE
 8      2     field_8        uint16 LE  (flags / type)
10      2     field_a        uint16 LE
12      2     field_c        uint16 LE
14      2     field_e        uint16 LE
16      1     name_len       uint8      (length of following name string)
17      name_len  name       char[]     (room name, no NUL terminator)
17+name_len  1  desc_len    uint8
18+name_len  desc_len  desc char[]     (room description)
```
Total fixed bytes per record before strings: 18.

**Display coordinate transform:**

| Map | X display | Y display |
|-----|-----------|-----------|
| IS.MAP | `raw_x / 3 + 380` | `raw_y / −3 + 248` |
| SOLARIS.MAP | `raw_x + 184` | `raw_y` (identity) |

---

### §19.8 — v1.23 Function Address Reference

Key `MPBTWIN.EXE` v1.23 function addresses discovered this RE session:

| Address | Name / Purpose |
|---------|---------------|
| `0x00401470` | `Frame_WriteType(n_words, val)` — base-85 multi-word field encoder |
| `0x00401b50` | Write `param+0x21` to outbuf |
| `0x00401b70` | Write `param+0x21` to outbuf (identical twin) |
| `0x00401b90` | Outbuf init — writes `ESC '!'` at buffer start |
| `0x00401bc0` | Combat text write — `len+0x21` byte + raw ASCII (max 84 chars) |
| `0x00401c20` | `Frame_WriteString` — length-prefixed base-85 string writer |

| `0x00407ba0` | `Combat_GetDamageCodeUpperBound_v123`: total upper bound for classifying weapon/critical/ammo damage-code ranges |
| `0x00407bc0` | `Combat_ClassifyDamageCode_v123`: partitions cmd-66/67 `damageCode` bytes into critical/system, armor-like, internal-like, weapon, and ammo-bin classes |
| `0x0040b700` | Scancode → action-index lookup |
| `0x0040d050` | Third velocity accumulator → `DAT_004f1d5c` |
| `0x0040d270` | Leg velocity accumulator → `DAT_004f1f7a` (±8190) |
| `0x0040d2d0` | Throttle velocity accumulator → `DAT_004f1f7c` (±8190) |
| `0x0040dca0` | **Movement packet builder** (100 ms timer, cmd 8/9) |

| `0x0040de50` | `Combat_Cmd66_ActorDamageUpdate_v123`: server cmd-66 actor damage code/value update |
| `0x0040de80` | `Combat_Cmd67_LocalDamageUpdate_v123`: server cmd-67 local-actor damage code/value update |
| `0x0040de90` | `Combat_ApplyDamagePairOrQueueEffect_v123`: shared cmd-66/67 damage helper; queues onto current projectile/effect or applies immediately |
| `0x0040e100` | `Combat_ApplyDamageCodeValue_v123`: applies classified damage code/value to actor mech state |
| `0x0040e2f0` | `Combat_Cmd73_UpdateActorRateFields_v123`: actor rate/bias-field update; exact meaning pending |
| `0x0040e230` | `Combat_WriteCmd10ShotGeometry_v123`: client cmd-10 shot geometry write helper; no local flush |
| `0x0040e570` | `Combat_Cmd69_ImpactEffectAtCoord_v123`: impact/effect-at-coordinate feedback |
| `0x0040eae0` | `Combat_Cmd71_ResetEffectState_v123`: clears current projectile/effect globals |
| `0x0040eb20` | `Combat_SendCmd12Action_v123`: generic client cmd-12 action sender |
| `0x0040eb40` | **ACK stub** — returns 0, no-op |
| `0x00401a70` | Append CRC to outbuf |
| `0x00422aa0` | Momentum / jump-jet input processor |
| `0x00422c50` | `Combat_JumpJetInputTick_v123`: jump jet firing handler; calls `Combat_SendCmd12Action_v123('\x04')` |
| `0x004231c0` | `Combat_InputActionDispatch_v123`: combat UI/input action dispatcher; sends cmd-12 action `0` for weapon fire |
| `0x00423f10` | `Combat_FireSelectedTicGroup_v123`: local TIC group fire/effect path |
| `0x00424c70` | `Combat_SelectWeaponSlot_v123`: selected weapon slot/HUD highlighter |
| `0x004271d0` | `Combat_CalcProjectileAngles_v123`: pitch/bearing from source to target/impact |
| `0x004272c0` | `Combat_CalcProjectileDistance_v123`: source-to-impact distance |
| `0x00427300` | `Combat_CalcProjectilePath_v123`: source muzzle + target attachment/fallback impact resolver |
| `0x00427400` | `Combat_AllocateProjectileEffect_v123`: projectile/effect object allocator |
| `0x00427650` | `Combat_CanQueueProjectileDamagePair_v123`: validates whether a cmd-66/67 damage pair can attach to the current projectile/effect |
| `0x004276a0` | `Combat_QueueProjectileDamagePair_v123`: appends a damage code/value pair to the current projectile/effect object |
| `0x004276e0` | `Combat_GetLastProjectileEffectId_v123`: returns last projectile/effect slot id |
| `0x0042bd10` | `Combat_UpdateWeaponDamageState_v123`: applies weapon-slot damage state and refreshes local weapon/TIC HUD |
| `0x0042bd90` | `Combat_UpdateCriticalDamageState_v123`: applies critical/system/mech damage state and side effects |
| `0x0042c020` | `Combat_UpdateAmmoBinState_v123`: applies ammo-bin damage state and refreshes local weapons using that ammo type |
| `0x00433910` | `Combat_InitActorRuntimeFromMec_v123`: initializes actor runtime fields from the loaded `.MEC` |
| `0x00433b50` | `Combat_InitDamageStateFromMec_v123`: initializes armor-like, weapon, critical, ammo, and internal-state maxima from `.MEC` |
| `0x00433c70` | `Combat_GetInternalStructureForSection_v123`: tonnage-table lookup for internal structure by section; head returns 9 |
| `0x00433d10` | `.MEC` file loader (`mechdata\*.MEC`) |
| `0x00434350` | WndProc / main window message handler |
| `0x00435c10` | TCP flush thunk — CRC + `SendTCPData` + buffer reset |
| `0x00440270` | `Combat_SelectTerrainFileSet_v123`: selects `terrain\ter_%03d.{bin,dat,pal}` from the cmd-72 terrain id |
| `0x00440ff0` | `Combat_ReadTerrainPointList_v123`: reads cmd-72 terrain resource id plus x/y/z point list |
| `0x00442870` | XOR decrypt loop (549 iterations) for `.MEC` |
| `0x004427f0` | Extract 4-char seed from `.MEC` filename stem |
| `0x004428a0` | LCG PRNG for `.MEC` XOR key: `s = s*0xf0f1+1; s += rotate16(s)` |
| `0x00445080` | `Combat_ReadArenaPointList_v123`: reads cmd-72 arena x/y point list, storing at most 10 entries |
| `0x004456c0` | `Combat_ReadLocalActorMechState_v123`: reads cmd-72 local mech id, initial damage-state blocks, ammo state, and actor display name |
| `0x00447e10` | HUD direction-indicator updater (NOT a network sender) |
| `0x00447f70` | Arrow-key throttle/turn dispatcher |
| `0x0042c7a0` | Rotation / heading calculator (fixed-point) |
| `0x0042dc30` | UI button key matcher (visual only) |
| `0x0042ec60` | F7/F8 vtable handler (`scene[0x50d]`) |
| `0x0042f7c0` | Combat scene allocator / init |
| `0x0043b110` | Connection context dirty-flag setter |
| `0x0043b3e0` | Connection context accessor (called from jump-jet handler) |
| `0x0043d500` | VK → scancode resolver |
| `0x0043d920` | Channel / mode command sender (RPS=0x42, Combat=0x35) |
| `0x0043eb10` | Text send (cmd 4): RPS vs combat encoding branch |

---

### §19.9 — v1.23 Cmd62 / Combat-Start Signal (`DAT_0047ef60`) (CONFIRMED)

**Confirmed by decompiling `FUN_0040d7f0` in `MPBTWIN.EXE` v1.23 via Ghidra (M6 RE, 2026-04-xx).**

#### Cmd62 — "All actors ready / combat start" (wire `0x5F`)

| Field | Value |
|-------|-------|
| Handler | `FUN_0040d7f0` @ `0x0040d7f0` |
| Wire byte | `0x5F` (= cmd 62 + `0x21`) |
| Payload | **None** — zero bytes read from packet buffer |

**Effect on `DAT_0047ef60`:**
```c
DAT_0047ef60 = (DAT_0047ef60 & 0xffffffdf) | 0x14;
_DAT_0047ef70 = 0;
```

- `& 0xffffffdf` = clear bit `0x20` — **unblocks SPACEBAR / weapon fire**
- `| 0x04` = set "all remote actors joined" flag
- `| 0x10` = set "combat active" flag
- `_DAT_0047ef70 = 0` = clear the expected-actor counter

Cmd62 **must** be sent after all Cmd64 (remote actor add) and initial Cmd65 (position sync)
packets. Without Cmd62, bit `0x20` of `DAT_0047ef60` remains set (written by `FUN_00445e70`
at combat init), and the client's weapon-fire input gate in `Combat_InputActionDispatch_v123`
(case `0x15`) is permanently blocked — SPACEBAR appears to do nothing.

#### `DAT_0047ef60` — Combat State Guard Flags (fully reconstructed)

| Bit | Mask | Meaning | Set by | Cleared by |
|-----|------|---------|--------|------------|
| 0 | `0x01` | Local actor initialized | `Cmd72` handler (`FUN_00445110`) | — |
| 1 | `0x02` | Arena scene/UI ready | `Cmd63` handler (`FUN_00445870`) | — |
| 2 | `0x04` | All remote actors joined | `Cmd72` (when `_DAT_0047ef70==0`); also `Cmd62` | — |
| 3 | `0x08` | Second stage init | `FUN_00445a90` | — |
| 4 | `0x10` | Combat active | `Cmd62` | `Combat_InitMode_v123` |
| 5 | `0x20` | **WEAPON FIRE BLOCKED** | `FUN_00445e70` (combat init) | **`Cmd62`** |
| 6 | `0x40` | — | — | `Combat_InitMode_v123` |

#### Secondary Combat Dispatch Table at `0x4784b0` (8 bytes/entry, base = Cmd59)

Confirmed by anchoring on `Combat_Cmd64_AddActor_v123` (`0x0040d390`) at index 5, then
back-computing the table base. Each entry is 8 bytes: 4-byte zero-padding + 4-byte function
pointer.

**Note:** This secondary table at `0x4784b0` handles the combat bootstrap/status cluster
(Cmd59–Cmd74) within the broader v1.23 combat dispatch table at `DAT_004782d8` (§19.6).

| Index | Cmd | Wire byte | Handler |
|-------|-----|-----------|---------|
| 0 | 59 | `0x5C` | `FUN_0040ec30` |
| 1 | 60 | `0x5D` | `FUN_0040ebc0` |
| 2 | 61 | `0x5E` | `FUN_0040eb50` |
| 3 | **62** | **`0x5F`** | **`FUN_0040d7f0`** — combat-start; clears `DAT_0047ef60` bit `0x20`; enables SPACEBAR |
| 4 | 63 | `0x60` | `FUN_00445870` — arena scene init; sets bit `0x02`; reads zero payload bytes |
| 5 | 64 | `0x61` | `Combat_Cmd64_AddActor_v123` (`0x0040d390`) |
| 6 | 65 | `0x62` | `Combat_Cmd65_UpdateActorPosition_v123` (`0x0040d830`) |
| 7 | 66 | `0x63` | `FUN_0040de50` — remote actor damage (see §19.6.1) |
| 8 | 67 | `0x64` | `FUN_0040de80` — local actor damage |
| 9 | 68 | `0x65` | `FUN_0040e390` — projectile/effect spawn |
| 10 | 69 | `0x66` | `FUN_0040e570` — impact effect at coordinate |
| 11 | 70 | `0x67` | `FUN_0040e700` — actor animation/status transition |
| 12 | 71 | `0x68` | `FUN_0040eae0` — reset current projectile/effect state |
| 13 | **72** | **`0x69`** | **`FUN_00445110`** — local actor bootstrap (Cmd72) |
| 14 | 73 | `0x6A` | `FUN_0040e2f0` — actor rate/bias-field update |
| 15 | 74 | `0x6B` | `FUN_004459f0` |

#### Cmd63 (`FUN_00445870`) — Arena Scene Init (no payload)

- Wire byte: `0x60` (cmd 63 + `0x21`)
- **Reads zero bytes** from the packet buffer
- Guard: if `DAT_0047ef60 & 0x02 != 0`, returns immediately (runs only once)
- Effect: sets `DAT_0047ef60 |= 0x02` (arena scene ready flag)
- Must be received before Cmd62 executes its `| 0x14` write

#### Ally Mode — ENTER Target Cycling

Earlier RE notes suggested ENTER target cycling required "ally mode" to be active via
pressing `=` twice after entering combat. Live GUI validation on 2026-04-11 contradicted
that for the current prototype/bootstrap path: the opponent became visible and plain
`ENTER` could target it immediately, while `=` was bound to the tactical overhead map.

Treat the older ally-mode inference as unresolved and lower-confidence until it is
reproduced against a more faithful bootstrap or a fresh static trace of the targeting
input path.

Current live behavior to trust for M6 testing:
- If the remote bot actor is visible, `ENTER` can target it directly.
- `=` should not currently be relied on as a prerequisite targeting toggle.

#### Complete Confirmed Combat Bootstrap Sequence

```
Step 1: Cmd72 (wire 0x69) — local mech init
        Slot 0 = player identity + selected mech
        Payload: scenario/title, terrain point lists, identity strings,
                 initial coordinates, mech id, initial local damage-state blocks
        Effect: DAT_0047ef60 |= 0x01 (local actor initialized)

Step 2: Cmd64 (wire 0x61) — add remote bot actor
        Slot 1 = "Opponent/Opponent"
        Loads bot mech .MEC data and identity strings

Step 3: Cmd65 (wire 0x62) — player initial position
        Slot 0 at world coords x=0, y=0, z=0 (origin)

Step 4: Cmd65 (wire 0x62) — bot initial position
        Slot 1 at x=0, y=0, z=300000
        (~300 m out from origin, clear of the center arena building)

Step 5: Cmd62 (wire 0x5F) — combat start (NO PAYLOAD)
        Clears DAT_0047ef60 bit 0x20 → enables SPACEBAR weapon fire
        Sets bits 0x04 and 0x10; resets _DAT_0047ef70

Step 6: Cmd65 timer (every 1000 ms) — keep bot position fresh
        Slot 1, same coordinates, prevents client interpolation drift
```

#### Coordinate Encoding

- `COORD_BIAS = 0x18e4258` is added to all type3 world coordinates in Cmd65/Cmd72 payloads
- Earlier `z=300000` bot-spawn notes in this section are stale. The later confirmed bot-spawn path uses `y=BOT_SPAWN_DISTANCE`, while the `Cmd65` handler work still points to the **third** coordinate field as airborne altitude.
- Treat `x/y` as the arena ground plane and `z` as the current best-confirmed altitude field for `Cmd65`.

---

### §19.10 — T.O.F.S. (The Tram) / Monorail System (CONFIRMED — SAME AS STANDARD TRAVEL)

The T.O.F.S. (TOFS Monorail Subway System) is the in-universe cross-sector rapid-transit
system on Solaris VII.  RE of the v1.23 client binary and the `SOLARIS.HLP` / `BT-MAN`
documentation resolves the tram's protocol mechanism.

**In-game description (from documentation):**
- Full name: **T.O.F.S. (The Tram)** / **TOFS Monorail Subway System** (as indexed in
  `SOLARIS.HLP`)
- Accessed via the **Travel Button** scene action (`actionType 4`, same as regular
  Solaris travel)
- The `SOLARIS.HLP` "Destination Database" index lists all 26 venue rooms *and* all 6
  sector common areas (rooms 1–6) as tram destinations — the tram gives access to the
  full Solaris city grid, not just a subset of sector hubs

**Wire protocol (confirmed by static RE of `MPBTWIN.EXE` v1.23):**

The tram uses the **identical** `cmd5 actionType 4 → Cmd43 → cmd10` travel flow as
regular Solaris map travel.  There is no tram-specific command or context value:

1. `World_HandleMapOpenSolarisPacket_v123` (`FUN_00420A40`, cmd 43, wire `0x4C`) contains
   only **one** context-specific branch: `if (contextId == 0xc6)`.  All other context
   values produce a map with null button labels — no tram-specific context ID exists.
2. No entry in the v1.23 world dispatch table (`DAT_00478070`, 77 entries, cmds 0–76)
   corresponds to a tram-only command.
3. The `MPBT.MSG` string table has no dedicated tram string; `MSG[0x131]` = `"Travel"`
   is the only relevant string (used for the "Travel" button label when `contextId == 0xc6`).

Additional RE detail: the incoming map-open packet leads into the dedicated map
window builder (`FUN_00420690`), which then calls the Solaris/IS map-specific
UI builders (`FUN_0041f7d0` / `FUN_0041f350`). Those builders call
`FUN_0041fa30`, which is the proven local renderer for the selected room's
`SOLARIS.MAP` / `IS.MAP` name and description text.

**Cmd43 packet structure (for reference):**

```
Cmd43 (wire 0x4C) → World_HandleMapOpenSolarisPacket_v123:
  [type1  contextId]        0xc6 for Solaris travel (only branch that sets button labels)
  [type1  currentRoomId+1]  1-based room ID of the player's current location
  [type1 × 26]              per-room occupant counters for venue rooms 146–171
```

The server differentiates tram-station access from regular-travel access purely by
session context (which room the player is in) — the client wire format is the same.

**Ghidra rename performed:** `FUN_00420A40` → `World_HandleMapOpenSolarisPacket_v123`

**Sector room IDs (from `SOLARIS.MAP` parse, used as tram transit hubs):**

| Room ID | Sector Name | Flags |
|---------|-------------|-------|
| 1 | International Sector | `0x0000` |
| 2 | Kobe Sector | `0x0101` |
| 3 | Silesia Sector | `0x0202` |
| 4 | Montenegro Sector | `0x0303` |
| 5 | Cathay Sector | `0x0504` |
| 6 | Black Hills Sector | `0x0405` |

**Conclusion:** No separate tram implementation is needed in the server.  The existing
`sendSolarisTravelMap` path (Cmd43, `contextId = 0xc6`) already covers all tram
destinations.  Issue #70 is resolved.

---

## 22. Windowed Mode — DirectDraw Rendering Architecture

This section documents the game's DirectDraw rendering pipeline as discovered through
static analysis of `MPBTWIN.EXE` v1.23, performed in the context of diagnosing and
fixing the black-screen bug in the windowed-mode DirectDraw shim (`ddraw.dll`).

---

### §22.1 — Overview

The game uses a **software rendering architecture**: all pixel data is written by the
CPU to raw memory buffers, and DirectDraw is used only to allocate those buffers (via
`CreateSurface` + `Lock`) and to present the final frame to the primary surface
(via `BltFast` or `Blt`).

DirectDraw is never used for hardware-accelerated blitting between offscreen surfaces
— all sprite composition is done via `memcpy`-style loops directly on raw pixel bytes.
This means a windowed-mode shim that replaces DirectDraw surfaces with GDI DIBs will
work correctly only if it does NOT involve GDI for surface-to-surface copies.

---

### §22.2 — Game Internal Surface Struct

The game wraps each DirectDraw surface in its own internal struct. The pixel descriptor
sub-struct (allocated at `piVar4[0x13]` inside the main surface struct) has this layout:

```
Offset  Size  Field
──────  ────  ──────────────────────────────────────────────────────────────────
+0x00   4     void* pixels      ← raw pixel pointer from Lock lpSurface
+0x04   4     int   pitch       ← lPitch from Lock (game stores pitch-1 at +4,
                                  and width-1 at +4; exact interpretation depends
                                  on caller — treat as stride in bytes)
+0x08   4     int   height-1    ← surface height minus 1
+0x0C   4     (reserved zero)
+0x10   4     (reserved zero)
+0x14   4     IDirectDrawSurface*  ← surface pointer from CreateSurface
```

The outer game surface struct (0x1484 bytes, allocated by `FUN_0042f7c0`) stores a
pointer to the pixel descriptor at offset `[0x13]` (i.e. `piVar4[0x4c]` in 32-bit
pointer arithmetic since indices scale by 4).

---

### §22.3 — Key Functions

#### `FUN_0042f420` — Main render context initializer

```c
DAT_0047a378 = FUN_0042f7c0(0, 0, 0x280, 0x1e0, 0);  // 640×480 game surface struct
DAT_0047a37c = DAT_0047a378;
DAT_004f66c4 = *(int*)DAT_0047a378[0x13] + 0x2b2dc;    // HUD overlay pointer
```
Called once at startup to create the main 640×480 render surface.

---

#### `FUN_0042f7c0` — Game surface struct allocator

- Allocates `0x1484` bytes via `FUN_0046c620(0x1484)`, zeroed
- Records pointer in global table at `(&DAT_004f5bf0)[iVar8]`;
  increments counter `DAT_004f5c34`
- Stores `height` at `piVar4[4]`, `width` at `piVar4[5]`
- Allocates pixel descriptor sub-struct (`0x18` bytes) at `piVar4[0x13]`:
  - `*(+0x8)` = height−1
  - `*(+0x4)` = width−1
- Calls `FUN_00443e60(piVar4[0x13], piVar4[0x13]+4, width, height)` to create the
  actual DirectDraw surface and populate the pixel descriptor
- Returns `piVar4` — the game surface struct pointer

---

#### `FUN_00443e60` — DD surface creator + pixel-bits extractor

```
param_1 = output: pixel pointer (void*)
param_2 = output: pitch (int)
param_3 = width
param_4 = height
```

Sequence:
1. Builds `DDSURFACEDESC` with `dwSize=0x6c`, `dwFlags=0x1007`, 8bpp
   (`dwRGBBitCount=8`)
2. `(*DAT_004e0a40)->CreateSurface(desc, &surf_out, 0)` — IDirectDraw vtable +0x18
3. `surf_out->Lock(0, desc, 1, 0)` — IDirectDrawSurface vtable +0x64
4. Copies `lpSurface` → `*param_1`, `lPitch` → `*param_2`
5. `surf_out->Unlock(0)` — IDirectDrawSurface vtable +0x80
6. Returns `surf_out` (stored by caller at pixel descriptor `+0x14`)

**Key insight:** This function calls our shim's `Lock` to get `dib().bits` and stores
it as the game's raw pixel pointer. The game then writes all rendering directly to
that address. The DIB bits pointer IS the game's render target.

---

#### `FUN_00437f70` — Battle render buffer init

```c
DAT_004f0628 = &DAT_004ef6d0;   // battle render buffer = static pixel descriptor
```
`DAT_004ef6d0` is a separate pixel descriptor struct used for the battle/HUD
compositing pass.

---

#### `FUN_004439d0` — Full-screen colour fill

Called once per frame before rendering begins:
```c
// calls primary surface Blt with DDBLT_COLORFILL, src = NULL
(*DAT_0047a7ec)->Blt(&full_rect, NULL, NULL, 0x1000400, &fx_with_fill_color);
// rect = (0, 0, 0x27f, 0x1df) = 640×480
```
`DDBLT_COLORFILL = 0x400`. The `fx.dwFillColor` is the background fill index (8bpp
palette index). A shim that does not implement the `src=NULL` / `DDBLT_COLORFILL`
path will leave the primary surface filled with garbage from the previous frame.

---

#### `FUN_00430590` — Lobby render loop

1. Creates back-buffer via
   `FUN_00443e60(&DAT_004da2f0, &DAT_004da2f4, 0x280, 0x1e0)` →
   stored at `DAT_004da2f8`
2. Iterates all game surface structs in `DAT_004f5bf0[0..DAT_004f5c34]`
3. Calls `FUN_00453d07` to software-blit each sprite into the back-buffer
4. Calls `FUN_00443b30` → `primary->BltFast(DAT_0047a7ec, back_surf, &rect, …)` to
   present

---

#### `FUN_00453d07` — Software sprite blit

Pure CPU copy between two game pixel descriptor structs. No DirectDraw is involved.
Reads `pixels` pointer directly from the struct and uses `memcpy`/loop to copy rows.

---

#### `FUN_0040b040` — Terrain tile renderer

Raw pixel copy loop:
```c
src = *(param_2 + 0x18);            // tile data pointer from tile struct
dst = param_1[0] + computed_offset; // game pixel buffer base + offset
// inner loop: memcpy rows of tile pixels
```
All writes go directly to the raw pixel buffer; no DirectDraw calls.

---

### §22.4 — Key Globals (Rendering)

| Address | Suggested Name | Description |
|---------|---------------|-------------|
| `0x0047a378` | `g_renderMainCtx` | Main game surface struct ptr (640×480) |
| `0x0047a37c` | `g_renderMainCtxCopy` | Mirror of `g_renderMainCtx` |
| `0x004f0628` | `g_renderBattleBuf` | Battle render buffer ptr (= `&DAT_004ef6d0`) |
| `0x004ef6d0` | `g_battlePixDesc` | Battle pixel descriptor `{bits*, pitch, h-1, …, IDD*}` |
| `0x004da2f0` | `g_renderBackBits` | Back-buffer pixel pointer (from Lock in FUN_00443e60) |
| `0x004da2f4` | `g_renderBackPitch` | Back-buffer pitch (from Lock) |
| `0x004da2f8` | `g_renderBackSurf` | Back-buffer `IDirectDrawSurface*` |
| `0x0047a7ec` | `g_renderPrimary` | Primary display `IDirectDrawSurface*` |
| `0x0047a7e4` | `g_renderBltMode` | 0 = `BltFast`, non-zero = `Blt` with explicit rects |
| `0x004e0a40` | `g_ddObject` | `IDirectDraw*` main DirectDraw object |
| `0x004f5c34` | `g_surfaceCount` | Count of game surface structs allocated |
| `0x004f5bf0` | `g_surfaceTable` | Array of game surface struct ptrs |
| `0x004f66c4` | `g_hudOverlayPtr` | HUD/overlay pixel region (main ctx + 0x2b2dc) |
| `0x0047a7c8` | `g_renderFlags` | bit0=render enabled, bit1=quit |
| `0x0047d05c` | `g_gameState` | 0-2=no render, 3=lobby, 4=battle |
| `0x0047ef60` | `g_state4Guard` | bit0 must be set to enter combat render path |

---

### §22.5 — IDirectDrawSurface Vtable Offsets (observed)

These vtable byte-offsets were confirmed from the game's assembly and match a standard
`IDirectDrawSurface` COM vtable (IUnknown at 0/4/8, then DD methods):

| Byte offset | Method |
|------------|--------|
| `+0x18` | `IDirectDraw::CreateSurface` |
| `+0x64` | `IDirectDrawSurface::Lock` |
| `+0x80` | `IDirectDrawSurface::Unlock` |
| `+0x68` | `IDirectDrawSurface::BltFast` (inferred from §22.3 render loop) |
| `+0x14` | `IDirectDrawSurface::Blt` (inferred; `DDBLT_COLORFILL` path) |

---

### §22.6 — Black Screen Root Cause and Fix

**Root cause:**  
The game creates all offscreen surfaces at startup after the DirectDraw palette has
been created. In the windowed-mode shim (`ddraw.dll`), each `FakeSurface` is backed
by a GDI DIB section. When the shim's `Blt` / `BltFast` implementation used GDI's
`BitBlt(dst.hdc, …, src.hdc, …, SRCCOPY)` to copy between two 8bpp DIBs, GDI
performed **palette-indexed colour translation**: it read the source DIB's colour
table and matched each source palette index to the closest colour in the destination
palette.

The offscreen surface DIBs were created (via `CreateDIBSection`) after
`IDirectDrawPalette::SetEntries` had been called a second time with an all-zeros
palette (a "wipe" call that precedes the real palette load). Because `CreateDIBSection`
copies the current colour table into the DIB at creation time, the offscreen DIBs had
all-zero colour tables. GDI's 8bpp→8bpp `BitBlt` therefore mapped every source index
to `RGB(0,0,0)` — black — regardless of the actual pixel byte values.

The primary-surface DIB received the final correct palette (after the wipe), so its
colour table was valid. But by then all intermediate blits had already been colour-matched
against the zero table.

**Why the cursor was visible:**  
The cursor surface (address `0x04328368`, 1×12 pixels) was tiny and written via a
direct `Lock` call *after* the real palette was loaded, so its underlying DIB happened
to get created with a non-zero colour table — or its single non-zero pixel value
happened to survive the mapping.

**Fix — `FakeSurface::Blt` / `BltFast`:**  
Replace `BitBlt` with raw `memcpy` over the DIB bits arrays. For 8bpp surfaces the
pixel bytes are palette indices, not colours; no colour translation is desired. The
row-by-row `memcpy` copies raw index bytes without any GDI involvement:

```cpp
// 8bpp raw-copy path (replaces BitBlt)
if (g_bpp == 8 && fs->dib().bits && dib().bits) {
    BYTE* dstP = (BYTE*)dib().bits + dy * dib().pitch + dx;
    BYTE* srcP = (BYTE*)fs->dib().bits + sy * fs->dib().pitch + sx;
    int rowW = min(sw, dib().w - dx);
    for (int r = 0; r < sh && (dy+r) < dib().h; ++r) {
        memcpy(dstP, srcP, rowW);
        dstP += dib().pitch;
        srcP += fs->dib().pitch;
    }
}
```

**Fix — `DDBLT_COLORFILL` support:**  
`FUN_004439d0` calls `primary->Blt(…, NULL, NULL, DDBLT_COLORFILL, &fx)` once per
frame to clear the background. The original shim returned `S_OK` as a no-op when
`src == NULL`. The fix fills the destination rectangle with `fx.dwFillColor` using
`memset`:

```cpp
if (!src && fx && (flags & DDBLT_COLORFILL)) {
    BYTE col = (BYTE)fx->dwFillColor;
    for (int row = dy; row < dy + dh && row < dib().h; ++row)
        memset(b + row * dib().pitch + dx, col, dw);
    if (m_isPrimary) BlitToWindow();
    return S_OK;
}
```

Both fixes are implemented in `mpbt-launcher/native/ddraw.cpp` and deployed to
`client-1.23/ddraw.dll`.

---

### §22.7 — New Appendix A Entries (MPBTWIN.EXE v1.23)

The following functions and data labels were identified during the windowed-mode
rendering investigation and should be considered canonical names:

**Functions:**

| Suggested name | Address | Purpose |
|---------------|---------|---------|
| `Render_InitMainCtx` | `0x0042f420` | Creates 640×480 main render context at `g_renderMainCtx` |
| `Render_AllocSurfaceStruct` | `0x0042f7c0` | Allocates 0x1484-byte game surface struct; calls `Render_CreateSurface` |
| `Render_CreateSurface` | `0x00443e60` | Creates DD offscreen surface; stores `bits` at `*param_1`, `pitch` at `*param_2` |
| `Render_InitBattleBuffers` | `0x00437f70` | Sets `g_renderBattleBuf = &g_battlePixDesc` |
| `Render_LobbyFrame` | `0x00430590` | Lobby render loop: create back-buffer, blit sprites, present |
| `Render_SceneInit` | `0x00446060` | Full scene initializer: colour-fill, sprite init, lobby frame |
| `Render_ColorFill` | `0x004439d0` | Full-screen `DDBLT_COLORFILL` on `g_renderPrimary` |
| `Render_SpriteBlit` | `0x00453d07` | Software sprite blit between raw game pixel descriptors (no DD) |
| `Render_SurfFill` | `0x00453c28` | Fills a game pixel buffer with a constant byte value |
| `Render_TileDraw` | `0x0040b040` | Terrain tile renderer: raw pixel copy to game pixel buffer |
| `Render_MapDraw` | `0x00430730` | Terrain map: calls `Render_TileDraw` for each tile |

---

## 23. Combat Match-End State Machine — CONFIRMED (Issue #79)

**Confirmed by Ghidra decompilation of `FUN_00447170`, `FUN_0043d2a0`, `FUN_0040de90`, `FUN_00441130`, `FUN_0040b4a0`, `FUN_00448290`, and XREFs to `DAT_004ef174` / `DAT_004f56a8` / `DAT_004f2032` in `MPBTWIN.EXE` v1.23.**

---

### §23.1 — Finding: No Server-to-Client "Match-End" Packet

**The match-end transition is entirely client-driven.** There is no dedicated server→client combat command that signals "match over, show results screen." The client determines match outcome using its local combat simulation.

---

### §23.2 — Key State Variables

| Address | Name | Values |
|---------|------|--------|
| `DAT_004f56a8` | `g_roundState` | `1` = active combat, `2` = match ended (results loop) |
| `DAT_004f5690` | `g_combatMode`  | `3` = normal combat (set in `FUN_00446060` init) |
| `DAT_004ef174` | `g_inputFlags`  | Bitmask updated by keyboard/joystick input handlers |
| `DAT_004f4eb0` | `g_matchEndFlag`| Set to `1` when `g_roundState` transitions to `2` |
| `DAT_004f2032` | `g_actorDeadFlag[0]` | `!= 0` when the focused enemy actor is destroyed |
| `DAT_0047d05c` | `g_exitState`   | `3` = graceful exit, `4` = awaiting network disconnect |
| `DAT_004e16dc` | `g_disconnectTimer` | Timestamp: when < `DAT_0047ef50`, fires `FUN_0040b3d0` (TCP close) |

---

### §23.3 — Main Combat Update Loop (`FUN_00447170`)

Each render tick:
1. Calls `FUN_0042cf60(0)` — per-actor physics step (mech movement, projectile advance).
2. Calls `FUN_0043d2a0()` — processes input flags from `g_inputFlags`, may set `g_roundState = 2`.
3. Checks the focused actor (`DAT_004f54d8`):
   - **WIN path**: `g_actorDeadFlag[focused] != 0 && g_combatMode == 3`  
     → calls `FUN_00449330` (IS bar renderer) + `FUN_00438170` (results panel for enemy mech).  
     Sets `g_actorDeadFlag[focused] = 0` and `DAT_0047f118 = now + 50` (re-display timer).
   - **LOSS path** (via `g_roundState == 2`): calls same functions for local actor (actor 0).
     Sets `g_matchEndFlag = 1`.
4. Checks `g_disconnectTimer`: if non-zero and expired, calls `FUN_0040b3d0(DAT_0047ef5c)` to close TCP.

---

### §23.4 — Input-Flag Architecture (`FUN_0040b4a0`)

`FUN_0040b4a0(flagIndex, value)` is a generic bit-setter for `g_inputFlags` (`DAT_004ef174`).
Callers: `FUN_0043d500` (keyboard translator → calls after key decode), `FUN_0044bca0` (joystick).

Bit assignments (selected):

| Case | Bit | Notes |
|------|-----|-------|
| 1 | `0x0001` | — |
| 5 | `0x0010` | Throttle up |
| 6 | `0x0020` | Throttle down |
| 7 | `0x0040` | **Match-exit / result-screen trigger** |
| 0x34 | `0x10000` | — |
| 0x35 | `0x20000` | — |

`g_inputFlags & 0x40` (bit 7) is checked in `FUN_0043d2a0`:
- If `g_roundState == 1`: sets `g_matchEndFlag = 1`, `g_roundState = 2` → enters LOSS-style results screen (showing own mech damage).
- If `g_roundState == 2`: toggles back to `g_roundState = 1`.

This bit is set by the **key bound to action index 7** — likely the combat-exit key (Escape or F-key). It is **not** a network-delivered signal.

---

### §23.5 — WIN Path (Enemy Killed)

1. Player fires weapon; `buildCmd68ProjectileSpawnPacket` spawns projectile client-side.
2. `FUN_004409f0` (projectile collision loop, called each tick via `FUN_0042cf60`) detects hit on enemy actor.
3. `FUN_00441130(enemy_actor_ptr)` is called:
   - Sets `*(int*)(&DAT_004f2032 + actor_index * 0x49c) = 1` (marks actor dead).
   - If `actor_index == 0` (player's own mech): additionally calls `FUN_004461c0(7)` (disconnect timer, LOSS only).
4. `FUN_00447170` WIN branch detects `g_actorDeadFlag[focused] == 1`, shows mini-results panel in loop.
5. Player presses combat-exit key → `g_inputFlags & 0x40` set → `g_roundState = 2` → full results screen.
6. `FUN_0040de90(0)` (similar dead-actor handler) eventually triggers `FUN_004461c0(7)`.
7. `g_disconnectTimer` fires → `FUN_0040b3d0` → TCP close.

---

### §23.6 — LOSS Path (Player Killed by Bot)

1. Server sends `Cmd67` (`FUN_0040de80`) with `damageCode, damageValue` pair.
2. Cmd67 applies the IS damage to local actor (actor 0) IS component array.
3. When IS component 0 reaches 0, the client's local physics step (`FUN_0042bb00`) detects actor death.
4. `FUN_0040de90(0)` is called:
   - Sets `g_actorDeadFlag[0] = 1`.
   - Calls `FUN_004461c0(7)` — sets `g_disconnectTimer = now + 7` (if `g_exitState == 4`).
5. `g_roundState = 2` (set externally via `g_inputFlags` or results loop).
6. `g_disconnectTimer` fires → `FUN_0040b3d0` → TCP close.

**Note:** The death detection path requires `g_exitState == 4` (`DAT_0047d05c`) for the timer to fire.  
The precise conditions under which `g_exitState` transitions to `4` during a normal LOSS were not fully traced.  
Live packet capture is needed to confirm the exact IS component threshold and death sequence timing.

---

### §23.7 — Server Implementation Implications

- **No match-end packet to send.** The server does not need to signal match-end.
- **WIN** is triggered automatically by client local simulation when the bot (seeded via `Cmd64`) dies from player weapon fire. The server should only ensure the bot has correct IS/HP seeded (see Issue #80).
- **LOSS** is triggered when enough `Cmd67` damage drains an IS component on actor 0 to zero. Server should stop sending `Cmd67` once it estimates player HP is depleted.
- **Cleanup**: The client closes the TCP connection itself (via `FUN_0040b3d0`) after the results screen. Server handles cleanup in the TCP-close handler.

---

### §23.8 — Function Cross-Reference

| Function | Address | Role |
|----------|---------|------|
| `Combat_MainLoop` | `0x00447170` | Main combat update loop; 250+ lines |
| `Combat_InputHandler` | `0x0043d2a0` | Input flag dispatch; triggers `g_roundState = 2` |
| `Combat_ActorDeadFlag_Setter` | `0x0040de90` | Sets `g_actorDeadFlag`; triggers disconnect timer for actor 0 |
| `Combat_ProjectileHitHandler` | `0x00441130` | Called by projectile collision; marks actor dead |
| `Combat_ProjectileLoop` | `0x004409f0` | Iterates active projectiles; calls `FUN_00441130` on expiry |
| `Combat_InputFlagSet` | `0x0040b4a0` | Generic bit-setter for `g_inputFlags` |
| `Combat_KeyTranslator` | `0x0043d500` | Translates raw key scancode → flag index → `FUN_0040b4a0` |
| `Combat_TimerSet` | `0x004461c0` | Sets `g_disconnectTimer = now + N` (only if `g_exitState == 4`) |
| `Combat_Disconnect` | `FUN_0040b3d0` | Closes TCP connection (called when timer fires) |
| `Combat_ResultsPanel` | `0x00438170` | Renders the post-match results screen panel |
| `Combat_ISBarRender` | `0x00449330` | Renders IS component bars on results screen |
| `Combat_ActiveRound` | `0x004466c0` | Per-tick render: radar blips, range text, heading lines |
| `Combat_Init` | `0x00446060` | Combat init: sets `g_combatMode = 3`, `g_roundState = 1` |

---

## 24. In-Arena Movement Physics — Walk/Run Speed and Physics Equilibrium

### §24.1 — Walk vs Run Speed Split

The mech `mec_speed` value (uint16 at .MEC offset 0x16) maps to two separate
in-arena speed registers in `Combat_InitActorRuntimeFromMec_v123` (0x00433910):

| Register | Formula | Notes |
|----------|---------|-------|
| Walk speed | `mec_speed × 300` | Confirmed by RE of `0x00433910` |
| Run/max speed | `round(mec_speed × 1.5) × 300` | Confirmed by RE of `0x00433910` |

Example — ANH-1A (`mec_speed = 2`):
- Walk: `2 × 300 = 600` → **21.6 kph**
- Run:  `round(3) × 300 = 900` → **32.4 kph**

Example — AS7-D Atlas (`mec_speed = 3`):
- Walk: `3 × 300 = 900` → **32.4 kph**
- Run:  `round(4.5) × 300 = 1500` → **54 kph**

> **NOTE:** The prior server-side formula `mec_speed × 450` was incorrect for
> odd `mec_speed` values (e.g., Atlas: 1350 vs correct 1500).

### §24.2 — Throttle Accumulator Scale (Cmd9 THROTTLE_RUN_SCALE)

The client's KP8 (throttle up) key sends Cmd9 frames with a `sVar2` throttle
accumulator that peaks at approximately **20** at full-forward input.  The
server must divide `throttleRaw - MOTION_NEUTRAL` by 20 (`THROTTLE_RUN_SCALE`)
to map full-throttle input to `maxSpeedMag`.

Using a divisor of 45 (the prior value) capped forward movement at approximately
walk speed (~21 kph for ANH-1A) because `20 × maxSpeedMag / 45 ≈ walkSpeedMag`.

On 2026-04-11, live testing confirmed the remaining TAP-mode throttle regression
was **not** another scale issue. The client keeps local ownership of
`actor+0x372` through `FUN_004229a0` while sending Cmd8 coasting frames
(`DAT_004f1f7c == 0`). Any server-side Cmd65 echo during that state can
overwrite the local throttle target before the next key event. The working fix
was to suppress Cmd8 movement echoes whenever `clientSpeed != 0` and keep only
the stopped reset path for `clientSpeed == 0`. The earlier Cmd9-only
`combatIntentStop` workaround was also removed because TAP mode never enters the
Cmd9 path.

### §24.3 — Physics Equilibrium and the `globalA` Constant (DAT_004f56b4)

**RE source:** Static analysis of `MPBTWIN.EXE` v1.23.

The Cmd72 bootstrap packet includes a constant `globalA` (wire field name) which
the client stores in `DAT_004f56b4`.  Ghidra analysis identified two functions
that use this constant at every physics tick:

**`FUN_0042c830` — velocity integrator (impulse source):**
```
  applied_accel = speed_target × 980 / D
  governor_factor = (100 - throttle_pct / 5) / 100   → 0.80 at 100% throttle
  net_impulse  = applied_accel × governor_factor
```

**`FUN_0042cd20` — grounded drag / airborne damping:**
```
  if grounded:
    decel = |v| × (globalB + D/100) / 100
  if jump-active:
    damping = |v| × 0.20 × globalC / 100
```

**Grounded equilibrium condition** (net_impulse = decel):
```
  0.80 × speed_target × 980 / D = |v_eq| × (globalB + D/100) / 100
  ↓ (at equilibrium |v_eq| = speed_target)
  globalB = 0.80 × 98000 / D - D / 100
```

**Confirmation table:**

| D / globalB | Forward eq speed | Expected impact |
|---------|-----------------|----------------|
| `3612 / 0` (prior) | `900 × 0.80 × 98000 / (3612 × 36.12) ≈ 552` | ~21 kph ✓ |
| `2800 / 0` | `900 × 0.80 × 98000 / (2800 × 28) = 900` | ~32 kph ✓ |
| `1462 / 39` | `900 × 0.80 × 98000 / (1462 × 53.62) ≈ 900` | same top-speed target, ~50% more Jenner jump apex than `1600 / 33` |

The value `D = 3612 = 0x0E1C = MOTION_NEUTRAL` was a copy/paste mistake — the
field was initialised from the motion-bias constant rather than the physics
parameter. Setting `globalA = 2800` with `globalB = 0` fixed the original top
speed issue, but deeper jump RE shows the more general rule is that **grounded**
equilibrium depends on the `globalA/globalB` pair rather than `globalA` alone.

**Function cross-reference:**

| Function | Address | Role |
|----------|---------|------|
| `Combat_InitActorRuntimeFromMec_v123` | `0x00433910` | Reads .MEC fields; sets walk/run speed registers |
| `FUN_0042c830` | `0x0042c830` | Velocity integrator; uses `DAT_004f56b4` (globalA) |
| `FUN_0042cd20` | `0x0042cd20` | Ground drag; uses `DAT_004f56b4` (globalA) |
| `FUN_004229a0` | `0x004229a0` | Client-local throttle target update (KP8/KP2 path) |


