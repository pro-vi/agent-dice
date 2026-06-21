#!/usr/bin/env bats

# cc-dice BATS tests
# Tests registration, accumulator, rolling, state, cooldown, session-start, CLI

BATS_TEST_DIRNAME="$(cd "$(dirname "$BATS_TEST_FILENAME")" && pwd)"
PROJ_DIR="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
CLI="$PROJ_DIR/bin/agent-dice.ts"

load '../test_helper/bats-support/load'
load '../test_helper/bats-assert/load'

setup() {
    export CC_DICE_BASE="$(mktemp -d)"
    mkdir -p "$CC_DICE_BASE/state"
    # Use a UUID-like format so extractSessionFromPath matches correctly
    # This mimics real Claude Code transcript paths
    export TEST_SESSION_ID="abcdef01-2345-6789-abcd-ef$(printf '%06x' $$)"
    # Also set env var as fallback
    export CC_DICE_SESSION_ID="$TEST_SESSION_ID"

    # Override HOME so getTranscriptPath() can auto-resolve transcripts in tests.
    # This lets CLI commands find transcripts without explicit path args.
    export REAL_HOME="$HOME"
    export HOME="$CC_DICE_BASE/fake_home"
    mkdir -p "$HOME"

    # Create project directory matching getTranscriptPath() slug resolution.
    # pathToSlug: path.replace(/[/_]/g, "-")
    local slug="${PWD//\//-}"
    slug="${slug//_/-}"
    export MOCK_PROJECT_DIR="$HOME/.claude/projects/$slug"
    mkdir -p "$MOCK_PROJECT_DIR"
}

teardown() {
    export HOME="$REAL_HOME"
    rm -rf "$CC_DICE_BASE"
}

# Helper: create a test transcript with N user messages
create_transcript() {
    local path="$1"
    local count="${2:-0}"
    > "$path"
    for ((i=1; i<=count; i++)); do
        echo '{"type":"user","message":{"role":"user","content":"message '$i'"}}' >> "$path"
        echo '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"response '$i'"}]}}' >> "$path"
    done
}

# Helper: deploy transcript where getTranscriptPath() auto-resolves it
# This places the file at the mocked ~/.claude/projects/<slug>/<session>.jsonl
deploy_transcript() {
    local count="${1:-0}"
    create_transcript "$MOCK_PROJECT_DIR/$TEST_SESSION_ID.jsonl" "$count"
}

# ============================================================================
# Registration Tests
# ============================================================================

@test "register: creates slot with defaults" {
    run bun "$CLI" register test-slot --die 20 --target 20 --message "Test trigger"
    assert_success
    assert_output --partial "Registered: test-slot"

    # Verify slots.json was created
    [ -f "$CC_DICE_BASE/slots.json" ]

    # Verify slot data
    run bun -e "
        const slots = JSON.parse(await Bun.file('$CC_DICE_BASE/slots.json').text());
        const s = slots['test-slot'];
        console.log(s.name, s.die, s.target, s.targetMode, s.type);
        console.log(s.accumulationRate, s.maxDice, s.cooldown);
        console.log(s.clearOnSessionStart, s.resetOnTrigger);
    "
    assert_success
    assert_line --index 0 "test-slot 20 20 exact accumulator"
    assert_line --index 1 "7 100 per-session"
    assert_line --index 2 "true true"
}

@test "register: flavor enabled by default" {
    bun "$CLI" register flavor-test --die 20 --target 20 --message "Trigger"

    run bun -e "
        const slots = JSON.parse(await Bun.file('$CC_DICE_BASE/slots.json').text());
        console.log(slots['flavor-test'].flavor);
    "
    assert_success
    assert_output "true"
}

@test "register: --no-flavor disables flavor" {
    bun "$CLI" register noflavor-test --die 20 --target 20 --no-flavor --message "Trigger"

    run bun -e "
        const slots = JSON.parse(await Bun.file('$CC_DICE_BASE/slots.json').text());
        console.log(slots['noflavor-test'].flavor);
    "
    assert_success
    assert_output "false"
}

@test "register: custom options" {
    run bun "$CLI" register custom-slot \
        --die 6 --target 1 --target-mode lte \
        --type fixed --fixed-count 3 \
        --cooldown none --no-clear-on-start --no-reset-on-trigger \
        --message "Custom trigger"
    assert_success

    run bun -e "
        const slots = JSON.parse(await Bun.file('$CC_DICE_BASE/slots.json').text());
        const s = slots['custom-slot'];
        console.log(s.die, s.target, s.targetMode);
        console.log(s.type, s.fixedCount);
        console.log(s.cooldown, s.clearOnSessionStart, s.resetOnTrigger);
    "
    assert_success
    assert_line --index 0 "6 1 lte"
    assert_line --index 1 "fixed 3"
    assert_line --index 2 "none false false"
}

@test "register: overwrites existing slot" {
    bun "$CLI" register my-slot --die 20 --target 20 --message "First"
    bun "$CLI" register my-slot --die 6 --target 6 --message "Second"

    run bun -e "
        const slots = JSON.parse(await Bun.file('$CC_DICE_BASE/slots.json').text());
        console.log(Object.keys(slots).length);
        console.log(slots['my-slot'].die);
    "
    assert_success
    assert_line --index 0 "1"
    assert_line --index 1 "6"
}

@test "list: shows registered slots" {
    bun "$CLI" register slot-a --die 20 --target 20 --message "A"
    bun "$CLI" register slot-b --die 6 --target 1 --target-mode lte --message "B"

    run bun "$CLI" list
    assert_success
    assert_output --partial "slot-a"
    assert_output --partial "slot-b"
}

@test "list: empty when no slots" {
    run bun "$CLI" list
    assert_success
    assert_output --partial "No slots registered"
}

@test "unregister: removes slot" {
    bun "$CLI" register temp-slot --die 20 --target 20 --message "Temp"
    run bun "$CLI" unregister temp-slot
    assert_success
    assert_output --partial "Removed slot: temp-slot"

    run bun "$CLI" list
    assert_output --partial "No slots registered"
}

@test "unregister: fails for nonexistent slot" {
    run bun "$CLI" unregister nonexistent
    assert_failure
    assert_output --partial "Slot not found"
}

@test "register: rejects path-traversal names" {
    run bun "$CLI" register "../../etc/passwd" --die 20 --target 20 --message "Exploit"
    assert_failure
    assert_output --partial "Invalid slot name"

    run bun "$CLI" register "../sneaky" --die 20 --target 20 --message "Exploit"
    assert_failure

    run bun "$CLI" register ".hidden" --die 20 --target 20 --message "Exploit"
    assert_failure
}

# ============================================================================
# Accumulator Tests
# ============================================================================

@test "accumulator: 0 dice for <7 turns" {
    local transcript="$CC_DICE_BASE/${TEST_SESSION_ID}.jsonl"
    create_transcript "$transcript" 5
    bun "$CLI" register acc-test --die 20 --target 20 --message "Trigger"

    run bun -e "
        process.env.CC_DICE_BASE = '$CC_DICE_BASE';
        const { getSlotStatus } = await import('$PROJ_DIR/src/index');
        const s = await getSlotStatus('acc-test', { transcriptPath: '$transcript', sessionId: '$TEST_SESSION_ID' });
        console.log('dice:', s.diceCount);
    "
    assert_success
    assert_output "dice: 0"
}

@test "accumulator: 1 die for 7 turns" {
    local transcript="$CC_DICE_BASE/${TEST_SESSION_ID}.jsonl"
    create_transcript "$transcript" 7
    bun "$CLI" register acc-test --die 20 --target 20 --message "Trigger"

    run bun -e "
        process.env.CC_DICE_BASE = '$CC_DICE_BASE';
        const { getSlotStatus } = await import('$PROJ_DIR/src/index');
        const s = await getSlotStatus('acc-test', { transcriptPath: '$transcript', sessionId: '$TEST_SESSION_ID' });
        console.log('dice:', s.diceCount);
    "
    assert_success
    assert_output "dice: 1"
}

@test "accumulator: 2 dice for 14 turns" {
    local transcript="$CC_DICE_BASE/${TEST_SESSION_ID}.jsonl"
    create_transcript "$transcript" 14
    bun "$CLI" register acc-test --die 20 --target 20 --message "Trigger"

    run bun -e "
        process.env.CC_DICE_BASE = '$CC_DICE_BASE';
        const { getSlotStatus } = await import('$PROJ_DIR/src/index');
        const s = await getSlotStatus('acc-test', { transcriptPath: '$transcript', sessionId: '$TEST_SESSION_ID' });
        console.log('dice:', s.diceCount);
    "
    assert_success
    assert_output "dice: 2"
}

@test "accumulator: 3 dice for 21 turns" {
    local transcript="$CC_DICE_BASE/${TEST_SESSION_ID}.jsonl"
    create_transcript "$transcript" 21
    bun "$CLI" register acc-test --die 20 --target 20 --message "Trigger"

    run bun -e "
        process.env.CC_DICE_BASE = '$CC_DICE_BASE';
        const { getSlotStatus } = await import('$PROJ_DIR/src/index');
        const s = await getSlotStatus('acc-test', { transcriptPath: '$transcript', sessionId: '$TEST_SESSION_ID' });
        console.log('dice:', s.diceCount);
    "
    assert_success
    assert_output "dice: 3"
}

@test "accumulator: max dice capped" {
    local transcript="$CC_DICE_BASE/${TEST_SESSION_ID}.jsonl"
    create_transcript "$transcript" 100
    bun "$CLI" register acc-test --die 20 --target 20 --max-dice 5 --message "Trigger"

    run bun -e "
        process.env.CC_DICE_BASE = '$CC_DICE_BASE';
        const { getSlotStatus } = await import('$PROJ_DIR/src/index');
        const s = await getSlotStatus('acc-test', { transcriptPath: '$transcript', sessionId: '$TEST_SESSION_ID' });
        console.log('dice:', s.diceCount);
    "
    assert_success
    assert_output "dice: 5"
}

# ============================================================================
# Rolling Tests
# ============================================================================

@test "roll: returns valid numbers for d20" {
    run bun -e "
        import { rollDice } from '$PROJ_DIR/src/roll';
        const rolls = rollDice(10, 20);
        const valid = rolls.every(r => r >= 1 && r <= 20);
        console.log('count:', rolls.length, 'valid:', valid);
    "
    assert_success
    assert_output --partial "count: 10 valid: true"
}

@test "roll: returns valid numbers for d6" {
    run bun -e "
        import { rollDice } from '$PROJ_DIR/src/roll';
        const rolls = rollDice(5, 6);
        const valid = rolls.every(r => r >= 1 && r <= 6);
        console.log('count:', rolls.length, 'valid:', valid);
    "
    assert_success
    assert_output --partial "count: 5 valid: true"
}

@test "roll: 0 count returns empty" {
    run bun -e "
        import { rollDice } from '$PROJ_DIR/src/roll';
        const rolls = rollDice(0, 20);
        console.log('count:', rolls.length);
    "
    assert_success
    assert_output --partial "count: 0"
}

@test "target check: exact mode" {
    run bun -e "
        import { checkTarget } from '$PROJ_DIR/src/roll';
        console.log(checkTarget([5, 10, 20], 20, 'exact'));
        console.log(checkTarget([5, 10, 15], 20, 'exact'));
    "
    assert_success
    assert_line --index 0 "true"
    assert_line --index 1 "false"
}

@test "target check: gte mode" {
    run bun -e "
        import { checkTarget } from '$PROJ_DIR/src/roll';
        console.log(checkTarget([5, 10, 15], 15, 'gte'));
        console.log(checkTarget([5, 10, 14], 15, 'gte'));
    "
    assert_success
    assert_line --index 0 "true"
    assert_line --index 1 "false"
}

@test "target check: lte mode" {
    run bun -e "
        import { checkTarget } from '$PROJ_DIR/src/roll';
        console.log(checkTarget([5, 10, 15], 5, 'lte'));
        console.log(checkTarget([6, 10, 15], 5, 'lte'));
    "
    assert_success
    assert_line --index 0 "true"
    assert_line --index 1 "false"
}

@test "target check: empty rolls returns false" {
    run bun -e "
        import { checkTarget } from '$PROJ_DIR/src/roll';
        console.log(checkTarget([], 20, 'exact'));
    "
    assert_success
    assert_output "false"
}

@test "findTriggerValue: exact mode returns target when present" {
    run bun -e "
        import { findTriggerValue } from '$PROJ_DIR/src/roll';
        console.log(findTriggerValue([5, 16, 20], 16, 'exact'));
        console.log(findTriggerValue([5, 10, 15], 16, 'exact'));
    "
    assert_success
    assert_line --index 0 "16"
    assert_line --index 1 "undefined"
}

@test "findTriggerValue: gte mode returns minimum qualifying roll" {
    run bun -e "
        import { findTriggerValue } from '$PROJ_DIR/src/roll';
        console.log(findTriggerValue([5, 15, 20], 15, 'gte'));
        console.log(findTriggerValue([5, 10, 14], 15, 'gte'));
    "
    assert_success
    assert_line --index 0 "15"
    assert_line --index 1 "undefined"
}

@test "findTriggerValue: lte mode returns maximum qualifying roll" {
    run bun -e "
        import { findTriggerValue } from '$PROJ_DIR/src/roll';
        console.log(findTriggerValue([2, 5, 15], 5, 'lte'));
        console.log(findTriggerValue([6, 10, 15], 5, 'lte'));
    "
    assert_success
    assert_line --index 0 "5"
    assert_line --index 1 "undefined"
}

@test "findTriggerValue: empty rolls returns undefined" {
    run bun -e "
        import { findTriggerValue } from '$PROJ_DIR/src/roll';
        console.log(findTriggerValue([], 20, 'exact'));
    "
    assert_success
    assert_output "undefined"
}

@test "probability: 1d20 exact 20 is 5%" {
    run bun -e "
        import { calculateProbability } from '$PROJ_DIR/src/roll';
        console.log(calculateProbability(1, 20, 20, 'exact'));
    "
    assert_success
    assert_output "5"
}

@test "probability: 0 dice is 0%" {
    run bun -e "
        import { calculateProbability } from '$PROJ_DIR/src/roll';
        console.log(calculateProbability(0, 20, 20, 'exact'));
    "
    assert_success
    assert_output "0"
}

# ============================================================================
# State Tests
# ============================================================================

@test "state: per-session isolation" {
    local transcript_a="$CC_DICE_BASE/session-a.jsonl"
    local transcript_b="$CC_DICE_BASE/session-b.jsonl"
    create_transcript "$transcript_a" 14
    create_transcript "$transcript_b" 7

    bun "$CLI" register iso-test --die 20 --target 20 --message "Trigger"

    run bun -e "
        process.env.CC_DICE_BASE = '$CC_DICE_BASE';
        const { getSlotStatus } = await import('$PROJ_DIR/src/index');
        const sa = await getSlotStatus('iso-test', { transcriptPath: '$transcript_a', sessionId: 'session-a' });
        const sb = await getSlotStatus('iso-test', { transcriptPath: '$transcript_b', sessionId: 'session-b' });
        console.log('a_dice:', sa.diceCount, 'b_dice:', sb.diceCount);
    "
    assert_success
    assert_output "a_dice: 2 b_dice: 1"
}

@test "state: reset sets depth" {
    local transcript="$CC_DICE_BASE/${TEST_SESSION_ID}.jsonl"
    create_transcript "$transcript" 14

    bun "$CLI" register reset-test --die 20 --target 20 --message "Trigger"

    run bun -e "
        process.env.CC_DICE_BASE = '$CC_DICE_BASE';
        const { getSlotStatus, resetSlot } = await import('$PROJ_DIR/src/index');
        const ctx = { transcriptPath: '$transcript', sessionId: '$TEST_SESSION_ID' };

        const before = await getSlotStatus('reset-test', ctx);
        console.log('before:', before.diceCount);

        await resetSlot('reset-test', ctx);

        const after = await getSlotStatus('reset-test', ctx);
        console.log('after:', after.diceCount);
    "
    assert_success
    assert_line --index 0 "before: 2"
    assert_line --index 1 "after: 0"
}

@test "state: clear resets to 0" {
    local transcript="$CC_DICE_BASE/${TEST_SESSION_ID}.jsonl"
    create_transcript "$transcript" 14

    bun "$CLI" register clear-test --die 20 --target 20 --message "Trigger"

    run bun -e "
        process.env.CC_DICE_BASE = '$CC_DICE_BASE';
        const { resetSlot, clearSlot } = await import('$PROJ_DIR/src/index');
        const ctx = { transcriptPath: '$transcript', sessionId: '$TEST_SESSION_ID' };

        await resetSlot('clear-test', ctx);
        const state1 = JSON.parse(await Bun.file('$CC_DICE_BASE/state/clear-test-${TEST_SESSION_ID}.json').text());
        console.log('after_reset:', state1.depth_at_last_trigger);

        await clearSlot('clear-test', ctx);
        const state2 = JSON.parse(await Bun.file('$CC_DICE_BASE/state/clear-test-${TEST_SESSION_ID}.json').text());
        console.log('after_clear:', state2.depth_at_last_trigger);
    "
    assert_success
    assert_line --index 0 "after_reset: 14"
    assert_line --index 1 "after_clear: 0"
}

@test "state: sentinel -1 calibration" {
    local transcript="$CC_DICE_BASE/${TEST_SESSION_ID}.jsonl"
    create_transcript "$transcript" 21

    bun "$CLI" register sentinel-test --die 20 --target 20 --message "Trigger"

    # Manually write state with sentinel -1
    echo '{"depth_at_last_trigger": -1, "last_reset": "2025-01-01T00:00:00.000Z"}' \
        > "$CC_DICE_BASE/state/sentinel-test-${TEST_SESSION_ID}.json"

    # Status should calibrate: depth_at_last_trigger becomes 21, so dice = 0
    run bun -e "
        process.env.CC_DICE_BASE = '$CC_DICE_BASE';
        const { getSlotStatus } = await import('$PROJ_DIR/src/index');
        const s = await getSlotStatus('sentinel-test', { transcriptPath: '$transcript', sessionId: '$TEST_SESSION_ID' });
        console.log('dice:', s.diceCount);
    "
    assert_success
    assert_output "dice: 0"

    # Verify state was updated
    run bun -e "
        const state = JSON.parse(await Bun.file('$CC_DICE_BASE/state/sentinel-test-${TEST_SESSION_ID}.json').text());
        console.log('depth:', state.depth_at_last_trigger);
    "
    assert_output --partial "depth: 21"
}

# ============================================================================
# Cooldown Tests
# ============================================================================

@test "cooldown: marker prevents re-trigger" {
    bun "$CLI" register cd-test --die 20 --target 20 --cooldown per-session --message "Trigger"

    # Create a cooldown marker (no .json extension — matches cooldown.ts)
    echo "2025-01-01" > "$CC_DICE_BASE/state/triggered-cd-test-${TEST_SESSION_ID}"

    # checkAllSlots should return not triggered due to cooldown
    run bun -e "
        process.env.CC_DICE_BASE = '$CC_DICE_BASE';
        process.env.CC_DICE_SESSION_ID = '$TEST_SESSION_ID';
        const { checkAllSlots } = await import('$PROJ_DIR/src/index');
        const results = await checkAllSlots({ sessionId: '$TEST_SESSION_ID' });
        const result = results.find(r => r.slotName === 'cd-test');
        console.log('triggered:', result.triggered, 'diceCount:', result.diceCount);
    "
    assert_success
    assert_output --partial "triggered: false diceCount: 0"
}

@test "cooldown: clear removes marker" {
    bun "$CLI" register cd-clear-test --die 20 --target 20 --message "Trigger"

    # Create marker (no .json extension — matches cooldown.ts)
    echo "2025-01-01" > "$CC_DICE_BASE/state/triggered-cd-clear-test-${TEST_SESSION_ID}"
    [ -f "$CC_DICE_BASE/state/triggered-cd-clear-test-${TEST_SESSION_ID}" ]

    # Clear should remove marker
    run bun -e "
        process.env.CC_DICE_BASE = '$CC_DICE_BASE';
        const { clearSlot } = await import('$PROJ_DIR/src/index');
        await clearSlot('cd-clear-test', { sessionId: '$TEST_SESSION_ID' });
        console.log('cleared');
    "
    assert_success

    # Marker should be gone
    [ ! -f "$CC_DICE_BASE/state/triggered-cd-clear-test-${TEST_SESSION_ID}" ]
}

# ============================================================================
# Session Start Tests
# ============================================================================

@test "session-start: clears auto-clear slots" {
    # Register two slots: one auto-clear, one not
    bun "$CLI" register auto-slot --die 20 --target 20 --message "Auto"
    bun "$CLI" register manual-slot --die 20 --target 20 --no-clear-on-start --message "Manual"

    local transcript="$CC_DICE_BASE/${TEST_SESSION_ID}.jsonl"
    create_transcript "$transcript" 14

    # Set some state via API (reset needs transcript path)
    bun -e "
        process.env.CC_DICE_BASE = '$CC_DICE_BASE';
        const { resetSlot } = await import('$PROJ_DIR/src/index');
        const ctx = { transcriptPath: '$transcript', sessionId: '$TEST_SESSION_ID' };
        await resetSlot('auto-slot', ctx);
        await resetSlot('manual-slot', ctx);
    "

    # Both should have depth 14 in state
    run bun -e "
        const auto = JSON.parse(await Bun.file('$CC_DICE_BASE/state/auto-slot-${TEST_SESSION_ID}.json').text());
        const manual = JSON.parse(await Bun.file('$CC_DICE_BASE/state/manual-slot-${TEST_SESSION_ID}.json').text());
        console.log('auto:', auto.depth_at_last_trigger, 'manual:', manual.depth_at_last_trigger);
    "
    assert_output --partial "auto: 14 manual: 14"

    # Session start via API
    run bun -e "
        process.env.CC_DICE_BASE = '$CC_DICE_BASE';
        const { sessionStart } = await import('$PROJ_DIR/src/index');
        const cleared = await sessionStart({ sessionId: '$TEST_SESSION_ID' });
        console.log('cleared:', cleared.join(', '));
    "
    assert_success
    assert_output --partial "auto-slot"
    refute_output --partial "manual-slot"

    # Auto-slot should be cleared to 0, manual should still be 14
    run bun -e "
        const auto = JSON.parse(await Bun.file('$CC_DICE_BASE/state/auto-slot-${TEST_SESSION_ID}.json').text());
        const manual = JSON.parse(await Bun.file('$CC_DICE_BASE/state/manual-slot-${TEST_SESSION_ID}.json').text());
        console.log('auto:', auto.depth_at_last_trigger, 'manual:', manual.depth_at_last_trigger);
    "
    assert_output --partial "auto: 0 manual: 14"
}

# ============================================================================
# CLI Tests
# ============================================================================

@test "cli: help shows usage" {
    run bun "$CLI" help
    assert_success
    assert_output --partial "Usage: agent-dice"
    assert_output --partial "register"
    assert_output --partial "status"
}

@test "cli: unknown command fails" {
    run bun "$CLI" foobar
    assert_failure
    assert_output --partial "Unknown command"
}

@test "cli: session-start is not a command" {
    run bun "$CLI" session-start
    assert_failure
    assert_output --partial "Unknown command"
}

@test "cli: register without name fails" {
    run bun "$CLI" register
    assert_failure
    assert_output --partial "slot name required"
}

@test "cli: status without name fails" {
    run bun "$CLI" status
    assert_failure
    assert_output --partial "slot name required"
}

@test "cli: status for nonexistent slot fails" {
    run bun "$CLI" status nonexistent
    assert_failure
    assert_output --partial "Slot not found"
}

@test "cli: roll with slot" {
    bun "$CLI" register roll-test --die 20 --target 20 --type single --message "Trigger"

    run bun "$CLI" roll roll-test
    assert_success
    assert_output --partial "roll-test: 1d20"
}

@test "cli: roll with 0 dice" {
    bun "$CLI" register roll-zero --die 20 --target 20 --message "Trigger"

    run bun "$CLI" roll roll-zero
    assert_success
    assert_output --partial "0 dice"
}

@test "cli: status with auto-resolved transcript" {
    deploy_transcript 14
    bun "$CLI" register status-auto --die 20 --target 20 --message "Trigger"

    run bun "$CLI" status status-auto
    assert_success
    assert_output --partial "Dice count:      2"
    assert_output --partial "Current depth:   14"
}

@test "cli: reset with auto-resolved transcript" {
    deploy_transcript 21
    bun "$CLI" register reset-auto --die 20 --target 20 --message "Trigger"

    # Should have 3 dice at depth 21
    run bun "$CLI" status reset-auto
    assert_output --partial "Dice count:      3"

    # Reset at current depth
    run bun "$CLI" reset reset-auto
    assert_success

    # Should have 0 dice now
    run bun "$CLI" status reset-auto
    assert_output --partial "Dice count:      0"
}

@test "cli: clear with auto-resolved transcript" {
    deploy_transcript 14
    bun "$CLI" register clear-auto --die 20 --target 20 --message "Trigger"

    # Reset to set depth
    bun "$CLI" reset clear-auto

    # Clear resets state
    run bun "$CLI" clear clear-auto
    assert_success
    assert_output --partial "Cleared slot: clear-auto"

    # Status should show depth 14 but 2 dice (cleared to 0 base)
    run bun "$CLI" status clear-auto
    assert_output --partial "Dice count:      2"
}

@test "cli: reset on nonexistent slot errors (exit 1)" {
    run bun "$CLI" reset no-such-slot
    assert_failure
    assert_output --partial "Slot not found: no-such-slot"
}

@test "cli: clear on nonexistent slot errors (exit 1)" {
    run bun "$CLI" clear no-such-slot
    assert_failure
    assert_output --partial "Slot not found: no-such-slot"
}

@test "cli: roll with multi-dice accumulator" {
    deploy_transcript 14
    bun "$CLI" register roll-multi --die 20 --target 20 --message "Trigger"

    run bun "$CLI" roll roll-multi
    assert_success
    assert_output --partial "roll-multi: 2d20"
}

@test "checkAllSlots: returns empty for no slots" {
    run bun -e "
        process.env.CC_DICE_BASE = '$CC_DICE_BASE';
        const { checkAllSlots } = await import('$PROJ_DIR/src/index');
        const results = await checkAllSlots({ sessionId: '$TEST_SESSION_ID' });
        console.log('count:', results.length);
    "
    assert_success
    assert_output "count: 0"
}

# ============================================================================
# Fixed & Single Dice Type Tests
# ============================================================================

@test "fixed: always rolls fixedCount dice" {
    bun "$CLI" register fixed-test --die 6 --target 6 --type fixed --fixed-count 3 --message "Trigger"

    run bun -e "
        process.env.CC_DICE_BASE = '$CC_DICE_BASE';
        const { getSlotStatus } = await import('$PROJ_DIR/src/index');
        const status = await getSlotStatus('fixed-test', { sessionId: 'test' });
        console.log('dice:', status.diceCount);
    "
    assert_success
    assert_output --partial "dice: 3"
}

@test "single: always rolls 1 die" {
    bun "$CLI" register single-test --die 20 --target 20 --type single --message "Trigger"

    run bun -e "
        process.env.CC_DICE_BASE = '$CC_DICE_BASE';
        const { getSlotStatus } = await import('$PROJ_DIR/src/index');
        const status = await getSlotStatus('single-test', { sessionId: 'test' });
        console.log('dice:', status.diceCount);
    "
    assert_success
    assert_output --partial "dice: 1"
}

# ============================================================================
# Transcript Counting Tests
# ============================================================================

@test "transcript: counts user messages correctly" {
    local transcript="$CC_DICE_BASE/test-transcript.jsonl"
    create_transcript "$transcript" 10

    run bun -e "
        import { countExchanges } from '$PROJ_DIR/src/transcript';
        const count = await countExchanges('$transcript');
        console.log('count:', count);
    "
    assert_success
    assert_output "count: 10"
}

@test "transcript: ignores toolUseResult entries" {
    local transcript="$CC_DICE_BASE/test-transcript.jsonl"
    echo '{"type":"user","message":{"role":"user","content":"hello"}}' > "$transcript"
    echo '{"type":"user","toolUseResult":true,"message":{"role":"user","content":"tool"}}' >> "$transcript"
    echo '{"type":"user","message":{"role":"user","content":"world"}}' >> "$transcript"

    run bun -e "
        import { countExchanges } from '$PROJ_DIR/src/transcript';
        const count = await countExchanges('$transcript');
        console.log('count:', count);
    "
    assert_success
    assert_output "count: 2"
}

@test "transcript: returns 0 for nonexistent file" {
    run bun -e "
        import { countExchanges } from '$PROJ_DIR/src/transcript';
        const count = await countExchanges('/nonexistent/path.jsonl');
        console.log('count:', count);
    "
    assert_success
    assert_output "count: 0"
}

@test "transcript: realistic mock with all entry types" {
    # Mirrors real Claude Code transcript structure
    local transcript="$CC_DICE_BASE/realistic.jsonl"
    cat > "$transcript" <<'EOF'
{"type":"file-history-snapshot","isSnapshotUpdate":true,"messageId":"abc","snapshot":{}}
{"type":"user","userType":"external","message":{"role":"user","content":"fix the bug"}}
{"type":"assistant","userType":"external","message":{"role":"assistant","content":[{"type":"text","text":"Looking at it"}]}}
{"type":"progress","userType":"external","data":{"type":"tool_use"},"parentToolUseID":"toolu_123"}
{"type":"progress","userType":"external","data":{"type":"tool_use"},"parentToolUseID":"toolu_123"}
{"type":"user","userType":"external","toolUseResult":{"type":"tool_result","content":"file contents"},"message":{"role":"user","content":[{"type":"tool_result"}]}}
{"type":"assistant","userType":"external","message":{"role":"assistant","content":[{"type":"text","text":"Fixed it"}]}}
{"type":"user","userType":"external","message":{"role":"user","content":"now add tests"}}
{"type":"system","userType":"external","message":{"role":"system","content":"context updated"}}
{"type":"progress","userType":"external","data":{"type":"tool_use"},"parentToolUseID":"toolu_456"}
{"type":"user","userType":"external","toolUseResult":["some","array","result"],"message":{"role":"user","content":[{"type":"tool_result"}]}}
{"type":"user","userType":"external","toolUseResult":"string result","message":{"role":"user","content":[{"type":"tool_result"}]}}
{"type":"assistant","userType":"external","message":{"role":"assistant","content":[{"type":"text","text":"Tests added"}]}}
{"type":"user","userType":"external","message":{"role":"user","content":"looks good"}}
EOF

    # 3 real user messages: "fix the bug", "now add tests", "looks good"
    # Excluded: 3 toolUseResult entries (object, array, string), system, progress, assistant, snapshot
    run bun -e "
        import { countExchanges } from '$PROJ_DIR/src/transcript';
        const count = await countExchanges('$transcript');
        console.log('count:', count);
    "
    assert_success
    assert_output "count: 3"
}

@test "transcript: handles empty file" {
    local transcript="$CC_DICE_BASE/empty.jsonl"
    > "$transcript"

    run bun -e "
        import { countExchanges } from '$PROJ_DIR/src/transcript';
        const count = await countExchanges('$transcript');
        console.log('count:', count);
    "
    assert_success
    assert_output "count: 0"
}

@test "transcript: survives malformed lines" {
    local transcript="$CC_DICE_BASE/malformed.jsonl"
    cat > "$transcript" <<'EOF'
{"type":"user","message":{"role":"user","content":"valid 1"}}
not json at all
{"type":"user","message":{"role":"user","content":"valid 2"}}
{"broken json
{"type":"user","message":{"role":"user","content":"valid 3"}}
EOF

    run bun -e "
        import { countExchanges } from '$PROJ_DIR/src/transcript';
        const count = await countExchanges('$transcript');
        console.log('count:', count);
    "
    assert_success
    assert_output "count: 3"
}

@test "transcript: ignores non-user types" {
    local transcript="$CC_DICE_BASE/types.jsonl"
    cat > "$transcript" <<'EOF'
{"type":"system","message":{"role":"system","content":"init"}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]}}
{"type":"progress","data":{"type":"tool_use"},"parentToolUseID":"toolu_1"}
{"type":"file-history-snapshot","snapshot":{}}
{"type":"user","message":{"role":"user","content":"only this one"}}
EOF

    run bun -e "
        import { countExchanges } from '$PROJ_DIR/src/transcript';
        const count = await countExchanges('$transcript');
        console.log('count:', count);
    "
    assert_success
    assert_output "count: 1"
}

# ============================================================================
# Shared Dice Pool Tests (checkAllSlots)
# ============================================================================

@test "shared pool: two single d20 slots get same base roll" {
    # Register two single d20 slots that always trigger (gte 1)
    bun "$CLI" register alpha --die 20 --target 1 --target-mode gte --type single --message "Alpha"
    bun "$CLI" register beta --die 20 --target 1 --target-mode gte --type single --message "Beta"

    run bun -e "
        process.env.CC_DICE_BASE = '$CC_DICE_BASE';
        process.env.CC_DICE_SESSION_ID = '$TEST_SESSION_ID';
        const { checkAllSlots } = await import('$PROJ_DIR/src/index');
        const results = await checkAllSlots({ sessionId: '$TEST_SESSION_ID' });
        const a = results.find(r => r.slotName === 'alpha');
        const b = results.find(r => r.slotName === 'beta');
        if (!a || !b) { console.log('FAIL: missing results'); process.exit(1); }
        if (a.rolls.length !== 1) { console.log('FAIL: alpha should have 1 roll, got ' + a.rolls.length); process.exit(1); }
        if (b.rolls.length !== 1) { console.log('FAIL: beta should have 1 roll, got ' + b.rolls.length); process.exit(1); }
        if (a.rolls[0] !== b.rolls[0]) { console.log('FAIL: base rolls differ: ' + a.rolls[0] + ' vs ' + b.rolls[0]); process.exit(1); }
        console.log('PASS: shared base roll = ' + a.rolls[0]);
    "
    assert_success
    assert_output --partial "PASS"
}

@test "shared pool: accumulator + single share base roll" {
    local transcript="$CC_DICE_BASE/${TEST_SESSION_ID}.jsonl"
    create_transcript "$transcript" 14

    # Accumulator gets 2 dice at depth 14, single always gets 1
    bun "$CLI" register acc --die 20 --target 20 --type accumulator --cooldown none --message "Acc"
    bun "$CLI" register flat --die 20 --target 1 --target-mode gte --type single --cooldown none --message "Flat"

    run bun -e "
        process.env.CC_DICE_BASE = '$CC_DICE_BASE';
        process.env.CC_DICE_SESSION_ID = '$TEST_SESSION_ID';
        const { checkAllSlots } = await import('$PROJ_DIR/src/index');
        const results = await checkAllSlots({ sessionId: '$TEST_SESSION_ID', transcriptPath: '$transcript' });
        const acc = results.find(r => r.slotName === 'acc');
        const flat = results.find(r => r.slotName === 'flat');
        if (!acc || !flat) { console.log('FAIL: missing results'); process.exit(1); }
        if (acc.diceCount !== 2) { console.log('FAIL: acc should have 2 dice, got ' + acc.diceCount); process.exit(1); }
        if (acc.rolls.length !== 2) { console.log('FAIL: acc should have 2 rolls, got ' + acc.rolls.length); process.exit(1); }
        if (flat.rolls.length !== 1) { console.log('FAIL: flat should have 1 roll, got ' + flat.rolls.length); process.exit(1); }
        if (acc.rolls[0] !== flat.rolls[0]) { console.log('FAIL: base rolls differ: ' + acc.rolls[0] + ' vs ' + flat.rolls[0]); process.exit(1); }
        console.log('PASS: shared base=' + flat.rolls[0] + ' acc_rolls=' + JSON.stringify(acc.rolls));
    "
    assert_success
    assert_output --partial "PASS"
}

@test "shared pool: different die sizes roll independently" {
    # d20 and d6 should have independent base rolls
    bun "$CLI" register d20-slot --die 20 --target 1 --target-mode gte --type single --cooldown none --message "D20"
    bun "$CLI" register d6-slot --die 6 --target 1 --target-mode gte --type single --cooldown none --message "D6"

    run bun -e "
        process.env.CC_DICE_BASE = '$CC_DICE_BASE';
        process.env.CC_DICE_SESSION_ID = '$TEST_SESSION_ID';
        const { checkAllSlots } = await import('$PROJ_DIR/src/index');
        const results = await checkAllSlots({ sessionId: '$TEST_SESSION_ID' });
        const d20 = results.find(r => r.slotName === 'd20-slot');
        const d6 = results.find(r => r.slotName === 'd6-slot');
        if (!d20 || !d6) { console.log('FAIL: missing results'); process.exit(1); }
        if (d20.rolls.length !== 1) { console.log('FAIL: d20 wrong roll count'); process.exit(1); }
        if (d6.rolls.length !== 1) { console.log('FAIL: d6 wrong roll count'); process.exit(1); }
        // d6 roll must be in [1,6], d20 in [1,20]
        if (d6.rolls[0] < 1 || d6.rolls[0] > 6) { console.log('FAIL: d6 out of range'); process.exit(1); }
        if (d20.rolls[0] < 1 || d20.rolls[0] > 20) { console.log('FAIL: d20 out of range'); process.exit(1); }
        console.log('PASS: d20=' + d20.rolls[0] + ' d6=' + d6.rolls[0]);
    "
    assert_success
    assert_output --partial "PASS"
}

@test "shared pool: zero-dice accumulator does not observe base roll" {
    local transcript="$CC_DICE_BASE/${TEST_SESSION_ID}.jsonl"
    create_transcript "$transcript" 3

    # Accumulator at depth 3 = 0 dice; single always gets 1
    bun "$CLI" register acc-zero --die 20 --target 20 --type accumulator --cooldown none --message "Acc"
    bun "$CLI" register single-always --die 20 --target 1 --target-mode gte --type single --cooldown none --message "Single"

    run bun -e "
        process.env.CC_DICE_BASE = '$CC_DICE_BASE';
        process.env.CC_DICE_SESSION_ID = '$TEST_SESSION_ID';
        const { checkAllSlots } = await import('$PROJ_DIR/src/index');
        const results = await checkAllSlots({ sessionId: '$TEST_SESSION_ID', transcriptPath: '$transcript' });
        const acc = results.find(r => r.slotName === 'acc-zero');
        const single = results.find(r => r.slotName === 'single-always');
        if (!acc || !single) { console.log('FAIL: missing results'); process.exit(1); }
        if (acc.diceCount !== 0) { console.log('FAIL: acc should have 0 dice, got ' + acc.diceCount); process.exit(1); }
        if (acc.rolls.length !== 0) { console.log('FAIL: acc should have 0 rolls, got ' + acc.rolls.length); process.exit(1); }
        if (single.rolls.length !== 1) { console.log('FAIL: single should have 1 roll'); process.exit(1); }
        console.log('PASS: acc_dice=0 single_roll=' + single.rolls[0]);
    "
    assert_success
    assert_output --partial "PASS"
}

@test "shared pool: single slot alone still works (backward compat)" {
    bun "$CLI" register solo --die 20 --target 1 --target-mode gte --type single --cooldown none --message "Solo"

    run bun -e "
        process.env.CC_DICE_BASE = '$CC_DICE_BASE';
        process.env.CC_DICE_SESSION_ID = '$TEST_SESSION_ID';
        const { checkAllSlots } = await import('$PROJ_DIR/src/index');
        const results = await checkAllSlots({ sessionId: '$TEST_SESSION_ID' });
        if (results.length !== 1) { console.log('FAIL: expected 1 result, got ' + results.length); process.exit(1); }
        const r = results[0];
        if (r.slotName !== 'solo') { console.log('FAIL: wrong slot name'); process.exit(1); }
        if (!r.triggered) { console.log('FAIL: should have triggered (gte 1)'); process.exit(1); }
        if (r.rolls.length !== 1) { console.log('FAIL: should have 1 roll'); process.exit(1); }
        console.log('PASS: solo roll=' + r.rolls[0] + ' triggered=' + r.triggered);
    "
    assert_success
    assert_output --partial "PASS"
}

@test "shared pool: exact targets are mutually exclusive on base die" {
    # Two single d20 slots: one targets 20, one targets 2
    # They share the same base roll, so they can NEVER both trigger
    bun "$CLI" register target-20 --die 20 --target 20 --type single --cooldown none --message "T20"
    bun "$CLI" register target-2 --die 20 --target 2 --type single --cooldown none --message "T2"

    # Run 100 iterations and verify mutual exclusivity
    run bun -e "
        process.env.CC_DICE_BASE = '$CC_DICE_BASE';
        process.env.CC_DICE_SESSION_ID = '$TEST_SESSION_ID';
        const { checkAllSlots } = await import('$PROJ_DIR/src/index');
        let bothTriggered = 0;
        for (let i = 0; i < 100; i++) {
            const results = await checkAllSlots({ sessionId: '$TEST_SESSION_ID' });
            const t20 = results.find(r => r.slotName === 'target-20');
            const t2 = results.find(r => r.slotName === 'target-2');
            if (t20.triggered && t2.triggered) bothTriggered++;
            // Verify they always see the same roll
            if (t20.rolls[0] !== t2.rolls[0]) {
                console.log('FAIL: rolls differ at iteration ' + i);
                process.exit(1);
            }
        }
        if (bothTriggered > 0) {
            console.log('FAIL: both triggered ' + bothTriggered + ' times (should be 0)');
            process.exit(1);
        }
        console.log('PASS: 100 iterations, mutual exclusivity holds');
    "
    assert_success
    assert_output --partial "PASS"
}

@test "shared pool: checkAllSlots triggers multiple slots" {
    bun "$CLI" register cli-a --die 20 --target 1 --target-mode gte --type single --cooldown none --message "CLI-A {rolls}"
    bun "$CLI" register cli-b --die 20 --target 1 --target-mode gte --type single --cooldown none --message "CLI-B {rolls}"

    # Both always trigger (gte 1), both should appear in results with same roll
    run bun -e "
        process.env.CC_DICE_BASE = '$CC_DICE_BASE';
        process.env.CC_DICE_SESSION_ID = '$TEST_SESSION_ID';
        const { checkAllSlots } = await import('$PROJ_DIR/src/index');
        const results = await checkAllSlots({ sessionId: '$TEST_SESSION_ID' });
        const a = results.find(r => r.slotName === 'cli-a');
        const b = results.find(r => r.slotName === 'cli-b');
        console.log('a_triggered:', a.triggered, 'b_triggered:', b.triggered);
        console.log('same_roll:', a.rolls[0] === b.rolls[0]);
    "
    assert_success
    assert_output --partial "a_triggered: true b_triggered: true"
    assert_output --partial "same_roll: true"
}

@test "shared pool: cooled-down slot excluded from pool without affecting others" {
    bun "$CLI" register hot --die 20 --target 1 --target-mode gte --type single --cooldown per-session --message "Hot"
    bun "$CLI" register cold --die 20 --target 1 --target-mode gte --type single --cooldown per-session --message "Cold"

    # Mark 'cold' as already triggered (cooldown marker)
    echo "2025-01-01" > "$CC_DICE_BASE/state/triggered-cold-${TEST_SESSION_ID}"

    run bun -e "
        process.env.CC_DICE_BASE = '$CC_DICE_BASE';
        process.env.CC_DICE_SESSION_ID = '$TEST_SESSION_ID';
        const { checkAllSlots } = await import('$PROJ_DIR/src/index');
        const results = await checkAllSlots({ sessionId: '$TEST_SESSION_ID' });
        const hot = results.find(r => r.slotName === 'hot');
        const cold = results.find(r => r.slotName === 'cold');
        if (!hot || !cold) { console.log('FAIL: missing results'); process.exit(1); }
        if (!hot.triggered) { console.log('FAIL: hot should trigger'); process.exit(1); }
        if (cold.triggered) { console.log('FAIL: cold should NOT trigger (cooldown)'); process.exit(1); }
        if (cold.diceCount !== 0) { console.log('FAIL: cold diceCount should be 0, got ' + cold.diceCount); process.exit(1); }
        if (hot.rolls.length !== 1) { console.log('FAIL: hot should have 1 roll'); process.exit(1); }
        console.log('PASS: hot triggered, cold cooled down');
    "
    assert_success
    assert_output --partial "PASS"
}

@test "shared pool: trigger marks cooldown correctly" {
    bun "$CLI" register cd-pool --die 20 --target 1 --target-mode gte --type single --cooldown per-session --message "Triggered"

    # First check should trigger and write cooldown
    run bun -e "
        process.env.CC_DICE_BASE = '$CC_DICE_BASE';
        process.env.CC_DICE_SESSION_ID = '$TEST_SESSION_ID';
        const { checkAllSlots } = await import('$PROJ_DIR/src/index');
        const r1 = await checkAllSlots({ sessionId: '$TEST_SESSION_ID' });
        const first = r1.find(r => r.slotName === 'cd-pool');
        if (!first.triggered) { console.log('FAIL: first check should trigger'); process.exit(1); }
        // Second check should be cooled down
        const r2 = await checkAllSlots({ sessionId: '$TEST_SESSION_ID' });
        const second = r2.find(r => r.slotName === 'cd-pool');
        if (second.triggered) { console.log('FAIL: second check should be cooled down'); process.exit(1); }
        if (second.diceCount !== 0) { console.log('FAIL: cooled down diceCount should be 0'); process.exit(1); }
        console.log('PASS: trigger then cooldown');
    "
    assert_success
    assert_output --partial "PASS"
}

@test "shared pool: accumulator resetOnTrigger within pool" {
    local transcript="$CC_DICE_BASE/${TEST_SESSION_ID}.jsonl"
    create_transcript "$transcript" 14

    bun "$CLI" register acc-reset --die 20 --target 1 --target-mode gte --type accumulator --cooldown none --message "Acc"

    run bun -e "
        process.env.CC_DICE_BASE = '$CC_DICE_BASE';
        process.env.CC_DICE_SESSION_ID = '$TEST_SESSION_ID';
        const { checkAllSlots, getSlotStatus } = await import('$PROJ_DIR/src/index');
        // Should trigger (gte 1 always hits) and reset accumulator
        const results = await checkAllSlots({ sessionId: '$TEST_SESSION_ID', transcriptPath: '$transcript' });
        const r = results.find(r => r.slotName === 'acc-reset');
        if (!r.triggered) { console.log('FAIL: should trigger'); process.exit(1); }
        if (r.diceCount !== 2) { console.log('FAIL: should have 2 dice at depth 14, got ' + r.diceCount); process.exit(1); }
        // After trigger with resetOnTrigger, state should be reset to current depth
        const status = await getSlotStatus('acc-reset', { sessionId: '$TEST_SESSION_ID', transcriptPath: '$transcript' });
        if (status.diceCount !== 0) { console.log('FAIL: after reset should have 0 dice, got ' + status.diceCount); process.exit(1); }
        console.log('PASS: triggered at 2 dice, reset to 0');
    "
    assert_success
    assert_output --partial "PASS"
}

@test "shared pool: fixed-type slots in pool" {
    bun "$CLI" register fix-a --die 6 --target 1 --target-mode gte --type fixed --fixed-count 3 --cooldown none --message "Fix-A"
    bun "$CLI" register fix-b --die 6 --target 1 --target-mode gte --type fixed --fixed-count 2 --cooldown none --message "Fix-B"

    run bun -e "
        process.env.CC_DICE_BASE = '$CC_DICE_BASE';
        process.env.CC_DICE_SESSION_ID = '$TEST_SESSION_ID';
        const { checkAllSlots } = await import('$PROJ_DIR/src/index');
        const results = await checkAllSlots({ sessionId: '$TEST_SESSION_ID' });
        const a = results.find(r => r.slotName === 'fix-a');
        const b = results.find(r => r.slotName === 'fix-b');
        if (!a || !b) { console.log('FAIL: missing results'); process.exit(1); }
        if (a.rolls.length !== 3) { console.log('FAIL: fix-a should have 3 rolls, got ' + a.rolls.length); process.exit(1); }
        if (b.rolls.length !== 2) { console.log('FAIL: fix-b should have 2 rolls, got ' + b.rolls.length); process.exit(1); }
        // Both share base d6 roll
        if (a.rolls[0] !== b.rolls[0]) { console.log('FAIL: base rolls differ: ' + a.rolls[0] + ' vs ' + b.rolls[0]); process.exit(1); }
        // All rolls in valid d6 range
        const allRolls = [...a.rolls, ...b.rolls];
        if (allRolls.some(r => r < 1 || r > 6)) { console.log('FAIL: roll out of d6 range'); process.exit(1); }
        console.log('PASS: fix-a=' + JSON.stringify(a.rolls) + ' fix-b=' + JSON.stringify(b.rolls));
    "
    assert_success
    assert_output --partial "PASS"
}

@test "shared pool: three die sizes in one check" {
    bun "$CLI" register s-d4 --die 4 --target 1 --target-mode gte --type single --cooldown none --message "D4"
    bun "$CLI" register s-d8 --die 8 --target 1 --target-mode gte --type single --cooldown none --message "D8"
    bun "$CLI" register s-d20 --die 20 --target 1 --target-mode gte --type single --cooldown none --message "D20"

    run bun -e "
        process.env.CC_DICE_BASE = '$CC_DICE_BASE';
        process.env.CC_DICE_SESSION_ID = '$TEST_SESSION_ID';
        const { checkAllSlots } = await import('$PROJ_DIR/src/index');
        const results = await checkAllSlots({ sessionId: '$TEST_SESSION_ID' });
        if (results.length !== 3) { console.log('FAIL: expected 3 results, got ' + results.length); process.exit(1); }
        const d4 = results.find(r => r.slotName === 's-d4');
        const d8 = results.find(r => r.slotName === 's-d8');
        const d20 = results.find(r => r.slotName === 's-d20');
        if (d4.rolls[0] < 1 || d4.rolls[0] > 4) { console.log('FAIL: d4 out of range'); process.exit(1); }
        if (d8.rolls[0] < 1 || d8.rolls[0] > 8) { console.log('FAIL: d8 out of range'); process.exit(1); }
        if (d20.rolls[0] < 1 || d20.rolls[0] > 20) { console.log('FAIL: d20 out of range'); process.exit(1); }
        console.log('PASS: d4=' + d4.rolls[0] + ' d8=' + d8.rolls[0] + ' d20=' + d20.rolls[0]);
    "
    assert_success
    assert_output --partial "PASS"
}


@test "shared pool: triggerValue matches target, not best" {
    # Two single d20 slots: one targets exact 1, one targets exact 20
    # The one that triggers should have triggerValue equal to its target
    bun "$CLI" register tv-low --die 20 --target 1 --type single --cooldown none --message "Low"
    bun "$CLI" register tv-high --die 20 --target 20 --type single --cooldown none --message "High"

    run bun -e "
        process.env.CC_DICE_BASE = '$CC_DICE_BASE';
        process.env.CC_DICE_SESSION_ID = '$TEST_SESSION_ID';
        const { checkAllSlots } = await import('$PROJ_DIR/src/index');
        // Run enough iterations to see both trigger at least once
        let lowSeen = false, highSeen = false;
        for (let i = 0; i < 500; i++) {
            const results = await checkAllSlots({ sessionId: '$TEST_SESSION_ID' });
            const low = results.find(r => r.slotName === 'tv-low');
            const high = results.find(r => r.slotName === 'tv-high');
            if (low.triggered) {
                if (low.triggerValue !== 1) {
                    console.log('FAIL: low triggerValue should be 1, got ' + low.triggerValue);
                    process.exit(1);
                }
                lowSeen = true;
            }
            if (high.triggered) {
                if (high.triggerValue !== 20) {
                    console.log('FAIL: high triggerValue should be 20, got ' + high.triggerValue);
                    process.exit(1);
                }
                highSeen = true;
            }
            // Non-triggered slots should have undefined triggerValue
            if (!low.triggered && low.triggerValue !== undefined) {
                console.log('FAIL: non-triggered low should have undefined triggerValue');
                process.exit(1);
            }
            if (!high.triggered && high.triggerValue !== undefined) {
                console.log('FAIL: non-triggered high should have undefined triggerValue');
                process.exit(1);
            }
            if (lowSeen && highSeen) break;
        }
        if (!lowSeen || !highSeen) {
            console.log('WARN: not both triggered in 500 iterations, but no incorrect values seen');
        }
        console.log('PASS: triggerValue matches target when triggered');
    "
    assert_success
    assert_output --partial "PASS"
}

@test "shared pool: triggerValue with gte mode returns minimum qualifying" {
    bun "$CLI" register tv-gte --die 20 --target 15 --target-mode gte --type single --cooldown none --message "GTE"

    run bun -e "
        process.env.CC_DICE_BASE = '$CC_DICE_BASE';
        process.env.CC_DICE_SESSION_ID = '$TEST_SESSION_ID';
        const { checkAllSlots } = await import('$PROJ_DIR/src/index');
        for (let i = 0; i < 200; i++) {
            const results = await checkAllSlots({ sessionId: '$TEST_SESSION_ID' });
            const r = results.find(r => r.slotName === 'tv-gte');
            if (r.triggered) {
                // triggerValue should be the roll itself (single die) and >= target
                if (r.triggerValue < 15 || r.triggerValue > 20) {
                    console.log('FAIL: triggerValue ' + r.triggerValue + ' out of range [15,20]');
                    process.exit(1);
                }
                // triggerValue should equal the roll (single die = 1 roll)
                if (r.triggerValue !== r.rolls[0]) {
                    console.log('FAIL: triggerValue ' + r.triggerValue + ' != roll ' + r.rolls[0]);
                    process.exit(1);
                }
            }
        }
        console.log('PASS: gte triggerValue always in valid range');
    "
    assert_success
    assert_output --partial "PASS"
}

@test "shared pool: base roll consistency over 200 iterations" {
    bun "$CLI" register cons-a --die 20 --target 1 --target-mode gte --type single --cooldown none --message "A"
    bun "$CLI" register cons-b --die 20 --target 1 --target-mode gte --type single --cooldown none --message "B"

    run bun -e "
        process.env.CC_DICE_BASE = '$CC_DICE_BASE';
        process.env.CC_DICE_SESSION_ID = '$TEST_SESSION_ID';
        const { checkAllSlots } = await import('$PROJ_DIR/src/index');
        let mismatches = 0;
        for (let i = 0; i < 200; i++) {
            const results = await checkAllSlots({ sessionId: '$TEST_SESSION_ID' });
            const a = results.find(r => r.slotName === 'cons-a');
            const b = results.find(r => r.slotName === 'cons-b');
            if (a.rolls[0] !== b.rolls[0]) mismatches++;
        }
        if (mismatches > 0) { console.log('FAIL: ' + mismatches + ' mismatches in 200 iterations'); process.exit(1); }
        console.log('PASS: 200 iterations, 0 mismatches');
    "
    assert_success
    assert_output --partial "PASS"
}

@test "shared pool: no results returned for empty registry" {
    run bun -e "
        process.env.CC_DICE_BASE = '$CC_DICE_BASE';
        process.env.CC_DICE_SESSION_ID = '$TEST_SESSION_ID';
        const { checkAllSlots } = await import('$PROJ_DIR/src/index');
        const results = await checkAllSlots({ sessionId: '$TEST_SESSION_ID' });
        if (results.length !== 0) { console.log('FAIL: expected 0, got ' + results.length); process.exit(1); }
        console.log('PASS: empty');
    "
    assert_success
    assert_output --partial "PASS"
}

# ============================================================================
# Conformance suite (plan D3): the Bun conformance runner is the single entry
# point, wrapped here so `bun run test` runs it alongside BATS in one report.
# ============================================================================

@test "conformance: bun runner passes (C1-C10)" {
    run bun "$PROJ_DIR/tests/conformance/run.ts"
    assert_success
    assert_output --partial "0 failed"
}
