# Agent Instructions

This repository is a reverse-engineered MPBT server. Treat current upstream
research as authoritative and avoid re-deriving documented findings.

## Repository Baseline

- Primary upstream is `kenhuman/mpbt-server`.
- Fork checkout used by gnummers is `C:\MPBT\mpbt-server`.
- Check `RESEARCH.md`, `ROADMAP.md`, and `symbols.json` before changing protocol code.
- v1.23 client work supersedes older v1.06 raw addresses unless a section explicitly says it was revalidated for v1.23.
- Binary assets such as `mechdata/`, `MPBT.MSG`, `music/`, `sound/`, `terrain/`, `IS.MAP`, and `SOLARIS.MAP` are local licensed install data. Do not add them to git.

## Branch Discipline

- Keep upstream-facing work small and branch-specific.
- For v1.23 combat RE stacked on Ken's PR #55, use `codex/v123-combat-position-trace` until Ken's `feat/re-research` branch merges or is superseded.
- Do not grow unrelated open PRs. Start a fresh branch for unrelated follow-ups.
- Before publishing, run `git diff --check` and `npm run build`.
- If a finding changes canonical names or binary addresses, update `symbols.json` when appropriate.
- If a finding changes protocol behavior or RE interpretation, update `RESEARCH.md` and `ROADMAP.md`.

## Ghidra Workflow

- Current Ghidra v1.23 target is `Mpbtwin.exe` from `C:\MPBT\Mpbtwin.exe`.
- Always pass `program: "Mpbtwin.exe"` to Ghidra MCP calls when using Codex.
- Prefer anchoring by dispatch tables, strings, xrefs, and decompile output; do not trust v1.06 addresses without revalidation.
- Save the Ghidra database after adding useful function boundaries, labels, or comments.
- Copilot will not automatically have Ghidra MCP access unless configured separately. When using Copilot, rely on checked-in `RESEARCH.md` notes or ask Codex/human to perform Ghidra-only validation.

## Current Research Context

- Active stacked v1.23 combat branch: `codex/v123-combat-position-trace`.
- It is based on Ken's `feat/re-research` PR #55, not `master`.
- Key traced combat packets:
  - `Cmd64` / wire `0x65`: remote actor/mech add.
  - `Cmd65` / wire `0x66`: server-to-client combat position/motion update.
  - `Cmd66` / wire `0x67`: actor damage code/value update.
  - `Cmd67` / wire `0x68`: local actor damage code/value update.
  - `Cmd68` / wire `0x69`: projectile/effect spawn.
  - `Cmd70` / wire `0x6b`: actor animation/status transition.
  - `Cmd72` / wire `0x6d`: local combat bootstrap.
- `.MEC` v1.23 correction: `weapon_count` is at `0x3a`, signed critical/equipment range bound is at `0x3c`, and weapon ids start at `0x3e`.

## Handoff Rules

- When switching from Codex to Copilot, tell Copilot to read this file and `AI_HANDOFF.md` first.
- When switching from Copilot back to Codex, summarize branch, commits, validation, Ghidra assumptions, and any open PR comments in `AI_HANDOFF.md`.
- Prefer checked-in docs over chat transcripts as the source of truth.
