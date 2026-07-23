# agent-dice

Probabilistic dice triggers for AI agent hooks — one host-agnostic engine with adapters for [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Codex](https://github.com/openai/codex), and [Pi](https://github.com/badlogic/pi-mono).

> Formerly **cc-dice**. The `cc-dice` command and `CC_DICE_*` env vars still work as aliases, so existing setups keep running.

Register dice slots, and agent-dice rolls them on every agent stop event. Accumulators escalate probability with conversation depth; single/fixed slots give flat odds.

## Why

Claude Code sessions are long-running, stateful, and unpredictable, which reminds me of a video game. Very much like a tabletop RPG campaign. In D&D, dice are the core mechanic that makes emergent behavior possible. A Natural 20 happens because probability demands it and it changes the course of the game.

agent-dice is more of a nod to the mechanics than trying to become a sophisticated plugin. In fact, you can create a stop hook yourself with a flat 5% chance to mimic a d20 roll. However, agent-dice gives you what a one-liner can't: accumulating dice pools across turns, shared rolls across multiple slots, per-session cooldowns, and state that persists across turns.

This creates moments that feel organic rather than scheduled. A prompt to invoke a skill that fires at turn 42 because the dice finally landed without any intervention. Your agents are part of the campaign.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/pro-vi/agent-dice/main/install.sh | bash
```

Or clone locally:

```bash
git clone https://github.com/pro-vi/agent-dice.git
cd agent-dice && ./install.sh
```

Requires [bun](https://bun.sh), [git](https://git-scm.com), and [jq](https://jqlang.github.io/jq/).

```bash
./install.sh check      # verify
./install.sh uninstall   # remove
```

### Codex

Codex ships proper lifecycle hooks, so the same dice work there too (see [Use with Codex](#use-with-codex)):

```bash
./install.sh codex             # install for Codex (~/.codex)
./install.sh check codex       # verify
./install.sh uninstall codex   # remove (keeps your slots; add --purge-data to wipe)
```

On first run Codex asks to **trust** the command hook — approve it (a persisted approval that sticks), or pass `--dangerously-bypass-hook-trust` for a single non-interactive invocation. Codex slots live under `${CODEX_HOME:-~/.codex}/dice`; point the CLI there with `AGENT_DICE_HOST=codex` (the bare CLI defaults to the Claude base):

```bash
AGENT_DICE_HOST=codex agent-dice register my-slot --message 'Triggered!'
# or an explicit path (wins over AGENT_DICE_HOST):
AGENT_DICE_BASE="${CODEX_HOME:-$HOME/.codex}/dice" agent-dice register my-slot --message 'Triggered!'
```

## Quick Start

```bash
# Register an accumulator slot (escalating probability)
agent-dice register refactor \
  --die 20 --target 20 --type accumulator \
  --message "Cast /refactor and review your current work."

# Register a flat-chance slot
agent-dice register second-opinion \
  --die 20 --target 2 --type single \
  --message "Get a second opinion (e.g. from codex)."

# Check status
agent-dice status refactor

# Manual roll (dry run, no state change)
agent-dice roll second-opinion
```

That's it. The installed stop hook rolls all slots automatically on every Claude Code stop event.

## How Hooks Work

The installer registers a **Stop** hook in `~/.claude/settings.json`. On each stop:

1. Hook receives `{ session_id, transcript_path }` on stdin
2. `checkAllSlots()` groups slots by die size, rolls one base die per group
3. Each slot checks its target against shared/bonus rolls
4. On trigger: `🎲 Nat {best}! {message}` shown to Claude via stderr (exit `2`)
5. No triggers: exit `0` (roll results visible to user only)

A **SessionStart** hook clears state for slots with `clearOnSessionStart` (default).

## Slot Configuration

```bash
agent-dice register <name> [options]
```

| Option | Default | Description |
|--------|---------|-------------|
| `--die <n>` | 20 | Die size (d20, d6, etc.) |
| `--target <n>` | 20 | Target number |
| `--target-mode <mode>` | exact | `exact`, `gte`, or `lte` |
| `--type <type>` | accumulator | `accumulator`, `fixed`, or `single` |
| `--accumulation-rate <n>` | 7 | Turns per +1 die (accumulator only) |
| `--max-dice <n>` | 100 | Dice cap (accumulator only) |
| `--fixed-count <n>` | 1 | Dice count (fixed only) |
| `--cooldown <mode>` | per-session | `per-session` or `none` |
| `--no-clear-on-start` | | Don't clear state on session start |
| `--no-reset-on-trigger` | | Don't reset accumulator on trigger |
| `--no-flavor` | | Don't prepend dice emoji + roll lingo |
| `--message <msg>` | | Message shown to Claude on trigger |

### Message Placeholders

`{rolls}`, `{best}`, `{diceCount}`, `{slotName}` are replaced at trigger time.

By default, trigger output is prefixed with `🎲 Nat {best}!` — disable with `--no-flavor`.

### Dice Types

**Accumulator**: +1 die per N turns since last trigger. Escalating pressure.

```
Turns 0-6:   0 dice (0%)      Turns 14-20: 2d20  (9.8%)
Turns 7-13:  1d20  (5%)       Turns 21-27: 3d20  (14.3%)
```

**Single**: Always 1 die. Flat chance every stop event.

**Fixed**: Always N dice. Constant probability.

## Shared Roll Pools

Slots sharing a die size observe the same base roll:

- Two single d20 slots claiming different faces are mutually exclusive
- An accumulator d20 slot gets the shared base roll + independent bonus dice
- Different die sizes (d20 vs d6) roll independently

This means registering `reflection` (target 20) and `second-opinion` (target 1) on a d20 guarantees at most one triggers per base roll.

## CLI Reference

```
agent-dice register <name> [options]   Register a dice slot
agent-dice unregister <name>           Remove a slot
agent-dice list                        List all slots
agent-dice status <name>               Show dice status
agent-dice roll <name>                 Dry-run roll
agent-dice reset <name>                Reset accumulator
agent-dice clear <name>                Clear state
```

## Storage

```
~/.claude/dice/
  slots.json                          Slot registry
  state/
    {slotName}-{sessionId}.json       Per-slot per-session state
    triggered-{slotName}-{sessionId}  Cooldown markers
```

## Library API

Hooks and scripts can import via the installed symlink:

```typescript
const { registerSlot, checkAllSlots } =
  await import(`${process.env.HOME}/.claude/dice/cc-dice.ts`);
```

Or from the source tree directly:

```typescript
import { registerSlot, checkAllSlots } from "./src/index";
```

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `AGENT_DICE_BASE` | Override base directory (default: `~/.claude/dice/` for Claude, `${CODEX_HOME:-~/.codex}/dice` for Codex, `~/.pi/agent/dice/` for Pi). Point two hosts at one path to share config. |
| `AGENT_DICE_HOST` | CLI host target: `codex` points `agent-dice` at the Codex base (a bare CLI defaults to Claude). `AGENT_DICE_BASE` overrides it. |
| `AGENT_DICE_SESSION_ID` | Override session ID |
| `CODEX_HOME` | Codex home root; the Codex host stores under `$CODEX_HOME/dice` (default `~/.codex`) |
| `DEBUG=1` | Verbose logging to stderr |

`CC_DICE_BASE` / `CC_DICE_SESSION_ID` remain supported as back-compat aliases (read when the `AGENT_DICE_*` form isn't set; the session-start hook sets both).

## Troubleshooting

**`./install.sh check` shows broken symlinks**: The source directory was moved or deleted. Re-run `./install.sh` to re-link.

**Hook not firing**: Verify with `./install.sh check` that hooks are registered in `settings.json`. Use `agent-dice roll <name>` to test a dry run.

**State not clearing between sessions**: Ensure the SessionStart hook is registered. Use `agent-dice clear <name>` to reset a specific slot manually.

## Architecture

agent-dice is a thin host **facade over a reusable, host-agnostic dice core**.
Scheduling (dice counts, shared rolls, cooldowns, sentinel calibration) lives in
`src/core/`; everything host-specific (transcripts/sessions, file storage, hook or
event output) lives in `src/adapters/`. The Claude Code public API in `src/index.ts`
is unchanged. The same engine drives **three hosts** via the `DiceHost` contract, with
zero core changes: Claude Code (default), **Codex** (`src/adapters/codex/`, a hook-based
host — the Claude twin), and **Pi** (`src/adapters/pi/`, an in-process extension). See
both below.

## Use with Codex

[Codex](https://github.com/openai/codex) ships Claude-Code-compatible lifecycle hooks, so
agent-dice runs there as a **hook-based host** — the structural twin of the Claude setup.
Install it with `./install.sh codex` (see [Install → Codex](#codex)).

Codex's `Stop` hook rolls all slots on turn-end; on a trigger the nudge goes to stderr and
the hook exits 2, which Codex re-injects to the model — exactly like Claude. Its
`SessionStart` hook clears `clearOnSessionStart` slots on a genuinely new session
(`source` `startup`/`clear`).

Configure slots with the CLI pointed at the Codex base via `AGENT_DICE_HOST=codex`:

```bash
AGENT_DICE_HOST=codex agent-dice register refactor \
  --die 20 --target 20 --message "Cast /refactor and review."
```

Codex config is CLI-driven (external hook processes can't register in-process tools, so
there's no `/dice` command or `register_dice` tool as under Pi). Slots live under
`${CODEX_HOME:-~/.codex}/dice`. `AGENT_DICE_HOST=codex` targets that base; a bare
`agent-dice register` (no env) targets the **Claude** base, and an explicit
`AGENT_DICE_BASE` overrides both — point two hosts at one path to share config.

## Use with Pi

agent-dice also ships as a [Pi](https://github.com/badlogic/pi-mono) extension — the
same core engine behind a Pi adapter.

```bash
pi install npm:agent-dice
# or from source:
pi install git:github.com/pro-vi/agent-dice
```

**Configure by talking to the agent (recommended).** The extension registers
`register_dice` / `list_dice` / `remove_dice` tools, so you just describe intent —
no flags to type:

> "nudge me to refactor as the session gets long, and about 5% of turns remind me to get a second opinion"

The agent calls `register_dice` and the slots are created.

**Or drive it yourself** with the `/dice` command (mirrors the CLI):

```text
/dice register refactor --die 20 --target 20 --message "Cast /refactor and review."
/dice list | status <name> | roll <name> | reset <name> | clear <name>
```

The extension rolls on each `agent_end` (Pi's analog of Claude's Stop) and injects a
nudge when a slot triggers. State lives under `~/.pi/agent/dice/` (or `AGENT_DICE_BASE`).

**Depth & delivery:** Pi measures depth the same way as Claude — the count of user
messages in the session (`sessionManager.getEntries()`, the analog of Claude's
transcript exchanges) — so `accumulationRate` defaults carry over unchanged. Trigger
nudges are best-effort (at-most-once): cooldown/reset commit at roll time, but a nudge
can be dropped if the session ends before Pi's next turn.

## Contributing

```bash
git clone --recurse-submodules https://github.com/pro-vi/agent-dice.git
cd agent-dice
bun install
bun run test   # BATS suite + conformance probes (bare `bun test` won't run BATS)
```

Test submodules (bats-core, bats-support, bats-assert) are required. If you cloned without `--recurse-submodules`:

```bash
git submodule update --init --recursive
```

See [docs/architecture.md](docs/architecture.md) for internals.

## License

MIT
