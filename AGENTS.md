# MPBT RE Guidance

Before doing any reverse-engineering work in this repository:

1. Read [`RESEARCH.md`](./RESEARCH.md).
2. Read [`symbols.json`](./symbols.json).
3. Assume the majority of the reverse-engineering work is already done.

Guidelines:

- Do not re-derive findings that are already documented in `RESEARCH.md`.
- Reuse canonical names from `symbols.json` instead of inventing new names for
  already-understood functions, globals, tables, or packet handlers.
- Treat new RE work as extension, confirmation, or gap-filling on top of the
  existing baseline.
- When investigating a protocol question, start by summarizing what
  `RESEARCH.md` already says about it before opening Ghidra or using MCP tools.
- Only update `RESEARCH.md` and `symbols.json` when a finding is newly validated
  or a documented assumption is corrected by stronger evidence.

For AI-assisted Ghidra sessions, prefer the workflow docs in `docs/`.
