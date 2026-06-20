/**
 * C1 / C4 / C5: Core engine conformance (grown across units).
 *
 * U2 lays the foundation: the in-memory host satisfies the DiceHost contract
 * without any Claude/file deps, and the deterministic RNG is reproducible.
 * U3 adds accumulator-math cases (C4); U4 adds engine semantics (C1/C5).
 */

import { type Check, assert, assertEqual } from "./harness";
import { makeMemoryHost, makeRng, slot } from "./fixtures";

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
];
