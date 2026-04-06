# Research Materials

Place proprietary Kesmai/EA reference files and private correspondence here
for local use during reverse-engineering work.  **This directory is gitignored.**
The contents of `research/` must never be committed to the repository.

## What goes here

| File | Source | Used for |
|---|---|---|
| `BT-MAN.decrypted.txt` | Extracted from BT-MAN.PDF (official game manual) | Combat mechanics, mech stat tables, world navigation detail |
| `IS.MAP` | MPBT installation root | Inner Sphere sector locations, rooms 1–145 (binary) |
| `SOLARIS.MAP` | MPBT installation root | Solaris city venue locations, rooms 146+ (binary, 189 KB) |
| `Gnum*.txt` / `Gnum*.md` | Private Discord conversation | Firsthand gameplay observations for RE sanity-checking |
| `BT-MAN.PDF` | Original game CD / installer | Full game manual (FlateDecode compressed — use decrypted.txt instead) |

## Map file quick-reference

Both map files share a **global room namespace**:

- `IS.MAP` — rooms **1–145** (Inner Sphere star systems / conference venues)
- `SOLARIS.MAP` — rooms **146+** (Solaris city districts, arenas, bars)

Record layout (partially decoded):
```
[2 bytes] room ID (little-endian, sequential)
[2 bytes] type flags
[8 bytes] bounding box (XY coords, 2 bytes each)
[6 bytes] unknown
[2 bytes] name length (LE uint16)  +  [name_len bytes] name string  +  [0x00]
[2 bytes] desc length (LE uint16)  +  [desc_len bytes] description  +  [0x00]
```

Confirmed SOLARIS.MAP rooms (partial):
- `0x0092` (146) — Solaris Starport (no arenas; public-works / tourist sector)
- `0x0093` (147) — Ishiyama Arena (Kobe sector; Iron Mountain arena)
- `0x0094` (148) — Government House (Kobe sector)
- `0x0095` (149) — White Lotus (Kobe sector; residential)

## Why these files are not in the repo

`IS.MAP`, `SOLARIS.MAP`, `BT-MAN.PDF`, and the game manual content are
proprietary to Kesmai Corporation / Electronic Arts.  Distributing them would
violate copyright.  The `Gnum` files contain a private conversation and must
not be made public.

See `CONTRIBUTING.md` (if present) or the project README for instructions on
obtaining a licensed MPBT installation.
