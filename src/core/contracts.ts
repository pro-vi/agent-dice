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
 * Context handed to the engine. Session id is resolved up front by the adapter
 * (plan D1). Depth is resolved LAZILY: the engine calls `getCurrentDepth()` only
 * on paths that actually need it (accumulator dice count / status / reset), so
 * cheap no-op checks — empty registry, all-cooled-down, single/fixed-only,
 * clearSlot, sessionStart — never parse the transcript. Adapters should memoize
 * the resolver so multiple accumulator slots in one check parse at most once.
 * Resolves to `undefined` when the host has no depth source.
 */
export interface CoreCheckContext {
  sessionId: string;
  getCurrentDepth(): Promise<number | undefined>;
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
