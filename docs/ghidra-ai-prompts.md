# MPBT GhidrAssist Prompt Pack

These prompts are designed for `GhidrAssist` with `GhidrAssistMCP` enabled.
Each one is scoped to a single reverse-engineering task so the model stays
grounded and produces reviewable output.

Before using any prompt in this file:

- read [`RESEARCH.md`](../RESEARCH.md)
- read [`symbols.json`](../symbols.json)
- summarize the already-confirmed findings relevant to the target
- assume the majority of the RE has already been done, and avoid re-solving
  documented protocol details from scratch

## Output Contract

Ask for this structure every time:

```text
1. Observed facts
2. Inferences
3. Candidate canonical names
4. Packet fields or state transitions
5. Confidence per claim
6. Next 2 manual checks
7. Do-not-rename-yet list
```

Also require the model to separate:

- `confirmed from code`
- `inferred from control flow`
- `speculative`

## Prompt 1: World Handshake Trace

```text
You are helping reverse engineer Multiplayer BattleTech: Solaris.

Goal: trace the post-REDIRECT world handshake.

Current binaries:
- MPBTWIN.EXE
- COMMEG32.DLL

Seed evidence:
- string: "\x1b?MMW Copyright Kesmai Corp. 1991"
- function(s): FUN_100014e0, FUN_00429870
- local project docs already describe the lobby handshake and current world notes

Before analyzing the binaries, summarize what RESEARCH.md and symbols.json
already say about the post-REDIRECT path.

Tasks:
- identify the exact byte flow after REDIRECT
- explain which side sends each frame first
- identify the welcome-gate conditions
- identify the first world command the client emits after the handshake
- list every global or flag that changes mode from lobby into world/RPS

Output using the required contract. Do not invent packet bytes that are not
visible in code or captures.
```

## Prompt 2: Dispatch Entry Naming

```text
Analyze one unknown dispatch-table entry in MPBTWIN.EXE.

Target:
- dispatch table: DAT_00470198 or DAT_00470408
- command index: <N>
- handler address: <FUN_xxxxxxxx>

Before proposing any name, check whether RESEARCH.md or symbols.json already
documents this entry or nearby handlers.

Tasks:
- summarize what the handler reads from the frame buffer
- list helper functions it calls
- identify UI side effects, globals touched, and network state changes
- propose a canonical name matching this repo's naming style
- propose a one-line RESEARCH.md note for the command table

Output using the required contract. Keep the proposed name conservative.
```

## Prompt 3: Key Binding to Wire Format

```text
Trace a client key path to its outgoing network packet.

Target key/action:
- <F7/F8/[ ] \\ Space JUMP STAND EJECT etc.>

Tasks:
- find the key handler
- follow the path to the send helper
- identify command index and argument encoders used
- produce the client->server packet schema
- note any mode guards, selected-target dependencies, or dialog-state checks

Output using the required contract. If the path splits, show the split points.
```

## Prompt 4: Packet Schema Extraction

```text
I need a packet schema for one MPBT handler.

Function:
- <FUN_xxxxxxxx>

Known context:
- mode: <RPS or Combat>
- suspected command index: <N>
- any available capture bytes: <paste if available>

Tasks:
- identify every frame read helper used
- map helpers to field types and offsets
- produce a packet table with byte width, decoder, semantic guess, and confidence
- list what server response or local side effect follows

Output using the required contract. Prefer field names like arg0/arg1 when
semantics are not confirmed.
```

## Prompt 5: Combat Crossover

```text
Trace how MPBT switches from RPS/world mode to combat mode.

Seed evidence:
- g_combatMode / DAT_004e2cd0
- Frame_VerifyCRC
- string: "\x1b?MMC Copyright Kesmai Corp. 1991"
- combat dispatch table: DAT_00470408

Before tracing, summarize the current documented understanding from RESEARCH.md
and only investigate what remains unresolved.

Tasks:
- identify the earliest write to g_combatMode that matters for network parsing
- explain the exact trigger for switching CRC seeds
- identify the first combat-specific handler that becomes reachable
- note whether combat is entered by world packet, local event, or direct welcome string

Output using the required contract.
```

## Prompt 6: Chat Channel Split

```text
Reverse engineer the difference between F7 and F8 chat in MPBT.

Tasks:
- locate both key bindings
- trace each to the send path
- identify whether the difference is command index, flag, list id, or payload text routing
- identify the receive-side display path for each message type
- propose conservative command names for any newly understood handlers

Output using the required contract.
```

## Prompt 7: Movement and Room State

```text
Help map the world movement pipeline in MPBT.

Seed context:
- known world commands include scene init, cursor, menu, session data, room list,
  text feed, and player events
- local docs also reference IS.MAP and SOLARIS.MAP

Tasks:
- identify which handlers populate current room, visible room list, exits, and player presence
- distinguish static room data from live movement/state updates
- list globals that look like current room id, sector, coordinates, or selected exit
- suggest the next best unknown command to inspect for actual movement packets

Output using the required contract.
```

## Prompt 8: RESEARCH.md Draft Helper

```text
Convert this validated RE result into a concise RESEARCH.md entry.

Constraints:
- do not overstate certainty
- preserve function/global addresses
- separate confirmed facts from inference
- include packet schema only if the field boundaries are confirmed

Source notes:
<paste your validated notes here>

Return:
- a short subsection title
- a 1-paragraph summary
- a packet table if justified
- a short "confidence / remaining unknowns" note
```

## Session Habit

At the end of each prompt, ask one final question:

```text
What is the smallest manual check in Ghidra that would most increase confidence?
```

That keeps the model acting like a guide instead of a source of unchecked truth.
