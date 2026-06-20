/**
 * Core contracts — host-agnostic dice engine interface.
 *
 * No Claude/Bun/fs/path/process.env here (enforced by C8). The engine owns
 * POLICY (dice counts, sentinel calibration, shared-roll grouping, trigger
 * detection, reset/cooldown-on-trigger, session-start clearing); the host owns
 * PRIMITIVES (storage + RNG). A second host (Pi/other) implements DiceHost to
 * reuse the engine without importing any Claude transcript/session helpers.
 */

import type { DiceSlotConfig, DiceState } from "../types";

/**
 * Context handed to the engine, already resolved by the adapter (plan D1).
 * The engine never resolves session id or depth itself.
 * `currentDepth` is `undefined` when the host has no depth source for this call.
 */
export interface CoreCheckContext {
  sessionId: string;
  currentDepth?: number;
}

/**
 * Capabilities a host provides to the engine. Storage methods are async to match
 * file/network stores; `clearCooldown` is sync to mirror the current file store.
 */
export interface DiceHost {
  listSlots(): Promise<DiceSlotConfig[]>;
  getSlot(name: string): Promise<DiceSlotConfig | null>;
  loadState(slotName: string, sessionId: string): Promise<DiceState>;
  saveState(slotName: string, sessionId: string, state: DiceState): Promise<void>;
  clearState(slotName: string, sessionId: string): Promise<void>;
  hasCooldown(slotName: string, sessionId: string): Promise<boolean>;
  markTriggered(slotName: string, sessionId: string): Promise<void>;
  clearCooldown(slotName: string, sessionId: string): void;
  /**
   * Optional RNG returning a float in [0, 1). Defaults to Math.random when
   * omitted; injected for deterministic conformance tests (plan D2).
   */
  rng?(): number;
}
