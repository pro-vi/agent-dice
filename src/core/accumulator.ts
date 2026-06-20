/**
 * Pure accumulator policy (no IO, no host coupling).
 *
 * Given the slot config, the resolved current depth, and the loaded state, this
 * returns the dice count and — only when the sentinel `-1` was hit — a calibrated
 * state the caller must persist. The caller owns the write; this module owns the math.
 */

import type { DiceSlotConfig, DiceState } from "../types";

export interface AccumulatorResult {
  diceCount: number;
  currentDepth: number;
  depthSinceTrigger: number;
  /** Present only when sentinel calibration changed the state; caller must persist it. */
  calibratedState?: DiceState;
}

/**
 * Formula: floor((currentDepth - depth_at_last_trigger) / accumulationRate), capped at maxDice.
 *
 * Sentinel: if depth_at_last_trigger < 0 (a reset ran without resolved depth),
 * calibrate to currentDepth and return the calibrated state for the caller to save.
 */
export function computeAccumulator(
  config: DiceSlotConfig,
  currentDepth: number,
  state: DiceState
): AccumulatorResult {
  let triggerDepth = state.depth_at_last_trigger;
  let calibratedState: DiceState | undefined;

  if (triggerDepth < 0) {
    triggerDepth = currentDepth;
    calibratedState = { ...state, depth_at_last_trigger: currentDepth };
  }

  const depthSinceTrigger = Math.max(0, currentDepth - triggerDepth);
  const diceCount = Math.min(Math.floor(depthSinceTrigger / config.accumulationRate), config.maxDice);

  return { diceCount, currentDepth, depthSinceTrigger, calibratedState };
}
