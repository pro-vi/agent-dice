/**
 * cc-dice — Generic probabilistic dice trigger system for Claude Code hooks
 *
 * Public API re-exports.
 */

// Types
export type {
  DiceSlotConfig,
  DiceState,
  CheckContext,
  DiceResult,
  SlotStatus,
} from "./types";

// Registration
export { registerSlot, unregisterSlot, getSlot, listSlots, getBaseDir, validateName } from "./registry";

// State
export { loadState, saveState, resetState, clearState } from "./state";

// Cooldown
export { hasCooldown, markTriggered, clearCooldown } from "./cooldown";

// Roll
export { rollDice, checkTarget, findTriggerValue, calculateProbability } from "./roll";

// Transcript
export { getTranscriptPath, countExchanges } from "./transcript";

// Session
export { getClaudeSessionId, getSessionId, extractSessionFromPath, getProjectHash } from "./session";

// Hook helpers
export { parseStopHookInput, exitWithResult } from "./hook-helpers";

// Accumulator
export { getAccumulatorDiceCount } from "./accumulator";

// Single-slot dry-run preview (used by the CLI `roll` command)
export { previewSlot } from "./core/engine";

// Trigger rendering (used by the Stop hook via the dynamically imported module)
export { renderTrigger, applyPlaceholders } from "./adapters/claude-renderer";

// ============================================================================
// High-level API
//
// Thin facade: resolve a Claude CheckContext into the engine's CoreCheckContext
// via the Claude adapter, then delegate to the host-agnostic engine. The legacy
// inline scheduler was deleted here in U5 — its single source of truth is now
// src/core/engine.ts (proven equivalent by the D6 conformance probe).
// ============================================================================

import type { CheckContext, DiceResult, SlotStatus } from "./types";
import { createClaudeHost, resolveCoreContext } from "./adapters/claude-code";
import * as engine from "./core/engine";

/**
 * Check all slots with shared dice pools. Slots with the same die size share one
 * base roll; single slots observe only the base, accumulator/fixed add bonus dice.
 */
export async function checkAllSlots(ctx: CheckContext = {}): Promise<DiceResult[]> {
  return engine.checkAllSlots(createClaudeHost(), resolveCoreContext(ctx));
}

/** Get status for a slot without rolling. */
export async function getSlotStatus(name: string, ctx: CheckContext = {}): Promise<SlotStatus | null> {
  return engine.getSlotStatus(createClaudeHost(), name, resolveCoreContext(ctx));
}

/**
 * Reset a slot's accumulator (set depth_at_last_trigger = current depth).
 * If no transcript is available, uses sentinel -1.
 */
export async function resetSlot(name: string, ctx: CheckContext = {}): Promise<void> {
  return engine.resetSlot(createClaudeHost(), name, resolveCoreContext(ctx));
}

/** Clear a slot's state completely (depth = 0, remove cooldown). */
export async function clearSlot(name: string, ctx: CheckContext = {}): Promise<void> {
  return engine.clearSlot(createClaudeHost(), name, resolveCoreContext(ctx));
}

/** Session start: clear all slots with clearOnSessionStart=true. */
export async function sessionStart(ctx: CheckContext = {}): Promise<string[]> {
  return engine.sessionStart(createClaudeHost(), resolveCoreContext(ctx));
}
