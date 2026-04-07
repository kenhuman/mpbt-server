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

## Reference Materials

These files are gitignored — place them in `research/` for local use.

| File | Contents | Project use |
|---|---|---|
| `BT-MAN.decrypted.txt` | Full game manual: world navigation, chat channels, combat controls, mech stat tables | Design reference for M4–M9; source for `src/data/mech-stats.ts` |
| `SOLARIS.MAP` | Solaris city venue locations, rooms 146+, 189 KB. Format: sequential room-ID records with 18-byte fixed header + LE-prefixed name string + LE-prefixed description string. Confirmed rooms: Solaris Starport, Ishiyama Arena, Government House, White Lotus | M5 world map reconstruction |
| `IS.MAP` | Inner Sphere sector locations, rooms 1–145, 40 KB. Identical layout format to SOLARIS.MAP. Together the two files form a **global room namespace** | M5 world map; full-sector navigation |
| `Gnum*.txt / Gnum*.md` | Firsthand gameplay observations: 4v4 lances, fixed spawns, travel times, team/all-chat | Sanity-check for RE findings |

---

## Milestones

---

### M1 — Lobby Completeness

**Goal:** The lobby experience is fully correct before moving to the game world.

| Task | Status | Notes |
|---|---|---|
| Parse real `.MEC` files → `src/data/mechs.ts` | ✅ | `loadMechs()` scans `mechdata/*.MEC`, assigns correct `mech_id` from MPBT.MSG variant table; `mechType` field hardcoded to 0 pending M2 binary RE; `variant`/`name` empty → client falls back to its own MPBT.MSG lookup |
| Cmd 20 — mech examine/stats response | ✅ | Single mode=2 packet with direct stats text built by `buildMechExamineText()` from `MECH_STATS`; `0x5C` (`\`) is the line separator (`FUN_00433310` NULs it before rendering); `#NNN` shortcode is NOT used — our MPBT.MSG has incomplete/stale stats data |
| Cmd `0x1D` — cancel/ESC in menu dialogs | ✅ | Resolved — server re-sends mech list; sending nothing freezes client |
| ACK reply for seq > 42 | 🔬 | Trigger condition documented in RESEARCH.md §9; reply format unknown |

**Verification:** Connect real `MPBTWIN.EXE`; press `X` on a mech (stats appear), press `ESC` in dialog (no disconnect), browse the first 20 mechs without crash.

---

### M2 — RE: Game World Protocol

**Goal:** Understand the protocol spoken on the second TCP connection (post-`REDIRECT`).

This milestone is pure Ghidra work. No code is written here — findings go into `RESEARCH.md`.

| RE Target | Binary | Status | Notes |
|---|---|---|---|
| `Aries_RecvHandler` case 0 & REDIRECT | `COMMEG32.DLL` | ✅ | §17: REDIRECT handler confirmed; case 0 sends WM_0x7f0 to game window |
| World command dispatch table | `MPBTWIN.EXE` | ✅ | §18: two tables — RPS (0x00470198, cmd 0–76) and Combat (0x00470408, cmd 0–79); full address table |
| Initial world handshake | `COMMEG32.DLL` + `MPBTWIN.EXE` | ✅ | §18: LOGIN_REQUEST→LOGIN→`"\x1b?MMW Copyright Kesmai Corp. 1991"`→cmd-3; same sequence as lobby |
| `g_aries_GameWorldConn` (`DAT_1001a080`) | `COMMEG32.DLL` | ✅ | §17: created by `Aries_Connect`; secondary connection object |
| Combat CRC crossover point | `MPBTWIN.EXE` | ✅ | §18: `Frame_VerifyCRC` uses `g_combatMode` to select seed; RPS=`0x0a5c25`, Combat=`0x0a5c45` |
| First 10+ world commands | `MPBTWIN.EXE` | ✅ | §18: first 13 RPS cmds decompiled — ping/ack (1–2), text broadcast (3), scene init (4), cursor (5–6), menu (7), session data (8), room list (9), text feed (10), player events (11–13) |
| World frame format | `MPBTWIN.EXE` | ✅ | §18: identical to lobby — ESC-delimited, 19-bit LFSR CRC, same base-85 encoding |

**Deliverable:** RESEARCH.md §17 (COMMEG32.DLL RE) and §18 (world protocol RE) — COMPLETE.

---

### M3 — Game World Connection

**Goal:** The client successfully connects to the game world server and enters a stable state without crashing.

*Depends on M2.*

| Task | Status | Notes |
|---|---|---|
| `src/server-world.ts` — second TCP listener | ✅ | Port 2001; same `PacketParser` (ARIES); RPS CRC seed 0x0A5C25 |
| `src/protocol/world.ts` — world command builders | ✅ | Cmd3 TextBroadcast, Cmd4 SceneInit, Cmd5/6 cursor, Cmd9 character-creation prompt notes |
| `src/state/launch.ts` — mech launch registry | ✅ | Bridges lobby→world: records selected mech before REDIRECT, consumed on world LOGIN |
| `ClientSession` — add `'world'` phase | ✅ | Extended `src/state/players.ts`; `selectedMechId?` / `selectedMechSlot?` added |
| Initial world handshake | ✅ | LOGIN_REQUEST → LOGIN → SYNC ack → MMW welcome → cmd-3 → Cmd6+Cmd4+Cmd10+Cmd3+Cmd5 |
| Fix REDIRECT target to WORLD_PORT | ✅ | Lobby now redirects to port 2001; launch record stored before REDIRECT sends |
| `gen-pcgi.ts` — separate lobby/world ports | N/A | `play.pcgi` always points to lobby (2000); REDIRECT carries the world address. Combat server is a separate dynamic spin-up (M6/M7). |

**M3 additions — Persistence, Character Creation, Direct World Entry (#25 / #26 / #27):**

| Task | Status | Notes |
|---|---|---|
| PostgreSQL persistence layer | ✅ | `pg` + `bcryptjs`; `src/db/{client,schema.sql,accounts,characters,migrate}.ts`; `docker-compose.yml` |
| `accounts` table + bcrypt password auth | ✅ | Auto-register on first login; verify password on subsequent logins; rejects wrong passwords |
| `characters` table + allegiance enum | ✅ | One character per account; `display_name UNIQUE`; allegiance CHECK constraint `Davion\|Steiner\|Liao\|Marik\|Kurita` |
| `npm run db:migrate` — idempotent schema apply | ✅ | Reads `src/db/schema.sql`; safe to re-run |
| `ClientSession` — add `accountId`, `displayName`, `allegiance` | ✅ | Set from DB after login; `'char-creation'` phase added |
| Character creation flow (first login) | ✅ | cmd-3 → no character in DB → send `Cmd9` callsign + House prompt → persist typed display name and allegiance → seed launch context → REDIRECT |
| Post-login direct world entry (returning player) | ✅ | cmd-3 → character found → REDIRECT to port 2001 immediately; no mech-select shown |
| World server uses `displayName` as Cmd4 callsign | ✅ | Falls back to `username` if character data unavailable (e.g. test direct-connect) |
| Display name entry (name selection dialog) | ✅ | Implemented with server `Cmd9`, the likely authentic first-login prompt: it opens `MPBT.MSG[5]` (`"Enter your character's name"`), then a numbered selector titled `MPBT.MSG[6]` (`"Choose your allegiance:"`), and submits outbound `cmd 9, subcmd 1, <typed name>, <selected-index>`. This supersedes the earlier `Cmd36`/`Cmd37` hypothesis; `Cmd36` is the read/reply viewer, `Cmd37` opens the ComStar compose editor, and the live `Cmd37(0)` probe is only a compatibility bridge. Live GUI probe confirmed the wire path; socket smoke now confirms persistence, launch-context seeding, and returning-account world entry with the typed callsign in `Cmd4`. |

**Known M3 limitations / M4 work:**
- Initial room-sync uses `Cmd10`; the earlier `Cmd9(count=0)` placeholder was removed, and `Cmd9` is now tied to the first-login name + allegiance prompt rather than room presence.
- `Cmd8` (session binary data / mech loadout) not yet sent; client mech stats display may be absent.
- Arena navigation and movement not yet implemented (M5).
- World server does not yet bounce a second REDIRECT to a combat server (M6/M7).

**Verification:**
- *New player:* connect, select House allegiance, enter world — Cmd4 callsign shows username; allegiance persisted to DB.
- *Returning player:* connect, skip character creation, enter world directly — no mech-select screen shown.
- *Wrong password:* second login with wrong credentials → connection closed.
- *Mech select (M6 path):* cmd-26 visible only when explicitly triggered; pre-combat flow unaffected.
- *First-login `Cmd9` implementation:* socket smoke confirmed `Cmd9` prompt → typed callsign + House reply → persisted character → REDIRECT → world init `6,4,10,3,5`, with `Cmd4` containing the typed callsign on both first-login and returning-account paths. The older `Cmd37(0)` probe remains a compatibility bridge, not the authentic original name-entry UI.

---

### M4 — Chat and Presence

**Goal:** Players see each other and communicate across the full world — not just within a room.

*Depends on M3.*

| Task | Status | Notes |
|---|---|---|
| Room broadcast | 🔬 | Same-room presence now seeds the roster with `Cmd10`, then uses `Cmd13` arrival and `Cmd11(status=0)` departure for incremental updates. World `cmd-4` free-text relay is now implemented as room-local chat fan-out to other clients via `Cmd3`. Validated with the local two-client socket harness and a one-client `MPBTWIN.EXE` launch (`play.pcgi` consumed; client remained connected through world init). A hybrid GUI+socket pass on 2026-04-06 also confirmed a socket world client receives the live GUI occupant in its `Cmd10` seed. A 2026-04-07 two-GUI sandbox attempt hit a client display-mode blocker before the second client reached the server. |
| Player join / leave events | 🔬 | Same-room `Cmd10` / `Cmd13` / `Cmd11(status=0)` path is implemented on the branch and passes the local two-client socket smoke harness. The social-room status transitions behind the roster menu are now partially implemented too: `Cmd7(listId=3)` `selection=0` grabs a new booth, `selection=2` stands, and `selection>=3` joins booth `selection-2`, with `Cmd11(status=5..12)` updating the live roster table. Hybrid GUI+socket validation confirmed the server emits arrival/departure notifications while a real GUI session is connected; visual confirmation inside two simultaneous GUI clients is still pending because the second sandboxed client logged `MPBT Fatal Error (SetDisplayMode): Action not supported`, and immediate `MPBTMemoryPatcher.exe` startup did not resolve it. |
| F7 — team / lance channel | 🔬 | Wire format for scoped team broadcast unknown |
| F8 — all-comm / chat-window toggle | 🔬 | May share a command code with the chat-window open/close packet |
| ComStar DM — store and deliver | 🔬 | Stronger RE now shows `Cmd36` is the received-message / reply viewer and `Cmd37` is the server-side compose opener; the local `listId=1000` submenu can also open compose without a server round-trip. The branch prototype now delivers live online ComStar mail as `Cmd36` with a nonzero reply target, while the sender still uses client `cmd 21` to submit text. Remaining gaps: offline persistence, unread delivery, exact message-body formatting, and real-GUI confirmation that the client’s `Reply` flow interoperates cleanly with the current server prototype. |
| All-roster query | 🔬 | Global presence query: returns every online player's ComStar ID, handle, current sector, and location; triggered via KP5. Current RE confirms the room menu `Cmd7(listId=3)` `selection=1` is the actual `All` request; the earlier `Cmd9` roster interpretation was wrong and now points to the first-login name + allegiance prompt. The current branch prototype follows the stronger RE path: `Cmd7(listId=3, selection=1)` sends `Cmd48_KeyedTripleStringList` (`0x51`) with live world sessions as rows, and row picks (`Cmd7(listId, item_id + 1)`) open the inquiry submenu at `listId=1000`. From there, the real client is expected to open local compose itself for `Send a ComStar message`, or send `Cmd7(0x3f2, target_id + 1)` for `Access personnel data`. The older `Cmd45`/`Cmd58` family still looks like a separate scroll-list shell/list-id helper rather than the minimal KP5 reply. Remaining gap: confirm this flow against the real GUI client, especially the local `1000` submenu behavior after a `Cmd48` all-roster reply. |

**Verification:** Local direct world-session smoke now covers `Cmd48` all-roster listing, row-pick inquiry submenu, `cmd 21` text submit, `Cmd36` inbound message delivery to the selected online target, and sender acknowledgment.

---

### M5 — World Navigation

**Goal:** A single player can move around the game world (Solaris sectors / arenas) from the server's perspective.

*Depends on M4.*

The world uses two distinct room types: **bar** (social spaces, Tier Ranking terminals, ComStar facilities) and **arena** (combat venues). Source topology: `SOLARIS.MAP` (rooms 146+, partly decoded) and `IS.MAP` (rooms 1–145) — both gitignored; see Reference Materials above.

| Task | Status | Notes |
|---|---|---|
| `SOLARIS.MAP` binary format RE | 🔬 | Fully decode record structure to extract room IDs, type flags, exits, and map coordinates |
| RE movement protocol | 🔬 | Client → server movement commands; server → client position/environment updates. RazorWing's Type P/D/S notes were revalidated against our binary as combat-mode leads, not this M5 world-navigation path. |
| Tram / monorail RE | 🔬 | Cross-sector navigation shortcut — client command format unknown |
| Room model from `SOLARIS.MAP` | ❌ | Replace stub `World` with real rooms (bar / arena types), exits, and coordinates decoded from map files |
| Server-side position tracking | ❌ | Extend `src/state/world.ts`; track current room + coordinates per player |
| Position sync to client | ❌ | Server → client position / environment packets |

**Verification:** Single client can navigate between areas; room type (bar vs. arena) is correctly identified by the server.

---

### M6 — Single-Client Combat Loop

**Goal:** One player in an arena can engage with the combat system (even against a scripted dummy opponent).

*Depends on M5.*

| Task | Status | Notes |
|---|---|---|
| RE weapon fire packets | 🔬 | Client → server fire command; server → client hit/miss result |
| RE TIC system | 🔬 | Three Targeting Interlock Circuits (A/B/C); `[`/`]`/`\\` fire each; Space fires selected single weapon — wire format unknown |
| RE damage model | 🔬 | Location-based armor/internal structure; heat states: green → yellow (system degradation) → red → shutdown |
| RE jump jets | 🔬 | Fuel-based: depletes on jump, regenerates over time; also consumed while turning/accelerating in-flight; damaged jets reduce max jump for the match; **Z (altitude)** is tracked server state |
| RE torso/leg independence | 🔬 | Legs = heading (KP4/6/2/8); torso = facing (WASD); server must track both; compass shows both simultaneously |
| RE turn timer / match end | 🔬 | 15-minute server-enforced limit; how does server signal mech destruction / match end? |
| RE physical combat | 🔬 | Death-from-above (DFA) and alpha strike — dedicated commands or derived from positional data? |
| Implement `src/protocol/combat.ts` | ❌ | All combat packet builders and parsers |
| Scripted dummy opponent | ❌ | Server-controlled bot mech that fires back, for single-player testing |

**Verification:** Player can enter an arena, fire weapons, receive damage feedback, and reach a win/lose screen.

---

### M7 — Multi-Client Combat

**Goal:** Two human players can fight each other in real time.

*Depends on M6.*

8 sides available; players cannot all enter on the same side. **Sanctioned matches** use only arenas #1 and #2 per sector — results feed SCentEx (M9). The primary full-match use case is a **4v4 lance (8 total players)**.

| Task | Status | Notes |
|---|---|---|
| Room broadcast | ❌ | Sync combat state to all clients in the same arena |
| Player enter / leave events | ❌ | Notify existing clients when a player joins or leaves |
| Side assignment enforcement | ❌ | Cannot assign all players to the same side |
| Synchronized position | 🔬 | Each client sees other mechs move in real time. Current local Ghidra lead: combat cmd `65` / wire `0x66` (`FUN_00401820`) parses player id, X/Y/Z, rotation-ish bytes, and speed/throttle-ish byte; constants differ from RazorWing/solaris. |
| Synchronized damage | ❌ | Damage dealt by one client is reflected in all clients' views |
| Match orchestration | ❌ | Ready-up, start, 15-min timer, end, sanctioned-match flag |

**Verification:** Two `MPBTWIN.EXE` instances connect, enter the same arena, see each other, and fight to completion.

---

### M8 — Playable Game

**Goal:** The emulator is complete enough for a real play session.

*Depends on M7.*

| Task | Status | Notes |
|---|---|---|
| All 161 mechs loaded from real `.MEC` files | 🔧 | `loadMechs()` scans/parses `mechdata/*.MEC` in M1; remaining work is validating and integrating all 161 mechs for actual gameplay |
| Real Solaris arena layouts | ❌ | From M5 RE work |
| Correct mech stat handling (armor, weapons, heat) | ❌ | From `.MEC` parser + damage model |
| Client launcher — `play.pcgi` generator | ✅ | `npm run gen-pcgi` already works |
| Basic observability (logs, session captures) | ✅ | Already implemented |
| Graceful disconnect / reconnect handling | ❌ | Client timeout, mid-match drop |

**Verification:** Full play session — two humans, real mechs, real arena, fight to conclusion — with no manual intervention.

---

### M9 — SCentEx / Persistence

**Goal:** Sanctioned matches produce persistent ranking results, matching original game behaviour.

*Depends on M8. Not optional — SCentEx existed in the original game.*

| Task | Status | Notes |
|---|---|---|
| SCentEx ranking model | ❌ | Damage inflicted vs. damage sustained determines rank change after each sanctioned match |
| Player fame stat | ❌ | Per-character fame tracked (BT-MAN p. 9) |
| Tier Ranking display | ❌ | Displayed at bar terminals; served by the world navigation layer |
| Personnel record | 🔬 | First page is now identified: `Cmd7(0x3f2, target_id + 1)` triggers world `Cmd14_PersonnelRecord` (`0x2f`), which displays the selected handle, ComStar ID, battles-to-date, and six server-formatted text lines. Follow-up trace on the built-in `Cmd7(0x95, 2)` `More` request did not reveal a distinct second-page command handler; strongest current inference is that later pages are delivered as additional `Cmd14` payloads. A minimal two-page server prototype is now implemented on the branch and passes a direct world-session socket smoke (`Cmd48 -> Cmd14 page 1 -> Cmd7(0x95, 2) -> Cmd14 page 2`). Remaining unknowns: exact mapping of the six text lines and the meaning of two legacy/unused `type4` payload slots. |
| SCentEx result reporting protocol | 🔬 | How does the server communicate sanctioned match results to the ranking system? |

**Verification:** Two players complete a sanctioned match; both observe updated rankings at a bar terminal.

---

## RE Priority Queue

Work these in order when sitting down with Ghidra:

1. **`FUN_100014e0` case 0** (`COMMEG32.DLL`) — secondary connection handler. Highest value; unlocks everything in M3+.
2. **World command dispatch table** (`MPBTWIN.EXE`) — analogous to `g_lobby_DispatchTable`; gives the full command index map for the game world.
3. **Initial world handshake** — the first bytes the client expects from the world server before entering the render loop.
4. **Cmd 20 server response** (`FUN_00401c90`) — needed for M1; can be worked in parallel with items 1–3.
5. **Combat CRC crossover** — when/how the client switches to the combat CRC seed.
6. **`SOLARIS.MAP` / `IS.MAP` exit graph** — decode room-to-room connections from the map files (unlocks M5 world map without full world-server RE).
7. **F7 / F8 chat channel wire format** — are team and all-comm differentiated by command code or a flag in the packet? (M4 prerequisite).
8. **Movement packets** (M5 prerequisite).
9. **Weapon fire / damage packets** (M6 prerequisite).
10. **TIC circuit wire format** (M6 prerequisite).
11. **Jump jet / altitude state packets** (M6 prerequisite).
12. **Turn timer / match lifecycle** (M6 prerequisite).
13. **SCentEx result reporting** (M9 prerequisite).

---

## Known Unknowns

These are gaps we know exist. They are not bugs — they are the RE frontier.

- **Post-REDIRECT protocol** — everything the game world server sends and receives. No analysis has been done yet.
- **Cmd 20 server response format** — client sends "examine mech"; server reply format is unknown.
- **Cmd `0x1D` server handling** — whether the server needs to acknowledge a cancel, or silently ignore it.
- **ACK reply format for seq > 42** — the trigger is documented (RESEARCH.md §9) but the reply packet format is not.
- **Combat CRC crossover point** — the server currently always uses lobby CRC init; the transition rule is unknown.
- **`SOLARIS.MAP` / `IS.MAP` exit graph** — room topology source files identified and partially decoded (shared global room namespace confirmed: IS.MAP rooms 1–145, SOLARIS.MAP rooms 146+); full exit connections and room-type classification still unknown.
- **F7 / F8 chat channel differentiation** — two distinct broadcast channels exist (team and all-comm); wire-format difference is unknown.
- **Bar booth terminal commands** — what packets does the client send when activating Tier Ranking / ComStar terminals at a bar?
- **Tram / monorail command** — protocol for the cross-sector navigation shortcut is unknown.
- **SCentEx result-reporting protocol** — how does the server communicate sanctioned match results?
- **`.MEC` file format** — the binary format of mech definition files has not been analyzed.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow.
See [RESEARCH.md](RESEARCH.md) for all confirmed protocol details and RE methodology.

If you have access to Ghidra and want to help, the RE Priority Queue above is where to start. Open a **Research Finding** issue with your findings before opening a PR.
