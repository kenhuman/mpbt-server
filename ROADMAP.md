# Roadmap

## Vision

Build a server emulator that lets the original retail **Multiplayer BattleTech: Solaris v1.29 client** (`MPBTWIN.EXE`, released June 24, 1999) connect, create or resume a character, move through Solaris, select mechs, enter sanctioned and unsanctioned arena fights, complete real-time multiplayer BattleMech combat, and persist SCentEx-style results without any Kesmai infrastructure.

This roadmap is intentionally scoped to the **retail v1.29 client**. Earlier v1.23 work remains valuable as reverse-engineering history, but completion is measured against the 1999 retail client behavior.

## Roadmap Rules

| Icon | Meaning |
|---|---|
| ✅ | Complete and tested against a real retail client |
| 🟡 | Implemented or mostly understood, but needs v1.29 hardening or broader coverage |
| 🔬 | Reverse-engineering blocker |
| ❌ | Not started |

## Commit-History Read

The project moved from first lobby compatibility to playable arena prototypes quickly:

- 2026-04-05 to 2026-04-07: lobby, `.MEC` roster, command 20, character/world entry, v1.23 protocol RE.
- 2026-04-08 to 2026-04-11: M4/M5 world travel, map parsing, combat entry, movement/control frames.
- 2026-04-10 to 2026-04-17: concentrated M6/M7 combat work: jump jets, firing gates, match-end scenes, ready rooms, sanctioned duel flow.
- 2026-04-18 to 2026-04-22: retail combat fidelity work: fall/recovery, gait, ammo, radar distance, bot behavior, arena regressions.
- 2026-04-23 to 2026-04-27: v1.29 migration: world command repurposing, Solaris live testing, travel fallback, bot team bootstrap fidelity.

Practical implication: the remaining work is not a wholesale protocol rewrite. It is v1.29-specific completion: safer Solaris UI routing, accurate arena staging, multi-client combat fidelity, sanctioned-battle lifecycle, SCentEx persistence, and long-running operational hardening. Client-visible mech-management screens exist in v1.29, but firsthand GameStorm behavior indicates buy-ammo/repair/name-mech style flows were not part of live 1999 gameplay, so they are post-completion research rather than launch-blocking server scope.

## Current Baseline

| Area | Status | Notes |
|---|---|---|
| ARIES transport, login, keepalive, redirect | ✅ | `COMMEG32.DLL` and `INITAR.DLL` are byte-identical between the local v1.23 and v1.29 installs; no new transport contract is expected just because of v1.29. |
| Lobby and world login | ✅ | Returning players can skip character creation and enter world; first-login character creation is implemented. |
| Room presence, room chat, ComStar DM | ✅ | Room roster, arrivals/departures, booths, online/offline messages, reply flow, and personnel-record basics exist. |
| Solaris travel | 🟡 | v1.29 `Cmd40`/`Cmd43` browser family and `Cmd49` overlays are understood enough for current travel; authentic topology and all facility flows need completion. |
| In-world mech picker | ✅ | Class/chassis/variant picker feeds combat bootstrap. Retail completion requires selection/loadout fidelity, not dormant repair or ammo-purchase economics. |
| Arena ready rooms | 🟡 | `MECH` / `SIDE` / `STATUS`, same-room staging, readiness, and 2..8 pilot launch are partly implemented. Full sanctioned lifecycle is not complete. |
| Single-client combat | 🟡 | Movement, jump jets, selected mech bootstrap, bot opponent, firing, damage feedback, and result scenes exist. Retail heat/damage/fall fidelity still needs closure. |
| Multi-client combat | 🟡 | Two-human sanctioned duel playtests are possible. Broader 4v4/team behavior, synchronized damage/state, and settlement hardening remain. |
| v1.29 world UI migration | 🟡 | Major repurposed commands are known (`Cmd39`, `Cmd44`, `Cmd46`, `Cmd57`, `Cmd45`/`Cmd58`), but some server surfaces still use conservative compatibility routes. |
| Rankings / SCentEx | 🟡 | Emulator ranking pages and duel persistence exist. Exact retail formula, result routing, and Team Sanctioned Battle reporting are not complete. |

## Completion Definition

The emulator is complete enough for a first public retail-v1.29 server when all of the following are true:

- A clean retail v1.29 install can connect through the normal launcher flow with no binary patches other than optional local windowing helpers.
- A new account can create a character, select allegiance, enter Solaris, travel, use ComStar, and persist state.
- Returning accounts restore world room, selected mech, messages, ranking state, and pending settlement notices.
- Players can use Solaris facilities needed for routine 1999 play: travel, ComStar, mech selection, arena ready rooms, rankings/results, and personnel records.
- At least one sanctioned 1v1 duel path is retail-stable end to end: staging, entry, combat, result scene, disconnect/restore, C-bill transfer, ranking update.
- Multi-player arena fights support the retail eight-side model and at least 4v4 lance-scale play without state desync.
- Combat uses real `.MEC` data for movement, weapons, ammo, armor/internal state, heat, jump capability, and critical effects as far as the retail client exposes them.
- Long-running sessions survive keepalives, disconnect/reconnect, duplicate-login replacement, combat result timing, and common client focus/window quirks.
- All remaining deviations from known retail behavior are documented as intentional compatibility choices.

## Milestones

### M0 — Preserve the Retail v1.29 Contract

**Goal:** Keep the project aligned to the actual June 1999 client rather than drifting around older v1.23 assumptions.

| Task | Status | Notes |
|---|---|---|
| Document v1.29 binary baseline | ✅ | `RESEARCH.md` records v1.29 file version, size, and SHA-256 plus byte-identical `COMMEG32.DLL` / `INITAR.DLL`. |
| Keep ARIES transport unchanged | ✅ | v1.29 does not require a new login, redirect, keepalive, or launcher contract. |
| Track repurposed v1.29 world opcodes | 🟡 | Known: old v1.23 meanings for `Cmd39`, `Cmd44`, and `Cmd46` are unsafe for v1.29. |
| Maintain v1.29 regression tests/smokes | 🟡 | Existing socket and GUI-driven probes should be kept; add explicit v1.29 fixtures for every fixed compatibility issue. |

**Exit criteria:** Every new server-visible feature states whether it targets v1.29 directly or is a v1.23-era compatibility fallback.

### M1 — Stable Retail Login, Account, and Character Flow

**Goal:** A retail v1.29 player can reliably get from launcher to world.

| Task | Status | Notes |
|---|---|---|
| ARIES login and redirect | ✅ | Transport, `LOGIN_REQUEST` / `LOGIN`, `SYNC`, welcome, and `REDIRECT` are implemented. |
| Account auth and first-login character creation | ✅ | PostgreSQL accounts/characters and House allegiance selection exist. |
| Returning-player direct world entry | ✅ | Existing character skips creation and redirects to world. |
| Duplicate-login/session replacement | 🟡 | Replacement behavior exists; broaden coverage for lobby, world, ready room, combat, and post-result windows. |
| Launcher/test tooling | 🟡 | `play.pcgi` generation exists; improve reproducibility for fresh per-launch retail-client validation. |

**Exit criteria:** Ten clean v1.29 launcher runs in a row can create or resume characters without manual recovery.

### M2 — Solaris World Core

**Goal:** The world layer is stable enough for ordinary social play.

| Task | Status | Notes |
|---|---|---|
| Room presence and chat | ✅ | Same-room roster, arrival/departure, booth privacy, and room-local text relay work. |
| ComStar direct messages | ✅ | Online and offline message delivery works. |
| All-roster inquiry and personnel record | 🟡 | `Cmd48` / `Cmd14` path works, but personnel-record page semantics and target header limitations need cleanup. |
| Facility entry model | 🟡 | Travel and arena entry exist. Bar terminal, global ComStar access, and facility-specific action menus need retail-safe coverage. |
| World reconnect restore | 🟡 | Room/mech/deferred settlement restore exists; expand to all world UI states that matter. |

**Exit criteria:** Two retail clients can spend 30 minutes in world using travel, room chat, ComStar, roster/personnel lookup, and reconnects without stale presence or broken UI state.

### M3 — v1.29 Solaris Browser and Menu Surfaces

**Goal:** Replace unsafe v1.23-shaped UI assumptions with v1.29-correct command families.

| Task | Status | Notes |
|---|---|---|
| `Cmd40` / `Cmd43` location browser | 🟡 | v1.29 browser family is mapped; server should consistently use the v1.29-safe path for travel and grouped Solaris browsing. |
| `Cmd49` map connector overlay | 🟡 | Handler is identified; use it where retail map links are known. |
| `Cmd45` / `Cmd58` scroll-list shell | 🟡 | Accepted body syntax for rankings/results is emulator-proven against v1.29; keep it as the safe paged-list surface. |
| `Cmd57` hotkey selection menu | 🔬 | Strong v1.29 chooser candidate, but preset/control-strip details are still risky. Do not replace working compatibility menus until a safe builder is proven. |
| Remove unsafe old `Cmd44`/`Cmd46` usage | 🟡 | v1.29 repurposes them; keep explicit builders only for the new meanings. |

**Exit criteria:** Travel, ranking choosers, mech-selection surfaces, and result pages use v1.29-safe surfaces with no accidental v1.23 opcode semantics.

### M4 — Map, Room, and Facility Model

**Goal:** Solaris feels like a coherent world, not a hardcoded room stub.

| Task | Status | Notes |
|---|---|---|
| Parse `SOLARIS.MAP` and `IS.MAP` leading room tables | ✅ | Leading room records are decoded and loaded. |
| Use real room names/descriptions/icons | 🟡 | Room descriptions are wired; complete icon/facility metadata and fallback behavior. |
| Authentic travel topology | 🔬 | Leading map tables do not contain exits. Need either RE of server-side topology clues, manual reconstruction, or documented approximation. |
| Room/facility classification | 🟡 | Arena vs. non-arena is enough for current flow; bar/terminal/bank/hub/street semantics need completion. |
| Tram/T.O.F.S. behavior | ✅ | Same travel flow as ordinary Solaris map travel; no separate command needed. |

**Exit criteria:** A player can navigate all known Solaris sectors/facilities exposed by the v1.29 client, with documented topology choices.

### M5 — Asset-Backed Mech Selection and Combat State

**Goal:** Server-owned mech selection and combat state match the retail data the client actually used during 1999 play.

| Task | Status | Notes |
|---|---|---|
| Load all `.MEC` variants | ✅ | Roster and mech IDs come from real assets and `MPBT.MSG`. |
| Use `.MEC` movement fields | ✅ | Walk/run split, speedMag, and jump-jet presence are integrated. |
| Use `.MEC` weapons/ammo/heat/armor/internal fields | 🟡 | Weapon ranges, ammo bootstrap, heat sinks, and key armor/internal values are partly integrated; complete all combat-critical fields. |
| Selected-mech persistence | 🟡 | Preserve the selected mech across world, ready-room, combat, reconnect, and result-restore flows. |
| Deliberately defer inactive mech-management economics | ✅ | `Cmd30`, `Cmd31`, and repurposed `Cmd39` are useful RE findings, but GameStorm-era play did not expose functional buy-ammo/repair/name-mech loops. Keep them out of the completion path unless new retail evidence proves otherwise. |

**Exit criteria:** A player can select a retail `.MEC` variant, enter world/ready-room/combat with that selection intact, fight with asset-backed movement/weapons/ammo/heat/armor data, and return to world without loadout or result-state corruption.

### M6 — Single-Client Combat Fidelity

**Goal:** One retail v1.29 client can fight a server bot with retail-shaped movement, weapons, damage, and result flow.

| Task | Status | Notes |
|---|---|---|
| Combat bootstrap (`Cmd72`, `Cmd64`, `Cmd65`, `Cmd62`) | ✅ | Local and remote actor setup works. |
| Movement and radar distance | ✅ | Recent history aligned movement/speed and radar distance with the retail client. |
| Jump jets including low-jet v1.27+ behavior | 🟡 | v1.29 confirms non-zero jump capability, not a four-jet minimum. Finish fuel, altitude, landing, and damage edge cases. |
| Weapon fire and projectile/effect updates | 🟡 | `cmd10` shot geometry and `Cmd68`/`Cmd69` effects are usable; finish ordinary vs. TIC volley semantics. |
| Damage, heat, criticals, ammo | 🟡 | Current model is playable but not complete retail fidelity. Heat/system degradation and all critical sections need closure. |
| Fall/recovery | 🟡 | v1.29 confirms `Cmd70` remains the main fall/landing/collapse driver; 60 FPS cap solved the visible slow-fall symptom. Finish recovery/stand-up and damaged-leg edge cases. |
| Bot opponent | 🟡 | Bot AI is increasingly retail-like; keep it deterministic enough for tests and configurable enough for play. |

**Exit criteria:** A single player can complete repeated bot fights with no stuck combat gate, no bogus speed/altitude state, correct result scene, and documented remaining combat deviations.

### M7 — Multi-Client Arena Combat

**Goal:** Multiple retail v1.29 clients can fight each other in real time with coherent state.

| Task | Status | Notes |
|---|---|---|
| Arena ready-room identity | 🟡 | Ready rooms, `MECH`, `SIDE`, `STATUS`, and room capacity exist; harden for all room counts and reconnects. |
| Team/side bootstrap | 🟡 | Recent upstream work improved bot team bootstrap fidelity; generalize to all human/bot combinations. |
| Remote movement/gait sync | 🟡 | Remote gait and position have received fixes; build stronger long-running multi-client tests. |
| Synchronized damage and death state | 🟡 | Ensure all clients see the same armor/internal, fall, destruction, and result state. |
| Arena chat channels | 🔬 | F7/F8 are local UI toggles; server-side fan-out depends on team/all-comm mode inference and team assignment. |
| Match orchestration | 🟡 | Shared combat can start from ready rooms; finish timers, disconnect policy, result settlement, and cleanup. |

**Exit criteria:** Four or more clients can enter the same arena, split into sides, fight, see consistent remote state, and return to world cleanly.

### M8 — Sanctioned Battles and SCentEx

**Goal:** Sanctioned play affects persistent rankings and player history like the retail service.

| Task | Status | Notes |
|---|---|---|
| Sanctioned duel lifecycle | 🟡 | First duel progression and C-bill settlement exist; finish all arena/session edge cases. |
| Team Sanctioned Battles | 🔬 | v1.27 introduced support; v1.29 still needs explicit server-visible lifecycle RE and implementation. |
| SCentEx formula | 🔬 | Current ranking model is emulator-owned. Retail damage-inflicted/sustained and fame/rank math need RE or documented approximation. |
| Ranking/result display | 🟡 | `Cmd45`/`Cmd58` pages are accepted by v1.29; `Cmd41` score matrix is a likely results surface. Finish safe result/ranking routing. |
| Personnel and public history | 🟡 | Basic personnel records exist; finish battles-to-date, fame, rank, house, mech, and result history pages. |
| Durable result settlement | 🟡 | Duel results persist; make settlement idempotent across disconnect/reconnect/server restart. |

**Exit criteria:** Two or more players complete sanctioned matches and can immediately see correct C-bill, fame/rank, personnel, and ranking/result updates from retail UI surfaces.

### M9 — Operational Hardening

**Goal:** The emulator can run unattended for real users.

| Task | Status | Notes |
|---|---|---|
| Database migrations and backups | 🟡 | Schema/migrate tooling exists; add operational backup/restore guidance and migration checks. |
| Observability | 🟡 | Logs and captures exist; add structured event IDs for session, combat, settlement, and packet-failure analysis. |
| Long-running soak tests | ❌ | Add multi-client soak covering world idle, travel, ComStar, arena staging, combat, result restore, and reconnect. |
| Config and deployment | 🟡 | Docker and env config exist; harden for public server deployment. |
| Abuse/duplicate/session controls | 🟡 | Duplicate session handling exists; complete rate limits, stale locks, and admin recovery tools. |

**Exit criteria:** A public test weekend can run without manual database surgery or server restarts for routine failures.

### M10 — Completion Polish

**Goal:** Close the difference between “playable” and “credible retail service.”

| Task | Status | Notes |
|---|---|---|
| Retail comparison matrix | ❌ | For every known retail surface, list implemented / approximate / intentionally absent. |
| Manual-backed gameplay audit | ❌ | Re-read BT manual against implemented world, mech, combat, and SCentEx behavior. |
| Compatibility docs | ❌ | Document exact required client version, assets, launcher flow, optional windowing shim, and known client quirks. |
| Admin/player docs | ❌ | Account creation, server setup, backup, troubleshooting, and play guide. |
| Release candidate test plan | ❌ | Freeze feature surface and run full regression checklist against clean v1.29 installs. |

**Exit criteria:** A new operator can deploy the server and a new player can connect with a retail v1.29 install using only documented steps.

## RE Priority Queue

Work these in order when doing Ghidra / live-client sessions:

1. **Team Sanctioned Battles**: server-visible lifecycle, side/team assignment details, result aggregation, and whether any v1.27+ opcode family is involved.
2. **SCentEx formula and result routing**: rank/fame/C-bill math, `Cmd41` score matrix role, and persistent public history.
3. **Combat heat/damage/critical fidelity**: heat buildup/dissipation, shutdown, ammo explosions, weapon disablement, section labels, and death/cripple boundaries.
4. **Jump/altitude edge cases**: fuel drain, recharge, landing, jump-jet damage, DFA/physical attacks if present.
5. **Arena chat channels**: F7/F8 local UI state and the server-visible distinction for team/all-comm delivery.
6. **World topology and facility menus**: authentic room graph, bar terminals, ComStar global entry, bank/terminal/hub actions.
7. **`Cmd57` safe builder**: prove the chooser preset/control-strip contract before using it for production ranking or menu flows.
8. **v1.28+ anti-hack/guard surfaces**: confirm whether any runtime guard affects server-visible behavior in v1.29.
9. **Long-run retail-client timing**: keep validating 60 FPS cap, result timers, fall/recovery timing, and focus/window repaint quirks.
10. **Post-completion mech-management surfaces**: exact `Cmd26` → `Cmd30` → `Cmd31` / `Cmd39` row order and submit behavior for repair/reload/buy-extra-ammo/name-mech, kept as optional future work unless new evidence shows GameStorm used it.

## Known Unknowns

- Exact retail SCentEx ranking formula and Team Sanctioned Battle settlement.
- Authentic Solaris room topology beyond decoded map room records.
- Full mech bay repair/reload/extra-ammo/name-mech contracts in v1.29, treated as post-completion client-capability research rather than required 1999 GameStorm behavior.
- Whether `Cmd57` can be safely used for production choosers without drawing unrelated stock controls.
- Full heat, shutdown, critical, ammo explosion, and physical-combat behavior.
- Complete arena team/all-comm delivery semantics.
- Whether v1.28+ anti-hack strings have any server-visible consequence.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow.
See [RESEARCH.md](RESEARCH.md) for confirmed protocol details, binary notes, and RE methodology.

For new RE findings, update `RESEARCH.md` first, then adjust this roadmap only after the finding changes implementation scope or completion criteria.
