# MPBT Throttle / KP5 Stop — Research & Bug Documentation

> **Status:** Fixed and verified on 2026-04-11.
> Cmd8 TAP-mode coasting no longer echoes Cmd65 while `clientSpeed != 0`; the
> client now owns throttle target updates through `FUN_004229a0`, and KP8/KP5/KP2
> behave correctly in live testing.

---

## 1. Problem Statement

| Key | Expected | Actual |
|-----|----------|--------|
| KP8 (tap ×10 to 100% throttle) | Mech accelerates to 32 kph | **Works ✓** |
| KP5 (full stop) — held | Mech decelerates while held | **Works but slowly ✓** |
| KP5 — released | Throttle stays at 0%; mech stays stopped | **Works ✓** |
| KP2 reverse | Reverse throttle persists correctly after key release | **Works ✓** |

**Final log evidence (`world-handlers.ts` Cmd8 handler):**
```
cmd8 coasting: x=... clientSpeed=921 -> no echo (trust local key events)
cmd8 coasting: x=... clientSpeed=0 suppressing echo (stopped)
```

The previous break-trap echo is gone. The server no longer reasserts `speedMag`
from Cmd8 TAP-mode coasting frames, so the client's local key-event path keeps
control of `actor+0x372` without being overwritten.

---

## 2. Client-Side Motion Architecture (Ghidra RE)

### Key variables

| Variable | Range | Role |
|----------|-------|------|
| `DAT_004f1f7c` | ±8190 (= MOTION_DIV×45) | **Throttle accumulator.** `sVar2 = DAT_004f1f7c / 182`. `sVar2 ≠ 0` → client sends **Cmd9**; `sVar2 = 0` → client sends **Cmd8**. |
| `actor+0x36e` (`DAT_004f209e`) | ±100 | **HUD throttle %** display counter. Written only by `FUN_004229a0`. Display-only. |
| `actor+0x372` (`DAT_004f20a2`) | unbounded | **Physics speed target.** Physics drives actual velocity toward this value. Written by `FUN_004229a0` (from key events) AND by the Cmd65 handler (from server echo). **This is what actually moves the mech.** |

### Key functions (all Ghidra-confirmed)

| Function | Trigger | Effect |
|----------|---------|--------|
| `FUN_004229a0(actor, delta, reset)` | Key event | If reset=1: zero `actor+0x36e` and `actor+0x372`. If reset=0: `actor+0x36e += delta`; `actor+0x372 = actor+0x36e × maxSpeed × THROTTLE_RUN_SCALE / 100` |
| `FUN_0040d2d0` | KP8 **held** (per-frame) | `DAT_004f1f7c -= 182` per frame, capped at -8190. This is what puts the client into Cmd9 (HOLD) mode. |
| `FUN_0040d150` / `FUN_00422b50` | KP8 **released** (coasting) | Reduces `\|DAT_004f1f7c\|` toward 0 per frame. Set when `DAT_00479954=1`. |
| `FUN_0040d830` | Cmd65 received | Writes `actor+0x372 = speedMagRaw - MOTION_NEUTRAL`. Optionally writes `DAT_004f1f7c` delta. This **always** overrides the key-event value of `actor+0x372`. |
| `FUN_004488e0` | Per-frame | Applies `DAT_004f1f7c` delta over N frames. Interpolates `DAT_004f1f7c` toward the value encoded in the last Cmd65. |

### Key dispatch (`FUN_00445b10`) — confirmed cases

| Case | Key | Action |
|------|-----|--------|
| `0x33` | KP5 press | `FUN_004229a0(actor, 0, 1)` → **zeroes `actor+0x36e` and `actor+0x372`**. Does NOT touch `DAT_004f1f7c`. |
| `0x34` | KP8 press | `FUN_004229a0(actor, 10, 0)` → increments `actor+0x36e`, sets `actor+0x372`. |
| `0x35` | KP2 press | `FUN_004229a0(actor, -10, 0)` → reverse. |
| `0x40` | KP8 **released** | Sets `DAT_00479954=1` → activates coasting (`FUN_0040d150`). |

### Cmd65 handler flow (`FUN_0040d830`)

1. Always writes: `actor+0x372 = speedMagRaw - MOTION_NEUTRAL`
2. Velocity gate (`FUN_0042bb00`): if physics velocity = 0 → calls `FUN_004229a0(0,1)`, return 0.
3. First Cmd65: writes `DAT_004f1f7c = decoded_throttle` directly.
4. Subsequent Cmd65: computes `delta = decoded_new - old_DAT_004f1f7c`, stores in `DAT_004f1f8a` (signed). `FUN_004488e0` applies step × ticks each frame.

### Game loop order (inferred from Ghidra)

```
[ Receive network packets (Cmd65) ]
        ↓
[ Apply Cmd65: set actor+0x372 ← speedMag, set DAT_004f1f7c delta ]
        ↓
[ Process key events: FUN_004229a0 / FUN_0040d2d0 may override actor+0x372 ]
        ↓
[ Physics: move mech toward actor+0x372 ]
        ↓
[ Send Cmd8 or Cmd9 to server ]
```

**Critical implication:** Key events run AFTER Cmd65. Key events override the server echo.
If no key event fires this frame, the server echo's `actor+0x372` persists unchallenged.

---

## 3. Two Throttle Modes

### TAP mode (10 × KP8 quick presses)

- `FUN_004229a0(actor, 10, 0)` fires 10 times → `actor+0x36e = 100`, `actor+0x372 = 900`
- `FUN_0040d2d0` (hold accumulator) does **NOT** fire for quick taps
- `DAT_004f1f7c = 0` (never accumulated) → `sVar2 = 0` → **client sends Cmd8 every frame**
- Cmd9 is NEVER sent in TAP mode

### HOLD mode (KP8 held for ~1.5 s)

- `FUN_0040d2d0` fires per-frame: `DAT_004f1f7c -= 182/frame`, reaches -8190 after 45 frames (~1.5 s at 30 fps)
- `sVar2 = -45` (non-zero) → **client sends Cmd9 every frame**
- Cmd8 is NEVER sent in HOLD mode (unless DAT_004f1f7c is cleared externally)

**The failing test uses TAP mode** (confirmed from logs: only Cmd8 ever seen, no Cmd9).

---

## 4. Root Cause

### The break trap (Cmd8 handler)

The Cmd8 handler has a "break trap" discriminant:

```typescript
const wasPreviouslyMoving = session.combatSpeedMag !== undefined && session.combatSpeedMag !== 0;

if (clientSpeed !== 0) {
  if (wasPreviouslyMoving) {
    // KP5 path — echo speedMag=0
  } else {
    // BREAK TRAP — echo speedMag=maxSpeedMag (900)
  }
}
```

**`wasPreviouslyMoving` is ALWAYS false in TAP mode** because `combatSpeedMag` is only set
inside the **Cmd9** handler — which never fires in TAP mode. So the break trap fired on
every single Cmd8 echo, including while KP5 was held and after it was released.

### Timeline of the bug

```
[KP8 × 10 taps] → actor+0x372=900, DAT_004f1f7c=0, client sends Cmd8 forever

[KP5 pressed]  → FUN_004229a0(0,1): actor+0x36e=0, actor+0x372=0
                → Physics: mech starts decelerating ✓

[~1 second]    → Server echo (Cmd65): speedMag=900 → actor+0x372=900
               → Physics: mech accelerates back to 900 ✗
               → No key event this frame (KP5 already released) → echo wins

[KP5 released] → Same as above, but no key event at all → echo fully controls
               → actor+0x372=900 every second, mech stays at 900
```

### Why the `combatIntentStop` fix (added in Cmd9) didn't help

The `combatIntentStop` speed-trend detection was added to the **Cmd9** handler. In TAP mode,
Cmd9 is NEVER sent. The fix code never executes. The Cmd8 handler's break trap re-accelerated
unconditionally.

---

## 5. Encoding Constants (all Ghidra-confirmed)

```typescript
MOTION_NEUTRAL  = 0x0E1C = 3612    // wire-neutral; client subtracts to get signed value
MOTION_DIV      = 0x00B6 = 182     // one throttle "step" unit
COORD_BIAS      = 0x18E4258        // X/Y wire offset
THROTTLE_RUN_SCALE = 20            // sVar2 max=45; 45*20=900=maxSpeedMag for CPLT-C1
```

**Wire encoding (all relative to MOTION_NEUTRAL):**
| Field | Encode | Client decodes |
|-------|--------|----------------|
| speedMag | `value + NEUTRAL` | `raw - NEUTRAL` = signed speed |
| throttle | `NEUTRAL - round(V / DIV)` | `(NEUTRAL - raw) × DIV` = V |
| legVel | `round(V / DIV) + NEUTRAL` | `(raw × 91 - 328692) × 2` ≈ V |
| facing | `round(V / DIV) + NEUTRAL` | `(raw - NEUTRAL) × DIV` = V |

**CPLT-C1 params:**
- `maxSpeedMag = combatMaxSpeedMag = 900` (32 kph)
- `combatWalkSpeedMag = 300` (walk speed)

---

## 6. Files and Locations

| File | Lines | What's there |
|------|-------|-------------|
| `src/world/world-handlers.ts` | 757–852 | **Cmd8 handler** — break trap + KP5 path + stopped reset |
| `src/world/world-handlers.ts` | 854–925 | **Cmd9 handler** — combatIntentStop detection + Cmd65 echo |
| `src/state/players.ts` | 129–163 | `ClientSession` combat fields (`combatSpeedMag`, `combatIntentStop`, etc.) |
| `src/protocol/combat.ts` | 71–85 | Encode helpers + exported constants |
| `src/protocol/game.ts` | 540–573 | `parseClientCmd8Coasting` / `parseClientCmd9Moving` parsers |

---

## 7. Implemented Fix (verified)

### Core insight

Key events run **after** Cmd65 each frame. Any value our echo writes to `actor+0x372` is
immediately overridden if a key event fires. If no key event fires (mech at steady state),
our echo is the sole writer — and the break trap re-accelerates the mech.

**In TAP mode, the server echo is harmful interference.** `actor+0x372` is already
set correctly by the client's own key event handlers. The server should not compete.

### Change to Cmd8 handler

The entire `if (clientSpeed !== 0)` block (break trap + KP5 path) was replaced with:

```typescript
if (clientSpeed !== 0) {
  // TAP mode: DAT_004f1f7c=0, client owns actor+0x372 via FUN_004229a0 key events.
  // Do NOT echo — any Cmd65 we send overrides actor+0x372 before key events can
  // restore it, fighting both KP5 deceleration and natural at-speed maintenance.
  // Key events run after Cmd65 in the game loop, so they will correct actor+0x372
  // when pressed, but between presses our echo is the sole writer — don't interfere.
  connLog.debug(
    '[world/combat] cmd8 coasting: x=%d y=%d heading=%d clientSpeed=%d → no echo (trust local key events)',
    session.combatX, session.combatY, frame.headingRaw, clientSpeed,
  );
  return;
}
```

The Cmd9 stop-intent override was also removed. Cmd9 now echoes plain movement state
again, and TAP-mode stop behavior is handled solely by suppressing Cmd8 interference.

### Why this works

- **KP8 taps (acceleration):** `FUN_004229a0` sets `actor+0x372=900` each tap. No echo
  interference. Physics drives toward 900. Mech reaches 32 kph. ✓
- **At-speed cruising (no keys):** `actor+0x372=900` from last key event persists. No echo
  to overwrite it. Physics maintains 900. ✓
- **KP5 pressed:** `FUN_004229a0(0,1)` → `actor+0x372=0`. No echo to fight it. Physics decelerates. ✓
- **KP5 released (mech still moving):** `actor+0x372=0` persists (no new key event, no echo). Physics continues decelerating. ✓
- **Mech fully stopped (clientSpeed=0):** Existing `combatSpeedMag=0` reset path unchanged. ✓
- **KP8 after stop:** New key event sets `actor+0x372=90` again. No echo interference. ✓
- **KP2 reverse:** Reverse key events own `actor+0x372` the same way; no break-trap echo fights the client. ✓

### Verification

Live validation on 2026-04-11 confirmed:

1. KP8 TAP acceleration holds commanded speed without decaying after release.
2. KP5 stop no longer re-accelerates after release.
3. Reverse throttle behavior (KP2) persists correctly under the same no-echo rule.
4. The server log no longer prints `breaking trap Cmd65`; Cmd8 logs `-> no echo (trust local key events)` instead.

The remaining Cmd8 `clientSpeed === 0` reset path stays in place so the next throttle
input after a full stop still starts from a clean state.

---

## 8. What Has Already Been Tried

| Attempt | Outcome |
|---------|---------|
| Echoing `throttle = throttlePct * MOTION_DIV` (full) | Fights `FUN_0040d150` coasting, prevents Cmd9→Cmd8 transition |
| Echoing `throttle = -throttlePct * MOTION_DIV` (sign-inverted) | `DAT_004f1f7c` oscillation — capped mech at 21 kph (walk speed) |
| `wasPreviouslyMoving` discriminant in Cmd8 | Correct concept but `combatSpeedMag` is never set in TAP mode → always false |
| `combatIntentStop` speed-trend detection (Cmd9) | Only runs in HOLD mode (Cmd9 path); never fires in TAP mode |
| Break trap echoing `speedMag=maxSpeedMag` | Re-accelerates after KP5 — the current bug |
| Suppress Cmd8 echo whenever `clientSpeed != 0` | **Final fix.** Restores client-local throttle ownership and resolves KP5/KP2 regressions |

---

## 9. Server Startup & Test Commands

```powershell
Start-Service postgresql-x64-18
$env:DATABASE_URL="postgres://mpbt:47711477acfb419395b97f982ee37a65@localhost:5432/mpbt"
cd C:\MPBT\mpbt-server
npm run build && node dist/server.js

# Client:
node --loader ts-node/esm tools/gen-pcgi.ts
Start-Process "C:\MPBT\MPBTWIN.EXE" -ArgumentList "-pcgi","C:\MPBT\play.pcgi"
```

**Test sequence:**
1. Select CPLT-C1 mech, enter combat arena
2. Tap KP8 ×10 (or hold until throttle=100%) → confirm 32 kph
3. Tap KP5 → confirm throttle display = 0%
4. Release KP5 → mech should stay stopped
5. Tap KP8 again → confirm mech re-accelerates to 32 kph
6. Tap/hold KP2 → confirm reverse speed persists correctly after release

**Debug logging** — filter server.log for:
```
cmd8 coasting | cmd9 moving | breaking trap
```

---

## 10. Final Implementation

The working change is in `src/world/world-handlers.ts`, `handleCombatMovementFrame`:

- Cmd8 now returns early with no `Cmd65` echo whenever `clientSpeed != 0`.
- Cmd8 keeps only the `clientSpeed === 0` stopped reset path.
- Cmd9 no longer carries the `combatIntentStop` stop-intent override; it echoes plain
  movement state again.

This leaves throttle ownership with the client in TAP mode, which matches the
Ghidra-confirmed `FUN_004229a0` key-event path and fixes the server-side interference
that was reasserting movement after stop.
