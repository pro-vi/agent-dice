# agent-dice

Probabilistic dice trigger system for Claude Code hooks.

## Project Layout

- `src/index.ts` — Public API facade (delegates to core via the Claude adapter)
- `src/core/` — Host-agnostic engine + `DiceHost` contract + pure accumulator (no Claude/Bun/fs)
- `src/adapters/` — Claude Code adapter (file stores, session/depth resolution) + trigger renderer
- `src/{registry,state,cooldown,transcript,session,roll}.ts` — Claude/file primitives
- `bin/agent-dice.ts` — CLI entrypoint
- `hooks/` — Claude Code hook scripts (stop, session-start)
- `install.sh` — Installer (symlinks, hook registration, dependency checks)
- `tests/unit/test_cc_dice.bats` — BATS test suite
- `tests/conformance/` — Conformance probes (`run.ts` entry; facade/storage/boundary/core-engine)
- `docs/architecture.md` — Architecture, design decisions, origin story

## Development

```bash
bun install                  # install dev dependencies
bun run test                 # run test suite (BATS + conformance). NOT bare `bun test`
./install.sh check           # verify installation
DEBUG=1 bun hooks/stop.ts    # run stop hook with verbose logging
```

## Key Concepts

- **Core + adapters**: `src/core/` owns host-agnostic policy behind the `DiceHost` contract; `src/adapters/claude-code.ts` is the only shipped host. `src/index.ts` stays the public facade. A second host (Pi/other) is future work — not shipped.
- **Boundary**: nothing under `src/core/**` may import a Claude/host module, node builtin, `Bun`, or `process.env` (enforced by conformance check C8).
- **Slots**: Named dice configurations persisted to `~/.claude/dice/slots.json`
- **Shared pools**: `checkAllSlots()` groups slots by die size, rolls one base die per group
- **Session isolation**: State is per-slot AND per-session via `AGENT_DICE_SESSION_ID` (or the `CC_DICE_SESSION_ID` back-compat alias)
- **Hook exit codes**: `0` = silent, `2` = stderr shown to Claude

## Testing

Tests use BATS with git submodules. All tests are isolated via `CC_DICE_BASE` temp directories.

```bash
git submodule update --init --recursive   # if submodules missing
bun run test
```

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `AGENT_DICE_BASE` | Override base directory (default: `~/.claude/dice/`; `CC_DICE_BASE` is a back-compat alias) |
| `AGENT_DICE_SESSION_ID` | Override session ID (`CC_DICE_SESSION_ID` is a back-compat alias) |
| `DEBUG=1` | Verbose logging to stderr |
