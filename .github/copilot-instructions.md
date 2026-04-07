# GitHub Copilot Instructions

Read `AGENTS.md` and `AI_HANDOFF.md` before making changes.

This repo is a reverse-engineered MPBT server. Do not guess protocol behavior when `RESEARCH.md`, `ROADMAP.md`, or `symbols.json` already document it. v1.23 client findings supersede older v1.06 raw addresses unless a section explicitly says otherwise.

Use `kenhuman/mpbt-server` as upstream. Keep changes small and branch-scoped. The current v1.23 combat RE work is stacked on Ken's PR #55 via `gnummers:codex/v123-combat-position-trace`, based on `upstream/feat/re-research`.

For protocol work, update `RESEARCH.md` and `ROADMAP.md`. Update `symbols.json` when adding canonical function names or binary addresses. Do not add licensed local assets such as `mechdata/`, `MPBT.MSG`, `music/`, `sound/`, `terrain/`, `IS.MAP`, or `SOLARIS.MAP`.

Before suggesting a commit or PR, run:

```powershell
git diff --check
npm run build
```

If a task requires Ghidra decompilation, ask the human to run Codex/Ghidra or work only from checked-in RE notes. Do not invent Ghidra-derived facts.
