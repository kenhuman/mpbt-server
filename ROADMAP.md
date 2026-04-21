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
| Post-redirect game world (world login, navigation, mech bay, combat handoff) | ✅ |
| Two-human sanctioned duel playtest | ✅ |

The emulator now goes well beyond the old redirect-only frontier: the client reaches the world, travels, selects mechs in-world, enters Solaris combat, and can complete supervised two-human sanctioned duel playtests. The remaining work is broader fidelity, richer multi-client arena behavior, and fuller late-1990s-faithful world/combat coverage.

---

## Reference Materials

These files are gitignored — place them in `research/` for local use.

| File | Contents | Project use |
|---|---|---|
| `BT-MAN.decrypted.txt` | Full game manual: world navigation, chat channels, combat controls, mech stat tables | Design reference for M4–M9; source for `src/data/mech-stats.ts` |
| `SOLARIS.MAP` | Solaris city venue locations, 189 KB. Leading room table is now reproducibly parsed: u16 record count, then room ID / flags / coordinates / aux fields / NUL-included name+description strings. Local file count is 32 records: Solaris rooms 146–171 plus sector rows 1–6; trailing non-room sections remain undecoded | M5 world map reconstruction |
| `IS.MAP` | Inner Sphere / global location table, 40 KB. Same leading room-table format; local file count is 271 records, covering room IDs 1–271, including Solaris entries duplicated in the global namespace | M5 world map; full-sector navigation |
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
| Cmd 20 — hierarchical class/mech/variant examine (issue #21) | ⏸ | **Deferred to M8** — the single-variant examine (`mode 2`) is complete. The 3-level hierarchy (class → mech list → variant details) is enhancement scope; will be revisited alongside `.MEC` file integration in M8. |
| Cmd `0x1D` — cancel/ESC in menu dialogs | ✅ | Resolved — server re-sends mech list; sending nothing freezes client |
| ACK reply for seq > 42 | 🔬 | Trigger condition documented in RESEARCH.md §9; v1.23 RE confirms `FUN_0040eb40` is a no-op stub — no ACK is sent by the combat client in v1.23. Server must not require combat ACKs. |

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
| ComStar DM — store and deliver | ✅ | `Cmd36` delivers to online recipients immediately. Offline messages are persisted to a `messages` DB table (`src/db/messages.ts`: `storeMessage` / `claimUndeliveredMessages`). The message body is stored pre-formatted and delivered atomically on the recipient's next world login (cmd-3 trigger). Offline detection: `10_000_000 + accountId` range→`recipientAccountId` derived from ComStar ID. `Reply` flow: `Cmd37(targetId)` opens the compose editor pre-addressed to the target. |
| Room broadcast | ✅ | Same-room presence seeds the roster with `Cmd10`, then uses `Cmd13` arrival and `Cmd11(status=0)` departure for incremental updates. World `cmd-4` free-text relay is implemented as room-local chat fan-out via `Cmd3`. Booth privacy implemented: booth occupants only hear each other; standing players only hear other standing players. Validated with two-GUI sandbox (2026-04-07): real Client B receives `Cmd10 RoomPresenceSync (2 entries)`, both clients exchange chat, and arrival/departure notifications fire correctly. |
| Player join / leave events | ✅ | Same-room `Cmd10` / `Cmd13` / `Cmd11(status=0)` path fully operational. Social-room status: `Cmd7(listId=3)` `selection=0` grabs a booth, `selection=2` stands, `selection>=3` joins booth `selection-2`, with `Cmd11(status=5..12)` updating the roster table. Two-GUI sandbox confirmed Client B world-init, `RoomPresenceSync`, and arrival/departure events with Client A connected. |
| F7 — team / lance channel | ❌ | Arena-only; requires `Cmd8` team assignment — moved to M7. v1.23 RE (§19.4) confirms F7 does NOT emit a network packet — it only toggles the local chat-channel UI indicator. Channel selection is implicit via the mode command (`FUN_0043d920`). |
| F8 — all-comm / chat-window toggle | ❌ | Arena-only; v1.23 RE (§19.4) confirms F8 does NOT emit a network packet — purely local UI state toggle (same `FUN_0042dc30` visual handler as F7). Moved to M7. |
| All-roster query + inquiry submenu | ✅ | KP5 → `Cmd7(listId=3, selection=1)` sends `Cmd48_KeyedTripleStringList` (`0x51`) with live sessions. Row-picks open the inquiry submenu (`INQUIRY_MENU_ID=0x3F3`; 0x3E8 is client-reserved and must not be used). `selection=1` sends `Cmd37(targetId)` to open ComStar compose; `selection=2` sends `Cmd14` personnel record. Both selections work even if the target disconnects after the submenu opens. Personnel record: `Handle` header fixed by sending a single-entry `Cmd10` (target only) before `Cmd14` — seeds `entry[0]` of the all-roster table; `ID` header fixed by shifting `comstarId` into the `FUN_00405ea0` valid range (`10_000_000 + accountId` → 5-char base-36). |

**Verification:** Two-GUI sandbox: KP5 → select target → "Send ComStar message" opens compose editor pre-addressed to correct player; "Access personnel data" shows correct Handle, ID, Rank, House, Sector, Location, Status. Offline stub shown when target disconnects between menu open and pick.

---

### M5 — World Navigation

**Goal:** A single player can move around the game world (Solaris sectors / arenas) from the server's perspective.

*Depends on M4.*

The world uses two distinct room types: **bar** (social spaces, Tier Ranking terminals, ComStar facilities) and **arena** (combat venues). Source topology: `SOLARIS.MAP` (rooms 146+, partly decoded) and `IS.MAP` (rooms 1–145) — both gitignored; see Reference Materials above.

| Task | Status | Notes |
|---|---|---|
| `SOLARIS.MAP` / `IS.MAP` binary format RE | ✅ | **DECODED** (RESEARCH.md §19.7): 2-byte LE record_count header; each record = 18-byte fixed prefix (room_id, faction, raw_x, raw_y, 4×flags) + uint8 name_len + name chars + uint8 desc_len + desc chars. IS.MAP display: `x/3+380`, `y/−3+248`; SOLARIS.MAP: identity. Parser via `npm run map:dump -- --rooms`. Ghidra confirms `Map_LoadFile` passes trailing bytes to the picture/resource loader; exits not stored in trailing blob. Needs implementation in room-loader. |
| RE movement protocol | 🔧 | **DECODED** (RESEARCH.md §19.2): client→server timer-based (100 ms). Cmd 8 (coasting): X(3w)+Y(3w)+heading(2w)+adj_vel(1w)+rotation(1w). Cmd 9 (moving): X(3w)+Y(3w)+heading(2w)+turn(1w)+0xe1c(1w)+throttle(1w)+leg(1w)+rotation(1w). Bias constant=0xe1c (3612), divisor=0xb6 (182). Travel-reply: server cmd 40/43 opens IS/Solaris map UI; client replies `cmd 10` (`type1 contextId` + `type4 selectedRoomId+1`). Real GUI validated `Travel → Cmd43 → cmd 10(selection=148) → Ishiyama Arena`. Server→client position packets (Cmd65) still 🔬. |
| Tram / monorail RE | ✅ | **RESOLVED** (RESEARCH.md §19.10): T.O.F.S. (The Tram) uses the **identical** `cmd5 actionType 4 → Cmd43 (context 0xc6) → cmd10` travel flow as regular Solaris map travel. `World_HandleMapOpenSolarisPacket_v123` has no tram-specific context branch; no separate tram command exists in the v1.23 dispatch table. No new server implementation needed. Closes issue #70. |
| Room model from map files | 🔧 | `parseMapFile()` implemented in `src/data/maps.ts`; `SOLARIS_SCENE_ROOMS` (32 rooms: 146–171 Solaris + sectors 1–6) is a hardcoded stub with provisional linear exits in `getSolarisRoomExits()`. `Cmd23` location-icon clicks handled via `handleLocationAction`; `Cmd43`→`cmd10` travel reply handled via `handleMapTravelReply`. Next: load rooms, types (bar / arena), and exits from `IS.MAP` / `SOLARIS.MAP` parsed data; replace hardcoded stub; authentic exit graph still 🔬. |
| RE world scene-action family | ✅ | **RESOLVED** (RESEARCH.md §19.6.0a): subtype `1/2` in-game noun confirmed as **Agreement** (C-bill contract between Successor State parties — `MSG[0x19e]` = `"Details of Agreement between"`). Full field-label MSG string table (`MSG[0x19e]`–`MSG[0x1b4]`) now documented. Subtype model: `1/2` = Agreement offer/review, `3` = duel, `4` = membership bid, `5/6/7` = subcontract offer/review/terms. Live capture for `cmd5 actionId → subtype` mapping deferred (not required for M5 verification). |
| Server-side position tracking | ✅ | `worldX/Y/Z` + `worldMapRoomId` on `ClientSession`; populated atomically via `setSessionRoomPosition()` in `world-data.ts` from SOLARIS.MAP `centreX/centreY` at every room transition. |
| Position sync to client | ✅ | World-mode scene position conveyed via Cmd4 `playerScoreSlot` (= room sceneIndex) — already working. Room type communicated via arena-only "Fight" button (`actionType 5`) in `buildSceneInitForSession`; Cmd65-equivalent server→client coord push in travel-world mode remains 🔬. |

**Verification:** Single client can navigate between areas; room type (bar vs. arena) is correctly identified by the server.

---

### M6 — Single-Client Combat Loop

**Goal:** One player in an arena can engage with the combat system (even against a scripted dummy opponent).

*Depends on M5.*

| Task | Status | Notes |
|---|---|---|
| RE server→client combat bootstrap / position sync | ✅ | Full bootstrap sequence documented in RESEARCH.md §19.9: Cmd72 (local mech init) → Cmd64 (remote actors) → Cmd65 (initial positions) → Cmd62 (combat-start, clears SPACEBAR block). SpeedMag Cmd65 echo implemented and confirmed on HUD gauge (§19.10). |
| Combat movement + speedMag physics | ✅ | Cmd8 (coasting) and Cmd9 (moving) client→server are parsed and handled with the corrected `.MEC` speed split from RESEARCH.md §24: `walkSpeedMag = mec_speed × 300`, `maxSpeedMag = round(mec_speed × 1.5) × 300`, and full-forward Cmd9 scaling now uses `THROTTLE_RUN_SCALE = 20` instead of the old `45`. TAP-mode Cmd8 echo suppression remains required so local throttle ownership is not overwritten, and current live-combat server policy also walk-caps reverse drift / echoed reverse `speedMag` for range pressure parity. HUD speed gauge confirmed working. |
| In-world 3-step mech picker (Mech / Mech Bay) | ✅ | Class → chassis → variant flow implemented. Arena scenes now label action type `6` as `Mech`; non-arena rooms still show `Mech Bay`. Safe listIds: `0x20` (class/variant), `0x3e` (chassis). Cursor-freeze fix: `Cmd5 CURSOR_NORMAL` sent after every `Cmd26` and after post-selection `Cmd3`. Selected mech slot stored in `session.selectedMechSlot`. See RESEARCH.md §23. |
| RE weapon fire packets | 🔧 | v1.23 client → server fire request decoding in RESEARCH.md §19.3 is now tighter: `Combat_SendCmd12Action_v123` emits `cmd 12`, but fresh 2026-04-20 caller audit shows its `action 0` caller is the downed recovery branch in `Combat_InputActionDispatch_v123`, while the other two live callers are jump start (`4`) and landing (`6`). That weakens the old "action0 is ordinary fire" interpretation further; current server combat still relies on `cmd10` shot geometry for actual weapon fire acceptance, with TIC volleys already proven to arrive as direct bundled `cmd10`. Server `Cmd68` is projectile/effect spawn; `Cmd66`/`Cmd67` now carry damage code/value updates. |
| RE TIC system | ✅ N/A | Three Targeting Interlock Circuits (A/B/C): v1.23 RE **confirms TIC is entirely client-local**. Toggle membership stored in local arrays (`DAT_004f2128`, `DAT_004f2150`, `DAT_004f2178`); TIC group fire calls a local effect path only. No separate network sender exists. No server-side player TIC protocol implementation is needed. Dynamic capture still needed to clarify whether `cmd 12/action 0` targets the selected weapon, selected TIC group, or all queued weapons. Current server note: bot AI may still derive TIC-style volley presets locally from weapon/heat data without changing this protocol conclusion. |
| RE damage model | 🔧 | v1.23 damage-result path is partially decoded in RESEARCH.md §19.6.1: `Cmd66` applies actor damage code/value pairs, `Cmd67` applies local-actor pairs, and the shared classifier partitions codes into critical/system, armor-like, internal-like, weapon, and ammo-bin ranges. `.MEC` offset correction: `0x3c` is a signed critical/equipment range bound and weapon ids start at `0x3e`. Exact section labels, kill semantics, and heat/system-degradation mapping still need live capture. |
| RE non-death fall / recovery fidelity | 🔬 | The server can now prove multiple left-leg loss probes on the wire (`Cmd70/8`, `1->8`, `4->8->6`, `1->4->8->6`, and local recovery `1->8->0`), and all meaningful variants tried so far are GUI-validated as visually insufficient: the retail client stays upright. Ghidra now narrows the recovery side: local slot `0` ignores inbound `Cmd70/4` and `Cmd70/6`, inbound `Cmd70/0` is the strongest current local recovery-ack candidate, and F12 stand-up should emit wire `cmd12/action0` only when the client is truly down. The latest live callback proof closes that local gate (`+0xdc bit 0x10` must clear before F12 sends), and fresh caller audit shows `cmd12/action0` comes from the recovery branch rather than ordinary weapon fire. Based on that, the server-side stateful `action0 -> Cmd70/0` path has now been promoted beyond the old env-gated experiment; the remaining blocker is full retail-visible fall/recovery fidelity, not the old timer heuristic. |
| RE jump jets | 🔧 | Fire command **decoded** (§19.3): client sends ESC+'!'+0x2D+0x25+CRC (cmd=12, action=4) via `Combat_SendCmd12Action_v123('\x04')`; landing/touchdown sends `cmd 12/action 6`. The server now matches several confirmed client guards instead of the older loose prototype: jump fuel uses the client's `0x78`/`120` cap, start requires fuel `> 0x32`/`50`, duplicate airborne start is rejected, and grounded recharge follows a single timer path closer to the client's main-loop regen instead of the old per-frame + passive combo. Remaining 🔬: exact airborne drain breakdown by thrust/turn/velocity flags, authoritative altitude/landing semantics for `action 6`, and no-jump chassis validation against broader `.MEC` data. |
| Implement `src/protocol/combat.ts` | ✅ | All combat packet builders: Cmd64–Cmd73 implemented; combat entry wired in server-world.ts via `/fight` text command; MMC welcome + Cmd72 bootstrap sent on trigger |
| Selected mech → combat bootstrap propagation | ✅ | World mech selection now feeds live combat bootstrap state. `tools\\duel-selected-mech-smoke.mjs` proves the shared duel path sends each pilot's chosen mech ID through `Cmd72` (local) and `Cmd64` (remote) on both clients. |
| RE torso/leg independence | 🔬 | Legs = heading (KP4/6/2/8); torso = facing (WASD); server must track both; compass shows both simultaneously |
| RE turn timer / match end | ✅ | **RE complete (issue #79, §23):** No server-to-client match-end packet exists. Win = client local sim kills enemy → results loop → exit key → TCP close. Loss = Cmd67 IS damage → actor-0 IS=0 → disconnect timer → TCP close. Server stops Cmd67 when `playerHealth ≤ 0`. |
| RE physical combat | 🔬 | Death-from-above (DFA) and alpha strike — dedicated commands or derived from positional data? |
| RE v1.23 RPS→combat state handoff | 🔬 | `MMW` welcome enters `"Solaris RPS"`; later `MMC` welcome enters `"Solaris COMBAT"` only after RPS is established. `"Transition to combat - even"` is an internal music state, not a server payload. |
| Scripted dummy opponent | 🔧 | The old static dummy has been replaced by a much more retail-like combat bot. It now maintains persistent remote position/facing, maneuvers to matchup-aware preferred range, uses jump jets tactically, strafes/jinks under threat, applies movement-aware to-hit rolls in both directions, derives TIC-style volley presets from heat/weapon data, and now keeps its retreat / reverse behavior inside the same walk-capped reverse envelope the live player path uses. Bot range holding and jump-fit planning are also ammo-aware, so spent long-range bins no longer keep it kiting for bands it cannot actually threaten. Remaining work is live tuning and any deeper retail fidelity gaps that only show up in manual duels. |

**Verification:** Player can enter an arena, fire weapons, receive damage feedback, and reach a win/lose screen.

---

### M7 — Multi-Client Combat

**Goal:** Two human players can fight each other in real time.

*Depends on M6.*

Manual-backed arena staging model: the ready room exposes `MECH`, `SIDE`, and `STATUS`; `SIDE` offers eight sides, and players on the same side are teammates. Current implementation assumption: cap an arena ready room at **8 participants**, matching the eight-side model, unless stronger contrary evidence appears. **Sanctioned matches** use only arenas #1 and #2 per sector — results feed SCentEx (M9). The primary full-match use case is a **4v4 lance (8 total players)**.

| Task | Status | Notes |
|---|---|---|
| Room broadcast | ❌ | Sync combat state to all clients in the same arena |
| Player enter / leave events | ✅ | Generic same-room `Cmd13` arrival / `Cmd11(status=0)` departure already work for arena rooms, `tools\\arena-room-smoke.mjs` live-validates arena ready-room arrival/departure visibility, and the lone-pilot combat fallback now uses the same departure/restore announcement path. |
| Side assignment enforcement | 🔧 | Arena scenes now expose `SIDE`, and same-side duel staging is rejected once both pilots explicitly pick the same side. Broader multi-party side-cap enforcement is still open. |
| Arena ready-room roster / listing model | 🔧 | Manual proves `MECH` / `SIDE` / `STATUS` and eight sides; current server assumption is max 8 participants. Arena entry now opens a live ready-room chooser, ready rooms are tracked as `Ready Room N` under each arena, `STATUS` titles/presence text/reconnect restore preserve that room identity, and a full room is rejected on selection instead of silently overfilling. Custom room naming, an explicit room-size selector, and explicit FFA/team-play labels remain unproven. |
| Synchronized position | 🔬 | Each client sees other mechs move in real time. Current local Ghidra lead: combat cmd `65` / wire `0x66` (`FUN_00401820`) parses player id, X/Y/Z, rotation-ish bytes, and speed/throttle-ish byte; constants differ from RazorWing/solaris. |
| Synchronized damage | ❌ | Damage dealt by one client is reflected in all clients' views |
| Match orchestration | 🔧 | Arena fights can now start as shared combat directly from `READY` when 2..8 pilots are in the same arena ready room. Remaining gaps are the full 15-minute match timer, end-of-match orchestration/settlement, and the sanctioned-match flag. |
| F7 — team / lance channel | 🔬 | Scoped broadcast to your lance teammates; v1.23 RE confirms F7 is local-only (no network packet). The server-side team-channel fan-out mechanism (identifying which clients are on the same lance) remains 🔬; wire format unknown. Requires `Cmd8` team assignment to be established. |
| F8 — all-comm channel | 🔬 | Broadcast to all players in the current arena match; v1.23 RE confirms F8 is local-only (no network packet). The all-comm delivery mechanism and any associated server→client command remain 🔬. |

Live robustness coverage now also includes `tools\\duel-reconnect-restore-smoke.mjs`, which reconnects a participant during the post-duel restore window and confirms deferred settlement delivery plus selected-mech persistence on the replacement session.

**Verification:** Two `MPBTWIN.EXE` instances connect, enter the same arena, see each other, and fight to completion.

---

### M8 — Playable Game

**Goal:** The emulator is complete enough for a real play session.

*Depends on M7.*

| Task | Status | Notes |
|---|---|---|
| All 161 mechs loaded from real `.MEC` files | 🔧 | `loadMechs()` scans/parses `mechdata/*.MEC` in M1. Mech examine/status surfaces and the world mech picker now expose `.MEC`-derived tonnage, walk/run speed, and jump-jet presence across all variants; remaining work is actual gameplay integration (armor, weapons, heat, internal state). |
| Real Solaris arena layouts | ❌ | From M5 RE work |
| Correct mech stat handling (armor, weapons, heat) | 🔧 | `.MEC`-driven weapon/heat fidelity is no longer purely placeholder: weapon families now carry direct damage, cooldown, per-weapon S/M/L range caps, and mech heat-sink counts; combat uses the real long-range table from `screenshots/weapon-ranges.png` (including `AC/10 = 360m`) and bot range-band logic now uses explicit per-weapon S/M/L caps instead of generic `90/270` heuristics. Bot TIC/range planning also now follows the **usable** loadout instead of stale mounted range alone, so expected-damage and jump-fit decisions ignore ammo-depleted weapons. Remaining work is broader gameplay integration: armor/internal fidelity, heat/system-degradation behavior, and any additional retail-only stat surfaces still missing from RE. |
| Client launcher — `play.pcgi` generator | ✅ | `npm run gen-pcgi` already works |
| Basic observability (logs, session captures) | ✅ | Already implemented |
| Graceful disconnect / reconnect handling | 🔧 | ARIES type-`0x05` keepalive is now sent periodically by the server and echoed by the client, matching COMMEG32.DLL `FUN_100014e0` case `5`. `ARIES_KEEPALIVE_INTERVAL_MS` and `SOCKET_IDLE_TIMEOUT_MS` are configurable so long GUI validation sessions are not cut off by the old hardcoded 120-second idle timeout. Real two-GUI validation on 2026-04-07 confirmed both `MPBTWIN.EXE` sessions remained connected beyond 120 seconds and replied to repeated world keepalive pings. Lobby→world reconnect now restores the previous room, selected mech, and deferred duel-settlement notice; replacement-session settlement sync also covers disconnect/reconnect timing races. Longer mid-match recovery and broader world-session restoration are still incomplete. |

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
| Personnel record | 🔬 | First page is now identified: `Cmd7(0x3f2, target_id + 1)` triggers world `Cmd14_PersonnelRecord` (`0x2f`), which displays the selected handle, ComStar ID, battles-to-date, and six server-formatted text lines. Follow-up trace on the built-in `Cmd7(0x95, 2)` `More` request did not reveal a distinct second-page command handler; strongest current inference is that later pages are delivered as additional `Cmd14` payloads. A minimal two-page server prototype is now implemented on the branch and passes a direct world-session socket smoke (`Cmd48 -> Cmd14 page 1 -> Cmd7(0x95, 2) -> Cmd14 page 2`). New client disassembly confirms the remaining header limitation too: `Cmd14` takes header `ID` from packet payload, but header `Handle` still comes from the client-local room-roster cursor, so the server cannot currently make both header values target-correct at once. Remaining unknowns: exact mapping of the six text lines and the meaning of two legacy/unused `type4` payload slots. |
| SCentEx result reporting protocol | 🔬 | How does the server communicate sanctioned match results to the ranking system? |

**Verification:** Two players complete a sanctioned match; both observe updated rankings at a bar terminal.

---

## RE Priority Queue

Work these in order when sitting down with Ghidra:

1. ~~**`FUN_100014e0` case 0** (`COMMEG32.DLL`) — secondary connection handler.~~ ✅ Resolved (RESEARCH.md §17)
2. ~~**World command dispatch table** (`MPBTWIN.EXE`).~~ ✅ Resolved (RESEARCH.md §18)
3. ~~**Initial world handshake**.~~ ✅ Resolved (RESEARCH.md §18)
4. ~~**Cmd 20 server response** (`FUN_00401c90`).~~ ✅ Resolved (M1 complete)
5. ~~**Combat CRC crossover**.~~ ✅ Resolved — `g_combatMode` flag selects seed; RPS=`0x0a5c25`, Combat=`0x0a5c45` (RESEARCH.md §18)
6. ~~**`SOLARIS.MAP` / `IS.MAP` exit graph** — decode room-to-room connections.~~ ✅ Leading room tables fully decoded (RESEARCH.md §19.7); provisional exit tree implemented in server-world.ts; authentic exit graph from trailing section still needs RE.
7. **Non-death fall / recovery local state** — why does the retail client remain upright even after proven local `Cmd70` fall/collapse/recover probes, and what additional local state unlocks wire `cmd12/action0` stand-up?
8. **F7 / F8 chat channel wire format** — are team and all-comm differentiated by command code or a flag in the packet? (M7 prerequisite; both channels require `Cmd8` team assignment and are arena-phase only).
9. **Movement packets** — ✅ DECODED (RESEARCH.md §19.2): Cmd8 (coasting) and Cmd9 (moving) client→server formats fully mapped; bias/divisor constants confirmed. Server→client position (Cmd65) implemented and confirmed in live combat test.
10. **Weapon fire / damage packets** — ✅ DECODED (RESEARCH.md §19.3 / §19.9): weapon fire acceptance is now grounded primarily on `cmd10` shot geometry, while recovery-side RE shows `cmd12/action 0` is reused for stand-up when already down rather than being a clean dedicated ordinary-fire opcode. Server `Cmd62` (wire `0x5F`) unblocks the fire gate by clearing `DAT_0047ef60` bit `0x20`. Damage model (Cmd66/Cmd67) is partially decoded; round-trip hit confirmation is strong enough for current combat play, but deeper retail damage/heat fidelity still needs capture. |
11. **TIC circuit wire format** (M6 prerequisite).
12. **Jump jet / altitude state packets** (M6 prerequisite) — fire command decoded; fuel/regen/Z-altitude still 🔬.
13. **Turn timer / sanctioned match lifecycle** (M6/M7 prerequisite) — local win/loss disconnect path is understood, but the shared 15-minute arena timer and broader sanctioned settlement/orchestration are still open.
14. **SCentEx result reporting** (M9 prerequisite).

---

## Known Unknowns

These are gaps we know exist. They are not bugs — they are the RE frontier.

- **`SOLARIS.MAP` / `IS.MAP` exit graph** — leading room tables are fully decoded (RESEARCH.md §19.7); the trailing binary section (picture/resource data) still needs a separate movement/topology RE pass to extract authentic room-to-room exit connections and room-type classifications.
- **F7 / F8 chat channel differentiation** — two distinct broadcast channels exist (team/lance and all-comm); both are arena-phase constructs gated on `Cmd8` team assignment; wire-format difference is unknown. Tracked in M7.
- **Bar booth terminal commands** — `KP5` → `Cmd48` all-roster query and `Cmd7(0x3f2)` personnel record are implemented; Tier Ranking terminal activation format is still unknown.
- **Arena ready-room creation / listing UI** — manual evidence proves `MECH`, `SIDE`, and `STATUS` in the ready room plus an eight-side team model; current server work assumes up to 8 participants, but custom room naming, an explicit room-size selector, and explicit FFA/team-play labels remain unproven.
- **Tram / monorail command** — ✅ **RESOLVED** (RESEARCH.md §19.10): T.O.F.S. uses the same `cmd5 actionType 4 → Cmd43 → cmd10` path as regular Solaris travel; no separate tram command. Closes issue #70.
- **SCentEx result-reporting protocol** — how does the server communicate sanctioned match results?
- **Non-death fall / recovery local state** — retail still stays upright after every meaningful server-side `Cmd70` probe tried so far, including local `1->8->0`. Ghidra now says F12 stand-up should become wire `cmd12/action0` only when the client is truly down, but the latest live `legrecover` validation still produced no `cmd12/action0`, no `cmd10`, and no posture change. The missing state transition that makes the client consider itself recoverable is still unknown.
- **Server→client combat position sync (`Cmd65`)** — implemented and live-confirmed for bootstrap/movement echo, but fuller field semantics for remote multi-client sync still need stronger capture confirmation.
- **TIC group fire** — whether `cmd 12/action 0` means selected weapon, selected TIC group, or all queued fire needs dynamic capture to confirm.
- **Jump jet fuel / Z-altitude state** — fire (`cmd 12/action 4`) and landing (`cmd 12/action 6`) decoded; fuel depletion, regeneration rate, and server→client altitude feedback still unknown.
- **Turn timer / sanctioned match lifecycle** — the local win/loss disconnect path is now understood, but the shared 15-minute arena timer, mech-kill broadcast/settlement behavior, and sanctioned-match orchestration are still unconfirmed.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow.
See [RESEARCH.md](RESEARCH.md) for all confirmed protocol details and RE methodology.

If you have access to Ghidra and want to help, the RE Priority Queue above is where to start. Open a **Research Finding** issue with your findings before opening a PR.
