# MPBT Server

A TypeScript server emulator for **Multiplayer BattleTech: Solaris** (Kesmai, 1996), the original online BattleTech MMO that ran on the GEnie and AOL networks.

This project reverse-engineers the **ARIES** binary protocol used by `MPBTWIN.EXE` and re-implements the server-side handshake well enough to reach — and navigate — the mech selection lobby.

## Status

| Milestone | Status |
|---|---|
| ARIES transport layer (12-byte framing) | ✅ Complete |
| LOGIN_REQUEST → LOGIN handshake | ✅ Complete |
| SYNC ack + welcome escape sequence | ✅ Complete |
| Inner game frame format (seq + cmd + CRC) | ✅ Complete |
| Mech selection window opens | ✅ Complete |
| Mech navigation + confirm dialog (cmd 7) | ✅ Complete |
| REDIRECT packet (type 0x03) sent on confirm | ✅ Complete |
| Post-redirect world server (second TCP connection) | ✅ Complete |
| Persistent accounts + character creation | ✅ Complete |
| Room presence — join, leave, roster (cmd 10/13/11) | ✅ Complete |
| ComStar direct messages (online + offline delivery) | ✅ Complete |
| World map travel (Solaris / IS sectors) | ✅ Complete |
| ARIES type-0x05 keepalive (lobby + world) | ✅ Complete |
| Combat bootstrap packet builders (cmd 64–73) | ✅ Complete |
| Server-authoritative combat loop | 🔬 Under investigation |
| Multi-client combat + match orchestration | 🔬 Under investigation |

The client reaches the mech selection screen, confirms a mech selection, is redirected to the world server, creates a character, and enters a named room alongside other connected players.

## Game Data

The server reads mech definitions from `mechdata/*.MEC` files and `MPBT.MSG` at startup.
**These files are not included in this repository** — they are proprietary assets
of Kesmai Corporation / Electronic Arts and must not be redistributed.

To run the server, copy the following from your own licensed copy of
**Multiplayer BattleTech: Solaris** into the project root:

```
mpbt-server/
  mechdata/
    ANH-1A.MEC
    ARC-2K.MEC
    ... (161 files total)
  MPBT.MSG
```

`MPBT.MSG` is the game's string table and is used to resolve the correct mech ID
indices that the client expects in the cmd 26 mech list packet.

---

## Background

MPBT ran on Kesmai's proprietary **ARIES** engine — the same engine that powered Air Warrior and Legends of Kesmai. The client (`MPBTWIN.EXE`) and its companion DLLs (`COMMEG32.DLL`, `INITAR.DLL`) have been extensively analyzed with Ghidra to reconstruct the wire protocol from scratch.

No original server binary, source code, or protocol documentation is known to exist.

## Protocol

### ARIES Transport

Every message is a 12-byte header followed by a variable-length payload:

```
Bytes [0-3]   uint32 LE   message type
Bytes [4-7]   uint32 LE   tag (timestamp / sequence; 0 in most client msgs)
Bytes [8-11]  uint32 LE   payload length
Bytes [12..]              payload
```

Key message types:

| Type | Direction | Meaning |
|------|-----------|---------|
| `0x00` | Both | SYNC / game data channel |
| `0x03` | S→C | REDIRECT (hand off to game server) |
| `0x05` | Both | KEEPALIVE |
| `0x15` | C→S | LOGIN |
| `0x16` | S→C | LOGIN_REQUEST |

### Inner Game Frame (type 0x00)

Game data is wrapped in an escape-framed inner format:

```
0x1B  [seq+0x21]  [cmd+0x21]  [args...]  [0x20]  [CRC×3]  0x1B
```

- **seq**: sequence number 0–42, consumed by the pre-handler before command dispatch
- **cmd+0x21**: command index (lobby dispatch table at `g_lobby_DispatchTable` (`DAT_00470198`), 0x4C entries)
- **args**: base-85 encoded arguments (each digit stored as `value + 0x21`)
- **CRC**: 19-bit LFSR over all bytes between the ESCs; encoded as 3 base-85 bytes

### Base-85 Encoding

Arguments use a custom base-85 scheme where each digit `d` is transmitted as `d + 0x21`:

| Encoder | Canonical Name | Bytes | Value range |
|---------|---------------|:---:|-------------|
| type 1 | `Frame_EncodeArg(1,v)` | 2 | 0–7,224 |
| type 2 | `Frame_EncodeArg(2,v)` | 3 | 0–614,124 |
| type 3 | `Frame_EncodeArg(3,v)` | 4 | 0–52,200,624 |
| type 4 | `Frame_EncodeArg(4,v)` | 5 | 0–4,437,053,124 |
| single byte | `Frame_ReadByte` | 1 | 0–84 |
| string | `Frame_ReadString` | 1+N | `[len+0x21][ASCII]` |

### CRC Algorithm

19-bit LFSR, confirmed from `Frame_VerifyCRC` (`FUN_00402e30`) in `MPBTWIN.EXE`:

```typescript
let crc = 0x0A5C25; // lobby; 0x0A5C45 for combat

for (const b of data) {
  crc = crc * 2;
  if (crc & 0x80000) crc = (crc & 0x7FFFE) | 1;
  crc ^= b;
}
// + 3 finalization rounds
```

### Lobby Command Table (`g_lobby_DispatchTable` / `DAT_00470198`)

Key commands confirmed by Ghidra analysis:

| Index | Canonical Name | Binary Address | Notes |
|:---:|----------------|---------------|-------|
| 3 | `Cmd3_SendCapabilities` | `FUN_0040d3c0` | Args: `[1,6,3,0]` (capability flags) |
| 7 | `Cmd7_ParseMenuDialog` | `FUN_004112b0` | type1(listId) + type4(selection) |
| 20 | `Cmd20_MouseHandler` | `FUN_00401c90` | 'X' key; mech detail request TBD |
| 26 | `Cmd26_ParseMechList` | `FUN_0043A370` | Mech list → opens mech window |

## Lobby Flow

```
Client connects (port 2000)
  ← SERVER: LOGIN_REQUEST (type 0x16)
  → CLIENT: LOGIN (type 0x15, 333 bytes: username, version, email, password)
  ← SERVER: SYNC ack (type 0x00, empty)
  ← SERVER: WELCOME escape (type 0x00, payload="\x1b?MMW Copyright Kesmai Corp. 1991")
  → CLIENT: cmd 3 (client-ready, args [1,6,3,0])

  [Returning player — character already in DB]
  ← SERVER: REDIRECT (type 0x03) → directly to world server

  [New player — no character yet]
  ← SERVER: cmd 26 (mech list)        ← mech selection window opens
  → CLIENT: cmd 7 (mech selected)
  ← SERVER: cmd 7 (confirm dialog)
  → CLIENT: cmd 7 (confirm pick)
  ← SERVER: REDIRECT (type 0x03, 120 bytes: addr[40] | internet[40] | pw[40])

Client reconnects to world server (port 2001)
  ← SERVER: LOGIN_REQUEST (type 0x16)
  → CLIENT: LOGIN (same format)
  ← SERVER: SYNC ack + "MMW" WELCOME escape
  → CLIENT: cmd 3
  ← SERVER: cmd 6 + cmd 4 (scene init) + cmd 10 (room roster)
             + cmd 3 (text broadcast) + cmd 5 (cursor)
  [first login only] ← cmd 9 (callsign + House allegiance prompt)
  [first login only] → CLIENT: cmd 9 (display name + allegiance selection)
```

## Project Structure

```
mpbt-server/
├── src/
│   ├── server.ts              # Lobby TCP server — LOGIN, mech select, REDIRECT
│   ├── server-world.ts        # World TCP server — room presence, chat, travel, combat entry
│   ├── config.ts              # Environment variable config (ports, keepalive, etc.)
│   ├── data/
│   │   ├── maps.ts            # .MAP file parser (used by tools/dump-map.ts)
│   │   ├── mechs.ts           # .MEC file loader → mech roster
│   │   └── mech-stats.ts      # Static mech stats for cmd 20 examine response
│   ├── db/
│   │   ├── client.ts          # pg pool
│   │   ├── schema.sql         # Canonical DB schema
│   │   ├── migrate.ts         # Idempotent schema apply (npm run db:migrate)
│   │   ├── accounts.ts        # Account lookup + bcrypt auth
│   │   ├── characters.ts      # Character record CRUD
│   │   ├── messages.ts        # ComStar offline message store + delivery
│   │   ├── add-account.ts     # CLI — create account
│   │   ├── edit-account.ts    # CLI — edit account
│   │   └── delete-account.ts  # CLI — delete account
│   ├── protocol/
│   │   ├── aries.ts           # ARIES 12-byte framing (PacketParser, buildPacket)
│   │   ├── auth.ts            # LOGIN handshake, SYNC ack, WELCOME packet
│   │   ├── combat.ts          # Combat packet builders (cmd 64–73)
│   │   ├── constants.ts       # Message types, port constants
│   │   ├── game.ts            # Inner frame builder, CRC, base-85, cmd builders
│   │   └── world.ts           # World-server protocol encoder (cmd 3–14, 48)
│   ├── state/
│   │   ├── launch.ts          # Lobby→world launch context (selectedMech, accountId)
│   │   └── players.ts         # ClientSession interface, PlayerRegistry
│   └── util/
│       ├── capture.ts         # Per-session packet capture logger
│       └── logger.ts          # Structured logger
├── tools/
│   ├── dump-map.ts            # MAP file inspector (npm run map:dump)
│   ├── gen-pcgi.ts            # play.pcgi generator (npm run gen-pcgi)
│   └── patch-mpbtwin-two-gui.ps1  # Runtime binary patches for two-client GUI testing
├── dist/                      # Compiled ESM output
├── logs/                      # Runtime logs
├── captures/                  # Per-session hex packet captures
├── package.json
└── tsconfig.json
```

## Getting Started

### Requirements

- Node.js 20.6+
- PostgreSQL 14+ (local or Docker — see `docker-compose.yml`)
- The original `MPBTWIN.EXE` and its DLLs (not included)
- Windows (the game client is Win32)

### Install

```bash
cd mpbt-server
npm install
```

### Build

```bash
npm run build
```

### Run

```bash
npm start
```

The server listens on port 2000 by default.

Runtime configuration is read from `.env`. Useful knobs for GUI validation:

| Variable | Default | Description |
|----------|---------|-------------|
| `SERVER_HOST` | `127.0.0.1` | Host advertised in world `REDIRECT` packets. |
| `ARIES_KEEPALIVE_INTERVAL_MS` | `30000` | Server-initiated ARIES type-0x05 keepalive interval; set `0` to disable. |
| `SOCKET_IDLE_TIMEOUT_MS` | `120000` | Lobby/world TCP idle timeout; set `0` to disable. |

### Generate a play.pcgi

`MPBTWIN.EXE` reads a `play.pcgi` file at launch to find the server address and credentials. The game deletes the file after reading it, so it must be regenerated before each session.

```bash
# Defaults: 127.0.0.1:2000, user=Player, pass=password, email=player@mpbt.local
npm run gen-pcgi

# Custom credentials
npm run gen-pcgi -- --server 127.0.0.1:2000 --user Moose --pass moose123 --email moose@mpbt.local

# Custom output path
npm run gen-pcgi -- --out C:\MPBT\play.pcgi
```

### Launch the client (Windows)

```bat
cd C:\MPBT
npm run gen-pcgi --prefix mpbt-server -- --user YourName
npm start --prefix mpbt-server
start "" "C:\MPBT\MPBTWIN.EXE" "C:\MPBT\play.pcgi"
```

Packet captures are written to `mpbt-server/captures/` and logs to `mpbt-server/logs/` for each session.

## Reverse Engineering Notes

All protocol details were derived from static analysis of the original binaries using Ghidra.
Canonical names for all confirmed functions and globals are defined in [`symbols.json`](symbols.json)
and documented in detail in [`RESEARCH.md`](RESEARCH.md).  Key functions:

| Canonical Name | Binary Address | Binary | Role |
|----------------|---------------|--------|------|
| `Aries_RecvDispatch` | `FUN_100014e0` | COMMEG32.DLL | Main protocol dispatcher (all message types) |
| `Aries_SendLoginPacket` | `FUN_10001420` | COMMEG32.DLL | Builds and sends LOGIN packet |
| `Aries_PacketParse` | `FUN_100036d0` | COMMEG32.DLL | ARIES packet parser |
| `Lobby_RecvDispatch` | `FUN_00402cf0` | MPBTWIN.EXE | Lobby command dispatcher (`g_lobby_DispatchTable`) |
| `Lobby_SeqHandler` | `FUN_0040C2A0` | MPBTWIN.EXE | Pre-handler: consumes seq byte before command dispatch |
| `Frame_VerifyCRC` | `FUN_00402e30` | MPBTWIN.EXE | 19-bit LFSR CRC verifier |
| `Cmd26_ParseMechList` | `FUN_0043A370` | MPBTWIN.EXE | Command 26 — parses mech list |
| `MechWin_Create` | `FUN_00439f70` | MPBTWIN.EXE | Creates 640×480 mech selection window |
| `Cmd7_ParseMenuDialog` | `FUN_004112b0` | MPBTWIN.EXE | Command 7 — creates numbered menu dialog |

## Roadmap

See [ROADMAP.md](ROADMAP.md) for the full milestone plan from current state to a playable two-player game.

## Contributing

This is an open research project. If you have:

- Packet captures from the original GEnie/AOL servers
- Knowledge of the post-redirect game world protocol
- Ghidra scripts or annotations for the MPBT binaries
- Any Kesmai/ARIES protocol documentation

...please open an issue or PR. The further sections of the protocol (combat, world navigation, the secondary connection via `DAT_1001a080`) are still under active investigation.

## Legal

This project contains no original Kesmai or MPBT code. It is an independent clean-room reimplementation derived from protocol analysis of a legally-owned copy of the game client.

Multiplayer BattleTech: Solaris and all related trademarks are the property of their respective owners. The original servers were shut down by Kesmai in 2001.
