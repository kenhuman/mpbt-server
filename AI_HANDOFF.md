# AI Handoff

This file is the shared handoff surface between Codex, GitHub Copilot, and the human maintainer.

## Current State

- Date: 2026-04-07
- Local checkout: `C:\MPBT\mpbt-server`
- Fork: `gnummers/mpbt-server`
- Upstream: `kenhuman/mpbt-server`
- Active branch: `codex/v123-combat-position-trace`
- Active upstream thread: Ken PR #55, `feat/re-research`
- Branch base: `upstream/feat/re-research`
- Current branch status before Copilot migration: clean and pushed

## Open Work Threads

- PR #55 is Ken's v1.23 RE branch. Our stacked branch adds follow-up v1.23 combat documentation and has been linked in PR comments.
- PR #54 documents v1.23 `Solaris RPS` / `Solaris COMBAT` state handoff and the `Transition to combat - even` music-state correction.
- PR #50 tracks earlier M5 map/travel work against Ken's current master.

## Latest Stacked Combat Findings

- `Cmd64` / wire `0x65`: remote actor/mech add.
- `Cmd65` / wire `0x66`: server-to-client combat position/motion sync.
- `Cmd66` / wire `0x67`: actor damage code/value update.
- `Cmd67` / wire `0x68`: local actor damage code/value update.
- `Cmd68` / wire `0x69`: projectile/effect spawn, not direct damage.
- `Cmd69` / wire `0x6a`: impact/effect-at-coordinate feedback.
- `Cmd70` / wire `0x6b`: actor animation/status transition.
- `Cmd71` / wire `0x6c`: clears current projectile/effect globals.
- `Cmd72` / wire `0x6d`: local combat bootstrap.
- `Cmd73` / wire `0x6e`: actor rate/bias fields; exact meaning pending.
- v1.23 `.MEC` correction: `weapon_count` at `0x3a`, signed critical/equipment bound at `0x3c`, weapon ids at `0x3e + slot*2`.

## Recommended Next Tasks

1. Prototype a minimal `Cmd72` builder in `src/protocol/combat.ts` or equivalent, but only after choosing whether to keep code work on this stacked branch or start a separate branch.
2. Add server-side combat packet builders for `Cmd64`, `Cmd65`, `Cmd66`, `Cmd67`, `Cmd68`, and `Cmd70`.
3. Capture a live combat entry session to label the remaining `Cmd72` identity/status fields and signed `Cmd65` motion conventions.
4. Correlate damage-code ranges with `.MEC` fields and live hit feedback before implementing final damage semantics.

## Validation Commands

```powershell
git diff --check
npm run build
npm run map:dump
```

Use `npm run map:dump` only when map/parser work is involved.

## Copilot Prompt Starter

Use this when starting a Copilot session:

```text
Read AGENTS.md and AI_HANDOFF.md first. Work in C:\MPBT\mpbt-server. Do not duplicate Ken's upstream PR #55 work. Continue from branch codex/v123-combat-position-trace unless I ask for a new branch. For v1.23 protocol work, treat RESEARCH.md §19 and ROADMAP.md M6/M7 as source of truth. Keep changes small, run git diff --check and npm run build, and summarize any unresolved Ghidra assumptions.
```

## Return-To-Codex Prompt Starter

Use this when switching back to Codex:

```text
Read AGENTS.md and AI_HANDOFF.md. Then inspect git status, latest commits, and any PR comments. Continue from the current branch without reverting Copilot changes. Validate with git diff --check and npm run build before pushing.
```
