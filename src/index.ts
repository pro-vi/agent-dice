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

// ============================================================================
// High-level API
// ============================================================================

import type { DiceSlotConfig, CheckContext, DiceResult, SlotStatus } from "./types";
import { getSlot, listSlots as listSlotsInternal } from "./registry";
import { loadState, resetState as resetStateInternal, clearState as clearStateInternal } from "./state";
import { hasCooldown, markTriggered as markTriggeredInternal, clearCooldown } from "./cooldown";
import { rollDice, checkTarget, findTriggerValue, calculateProbability } from "./roll";
import { countExchanges } from "./transcript";
import { extractSessionFromPath, getSessionId } from "./session";
import { getAccumulatorDiceCount } from "./accumulator";

/**
 * Resolve session ID from context, falling back to env/project hash.
 */
function resolveSessionId(ctx: CheckContext): string {
  if (ctx.sessionId) return ctx.sessionId;
  if (ctx.transcriptPath) {
    const extracted = extractSessionFromPath(ctx.transcriptPath);
    if (extracted) return extracted;
  }
  return getSessionId();
}

/**
 * Calculate dice count for any slot type.
 */
async function getDiceCount(
  config: DiceSlotConfig,
  sessionId: string,
  ctx: CheckContext
): Promise<{ diceCount: number; currentDepth: number; depthSinceTrigger: number }> {
  switch (config.type) {
    case "accumulator":
      return getAccumulatorDiceCount(config, sessionId, ctx);

    case "fixed":
      return { diceCount: config.fixedCount, currentDepth: 0, depthSinceTrigger: 0 };

    case "single":
      return { diceCount: 1, currentDepth: 0, depthSinceTrigger: 0 };

    default:
      return { diceCount: 0, currentDepth: 0, depthSinceTrigger: 0 };
  }
}

/**
 * Reset a slot's accumulator (set depth_at_last_trigger = current depth).
 * If no transcript is available, uses sentinel -1.
 */
export async function resetSlot(name: string, ctx: CheckContext = {}): Promise<void> {
  const config = await getSlot(name);
  if (!config) return;

  const sessionId = resolveSessionId(ctx);

  let currentDepth = -1; // sentinel
  if (ctx.transcriptPath) {
    currentDepth = await countExchanges(ctx.transcriptPath);
  }

  await resetStateInternal(name, sessionId, currentDepth);
}

/**
 * Clear a slot's state completely (depth = 0, remove cooldown).
 */
export async function clearSlot(name: string, ctx: CheckContext = {}): Promise<void> {
  const config = await getSlot(name);
  if (!config) return;

  const sessionId = resolveSessionId(ctx);
  await clearStateInternal(name, sessionId);
  clearCooldown(name, sessionId);
}

/**
 * Get status for a slot without rolling.
 */
export async function getSlotStatus(name: string, ctx: CheckContext = {}): Promise<SlotStatus | null> {
  const config = await getSlot(name);
  if (!config) return null;

  const sessionId = resolveSessionId(ctx);
  const { diceCount, currentDepth, depthSinceTrigger } = await getDiceCount(config, sessionId, ctx);
  const probability = calculateProbability(diceCount, config.die, config.target, config.targetMode);

  // Calculate next dice threshold
  let nextDiceAt = 0;
  if (config.type === "accumulator") {
    const state = await loadState(name, sessionId);
    nextDiceAt = state.depth_at_last_trigger + (diceCount + 1) * config.accumulationRate;
  }

  return {
    name: config.name,
    type: config.type,
    diceCount,
    currentDepth,
    depthSinceTrigger,
    probability,
    nextDiceAt,
    sessionId,
  };
}

/**
 * Check all slots with shared dice pools.
 *
 * Slots with the same die size share a "base roll" — one die rolled once
 * per group. Single-type slots observe only the base roll. Accumulator
 * and fixed-type slots observe the base roll plus bonus dice.
 *
 * This ensures that multiple single-type slots on the same die size
 * see the same roll value (face claims are mutually exclusive on the
 * base die).
 */
export async function checkAllSlots(ctx: CheckContext = {}): Promise<DiceResult[]> {
  const slots = await listSlotsInternal();
  if (slots.length === 0) return [];

  const sessionId = resolveSessionId(ctx);

  // Pre-filter cooled-down slots, calculate dice counts for active ones
  type SlotInfo = { config: DiceSlotConfig; diceCount: number };
  const active: SlotInfo[] = [];
  const results: DiceResult[] = [];

  for (const config of slots) {
    if (config.cooldown === "per-session" && await hasCooldown(config.name, sessionId)) {
      results.push({ triggered: false, rolls: [], best: 0, diceCount: 0, probability: 0, slotName: config.name });
      continue;
    }
    const { diceCount } = await getDiceCount(config, sessionId, ctx);
    active.push({ config, diceCount });
  }

  // Group active slots by die size
  const groups = new Map<number, SlotInfo[]>();
  for (const info of active) {
    const group = groups.get(info.config.die) || [];
    group.push(info);
    groups.set(info.config.die, group);
  }

  for (const [dieSize, groupSlots] of groups) {
    // Roll one base die if any slot in this group needs at least 1 die
    const anyNeedsDice = groupSlots.some(s => s.diceCount > 0);
    const baseRoll = anyNeedsDice ? rollDice(1, dieSize)[0] : 0;

    for (const { config, diceCount } of groupSlots) {
      if (diceCount <= 0) {
        results.push({ triggered: false, rolls: [], best: 0, diceCount: 0, probability: 0, slotName: config.name });
        continue;
      }

      // Base roll shared across group + bonus dice for this slot
      const bonusRolls = diceCount > 1 ? rollDice(diceCount - 1, dieSize) : [];
      const rolls = [baseRoll, ...bonusRolls];

      const best = Math.max(...rolls);
      const triggered = checkTarget(rolls, config.target, config.targetMode);
      const triggerValue = triggered ? findTriggerValue(rolls, config.target, config.targetMode) : undefined;
      const probability = calculateProbability(diceCount, dieSize, config.target, config.targetMode);

      if (triggered) {
        if (config.resetOnTrigger && config.type === "accumulator") {
          let currentDepth = 0;
          if (ctx.transcriptPath) {
            currentDepth = await countExchanges(ctx.transcriptPath);
          }
          await resetStateInternal(config.name, sessionId, currentDepth);
        }
        if (config.cooldown === "per-session") {
          await markTriggeredInternal(config.name, sessionId);
        }
      }

      results.push({ triggered, rolls, best, triggerValue, diceCount, probability, slotName: config.name });
    }
  }

  return results;
}

/**
 * Session start: clear all slots with clearOnSessionStart=true.
 */
export async function sessionStart(ctx: CheckContext = {}): Promise<string[]> {
  const slots = await listSlotsInternal();
  const sessionId = resolveSessionId(ctx);
  const cleared: string[] = [];

  for (const slot of slots) {
    if (slot.clearOnSessionStart) {
      await clearStateInternal(slot.name, sessionId);
      clearCooldown(slot.name, sessionId);
      cleared.push(slot.name);
    }
  }

  return cleared;
}
