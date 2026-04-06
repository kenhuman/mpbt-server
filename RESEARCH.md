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
17. [Methodology](#17-methodology)

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
| `0x05` | Both | `KEEPALIVE` | Client sends; server echoes back identical packet |
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

| Context | Init value | Notes |
|---------|-----------|-------|
| Lobby | `0x0A5C25` | Derived: `(0xFFFFFFE0 + 0x0A5C45) & 0xFFFFFFFF` |
| Combat | `0x0A5C45` | Read directly from `Frame_VerifyCRC` (`FUN_00402e30`) |

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
| 3 | `Cmd3_Thunk` | `FUN_0040C190` | Calls `Cmd3_SendCapabilities` (`FUN_0040d3c0`): sends `[1,6,3,0]` |
| 7 | `Cmd7_ParseMenuDialog` | `FUN_004112B0` | Server menu dialog renderer |
| 20 | `Cmd20_ParseTextDialog` | `FUN_00411D90` | Server text dialog with mech stats (see §14) |
| 26 | `Cmd26_ParseMechList` | `FUN_0043A370` | Mech list parser → `MechWin_Create` (`FUN_00439f70`) |

### Combat Command Table (`g_combat_DispatchTable` / `DAT_00470408`) — Key Entries

| Index | Binary Address | Notes |
|:---:|---------|------|
| 0x48 | `FUN_00406140` | Receives mech stats from server; fills mech data arrays |

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

### Special list_id Values to Avoid

These values cause the client to keep the dialog open after a pick (special
sub-menu logic):

| Value (decimal) | Hex | Notes |
|:---:|:---:|-------|
| 8 | `0x08` | — |
| 12 | `0x0c` | — |
| 34 | `0x22` | — |
| 37 | `0x25` | — |
| 52 | `0x34` | — |
| 1000 | `0x3E8` | Triggers sub-menu logic |

Use any other positive integer as `list_id` to get a simple dismiss-on-pick dialog.

### ESC / Cancel Handling (`Cmd7_OnMenuEsc` / `FUN_004122d0`)

If the user presses ESC:
- Calls `Cmd1d_Send` (`FUN_00410cc0`) → sends command `0x1d` frame: `[byte(p1), type1(p2), type4(p3)]`
- This is **not** a cmd-7 reply; `selection = 0` in a cmd-7 reply also means cancel.

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
[type1  2B]  dialog_id     (arbitrary id; avoid 13/30/35/39 — trigger printf via MPBT.MSG)
[byte   1B]  mode          2 = create/show stats panel with Ok button
[string    ] text          "#NNN" where NNN is the zero-padded mech_id (3 ASCII digits)
```

### `#NNN` Text Format

The client's `FUN_00411a10` inspects `text[0]`:
- If `text[0] == '#'` (0x23): decodes a 3-digit decimal mech_id from `text[1..3]`
  using the formula `(d1-'0')*100 + (d2-'0')*10 + (d3-'0')`, looks up
  `DAT_00473ad8[mech_id]` (a table of MPBT.MSG line numbers), fetches the
  pre-formatted stats string via `FUN_00405840`, copies it over `text`, and
  uses the expanded string as the dialog content.
- If `text[0] != '#'`: the text is used as-is (arbitrary string in the dialog).

The `#NNN` path is the **correct** path for mech stats.  The client has all stats
embedded in MPBT.MSG; the server only provides the 3-digit mech_id redirect.

**Example:** `examineText = "#156"` for ANH-1A (mech_id 156).

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

**Server response:** ONE cmd-20 packet, mode=2, `text="#NNN"` (3-digit mech_id).
See §14 for full details.

### Post-Redirect Game World Protocol

- After REDIRECT, the client opens a new TCP connection to the address in the
  REDIRECT payload
- The game world protocol has not been analysed; a second capture session
  against the live server (or further Ghidra work on `FUN_100014e0` case 0 for
  the new connection) is needed

### Secondary Connection (`DAT_1001a080`)

- Set by `Aries_Connect` (`FUN_100011c0`) after REDIRECT
- The data arriving on this connection is fed to a different game window/loop
- Relationship to the lobby connection is not fully understood

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

## 17. Methodology

### Tools Used

- **Ghidra 11** — primary disassembler / decompiler
- **Wireshark** — originally considered but private server was unavailable;
  analysis was done purely through static RE
- **Custom TypeScript server** (`src/server.ts`) — used to trigger client paths
  and observe what the binary did next

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
| `Aries_Connect` | `FUN_100011c0` | Opens new TCP connection to addr (called on REDIRECT) |
| `Aries_RawWrite` | `FUN_10002b10` | Sends raw bytes on active socket |

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

### Key Data Labels — MPBTWIN.EXE

| Canonical Name | Binary Label | Value / Role |
|----------------|-------------|------|
| `g_lobby_DispatchTable` | `DAT_00470198` | Lobby command function-pointer table (0x4C entries) |
| `g_lobby_SeqHandlerPtr` | `PTR_FUN_00470190` | Points to `Lobby_SeqHandler`; installed as pre-handler |
| `g_lobby_LastSeq` | `DAT_004e2da4` | Stores last seen seq value from client frame |
| `g_lobby_WelcomeGateOpen` | `DAT_004e2de8` | Set to 1 by `Lobby_WelcomeGate` when welcome string matches |
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
