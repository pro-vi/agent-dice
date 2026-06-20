/**
 * Shared conformance fixtures: a seedable RNG, an in-memory DiceHost, and a slot
 * builder. Not a `*.conformance.ts` file, so the runner does not treat it as a
 * suite. Reused by core-engine.conformance.ts across U2/U3/U4.
 */

import type { CoreCheckContext, DiceHost } from "../../src/core/contracts";
import type { DiceSlotConfig, DiceState } from "../../src/types";

/** Build a CoreCheckContext with an eager (already-known) depth, for tests. */
export function coreCtx(sessionId: string, depth?: number): CoreCheckContext {
  return { sessionId, getCurrentDepth: async () => depth };
}

/** Deterministic, seedable PRNG (mulberry32) returning a float in [0, 1). */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIXED_RESET = "1970-01-01T00:00:00.000Z";

export type MemoryHost = DiceHost & {
  _state: Map<string, DiceState>;
  _cooldown: Set<string>;
};

/** In-memory DiceHost with zero Claude/file/Bun dependencies. */
export function makeMemoryHost(
  slots: DiceSlotConfig[],
  opts: { rng?: () => number; state?: Record<string, DiceState> } = {}
): MemoryHost {
  const slotMap = new Map(slots.map((s) => [s.name, s]));
  const state = new Map<string, DiceState>();
  const cooldown = new Set<string>();
  const key = (slot: string, session: string) => `${slot}::${session}`;
  if (opts.state) for (const [k, v] of Object.entries(opts.state)) state.set(k, v);

  return {
    _state: state,
    _cooldown: cooldown,
    async listSlots() {
      return [...slotMap.values()];
    },
    async getSlot(name) {
      return slotMap.get(name) ?? null;
    },
    async loadState(slot, session) {
      return state.get(key(slot, session)) ?? { depth_at_last_trigger: 0, last_reset: FIXED_RESET };
    },
    async saveState(slot, session, s) {
      state.set(key(slot, session), s);
    },
    async clearState(slot, session) {
      state.set(key(slot, session), { depth_at_last_trigger: 0, last_reset: FIXED_RESET });
    },
    async hasCooldown(slot, session) {
      return cooldown.has(key(slot, session));
    },
    async markTriggered(slot, session) {
      cooldown.add(key(slot, session));
    },
    clearCooldown(slot, session) {
      cooldown.delete(key(slot, session));
    },
    rng: opts.rng,
  };
}

/** Build a full DiceSlotConfig from partial overrides (mirrors SLOT_DEFAULTS). */
export function slot(overrides: Partial<DiceSlotConfig> & { name: string }): DiceSlotConfig {
  return {
    name: overrides.name,
    die: 20,
    target: 20,
    targetMode: "exact",
    type: "accumulator",
    accumulationRate: 7,
    maxDice: 100,
    fixedCount: 1,
    cooldown: "per-session",
    clearOnSessionStart: true,
    resetOnTrigger: true,
    flavor: true,
    onTrigger: { message: "m" },
    ...overrides,
  };
}
