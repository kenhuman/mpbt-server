# MPBT Prompt Pack for `ghidra-mcp`

These prompts are written for an MCP-aware AI client that can call the exact
tool names exposed by `bridge_mcp_ghidra.py`.

Use them as task starters, not blind automation. Keep the model in read-only mode
until the result is validated.

Before using any prompt in this file:

- read [`RESEARCH.md`](../RESEARCH.md)
- read [`symbols.json`](../symbols.json)
- summarize the relevant already-confirmed findings
- assume the majority of the RE has already been completed and use MCP to fill
  gaps rather than rediscover the established baseline

## Output Contract

Require this structure every time:

```text
1. Tool calls made
2. Observed facts from tool output
3. Inferences
4. Candidate names or packet fields
5. Confidence per claim
6. Smallest next validation step
7. No-write recommendation unless evidence is strong
```

Also require the model to tag each claim as:

- `confirmed`
- `inferred`
- `speculative`

## Prompt 1: World Handshake Trace

```text
Reverse engineer the MPBT post-REDIRECT world handshake.

Use these tools first, in order:
- check_connection
- list_open_programs
- switch_program to COMMEG32.DLL
- search_memory_strings for "MMW"
- search_memory_strings for "MMC"
- get_xrefs_to for the best string results
- decompile_function for the strongest xref functions
- switch_program to MPBTWIN.EXE
- decompile_function for FUN_00429870
- get_function_callers
- get_function_callees
- analyze_function_complete

Questions to answer:
- what exact welcome string gates world/RPS mode?
- what happens immediately after REDIRECT?
- what is the first client world command?
- which globals or flags change state?

Before tool use, summarize what RESEARCH.md and symbols.json already say about
the handshake and treat that as the baseline.

Do not rename or comment anything yet.
Return using the required output contract.
```

## Prompt 2: RPS Dispatch Entry Naming

```text
Investigate one unknown MPBT world/RPS dispatch entry.

Target:
- program: MPBTWIN.EXE
- dispatch table: DAT_00470198
- command index: <N>
- handler address: <FUN_xxxxxxxx>

Use these tools:
- switch_program
- get_function_by_address
- decompile_function
- disassemble_function
- get_function_xrefs
- get_function_callers
- get_function_callees
- analyze_control_flow

Return:
- what the handler reads from the frame
- what globals it touches
- UI or state side effects
- a conservative canonical name
- a one-line RESEARCH.md entry

Before proposing a name, check whether the command or adjacent handlers are
already documented in RESEARCH.md or symbols.json.

Do not perform write operations.
```

## Prompt 3: `F7` / `F8` Chat Split

```text
Reverse engineer the difference between F7 and F8 chat in MPBT.

Use these tools:
- switch_program to MPBTWIN.EXE
- search_memory_strings for likely chat window labels, prompts, and status text
- get_xrefs_to on useful chat strings
- decompile_function on the key input handlers
- get_function_callees
- disassemble_function where send helpers are unclear
- analyze_control_flow

Questions:
- where are the F7 and F8 key paths?
- do they diverge by command index, argument, flag, or routing field?
- what is the receive/display path?

Do not rename anything yet.
Return using the required output contract.
```

## Prompt 4: Packet Schema Extraction

```text
Extract a cautious packet schema for one MPBT handler.

Target:
- program: <program>
- function: <FUN_xxxxxxxx>
- mode: <RPS or Combat>

Use these tools:
- get_function_by_address
- decompile_function
- disassemble_function
- get_function_callees
- analyze_function_complete

Return:
- every frame-read helper used
- likely field boundaries
- packet table with width, helper, semantic guess, confidence
- resulting side effects or response behavior

Prefer field names like arg0/arg1 when semantics are not fully proven.
No writes.
```

## Prompt 5: Combat Crossover

```text
Find the exact MPBT transition from RPS/world mode to combat mode.

Use these tools:
- switch_program to MPBTWIN.EXE
- search_memory_strings for "MMC"
- get_xrefs_to
- decompile_function
- get_xrefs_to on DAT_004e2cd0
- decompile_function on the earliest relevant writers
- disassemble_function if the write path remains ambiguous

Questions:
- what changes g_combatMode?
- when does the CRC seed change?
- what is the first combat-only handler that becomes reachable?

No writes.
Return using the required output contract.
```

## Prompt 6: Confirm Then Write

```text
I already validated this MPBT finding manually. Help me apply only the minimal safe edits.

Validated facts:
<paste facts here>

Use read tools first:
- get_function_by_address
- decompile_function
- get_plate_comment

If the evidence still matches, propose only these write operations:
- rename_function_by_address
- rename_global_variable
- set_plate_comment

Return:
- exact write operations recommended
- exact names/comments
- anything that should remain unchanged

Do not perform bulk operations.
```

## Prompt 7: Documentation Transfer Across Versions

```text
Help compare this MPBT binary against another version or build.

Use these tools:
- get_function_hash
- get_bulk_function_hashes
- get_function_documentation
- lookup_function_by_hash
- compare_programs_documentation

Questions:
- which functions have confident matches?
- which matches are too weak for auto-transfer?
- what should be reviewed manually before applying documentation?

Return using the required output contract.
```

## Prompt 8: Room-State Investigation

```text
Map the MPBT world room-state pipeline.

Use these tools:
- switch_program to MPBTWIN.EXE
- decompile_function on known world handlers near commands 4 and 8-13
- get_function_callees
- list_globals
- get_xrefs_to on candidate room/player globals
- analyze_data_region around relevant data blocks
- inspect_memory_content or read_memory if needed

Questions:
- which handlers populate room metadata?
- which handlers populate visible players/events?
- which unknown command is most likely live movement?

Do not rename yet.
Return using the required output contract.
```

## Default Rule for MPBT

End every prompt with:

```text
If confidence is below medium, stop before any write tool and tell me the smallest next read-only tool call.
```
