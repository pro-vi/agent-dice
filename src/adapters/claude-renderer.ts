/**
 * Claude Code trigger rendering (adapter-owned, NOT core).
 *
 * Single home for the placeholder substitution that was duplicated between
 * hooks/stop.ts and src/hook-helpers.ts (U6). Two surfaces with intentionally
 * different output are preserved exactly:
 *   - applyPlaceholders: the raw {rolls}/{best}/{diceCount}/{slotName} expansion
 *     (used by exitWithResult — no flavor prefix).
 *   - renderTrigger: applyPlaceholders + the "🎲 Nat <best>!" flavor prefix when
 *     slot.flavor !== false (used by the Stop hook).
 */

import type { DiceResult, DiceSlotConfig } from "../types";

/** Expand the {rolls}/{best}/{diceCount}/{slotName} placeholders in a message. */
export function applyPlaceholders(message: string, result: DiceResult): string {
  return message
    .replace("{rolls}", result.rolls.join(", "))
    .replace("{best}", String(result.best))
    .replace("{diceCount}", String(result.diceCount))
    .replace("{slotName}", result.slotName);
}

/** Full Stop-hook trigger line: placeholders plus the optional dice-flavor prefix. */
export function renderTrigger(result: DiceResult, slot: DiceSlotConfig): string {
  const msg = applyPlaceholders(slot.onTrigger.message, result);
  return slot.flavor !== false ? `🎲 Nat ${result.best}! ${msg}` : msg;
}
