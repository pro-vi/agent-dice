---
title: Add Codex CLI as a third dice host
objective: Extend agent-dice's probabilistic nudges to Codex sessions, so a user running Codex gets the same dice-triggered reminders that Claude Code and Pi users already do — reaching a second hook-based agent with zero changes to the shared engine.
type: feat
status: active
date: 2026-07-18
origin: conversation (standalone /architect; no ticket/brainstorm)
---

# Add Codex CLI as a third dice host

## Context

agent-dice (renamed from cc-dice) is a probabilistic "roll dice on each turn; nudge the
model when it hits" system. It was deliberately refactored into a **host-agnostic engine**
(`src/core/`) behind a small `DiceHost` contract, with per-host **adapters**. Two hosts ship
today: Claude Code (`src/adapters/claude-code.ts` + `hooks/`) and Pi
(`src/adapters/pi/`). The engine owns policy (dice counts, trigger detection, cooldown/reset);
each adapter owns primitives (storage, session id, conversation depth).

Codex CLI (installed: 0.144.5) now ships **proper lifecycle hooks**. Research into its Rust
source (`codex-rs/hooks/`) found its hook system is a near-literal clone of Claude Code's —
same event names (`Stop`, `SessionStart`), same stdin-JSON contract (`session_id`,
`transcript_path`, `cwd`), and the **same nudge mechanism: exit 2 + stderr re-injects text to
the model**. ADR 0001 had predicted Codex would have "a fundamentally different lifecycle"; the
opposite is true. **Codex is a structural twin of the Claude host** (external hook scripts +
stdin JSON + exit-2 nudge), not a Pi-style in-process extension.

Outcome intended: a user runs `./install.sh codex`, registers a slot, and dice nudges surface
inside Codex turns — identical UX to Claude, isolated storage under Codex's own home.

**Decisions (confirmed with user):**
- **Per-host storage** at `${CODEX_HOME:-~/.codex}/dice` (honoring `AGENT_DICE_BASE` override),
  mirroring how Pi isolates under `~/.pi/agent/dice`. Claude and Pi untouched; sharing is opt-in
  via `AGENT_DICE_BASE`.
- **Scope:** `Stop` + `SessionStart` hooks (parity with the Claude host).

This plan reflects two rounds of adversarial review; the closed findings are recorded inline as
rationale so the plan reads cold.

## Architecture Decision

**Approach:** Add Codex as a **hook-based host that mirrors the Claude adapter**. New
`src/adapters/codex/` (rollout-transcript parser + host/context resolver) +
`hooks/codex-{stop,session-start}.ts` + a `codex` path in `install.sh`. Reuse the engine
(`src/core/engine.ts`), the Bun file stores (`registry`/`state`/`cooldown`), the generic
renderer `renderTrigger` (`src/adapters/claude-renderer.ts`), and `getProjectHash`
(`src/session.ts`).

**Rationale (criteria: Consistency #1, Simplicity #2):** Codex's hook model is Claude-compatible,
so the Claude adapter is the template. `getBaseDir()` reads `AGENT_DICE_BASE` **at call time**
(`src/registry.ts:20`) and Codex hooks run under `bun`, so pointing the existing Bun stores at
`${CODEX_HOME:-~/.codex}/dice` needs one guarded env line — **not** a third storage
reimplementation.

**Rejected alternative:** A dedicated Codex `store.ts` mirroring Pi's. Pi needed its own
Node-`fs` store because Pi runs under Node (no `Bun.*`); Codex runs Bun. A third copy would be
pure duplication and would reintroduce the byte-for-byte format-parity burden that reuse avoids.

**Refinement A — one root, defined once (closes a root-mismatch gap):**
- Runtime (`codex/host.ts`): `codexRoot() = process.env.CODEX_HOME || join(homedir(), ".codex")`
  — **`||`, not `??`**, so an empty-string `CODEX_HOME` falls through (matches Bash `${VAR:-…}`).
  `codexBaseDir() = AGENT_DICE_BASE ?? CC_DICE_BASE ?? join(codexRoot(), "dice")`.
- Installer (bash): `CODEX_ROOT="${CODEX_HOME:-$HOME/.codex}"`; hooks at `$CODEX_ROOT/hooks.json`,
  data at `$CODEX_ROOT/dice`, hook scripts symlinked under `$CODEX_ROOT/dice/`.
- Both resolve identically, including the empty-`CODEX_HOME` case.

**Refinement B — the host owns base selection:** `createCodexHost()` runs the guarded bootstrap
(`process.env.AGENT_DICE_BASE ??= codexBaseDir()`) internally, then returns the file host. No
entry point repeats the shim. `??=` preserves an explicit `AGENT_DICE_BASE` override.

**Integration-shape check (no bridge unit):** `createCodexHost()` returns a value type-identical
to `createClaudeHost()`'s `DiceHost` (already consumed by the engine). `resolveCodexContext(input)`
returns `CoreCheckContext` (`{ sessionId, getCurrentDepth }`), the same shape `resolveCoreContext`
returns (`src/adapters/claude-code.ts:58`). Only the depth parser differs.

## Representation ledger — conversation depth across 3 hosts

Depth feeds the accumulator. Each host derives it from its own transcript (a necessary
boundary mirror).

- **Codex predicate:** `type==="response_item" && payload.type==="message" && payload.role==="user"`
  — verified against a real rollout; excludes `assistant`/`developer`/`reasoning` and
  `function_call_output`/`custom_tool_call_output`. Analog of Claude's
  `type==="user" && !toolUseResult` (`src/transcript.ts:93`) and Pi's `role==="user"` count
  (`src/adapters/pi/depth.ts:16`).
- **Invariant (precise, not overstated):** all three hosts increment depth by the **same amount
  per ordinary user turn**. There is a possible **host-specific constant initial offset**: a real
  rollout carried two `role:"user"` records for one human request because the
  `<environment_context>` bootstrap is user-role (Claude similarly counts an injected first user
  entry). This preserves the **accumulation slope**, so `accumulationRate` transfers unchanged.
  It does **not** cancel the offset: with state initialized at depth 0, a +1 bootstrap offset
  makes the **first** threshold arrive one ordinary turn earlier. This is an **accepted
  initial-phase skew**; after the first trigger/reset, state is rebased to the current depth and
  progression is equivalent across hosts.
- **Storage format:** Claude's file stores are the authority; Codex reuses them verbatim, so it
  cannot drift (no C3-style parity test needed, unlike Pi).

## Implementation Units

### U1. Codex rollout depth parser
- **Goal:** Count conversation depth from a Codex `rollout-*.jsonl` transcript.
- **Requirements:** Depth source for the accumulator on Codex.
- **Dependencies:** None
- **Files:**
  - Create: `src/adapters/codex/transcript.ts`
  - Test: `tests/conformance/codex-transcript.conformance.ts`
- **Approach:** `countExchanges(path)` mirroring `src/transcript.ts:80` (Bun.file, per-line
  try/catch, missing file → 0). Count the predicate above. Full-file rescan is acceptable — the
  parser processed a 135 MiB rollout in ~0.16s under Bun; no tail/incremental optimization. Live
  `.jsonl` only (cold `.jsonl.zst` is never a Stop `transcript_path`); note this in a comment.
- **Patterns to follow:** `src/transcript.ts:80`; depth-unit rationale in `src/adapters/pi/depth.ts`.
- **Test scenarios:**
  - *Happy:* rollout with 3 `role:"user"` message records → 3.
  - *Edge:* `developer` / `reasoning` / `function_call_output` lines excluded.
  - *Edge (documents the offset):* a leading `<environment_context>` `role:"user"` record **is**
    counted — asserts and documents the constant initial offset.
  - *Edge:* empty / missing file → 0.
  - *Error:* malformed JSON line skipped, remainder counted.
- **Verification:** Returns user-turn count with tool/assistant/reasoning excluded; the offset
  behavior is pinned by a test, not just prose.

### U2. Codex host + context resolver
- **Goal:** Provide `DiceHost` + `CoreCheckContext` for Codex, owning base selection.
- **Dependencies:** U1
- **Files:** Create `src/adapters/codex/host.ts`
- **Approach:** `codexRoot()` (`||` fallback per Refinement A) + `codexBaseDir()`.
  `createCodexHost()` bootstraps the base (`AGENT_DICE_BASE ??= codexBaseDir()`) then returns
  `createClaudeHost()`. `resolveCodexContext(input)` → `sessionId = input.session_id ?? getProjectHash()`;
  depth lazy + memoized via U1, `undefined` when no `transcript_path`.
- **Patterns to follow:** `src/adapters/claude-code.ts:18,58`; `src/adapters/pi/store.ts:49`
  (env precedence).
- **Test scenarios:**
  - *Edge:* `CODEX_HOME=/tmp/x` → `codexBaseDir()` under `/tmp/x/dice` (custom root, not `$HOME/.codex`).
  - *Edge:* `CODEX_HOME=""` → falls back to `$HOME/.codex/dice` (empty-string case).
  - *Edge:* explicit `AGENT_DICE_BASE` wins over `codexRoot()`.
  - *Edge:* missing `session_id` → `getProjectHash()`.
  - (Trigger behavior locked in U5.)
- **Verification:** One root drives data path and (with U4) hook path across default / custom /
  empty `CODEX_HOME`; explicit override respected.

### U3. Stop + SessionStart hook scripts
- **Goal:** Roll on turn-end and clear on new-session, surfacing nudges to Codex.
- **Dependencies:** U2
- **Files:** Create `hooks/codex-stop.ts`, `hooks/codex-session-start.ts`
- **Approach:** No manual env shim — call `createCodexHost()` (bootstraps the base).
  - **codex-stop.ts:** parse stdin (`session_id`, `transcript_path`) →
    `engine.checkAllSlots(host, resolveCodexContext(input))` → `renderTrigger` (imported
    **statically** from `src/adapters/claude-renderer.ts` — **no local fallback renderer**; unlike
    Claude's dynamically-imported installed module, this hook statically imports the matching
    source version, so version-skew fallback is unnecessary). Trigger → exit 2 + stderr; else exit 0;
    all errors fail-open (exit 0). Engine called directly (not the Claude-bound `index.checkAllSlots`).
  - **codex-session-start.ts:** parse stdin (`session_id`, `source`); clear only on
    `source ∈ {startup, clear}` (skip `resume`/`compact`) via `engine.sessionStart`; fail-open
    silent. No `CLAUDE_ENV_FILE` analog exists in Codex and none is needed — Stop payloads always
    carry `session_id`.
- **Patterns to follow:** `hooks/stop.ts` (stdin→checkAllSlots→exit-2 + fail-open),
  `hooks/session-start.ts`; `source`-gating rationale in `src/adapters/pi/index.ts:40`.
- **Test scenarios:** locked in U5.
- **Verification:** Trigger → exit 2 + stderr nudge; a genuinely-new session clears the right
  slots; failures never block Codex.

### U4. Installer `codex` path
- **Goal:** `./install.sh codex` wires hooks + storage; `check`/`uninstall` are host-scoped and
  data-safe.
- **Dependencies:** U3
- **Files:** Modify `install.sh`; add sandboxed cases to `tests/unit/test_cc_dice.bats`
- **Approach:**
  - **Commands:** `./install.sh codex`, `./install.sh check codex`, `./install.sh uninstall codex`
    (bare/`check`/`uninstall` stay Claude-scoped). Needs two-token arg parsing in the `case`
    dispatch (`install.sh:355`).
  - **Root:** `CODEX_ROOT="${CODEX_HOME:-$HOME/.codex}"` everywhere.
  - **Install:** `mkdir -p $CODEX_ROOT/dice/state`; symlink hook scripts under `$CODEX_ROOT/dice/`;
    register `Stop` + `SessionStart` command hooks into `$CODEX_ROOT/hooks.json` **with an explicit
    `timeout`** (e.g. `10`). Generalize `register_hook`/`unregister_hook` (`install.sh:101`) to take
    a **target-file** arg — Codex `hooks.json` block shape == Claude `settings.json` block, so the
    jq reuses.
  - **Idempotent registration (trust-safe):** Codex hook trust is index-sensitive
    (`~/.codex/config.toml` `[hooks.state]`). Re-registration must be a **byte-for-byte no-op when
    an identical command entry already exists** (or update in place) — **never remove-then-append**,
    which changes indices and churns trust. Existing unrelated hooks and their order are preserved.
  - **Uninstall (data-safe, host-scoped):** remove **only** Codex hooks + code symlinks. **Preserve
    `$CODEX_ROOT/dice` (slots.json + state) by default**; delete data only under an explicit
    `--purge-data` flag (mirrors the confirm-before-delete pattern at `install.sh:329`). Remove the
    shared `agent-dice`/`cc-dice` CLI symlink **only when no host remains** — i.e. only if the Claude
    module symlink `~/.claude/dice/cc-dice.ts` is absent. Never touch Claude hooks or `settings.json`.
- **Test scenarios (sandboxed: `HOME` and `CODEX_HOME` → `mktemp -d`):**
  - *Integration:* `install.sh codex` → `hooks.json` has both hooks **with the timeout**, symlinks
    resolve, `check codex` OK.
  - *Custom root:* `CODEX_HOME != $HOME/.codex` honored for hooks + data.
  - *Idempotency (trust-safe):* a second `install.sh codex` leaves `hooks.json` **byte-for-byte
    unchanged** and preserves unrelated hook order.
  - *Preservation:* a pre-existing unrelated hook survives install and uninstall.
  - *Data safety:* `uninstall codex` (no flag) leaves `$CODEX_ROOT/dice/slots.json` intact;
    `--purge-data` removes it.
  - *Coexistence:* Claude + Codex installed → `uninstall codex` leaves Claude hooks **and** the
    shared CLI intact; uninstalling the last remaining host removes the CLI.
- **Verification:** Codex install/uninstall is host-scoped, idempotent (no trust churn),
  root-consistent, and never deletes user data without `--purge-data`.

### U5. Deterministic hook probe + wiring conformance
- **Goal:** Prove the engine drives the Codex host end-to-end, model-free — with the untested
  boundary named.
- **Dependencies:** U2, U3
- **Files:** Create `tests/conformance/codex-wiring.conformance.ts`, `tests/codex-hook-probe.sh`;
  Modify `tests/unit/test_cc_dice.bats`
- **Approach:**
  - *Wiring conformance:* temp `AGENT_DICE_BASE`, register a slot, synthetic rollout at
    `transcript_path`, `engine.checkAllSlots` with `resolveCodexContext` + **seeded rng** → assert
    trigger, accumulator reset, cooldown marker, and depth-from-Codex-parser. Mirror
    `tests/conformance/pi-wiring.conformance.ts`.
  - *`codex-hook-probe.sh`:* pipe synthetic Stop JSON into `bun hooks/codex-stop.ts` → assert exit 2
    + nudge on trigger; exit 0 on no-trigger. **Explicitly documents** that it proves *hook-script
    behavior only* and **bypasses Codex's hook loader, schema validation, trust gate, and real
    payload production** — that upstream-drift surface is not covered here. CI-friendly (no `codex`
    binary). Mirror `tests/pi-smoke.sh`.
- **Test scenarios:** the probe/conformance cases above.
- **Verification:** `bun run test` green including new probes; the untested drift boundary is named,
  not hidden.

### U6. Docs + conformance flip + ADR amendment + package
- **Goal:** Document Codex as a shipped third host and update the guard that currently forbids that
  claim.
- **Dependencies:** U1–U5
- **Files:** Modify `tests/conformance/docs.conformance.ts`, `docs/architecture.md`, `CLAUDE.md`,
  `README.md`, `docs/adr/0001-host-agnostic-core-and-adapters.md`, `package.json`
- **Approach:**
  - **C9 flip (land WITH the docs — the suite is red until both change):** in
    `docs.conformance.ts`, change the third check (`:38`) from *"no doc claims Codex ships"* to
    *"Codex is documented as a shipped third host"*; require `architecture.md` to mention codex; keep
    the Pi assertions. The old overclaim guard was correct while Codex was research-only; shipping
    inverts it.
  - **architecture.md:** Codex as third host (hook-based Claude twin; rollout parser;
    `${CODEX_HOME:-~/.codex}/dice`; `hooks.json`; exit-2 nudge) + host-section/file-map updates.
  - **CLAUDE.md:** layout (`src/adapters/codex/`, `hooks/codex-*.ts`), `CODEX_HOME` env var, testing.
  - **README.md:** Codex install (`./install.sh codex`); CLI recipe shown with a real env var —
    `AGENT_DICE_BASE="${CODEX_HOME:-$HOME/.codex}/dice" agent-dice register …` (not a made-up
    `$CODEX_ROOT`); and a trust note distinguishing one-shot `--dangerously-bypass-hook-trust`
    (per-invocation) from **persisted** hook approval.
  - **ADR 0001:** add a **new dated amendment (2026-07-18)** to the existing Accepted record —
    **preserve** the 2026-06-20 "fundamentally different lifecycle" prediction as historical
    evidence; the new amendment records that Codex hooks are Claude-compatible, it *does* have
    SessionStart with `source` gating, the nudge is identical, and the seam held a **third** time
    with zero core changes.
  - **package.json:** description + `codex` keyword.
- **Test scenarios:** none (docs) — but C9 must be green after the flip.
- **Verification:** Docs describe three shipped hosts; C9 passes *because* it now requires Codex;
  the ADR keeps its prediction beside its dated correction.

## Scope Boundaries
- Per-host `${CODEX_HOME:-~/.codex}/dice` only; sharing stays opt-in via `AGENT_DICE_BASE`.
- No new CLI flag; Codex config uses the existing CLI via `AGENT_DICE_BASE`.
- No in-process Codex config UX (external hook processes can't register in-process tools/commands).
- `Stop` + `SessionStart` only; no PreToolUse/PostToolUse/Compact hooks.
- No `.jsonl.zst` decompression (only the live uncompressed session is read).

### Deferred to Follow-Up Work
- **Optional real-Codex live smoke** — a `codex`-gated script exercising the real hook loader /
  schema / trust / payload; needs model + auth + trust behavior defined. Out of this plan; the
  deterministic probe (U5) stays in.
- **Cross-host equivalent-conversation depth fixtures** — prove the initial offset is truly
  constant across Claude/Pi/Codex; test-hardening PR.
- **`AGENT_DICE_HOST=codex` CLI convenience** and **installer auto-trust** of the Codex hook hash.

## System-Wide Impact
- **Interaction graph:** two new hook scripts invoked by Codex → the *existing* engine + stores;
  Claude/Pi entry points untouched.
- **Error propagation:** hooks fail-open (exit 0), like `hooks/stop.ts` — a dice bug never blocks a
  Codex turn.
- **State lifecycle:** Codex state lives under `$CODEX_ROOT/dice/state/`; per-session keys (distinct
  UUIDs) mean no cross-host collision even if a user later shares a base.
- **Unchanged invariants:** `src/core/**`, the `DiceHost`/`CoreCheckContext` contract, the Claude and
  Pi adapters, the on-disk format, and C8 are all untouched. **C9 does change — intentionally, in
  lockstep with the docs it guards.**

## Risks & Dependencies
| Risk | Mitigation |
|---|---|
| Codex payload/loader/schema/trust drift from the researched source | U5 probe is honestly scoped to hook behavior; drift boundary named; hooks read fields defensively + fail-open. Real-loader smoke deferred. |
| Custom or empty `CODEX_HOME` splits install vs runtime | Single root (`CODEX_ROOT` / `codexRoot()` with `||` fallback) + custom-root and empty-string tests in U2/U4. |
| Destructive uninstall removing user data or shared CLI/Claude artifacts | Data preserved unless `--purge-data`; CLI removed only when Claude module symlink absent; coexistence + preservation + data-safety tests in U4. |
| Re-install churns Codex hook trust | Idempotent registration: byte-for-byte no-op on identical command; never remove-then-append; asserted in U4. |
| `<environment_context>` inflates depth by a constant | Accepted initial-phase skew (documented in the ledger + U1 test); slope preserved, first threshold one turn early, equivalent after first reset. |

## Verification (end-to-end)
1. `bun run test` — BATS + conformance green, including new Codex transcript/wiring probes, the
   installer cases, and the flipped C9.
2. Deterministic hook probe: register a guaranteed-trigger slot under a temp base; pipe a synthetic
   Stop JSON into `bun hooks/codex-stop.ts` → exit 2 + `🎲 Nat …` on stderr; non-trigger → exit 0.
3. `./install.sh codex` under a temp `CODEX_HOME`, then `./install.sh check codex` → both hooks in
   `hooks.json` with timeout, symlinks resolve; re-run leaves `hooks.json` byte-for-byte unchanged;
   `uninstall codex` preserves `slots.json`.
4. (Optional, manual) In a real Codex session with a registered slot, confirm a trigger surfaces as
   an injected nudge and `$CODEX_ROOT/dice/state/` shows per-session state/cooldown files.
