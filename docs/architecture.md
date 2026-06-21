# Architecture — agent-dice

This document records the origin, architecture, and design decisions of agent-dice.

---

## Origin

agent-dice was extracted from [cc-reflection](https://github.com/pro-vi/cc-reflection), which had a dice accumulator system baked directly into its codebase. The dice logic was generic — nothing about rolling d20s and checking for Natural 20 is reflection-specific — but it was entangled with reflection's session management, state directories, and CLI dispatcher.

The extraction (2026-02-14) produced a standalone package that any Claude Code tool can depend on for probabilistic triggering. cc-reflection became a thin consumer: -939 lines removed, stop hooks reduced to ~15 lines each.

**Why a bun package, not a Claude Code plugin?** Plugins can register hooks but can't expose APIs that other plugins consume. agent-dice needs to be importable as a library.

---

## Architecture: Core + Adapters

agent-dice is the **Claude Code facade over a reusable dice core**. The scheduling
logic is host-agnostic; everything Claude-specific (transcripts, session env vars,
file storage, hook rendering) lives in an adapter behind a small contract.

```
bin/agent-dice.ts, hooks/stop.ts, hooks/session-start.ts
        |
        v
src/index.ts                   public compatibility facade (unchanged API)
        |
        v
src/adapters/claude-code.ts    builds a DiceHost from registry/state/cooldown and
src/adapters/claude-renderer.ts   resolves session/depth; renders trigger output
        |
        v
src/core/engine.ts             host-agnostic scheduler + state transitions
  src/core/contracts.ts          DiceHost + CoreCheckContext (no Claude/Bun/fs)
  src/core/accumulator.ts        pure depth→dice formula + sentinel calibration
  src/roll.ts                    pure rolling (injectable RNG)
```

**The engine owns policy** — dice counts, sentinel calibration, shared-roll
grouping, trigger detection, reset/cooldown-on-trigger, session-start clearing.
**The host owns primitives** — list/get slots, load/save/clear state,
check/mark/clear cooldown, and an optional RNG. The adapter resolves a Claude
`CheckContext` (`{ transcriptPath?, sessionId? }`) into the engine's resolved
`CoreCheckContext` (`{ sessionId, currentDepth? }`) before the engine runs — the
engine never touches a transcript or a session env var.

A boundary conformance test (C8) fails if anything under `src/core/**` imports a
Claude/host module, a node builtin, `Bun`, or `process.env`.

**Reusability:** the engine now drives a **second host**. The Pi adapter under
`src/adapters/pi/` (installed via `pi install git:github.com/pro-vi/agent-dice`)
implements `DiceHost` without importing any Claude transcript/session helpers —
validating the seam with **zero changes to core**. Pi rolls on `agent_end` (its
analog of Claude's Stop), caches depth from `turn_end`'s `turnIndex` (no transcript
parse), persists state via `node:fs` under `~/.pi/agent/dice/`, and injects nudges
via `pi.sendMessage`. A Codex adapter is researched but not yet built. agent-dice
remains the Claude Code distribution; Pi is an additional host on the same core.

---

## Slot System

The core abstraction is a "dice slot" — a named configuration for probabilistic triggering:

```typescript
registerSlot({
  name: 'reflection',
  type: 'accumulator',       // accumulator | fixed | single
  die: 20,
  target: 20,
  targetMode: 'exact',       // exact | gte | lte
  accumulationRate: 7,        // turns per +1 die
  cooldown: 'per-session',
  clearOnSessionStart: true,
  resetOnTrigger: true,
  flavor: true,                 // prepend 🎲 Nat {best}! to trigger output
  onTrigger: { message: 'Do the thing.' },
});
```

Slots are persisted to `slots.json`. Multiple consumers register independent slots. The stop hook checks all slots via `checkAllSlots()`.

### Dice Types

**Accumulator** (default): Dice count scales with conversation depth.

```
Turns since trigger | Dice | Per-turn chance | Cumulative
0-6                 | 0    | 0%              | 0%
7-13                | 1    | 5%              | ~50% by turn 13
14-20               | 2    | 10%             | ~89% by turn 20
21-27               | 3    | 14%             | ~99% by turn 27
```

**Fixed**: Always rolls N dice. Constant probability regardless of depth.

**Single**: Always rolls exactly 1 die. Flat chance every turn.

---

## Shared Roll Pools

When `checkAllSlots()` runs (the stop hook path), slots sharing a die size observe the same base roll:

1. Slots grouped by die size (all d20 slots together, all d6 slots together)
2. One base die rolled per group
3. Single-type slots observe only the base roll
4. Accumulator/fixed slots get the base roll + independent bonus dice

This means two single-type d20 slots claiming different target numbers are mutually exclusive on the same physical die — exactly like different faces on one die.

---

## State Model

```
~/.claude/dice/
  slots.json                           # slot registry (all configs)
  state/
    {slotName}-{sessionId}.json        # per-slot per-session accumulator state
    triggered-{slotName}-{sessionId}   # per-session cooldown markers
```

State is per-slot AND per-session. Two Claude sessions in the same project have independent dice counts. Two different slots in the same session have independent state.

### Session ID Resolution

Priority:
1. `CC_DICE_SESSION_ID` env var (set by session-start hook)
2. Extracted from transcript path (`{uuid}.jsonl`)
3. Project hash fallback (12-char MD5 of PWD)

### Sentinel -1

When `resetSlot` is called without transcript access, it saves `depth_at_last_trigger = -1`. On the next `checkAllSlots` call (when the transcript IS available), it detects the sentinel and calibrates to the current depth. This prevents the accumulator from counting from 0 after a reset where the real depth was unknown.

---

## Hook Integration

Stop hook receives JSON on stdin from Claude Code:

```json
{ "session_id": "uuid", "transcript_path": "/path/to/transcript.jsonl" }
```

Exit codes:
- `0` — no triggers (stdout visible to user only)
- `2` — triggered; stderr message shown to Claude, conversation continues

The stop hook collects all triggered slot messages, prepends dice flavor (`🎲 Nat {best}!` by default), and outputs them as one stderr block. Flavor can be disabled per-slot with `flavor: false`.

### Depth Resolution

Depth is resolved from Claude Code JSONL transcripts — counts entries with `type === "user"` (excluding tool results). The transcript path is provided via the stop hook's stdin JSON.

---

## Check Flow

```
checkAllSlots(ctx) — per slot:
  |
  +-- Load slot config from registry
  +-- Resolve session ID (ctx > transcript path > env var > project hash)
  +-- Check cooldown marker
  |     YES -> return { triggered: false }
  |     NO  -> continue
  +-- Calculate dice count
  |     accumulator: transcript depth -> floor((depth - last_trigger) / rate)
  |     fixed: config.fixedCount
  |     single: 1
  +-- Roll dice
  +-- Check target (exact/gte/lte)
  |     NO  -> return { triggered: false, rolls, best, ... }
  |     YES -> continue
  +-- Auto-reset accumulator (if resetOnTrigger)
  +-- Write cooldown marker (if per-session)
  +-- return { triggered: true, rolls, best, ... }
```

---

## Design Decisions

### Auto-reset on trigger

The two-step dance (dice triggers -> consumer acts -> consumer calls dice-reset) was unnecessary friction. The cooldown marker prevents re-triggering in the same session anyway. Override with `resetOnTrigger: false`.

### Default transcript parser shipped with package

DX. Nobody installing a dice package should have to write their own JSONL parser.

### File-based slot registry

Simple, portable, inspectable. `slots.json` can be edited by hand.

### Separate repo, not monorepo

Independent versioning, independent install, independent git history. agent-dice may get consumers beyond cc-reflection.

---

## File Map

```
agent-dice/
  package.json              Package config (bun-only)
  tsconfig.json             TypeScript config
  README.md                 User-facing docs
  CLAUDE.md                 Dev instructions for Claude Code
  install.sh                Installer (symlinks, hook registration)

  src/
    index.ts                Public API facade (delegates to core via adapter)
    types.ts                All interfaces
    core/
      contracts.ts          DiceHost + CoreCheckContext (host-agnostic; no Claude/Bun/fs)
      engine.ts             Host-agnostic scheduler + state transitions
      accumulator.ts        Pure depth→dice formula + sentinel calibration
    adapters/
      claude-code.ts        Builds DiceHost from file stores + resolves session/depth
      claude-renderer.ts    Trigger-message rendering (placeholders + dice flavor)
      pi/                   Pi extension adapter (second host)
        index.ts            Extension entry: turn_end / session_start / agent_end wiring
        host.ts             createPiHost (DiceHost) + piContext (CoreCheckContext)
        store.ts            node:fs storage (Claude-identical formats)
        commands.ts         /dice slash command
    registry.ts             Slot CRUD + file persistence
    roll.ts                 Pure rolling (injectable RNG) + target checking + probability
    accumulator.ts          Claude/file wrapper over core/accumulator
    state.ts                Per-slot per-session state persistence
    cooldown.ts             Per-session trigger markers
    transcript.ts           Claude Code JSONL parser (depth resolution)
    session.ts              Session ID resolution
    hook-helpers.ts         Stdin parsing + exit code handling

  bin/
    agent-dice.ts              CLI entrypoint

  hooks/
    stop.ts                 Generic stop hook (checks all slots)
    session-start.ts        Session initialization hook

  docs/
    architecture.md         This file

  tests/
    unit/
      test_cc_dice.bats     BATS test suite
    conformance/
      run.ts                Conformance runner (`bun run test` wraps it)
      *.conformance.ts      Facade / storage / boundary / core-engine / CLI / docs probes
```

---

## Environment Variables

| Variable | Purpose | Set by |
|----------|---------|--------|
| `CC_DICE_BASE` | Override base directory (default: `~/.claude/dice/`) | Test setup |
| `CC_DICE_SESSION_ID` | Session UUID for state isolation | SessionStart hook |
| `DEBUG` | Verbose logging to stderr when `"1"` | User |

---

## Testing

BATS (Bash Automated Testing System) with submodules for assertion helpers.

All tests use temp directories via `CC_DICE_BASE` override — tests never touch `~/.claude/dice/`.

```bash
bun run test   # runs BATS + the conformance runner in one report
# or
./tests/bats/bin/bats tests/unit/test_cc_dice.bats
```

Note: bare `bun test` is Bun's *native* runner — it does **not** execute the
`package.json` test script (BATS). The conformance suite is intentionally named
`*.conformance.ts` (not `*.test.ts`) so the native runner ignores it; it runs only
via `tests/conformance/run.ts`, which `bun run test` invokes through a BATS case.
