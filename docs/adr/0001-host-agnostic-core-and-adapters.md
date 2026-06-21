# ADR 0001: Host-agnostic dice core behind a provisional DiceHost contract

- **Status:** Accepted (amended 2026-06-20 — validated by the Pi adapter; see Amendment)
- **Date:** 2026-06-20
- **Tickets:** PR #2 (v0.2.0, commit 33e80dc); Pi adapter on branch `feat/pi-adapter`
- **Deciders:** provi; Claude Code; cross-model `/code-review`
- **Supersedes:** —

> **Renamed:** the package became **agent-dice** in v0.4.0 (the `cc-dice` command and
> `CC_DICE_*` env vars remain as aliases). "cc-dice" below is the original name.

## Amendment (2026-06-20): validated by the Pi adapter

The "a second host is actually built → finalize the contract" revisit trigger has
**fired**. A Pi adapter (`src/adapters/pi/`, installed via `pi install`) now drives
the engine with **zero changes to `src/core/` or `DiceHost`/`CoreCheckContext`** — the
seam held. The contract is no longer provisional in the "untested against a real
second host" sense.

What the build confirmed:

- **Both hedges paid off.** Lazy `getCurrentDepth` and adapter-only resolution (D1)
  hold — Pi resolves session via `ctx.sessionManager.getSessionId()` and depth via the
  adapter; the engine touches neither.
- **No interface change.** Storage, trigger (`agent_end`), and render
  (`pi.sendMessage`) all mapped onto the existing primitives.

Deltas — documentation/adapter, not contract:

- **Depth is the same unit on both hosts.** Pi depth = count of user-message entries
  from `sessionManager.getEntries()` (session-cumulative), the exact analog of the
  Claude adapter's `countExchanges` (`type==="user" && !toolUseResult`). So
  `accumulationRate` needs **no** per-host recalibration. (Code review correction: the
  first cut used `turn_end.turnIndex`, which Pi resets to 0 each prompt
  — `agent-session.ts:615` — silently zeroing the accumulator; fixed before merge.)
- **Session lifecycle is `reason`-gated.** `clearOnSessionStart` clears only on
  `SessionStartEvent.reason ∈ {new, startup}`, not `resume`/`reload`/`fork`
  (continuations of the same logical session). Codex would have no in-session
  session-start event and must synthesize one.
- **Render channel is adapter-owned** (as designed): Pi surfaces via `sendMessage`
  (`content` = text, `display` = boolean UI flag) vs Claude's stderr + exit 2. The U1
  probe caught that the published Pi `CustomMessage.display` is a boolean, not the
  string the `badlogic/pi-mono` snapshot implied — an adapter fix, not a contract one.
- **Delivery is best-effort (at-most-once).** The engine commits cooldown + reset at
  roll time, but the Pi nudge rides the in-memory `nextTurn` queue, which is dropped if
  the session ends before the next prompt — so a trigger can be spent without being
  shown. Acceptable for a probabilistic nudge; documented rather than engineered around
  (forcing delivery via `triggerTurn` risks re-trigger loops for no-cooldown slots).

The contract is validated for Claude + Pi. It may still evolve for a host with a
fundamentally different lifecycle (e.g. Codex's hook-process model) — that remains a
revisit trigger.

## Context

cc-dice's scheduling logic (dice counts, shared-roll grouping, trigger detection,
reset/cooldown-on-trigger, sentinel calibration) lived in `src/index.ts` and
`src/accumulator.ts`, entangled with Claude-specific sources: transcript depth
(`countExchanges`), session resolution, file-backed registry/state/cooldown, and
hook rendering. The dice mechanic itself is host-agnostic, and there was intent to
reuse it from another agent host (Pi). But **exactly one host exists today**, and
no second adapter was being built in this change.

The pressure: capture the reuse seam while the codebase is tiny, without branding
or freezing an abstraction that a real second host hasn't yet validated.

## Decision

Extract a host-agnostic engine under `src/core/` behind a `DiceHost` contract, and
keep `src/index.ts` as the unchanged public facade. Ship a Claude Code adapter
(`src/adapters/`) as the **only** host.

Binding constraints:

- **Engine owns policy; host owns primitives** (list/get slots, load/save/clear
  state, check/mark/clear cooldown, optional RNG).
- **Resolution is adapter-only.** `DiceHost` exposes **no** `resolveSessionId`/
  `resolveCurrentDepth`; the adapter resolves session id eagerly and current depth
  lazily, handing the engine a resolved `CoreCheckContext { sessionId,
  getCurrentDepth() }`. (This is the as-shipped form; it diverges from the original
  plan, which had host-side resolve methods.)
- **`src/core/**` must not reach** any Claude/host module, node builtin, `Bun`, or
  `process.env` — enforced mechanically by an import-graph conformance check (C8).
- **The contract is provisional.** It is shaped by the one host that exists; do not
  rename/repackage to a generic name, and do not publish or version `DiceHost` as
  public API, until a second host has exercised it.

## Rationale

A reusable mechanic needs a real seam, but a contract can't be proven against a
host that doesn't exist. Extracting only the seams Claude already uses captures the
present-day, host-independent wins — a pure, deterministically testable engine and
accumulator (via injectable RNG), and removal of the math↔Claude coupling — while
keeping the abstraction out of the public brand. The seam is cheapest to add now,
while `src/` is small. Framing the contract as provisional avoids over-fitting it
to a single host.

Rejected alternatives:

- **Rename/split into a generic `agent-dice` package now** — brands an unproven
  abstraction and risks breaking the installed `cc-dice` CLI/hook surface.
- **Freeze a full host contract as public API now** — unfalsifiable against a
  nonexistent second host; the shape would likely be wrong.

## Consequences

Positive:

- Core engine + accumulator are pure and deterministically testable; the only
  math↔Claude coupling (`countExchanges`) is gone from core.
- A second host can implement `DiceHost` without importing Claude transcript/
  session helpers; the boundary is enforced by C8, behavior by a 6-suite
  conformance harness + CI.
- Lazy/memoized depth means cheap no-op Stop paths (no accumulator active, all
  cooled) never parse the transcript.

Negative:

- Net-new indirection (facade → adapter → engine → host) for a single host today —
  a deliberate, small bet on the second host.
- `DiceHost` is unproven against a real host and likely to change when Pi lands;
  it is intentionally **not** public/versioned API.
- One behavior change shipped alongside the refactor: `reset`/`clear` now exit `1`
  on a missing slot (was silent exit 0).

## Revisit Triggers

- **A second host (Pi or other) is actually built** → finalize/freeze the contract
  and amend or supersede this ADR (drop "provisional").
- **No second host materializes in a reasonable window** → reconsider whether the
  core/adapters indirection earns its keep; consider collapsing it back.
- **The contract is found to need host-side resolution or host-side depth** →
  revisit the adapter-only resolution decision.

## References

- PR #2 / commit 33e80dc; release v0.2.0
- `src/core/contracts.ts` (`DiceHost`, `CoreCheckContext`), `src/core/engine.ts`,
  `src/core/accumulator.ts`, `src/adapters/claude-code.ts`, `src/adapters/claude-renderer.ts`
- Boundary check: `tests/conformance/boundary.conformance.ts` (C8); engine probes:
  `tests/conformance/core-engine.conformance.ts`
- `docs/architecture.md` — "Architecture: Core + Adapters"
- Source plan (local, untracked, now compacted into this ADR):
  `docs/plans/2026-06-20-001-refactor-core-adapters-conformance-plan.md`
