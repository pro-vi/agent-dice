/**
 * C1 / C4 / C5: Core engine conformance (grown across units).
 *
 * U2 lays the foundation: the in-memory host satisfies the DiceHost contract
 * without any Claude/file deps, and the deterministic RNG is reproducible.
 * U3 adds accumulator-math cases (C4); U4 adds engine semantics (C1/C5).
 */

import { type Check, assert, assertEqual } from "./harness";
import { makeMemoryHost, makeRng, slot } from "./fixtures";
import { computeAccumulator } from "../../src/core/accumulator";
import type { DiceState } from "../../src/types";

const accSlot = slot({ name: "acc", type: "accumulator", accumulationRate: 7, maxDice: 100 });
const st = (depth: number): DiceState => ({ depth_at_last_trigger: depth, last_reset: "t" });

export const checks: Check[] = [
  {
    name: "C1: in-memory host satisfies the DiceHost contract (no Claude/file deps)",
    fn: async () => {
      const host = makeMemoryHost([slot({ name: "acc" })]);
      assertEqual((await host.listSlots()).length, 1, "listSlots returns registered slots");
      assertEqual((await host.getSlot("acc"))?.name, "acc", "getSlot by name");
      assertEqual(await host.getSlot("nope"), null, "getSlot missing → null");

      await host.saveState("acc", "s", { depth_at_last_trigger: 3, last_reset: "t" });
      assertEqual((await host.loadState("acc", "s")).depth_at_last_trigger, 3, "state round-trips");
      await host.clearState("acc", "s");
      assertEqual((await host.loadState("acc", "s")).depth_at_last_trigger, 0, "clearState → depth 0");

      assert(!(await host.hasCooldown("acc", "s")), "no cooldown initially");
      await host.markTriggered("acc", "s");
      assert(await host.hasCooldown("acc", "s"), "markTriggered sets cooldown");
      host.clearCooldown("acc", "s");
      assert(!(await host.hasCooldown("acc", "s")), "clearCooldown removes it");
    },
  },
  {
    name: "C1: deterministic RNG is reproducible per seed and bounded to [0,1)",
    fn: () => {
      const a = makeRng(42);
      const b = makeRng(42);
      const seqA = [a(), a(), a(), a()];
      const seqB = [b(), b(), b(), b()];
      assertEqual(seqA, seqB, "same seed → same sequence");
      assert(seqA.every((x) => x >= 0 && x < 1), "rng output in [0,1)");
      const c = makeRng(7);
      assert(JSON.stringify([c(), c()]) !== JSON.stringify(seqA.slice(0, 2)), "different seed → different sequence");
    },
  },
  {
    name: "C4: dice counts at depths 0/6/7/13/14/21 (rate 7, from trigger 0)",
    fn: () => {
      const cases: Array<[number, number]> = [[0, 0], [6, 0], [7, 1], [13, 1], [14, 2], [21, 3]];
      for (const [depth, expected] of cases) {
        assertEqual(computeAccumulator(accSlot, depth, st(0)).diceCount, expected, `depth ${depth} → ${expected} dice`);
      }
    },
  },
  {
    name: "C4: maxDice caps the count",
    fn: () => {
      const capped = slot({ name: "c", type: "accumulator", accumulationRate: 7, maxDice: 2 });
      assertEqual(computeAccumulator(capped, 21, st(0)).diceCount, 2, "floor(21/7)=3 capped to 2");
    },
  },
  {
    name: "C4: depthSinceTrigger subtracts the last trigger depth",
    fn: () => {
      const r = computeAccumulator(accSlot, 20, st(6));
      assertEqual(r.depthSinceTrigger, 14, "20 - 6 = 14");
      assertEqual(r.diceCount, 2, "floor(14/7) = 2");
    },
  },
  {
    name: "C4: sentinel -1 calibrates to current depth → 0 dice + calibratedState (write)",
    fn: () => {
      const r = computeAccumulator(accSlot, 10, st(-1));
      assertEqual(r.diceCount, 0, "0 dice immediately after calibration");
      assertEqual(r.depthSinceTrigger, 0, "no depth since trigger");
      assert(r.calibratedState !== undefined, "calibratedState present so caller persists it");
      assertEqual(r.calibratedState?.depth_at_last_trigger, 10, "calibrated to current depth");
    },
  },
  {
    name: "C4: non-sentinel state produces no calibratedState (no write)",
    fn: () => {
      assert(computeAccumulator(accSlot, 14, st(0)).calibratedState === undefined, "no write when not calibrating");
    },
  },
];
