/**
 * Pi adapter — builds the DiceHost from the node:fs store and resolves the
 * engine's CoreCheckContext from Pi-provided values.
 *
 * Resolution is adapter-only (ADR 0001 D1): the engine never reaches for session
 * id or depth. Kept free of @earendil-works imports so it's testable under Bun —
 * the extension entry (index.ts) supplies sessionId + depth from the Pi context.
 */

import type { CoreCheckContext, DiceHost } from "../../core/contracts";
import * as store from "./store";

/** DiceHost backed by the node:fs store. rng omitted → engine uses Math.random. */
export function createPiHost(): DiceHost {
  return {
    listSlots: store.listSlots,
    getSlot: store.getSlot,
    loadState: store.loadState,
    saveState: store.saveState,
    clearState: store.clearState,
    hasCooldown: store.hasCooldown,
    markTriggered: store.markTriggered,
    clearCooldown: store.clearCooldown,
  };
}

/**
 * Build the engine context. `depth` is the cached turn index (or undefined when
 * no turn has completed yet); the engine applies the right per-op default
 * (0 for accumulator reads / trigger-reset, -1 sentinel for manual reset).
 */
export function piContext(sessionId: string, depth: number | undefined): CoreCheckContext {
  return { sessionId, getCurrentDepth: async () => depth };
}
