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
19. [Methodology](#19-methodology)
20. [MEC File Binary Format](#20-mec-file-binary-format)

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
| 14 | `0x2f` | `0x00415700` | |
| 15 | `0x30` | `0x004139C0` | |
| 16 | `0x31` | `0x00411DE0` | same addr as cmd 19 |
| 17 | `0x32` | `0x0041E2C0` | |
| 18 | `0x33` | `0x00420780` | |
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
| 32 | `0x41` | `0x0043A520` | |
| 33 | `0x42` | `0x00419360` | `FUN_00419370` — Ok-dialog callback |
| 34 | `0x43` | `0x00413FF0` | |
| 35 | `0x44` | `0x00429C80` | |
| 36 | `0x45` | `0x004161A0` | |
| 37 | `0x46` | `0x00416D40` | |
| 38 | `0x47` | `0x00419250` | |
| 39 | `0x48` | `0x0043DAE0` | |
| 40 | `0x49` | `0x0040ECB0` | |
| 41 | `0x4a` | `0x00415AF0` | |
| 42 | `0x4b` | `0x00412680` | |
| 43 | `0x4c` | `0x0040EED0` | |
| 44 | `0x4d` | `0x00410000` | |
| 45 | `0x4e` | `0x0040CEF0` | |
| 46 | `0x4f` | `0x00414130` | |
| 47 | `0x50` | `0x004192F0` | |
| 48 | `0x51` | `0x00411DF0` | |
| 49 | `0x52` | `0x0040F980` | |
| 50 | `0x53` | `0x00410460` | |
| 51 | `0x54` | `0x00410480` | |
| 52 | `0x55` | `0x00401000` | |
| 53 | `0x56` | `0x004010C0` | |
| 54 | `0x57` | `0x00419320` | |
| 55 | `0x58` | `0x00419340` | |
| 56 | `0x59` | `0x0040FD60` | |
| 57 | `0x5a` | `0x004168E0` | |
| 58 | `0x5b` | `0x0040CEE0` | |
| 59 | `0x5c` | `0x0040D4E0` | |
| 60 | `0x5d` | `0x0040FEB0` | |
| 61 | `0x5e` | `0x0040FA00` | |
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
| 4 | `0x25` | `FUN_00414B70` | `Cmd4_SceneInit` | Large UI-initialization command (~2836 bytes). Reads: 1-byte session-flags (bit `0x10` = has-opponents, `0x20` = clear-arena-data), 1-byte player-slot, 1-byte player-ID; optionally up to 4 opponent entries (type byte + ID byte each) then player callsign and scene name strings; 1-byte arena-option count then option strings. Creates main game window and fills arena labels, mech-slot buttons, chat scroll-window, scoreboard boxes. Sets `g_chatReady = 1` at completion. This is the principal "enter arena" command. |
| 5 | `0x26` | `FUN_0040C2F0` | `Cmd5_CursorNormal` | Calls `FUN_00433ec0` → loads `IDC_ARROW` cursor (`0x7f00`), clears `DAT_00474d00`. Server signals "loading complete; restore normal cursor". |
| 6 | `0x27` | `FUN_0040C300` | `Cmd6_CursorBusy` | Calls `FUN_00433ef0` → loads `IDC_WAIT` cursor (`0x7f02`), sets `DAT_00474d00 = 1`. Server signals "processing; show hourglass". |
| 7 | `0x28` | `FUN_004112B0` | `Cmd7_ParseMenuDialog` | Menu dialog renderer — documented in §11. |
| 8 | `0x29` | `FUN_00413960` | `Cmd8_SessionData` | Reads connection object (`FUN_0040d4c0`), then `Frame_ReadArg` into `DAT_0048a070`. Passes buffer to `FUN_00413800(conn, buf, NULL)` — loads per-session binary data (mech load-out / team assignment). Updates two input-handler jump-table entries. |
| 9 | `0x2a` | `FUN_0040C310` | `Cmd9_RoomPlayerList` | Reads sentinel byte; if `0x01`: reads 1-byte count, then for each player reads a `Frame_ReadArg` entry into `DAT_004de000` array. Calls `FUN_0042da40` to populate roster UI, sets `DAT_004ddfc0+0x44 = 8` (ready flag). Server sends the initial occupant list for the entered room. |
| 10 | `0x2b` | `FUN_0040C370` | `Cmd10_TextFeed` | Reads records — each comprising a 4-byte session-ID, 1-byte type, and a `Frame_ReadArg` string — until a sentinel type byte `0x54` ('T'). Appends each record to the chat scroll-window with separator lines between records. Used for multi-line server announcements (welcome text, room history). |
| 11 | `0x2c` | `FUN_0040C6C0` | `Cmd11_PlayerEvent` | Reads 4-byte session-ID + 1-byte status code + callsign string. Finds/creates roster slot via `FUN_0040c590`. Status: `0`=left arena; `1–4`=tier/game-state (formatted via message table `DAT_00472a34[status]`); `5`=moved to spectator; `0x54`=match-end score update; other=game-state N−5. Appends formatted event line to chat. |
| 12 | `0x2d` | `FUN_0040C5C0` | `Cmd12_PlayerRename` | Reads 4-byte session-ID + new callsign string. Looks up existing roster slot, formats "{old} is now {new}" message (MSG `0x13`), overwrites stored name in player table, appends to chat. |
| 13 | `0x2e` | `FUN_0040C920` | `Cmd13_PlayerArrival` | Reads 4-byte session-ID + callsign string. Searches player table for matching session-ID (update) or first free slot (insert). Sets active flag, stores callsign, resets timer field to 0, appends "{callsign} entered" line (MSG `0x19`) to chat. |

**Correction note for §8**: The lobby dispatch table entry at index 3 was previously labelled
`Cmd3_Thunk — Calls Cmd3_SendCapabilities (FUN_0040d3c0)`.  Decompilation of `FUN_0040C190`
confirms it does **not** call `FUN_0040d3c0`.  `FUN_0040d3c0` is called directly from the welcome
gate handlers `FUN_00429870` and `FUN_00429a00` — it fires when the client receives the
`"\x1b?MM[WC]..."` welcome string, not in response to a server cmd-3 frame.

---

## 19. Methodology

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
**Loader**: `FUN_004387f0` (`MecFile_Load`) @ `0x004387f0`, MPBTWIN.EXE  
**Confirmed against**: AS7-D (Atlas 100t), BJ-1 (Blackjack 45t), SDR-5V (Spider 30t)

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
| `0x3C` | u16[] | `weapon_ids[weapon_count]` | Array of weapon type IDs (see §20.3) |
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
| `3`  | Medium Laser | Present in Atlas ×4, Blackjack ×3, Spider ×1; most ubiquitous energy weapon in 3025 |
| `6`  | AC/2 (Autocannon/2) | Appears in BJ-1 weapon list and matched ammo bin type |
| `8`  | Unconfirmed (missile?) | Atlas position 0, BJ-1 position 0; presumed SRM variant |
| `9`  | Unconfirmed (missile/beam?) | Atlas position 1, Spider position 0 |
| `16` | AC/20 (Autocannon/20) | Atlas position 2; 2 ammo bins of 5 rounds each = 10 total ✓ |

IDs `1`, `2`, `4`, `12` appear in other mechs and remain unresolved without
cross-referencing the weapon global table at `DAT_00477b58` (stride `0x5C`, 0-indexed).

### 20.4 Cross-Validation Table

| Field | AS7-D (Atlas 100t) | BJ-1 (Blackjack 45t) | SDR-5V (Spider 30t) |
|-------|--------------------|----------------------|---------------------|
| Seed  | `0x73372D64` | `0x626A2D31` | `0x722D3576` |
| `tonnage` (0x18) | **100** | **45** | **30** |
| `walk_mp` (0x16) | **3** | **4** | **8** |
| `jump_mp` (0x38) | **0** | **4** | **8** |
| `heat_sinks` (0x34) | **20** | **11** | **10** |
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
| `weapon_ids` (0x3C+) | `[8,9,16,3,3,3,3]` | `[8,6,6,3,3,3]` | `[9,3]` |
| `ammo_bin_count` (0x1EC) | 5 | 1 | 0 |

**Variant name**: sourced from `MechWin_LookupMechName` (§Appendix A) which reads the
mech string table at `MPBT.MSG` offset `(mech_id + 0x3AE) * 2` (§15).  The loader
uses this name both to construct the filename `mechdata\<name>.MEC` and as the
encryption seed source.

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
