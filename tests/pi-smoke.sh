#!/usr/bin/env bash
# Live Pi smoke for the agent-dice extension.
#
# Requires `pi` on PATH (the @earendil-works Pi agent). Model-free: only exercises
# the /dice LOCAL slash command, so it never calls a model. Verifies the extension
# loads under the real Pi runtime and that the command writes through the node:fs
# store. The agent_end trigger path is covered deterministically by
# tests/conformance/pi-wiring.conformance.ts (it needs a real model turn to fire live).
#
# Not part of `bun run test` (CI has no `pi`). Run locally:  bash tests/pi-smoke.sh
set -euo pipefail

if ! command -v pi >/dev/null 2>&1; then
  echo "SKIP: pi not on PATH"
  exit 0
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EXT="$ROOT/src/adapters/pi/index.ts"
BASE="$(mktemp -d)"
PIFLAGS=(--no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files -e "$EXT")

echo "==> /dice register (loads extension, runs local command)"
CC_DICE_BASE="$BASE" pi "${PIFLAGS[@]}" \
  -p '/dice register smoke --die 20 --target 7 --type single --message "hi {best}"' >/dev/null 2>&1

echo "==> verify the command wrote through the node:fs store"
test -f "$BASE/slots.json" || { echo "FAIL: slots.json not written"; exit 1; }
grep -q '"name": "smoke"' "$BASE/slots.json" || { echo "FAIL: slot 'smoke' not registered"; exit 1; }

echo "==> /dice list + status (extension loads, commands resolve)"
CC_DICE_BASE="$BASE" pi "${PIFLAGS[@]}" -p '/dice list' >/dev/null 2>&1
CC_DICE_BASE="$BASE" pi "${PIFLAGS[@]}" -p '/dice status smoke' >/dev/null 2>&1

echo "PASS: agent-dice Pi extension loads and /dice writes through the store"
