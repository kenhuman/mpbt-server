# Roadmap

## Vision

Two players load `MPBTWIN.EXE`, connect to this server, pick their mechs, drop into a Solaris arena, and fight a real-time BattleMech duel — served entirely from this open-source emulator with no Kesmai infrastructure.

This is a long-haul reverse-engineering project. Every milestone below is blocked by RE work or builds directly on a prior milestone. Progress is honest: where the protocol is unknown, we say so.

---

## How to Read This

| Icon | Meaning |
|------|---------|
| ✅ | Complete and tested against the real client |
| 🔬 | Blocked on Ghidra RE — protocol unknown |
| 🔧 | Engineering work — protocol understood, implementation needed |
| ❌ | Not started |

---

## Current State

| Feature | Status |
|---|---|
| ARIES 12-byte transport framing | ✅ |
| TCP stream reassembly (fragmentation) | ✅ |
| `LOGIN_REQUEST` → `LOGIN` handshake | ✅ |
| `SYNC` ack + welcome escape sequence | ✅ |
| Inner game frame (seq + cmd + CRC) | ✅ |
| Base-85 encode/decode | ✅ |
| 19-bit LFSR CRC (lobby init `0x0A5C25`) | ✅ |
| Cmd 26 — mech list window | ✅ |
| Cmd 7 — menu dialog (select + confirm) | ✅ |
| Cmd 0x1D — cancel/ESC re-sends mech list | ✅ |
| Cmd 20 — examine mech text-dialog response | ✅ |
| `REDIRECT` packet (type `0x03`) | ✅ |
| Post-redirect game world | 🔬 |

The client reaches the mech selection screen, browses mechs, confirms selection, and receives a `REDIRECT`. That is the furthest any known public attempt has reached.

---

## Milestones

---

### M1 — Lobby Completeness

**Goal:** The lobby experience is fully correct before moving to the game world.

| Task | Status | Notes |
|---|---|---|
| Parse real `.MEC` files → `src/data/mechs.ts` | ❌ | 161 files in `mechdata/`; replace hardcoded `SAMPLE_MECHS` |
| Cmd 20 — mech examine/stats response | ✅ | Single mode=2 packet with `#NNN` text → client resolves full stats from MPBT.MSG via `DAT_00473ad8` jump table; no server-side .MEC data needed |
| Cmd `0x1D` — cancel/ESC in menu dialogs | ✅ | Resolved — server re-sends mech list; sending nothing freezes client |
| ACK reply for seq > 42 | 🔬 | Trigger condition documented in RESEARCH.md §9; reply format unknown |

**Verification:** Connect real `MPBTWIN.EXE`; press `X` on a mech (stats appear), press `ESC` in dialog (no disconnect), browse all 161 mechs without crash.

---

### M2 — RE: Game World Protocol

**Goal:** Understand the protocol spoken on the second TCP connection (post-`REDIRECT`).

This milestone is pure Ghidra work. No code is written here — findings go into `RESEARCH.md`.

| RE Target | Binary | Notes |
|---|---|---|
| `FUN_100014e0` case 0 | `COMMEG32.DLL` | Secondary connection data handler — entry point for everything post-REDIRECT |
| World command dispatch table | `MPBTWIN.EXE` | Analogous to `g_lobby_DispatchTable`; find equivalent for game-world connection |
| Initial world handshake | `COMMEG32.DLL` | What does the server send first on the new connection? What does the client need before it renders the game world? |
| `g_aries_GameWorldConn` (`DAT_1001a080`) | `COMMEG32.DLL` | Secondary Aries connection object; how is it initialized? |
| Combat CRC crossover point | `MPBTWIN.EXE` | When does the client switch from lobby CRC seed (`0x0A5C25`) to combat (`0x0A5C45`)? |
| First 10+ world commands | `MPBTWIN.EXE` | Position, movement, chat, damage, turn timer, UI updates |

**Deliverable:** New RESEARCH.md sections (§16+) documenting all of the above with confirmed wire formats.

---

### M3 — Game World Connection

**Goal:** The client successfully connects to the game world server and enters a stable state without crashing.

*Depends on M2.*

| Task | Status | Notes |
|---|---|---|
| `src/server-world.ts` — second TCP listener | ❌ | Separate port; same `PacketParser` (ARIES); combat CRC init |
| `src/protocol/world.ts` — world command stubs | ❌ | One handler per command discovered in M2 |
| Update `gen-pcgi.ts` — separate lobby + world ports | ❌ | `play.pcgi` needs to route the REDIRECT to the right address/port |
| `ClientSession` — add `'world'` phase | ❌ | Extend `src/state/players.ts` |
| Initial world handshake response | ❌ | Whatever M2 reveals the client expects first |

**Verification:** Client connects after REDIRECT, game world renders, no immediate crash or disconnect.

---

### M4 — World Navigation

**Goal:** A single player can move around the game world (Solaris sectors / arenas) from the server's perspective.

*Depends on M3.*

| Task | Status | Notes |
|---|---|---|
| RE movement protocol | 🔬 | Client → server movement commands; server → client position updates |
| Real world map | ❌ | Replace fictional 3-room `World` with actual Solaris sector/arena layout, reconstructed from `MPBT.MSG` strings and RE |
| Server-side position tracking | ❌ | Extend `src/state/world.ts` with real rooms, exits, and coordinates |
| Position sync to client | ❌ | Server → client position/environment packets |

**Verification:** Single client can navigate between areas; environment updates correctly.

---

### M5 — Single-Client Combat Loop

**Goal:** One player in an arena can engage with the combat system (even against a scripted dummy opponent).

*Depends on M4.*

| Task | Status | Notes |
|---|---|---|
| RE weapon fire packets | 🔬 | Client → server fire command; server → client hit/miss result |
| RE damage model | 🔬 | Location-based armor/internal structure; heat buildup |
| RE turn timer / initiative | 🔬 | How does the server pace combat rounds? |
| RE win/lose condition | 🔬 | How does the server signal mech destruction / match end? |
| Implement `src/protocol/combat.ts` | ❌ | All combat packet builders and parsers |
| Scripted dummy opponent | ❌ | Server-controlled bot mech that fires back, for single-player testing |

**Verification:** Player can enter an arena, fire weapons, receive damage feedback, and reach a win/lose screen.

---

### M6 — Multi-Client Combat

**Goal:** Two human players can fight each other in real time.

*Depends on M5.*

| Task | Status | Notes |
|---|---|---|
| Room broadcast | ❌ | `PlayerRegistry.broadcast()` — sync combat state to all clients in a room |
| Player enter/leave events | ❌ | Notify existing clients when a new player joins or leaves |
| Synchronized position | ❌ | Each client sees other mechs move in real time |
| Synchronized damage | ❌ | Damage dealt by one client is reflected in all clients' views |
| Match orchestration | ❌ | Server manages match lifecycle: ready-up, start, end, scoring |

**Verification:** Two `MPBTWIN.EXE` instances connect, enter the same arena, see each other, and fight to completion.

---

### M7 — Playable Game

**Goal:** The emulator is complete enough for a real play session.

*Depends on M6.*

| Task | Status | Notes |
|---|---|---|
| All 117+ mechs loaded from real `.MEC` files | ❌ | M1 prerequisite |
| Real Solaris arena layouts | ❌ | From M4 RE work |
| Correct mech stat handling (armor, weapons, heat) | ❌ | From `.MEC` parser + damage model |
| Client launcher — `play.pcgi` generator | ✅ | `npm run gen-pcgi` already works |
| Basic observability (logs, session captures) | ✅ | Already implemented |
| Graceful disconnect / reconnect handling | ❌ | Client timeout, mid-match drop |

**Verification:** Full play session — two humans, real mechs, real arena, fight to conclusion — with no manual intervention.

---

## RE Priority Queue

Work these in order when sitting down with Ghidra:

1. **`FUN_100014e0` case 0** (`COMMEG32.DLL`) — secondary connection handler. Highest value; unlocks everything in M3+.
2. **World command dispatch table** (`MPBTWIN.EXE`) — analogous to `g_lobby_DispatchTable`; gives the full command index map for the game world.
3. **Initial world handshake** — the first bytes the client expects from the world server before entering the render loop.
4. **Cmd 20 server response** (`FUN_00401c90`) — needed for M1; can be worked in parallel with items 1–3.
5. **Combat CRC crossover** — when/how the client switches to the combat CRC seed.
6. **Movement packets** (M4 prerequisite).
7. **Weapon fire / damage packets** (M5 prerequisite).
8. **Turn timer / match lifecycle** (M5 prerequisite).

---

## Known Unknowns

These are gaps we know exist. They are not bugs — they are the RE frontier.

- **Post-REDIRECT protocol** — everything the game world server sends and receives. No analysis has been done yet.
- **Cmd 20 server response format** — client sends "examine mech"; server reply format is unknown.
- **Cmd `0x1D` server handling** — whether the server needs to acknowledge a cancel, or silently ignore it.
- **ACK reply format for seq > 42** — the trigger is documented (RESEARCH.md §9) but the reply packet format is not.
- **Combat CRC crossover point** — the server currently always uses lobby CRC init; the transition rule is unknown.
- **Real Solaris world map** — the actual sector/arena layout has not been reconstructed.
- **`.MEC` file format** — the binary format of mech definition files has not been analyzed.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow.
See [RESEARCH.md](RESEARCH.md) for all confirmed protocol details and RE methodology.

If you have access to Ghidra and want to help, the RE Priority Queue above is where to start. Open a **Research Finding** issue with your findings before opening a PR.
