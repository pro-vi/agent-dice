/**
 * Host-agnostic dice engine.
 *
 * Owns scheduling policy (dice counts, sentinel calibration, shared-roll grouping,
 * trigger detection, reset/cooldown-on-trigger, session-start clearing) over the
 * DiceHost primitives. No Claude/Bun/fs/path/process.env (enforced by C8). The
 * only impurities are rollDice (seeded via host.rng) and the reset timestamp.
 */

import type { DiceResult, DiceSlotConfig, SlotStatus } from "../types";
import type { CoreCheckContext, DiceHost } from "./contracts";
import { rollDice, checkTarget, findTriggerValue, calculateProbability } from "../roll";
import { computeAccumulator } from "./accumulator";

function emptyResult(slotName: string): DiceResult {
  return { triggered: false, rolls: [], best: 0, diceCount: 0, probability: 0, slotName };
}

/**
 * Pure single-slot dry-run preview: rolls `diceCount` dice with NO shared pool and
 * NO side effects (no reset, no cooldown). Used by `cc-dice roll` so the CLI shares
 * the engine's roll/trigger math instead of re-implementing it (D8).
 */
export function previewSlot(config: DiceSlotConfig, diceCount: number, rng?: () => number): DiceResult {
  if (diceCount <= 0) return emptyResult(config.name);
  const rolls = rollDice(diceCount, config.die, rng);
  const best = Math.max(...rolls);
  const triggered = checkTarget(rolls, config.target, config.targetMode);
  const triggerValue = triggered ? findTriggerValue(rolls, config.target, config.targetMode) : undefined;
  const probability = calculateProbability(diceCount, config.die, config.target, config.targetMode);
  return { triggered, rolls, best, triggerValue, diceCount, probability, slotName: config.name };
}

/** Dice count for any slot type. Accumulator persists sentinel calibration via the host. */
async function getDiceCount(
  host: DiceHost,
  config: DiceSlotConfig,
  ctx: CoreCheckContext
): Promise<{ diceCount: number; currentDepth: number; depthSinceTrigger: number }> {
  switch (config.type) {
    case "accumulator": {
      const depth = ctx.currentDepth ?? 0; // accumulator reads default to 0 without depth
      const state = await host.loadState(config.name, ctx.sessionId);
      const result = computeAccumulator(config, depth, state);
      if (result.calibratedState) {
        await host.saveState(config.name, ctx.sessionId, result.calibratedState);
      }
      return {
        diceCount: result.diceCount,
        currentDepth: result.currentDepth,
        depthSinceTrigger: result.depthSinceTrigger,
      };
    }
    case "fixed":
      return { diceCount: config.fixedCount, currentDepth: 0, depthSinceTrigger: 0 };
    case "single":
      return { diceCount: 1, currentDepth: 0, depthSinceTrigger: 0 };
    default:
      return { diceCount: 0, currentDepth: 0, depthSinceTrigger: 0 };
  }
}

/**
 * Check all slots with shared dice pools. Slots with the same die size share one
 * base roll; single slots observe only the base, accumulator/fixed add bonus dice.
 *
 * RNG consumption order (must stay stable for the legacy↔core equivalence probe,
 * D6): groups iterate in die-size first-seen order; within a group the base die is
 * rolled first, then bonus dice per active slot in listSlots order.
 */
export async function checkAllSlots(host: DiceHost, ctx: CoreCheckContext): Promise<DiceResult[]> {
  const slots = await host.listSlots();
  if (slots.length === 0) return [];

  type SlotInfo = { config: DiceSlotConfig; diceCount: number };
  const active: SlotInfo[] = [];
  const results: DiceResult[] = [];

  // Pre-filter cooled-down slots BEFORE grouping (cooldown gate wins).
  for (const config of slots) {
    if (config.cooldown === "per-session" && (await host.hasCooldown(config.name, ctx.sessionId))) {
      results.push(emptyResult(config.name));
      continue;
    }
    const { diceCount } = await getDiceCount(host, config, ctx);
    active.push({ config, diceCount });
  }

  // Group active slots by die size (insertion order = first-seen die size).
  const groups = new Map<number, SlotInfo[]>();
  for (const info of active) {
    const group = groups.get(info.config.die) || [];
    group.push(info);
    groups.set(info.config.die, group);
  }

  for (const [dieSize, groupSlots] of groups) {
    const anyNeedsDice = groupSlots.some((s) => s.diceCount > 0);
    const baseRoll = anyNeedsDice ? rollDice(1, dieSize, host.rng)[0] : 0;

    for (const { config, diceCount } of groupSlots) {
      if (diceCount <= 0) {
        results.push(emptyResult(config.name));
        continue;
      }

      const bonusRolls = diceCount > 1 ? rollDice(diceCount - 1, dieSize, host.rng) : [];
      const rolls = [baseRoll, ...bonusRolls];

      const best = Math.max(...rolls);
      const triggered = checkTarget(rolls, config.target, config.targetMode);
      const triggerValue = triggered ? findTriggerValue(rolls, config.target, config.targetMode) : undefined;
      const probability = calculateProbability(diceCount, dieSize, config.target, config.targetMode);

      if (triggered) {
        if (config.resetOnTrigger && config.type === "accumulator") {
          const depth = ctx.currentDepth ?? 0; // trigger-reset default 0 (D7: differs from resetSlot's -1)
          await host.saveState(config.name, ctx.sessionId, {
            depth_at_last_trigger: depth,
            last_reset: new Date().toISOString(),
          });
        }
        if (config.cooldown === "per-session") {
          await host.markTriggered(config.name, ctx.sessionId);
        }
      }

      results.push({ triggered, rolls, best, triggerValue, diceCount, probability, slotName: config.name });
    }
  }

  return results;
}

/** Status for a slot without rolling. */
export async function getSlotStatus(
  host: DiceHost,
  name: string,
  ctx: CoreCheckContext
): Promise<SlotStatus | null> {
  const config = await host.getSlot(name);
  if (!config) return null;

  const { diceCount, currentDepth, depthSinceTrigger } = await getDiceCount(host, config, ctx);
  const probability = calculateProbability(diceCount, config.die, config.target, config.targetMode);

  let nextDiceAt = 0;
  if (config.type === "accumulator") {
    const state = await host.loadState(name, ctx.sessionId);
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
    sessionId: ctx.sessionId,
  };
}

/**
 * Reset a slot's accumulator. Without resolved depth, writes the sentinel `-1`
 * (D7: distinct from trigger-reset's 0 default — calibrated on the next depth-aware read).
 */
export async function resetSlot(host: DiceHost, name: string, ctx: CoreCheckContext): Promise<void> {
  const config = await host.getSlot(name);
  if (!config) return;

  const depth = ctx.currentDepth ?? -1; // sentinel when no depth
  await host.saveState(name, ctx.sessionId, {
    depth_at_last_trigger: depth,
    last_reset: new Date().toISOString(),
  });
}

/** Clear a slot's state completely and remove its cooldown marker. */
export async function clearSlot(host: DiceHost, name: string, ctx: CoreCheckContext): Promise<void> {
  const config = await host.getSlot(name);
  if (!config) return;

  await host.clearState(name, ctx.sessionId);
  host.clearCooldown(name, ctx.sessionId);
}

/** Session start: clear all slots with clearOnSessionStart=true. */
export async function sessionStart(host: DiceHost, ctx: CoreCheckContext): Promise<string[]> {
  const slots = await host.listSlots();
  const cleared: string[] = [];

  for (const slot of slots) {
    if (slot.clearOnSessionStart) {
      await host.clearState(slot.name, ctx.sessionId);
      host.clearCooldown(slot.name, ctx.sessionId);
      cleared.push(slot.name);
    }
  }

  return cleared;
}
