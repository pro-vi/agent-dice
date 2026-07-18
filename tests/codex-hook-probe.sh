#!/usr/bin/env bash
# Deterministic Codex hook probe for agent-dice (model-free, CI-friendly).
#
# Pipes synthetic hook payloads into the hook SCRIPTS directly and asserts their
# exit codes + stderr — the exit-2/stderr nudge is the whole integration contract.
#
# SCOPE / what this does NOT cover: it invokes the scripts directly, so it bypasses
# Codex's hook loader, hooks.json schema, hook-trust gate, and real payload
# production. Upstream drift in those (a renamed field, a schema change) is NOT
# caught here — that needs a live-Codex smoke, deferred (see the plan's Deferred
# Work). This probe proves the hook scripts behave, given a Codex-shaped payload.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASE="$(mktemp -d)"
trap 'rm -rf "$BASE"' EXIT
export AGENT_DICE_BASE="$BASE"
mkdir -p "$BASE/state"

fail() { echo "FAIL: $1"; exit 1; }

echo "==> Stop with no slots registered → exit 0 (silent)"
echo '{"session_id":"probe","hook_event_name":"Stop"}' | bun "$ROOT/hooks/codex-stop.ts" >/dev/null 2>&1
[ $? -eq 0 ] || fail "empty-registry Stop should exit 0"

echo "==> register a guaranteed-trigger slot (single d1 target 1)"
bun "$ROOT/bin/agent-dice.ts" register probe --type single --die 1 --target 1 --message "poke {best}" >/dev/null 2>&1 \
  || fail "could not register probe slot"

echo "==> Stop with a triggering slot → exit 2 + nudge on stderr"
STDERR="$(echo '{"session_id":"probe","hook_event_name":"Stop"}' | bun "$ROOT/hooks/codex-stop.ts" 2>&1 1>/dev/null)"
CODE=$?
[ $CODE -eq 2 ] || fail "triggering Stop should exit 2 (got $CODE)"
echo "$STDERR" | grep -q "🎲 Nat 1!" || fail "stderr should carry the rendered nudge (got: $STDERR)"
echo "$STDERR" | grep -q "poke 1" || fail "stderr should carry the slot message (got: $STDERR)"

echo "==> malformed stdin → fail-open exit 0"
echo 'not json' | bun "$ROOT/hooks/codex-stop.ts" >/dev/null 2>&1
[ $? -eq 0 ] || fail "malformed stdin should fail-open (exit 0)"

echo "==> SessionStart (source=startup) runs clean → exit 0"
echo '{"session_id":"probe","source":"startup","hook_event_name":"SessionStart"}' | bun "$ROOT/hooks/codex-session-start.ts" >/dev/null 2>&1
[ $? -eq 0 ] || fail "SessionStart should exit 0"

echo "==> SessionStart (source=resume) runs clean → exit 0"
echo '{"session_id":"probe","source":"resume","hook_event_name":"SessionStart"}' | bun "$ROOT/hooks/codex-session-start.ts" >/dev/null 2>&1
[ $? -eq 0 ] || fail "SessionStart resume should exit 0"

echo "PASS: Codex hook scripts honor the exit-2/stderr nudge contract and fail open"
