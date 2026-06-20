/**
 * Accumulator dice type logic — Claude/file-store wrapper.
 *
 * Resolves current depth from the transcript and loads/saves state, delegating
 * the pure math + sentinel calibration to src/core/accumulator.ts. This file is
 * a thin host bridge; the policy lives in core.
 */

import type { DiceSlotConfig, CheckContext } from "./types";
import { countExchanges } from "./transcript";
import { loadState, saveState } from "./state";
import { computeAccumulator } from "./core/accumulator";

/**
 * Calculate the number of dice for an accumulator slot.
 * Resolves depth from the transcript (0 when absent), then applies the pure core
 * formula. Sentinel `-1` calibration is persisted here, preserving prior behavior.
 */
export async function getAccumulatorDiceCount(
  config: DiceSlotConfig,
  sessionId: string,
  ctx: CheckContext
): Promise<{ diceCount: number; currentDepth: number; depthSinceTrigger: number }> {
  let currentDepth = 0;
  if (ctx.transcriptPath) {
    currentDepth = await countExchanges(ctx.transcriptPath);
  }

  const state = await loadState(config.name, sessionId);
  const result = computeAccumulator(config, currentDepth, state);

  if (result.calibratedState) {
    await saveState(config.name, sessionId, result.calibratedState);
  }

  return {
    diceCount: result.diceCount,
    currentDepth: result.currentDepth,
    depthSinceTrigger: result.depthSinceTrigger,
  };
}
