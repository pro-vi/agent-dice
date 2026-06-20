/**
 * C1 / C4 / C5: Core engine conformance (grown across units).
 *
 * U2 lays the foundation: the in-memory host satisfies the DiceHost contract
 * without any Claude/file deps, and the deterministic RNG is reproducible.
 * U3 adds accumulator-math cases (C4); U4 adds engine semantics (C1/C5).
 */

import { type Check, assert, assertEqual } from "./harness";
import { coreCtx, makeMemoryHost, makeRng, slot } from "./fixtures";
import { computeAccumulator } from "../../src/core/accumulator";
import {
  checkAllSlots as engineCheckAllSlots,
  clearSlot as engineClearSlot,
} from "../../src/core/engine";
import { checkTarget, findTriggerValue, calculateProbability } from "../../src/roll";
import type { DiceResult, DiceSlotConfig, DiceState } from "../../src/types";

const accSlot = slot({ name: "acc", type: "accumulator", accumulationRate: 7, maxDice: 100 });
const st = (depth: number): DiceState => ({ depth_at_last_trigger: depth, last_reset: "t" });

/**
 * Independent legacy-scheduler oracle (single/fixed only; depth-independent).
 * Re-derives grouping + shared base roll + bonus dice + RNG consumption order
 * straight from the spec — NOT from src/core/engine.ts or src/index.ts. Since the
 * facade now delegates to the engine, comparing against the facade would be
 * engine-vs-engine; this oracle restores a genuine reference (review finding #3).
 * The pure leaf math (checkTarget/findTriggerValue/calculateProbability) is reused
 * intentionally — it is not "the scheduler" and is covered by its own tests.
 */
function legacyOracle(slots: DiceSlotConfig[], rng: () => number): DiceResult[] {
  const active = slots.map((config) => ({
    config,
    diceCount: config.type === "fixed" ? config.fixedCount : config.type === "single" ? 1 : 0,
  }));
  const groups = new Map<number, typeof active>();
  for (const info of active) {
    const g = groups.get(info.config.die) ?? [];
    g.push(info);
    groups.set(info.config.die, g);
  }
  const roll = (n: number, die: number) => Array.from({ length: n }, () => Math.floor(rng() * die) + 1);
  const results: DiceResult[] = [];
  for (const [dieSize, groupSlots] of groups) {
    const baseRoll = groupSlots.some((s) => s.diceCount > 0) ? roll(1, dieSize)[0] : 0;
    for (const { config, diceCount } of groupSlots) {
      if (diceCount <= 0) {
        results.push({ triggered: false, rolls: [], best: 0, diceCount: 0, probability: 0, slotName: config.name });
        continue;
      }
      const rolls = [baseRoll, ...(diceCount > 1 ? roll(diceCount - 1, dieSize) : [])];
      const triggered = checkTarget(rolls, config.target, config.targetMode);
      results.push({
        triggered,
        rolls,
        best: Math.max(...rolls),
        triggerValue: triggered ? findTriggerValue(rolls, config.target, config.targetMode) : undefined,
        diceCount,
        probability: calculateProbability(diceCount, dieSize, config.target, config.targetMode),
        slotName: config.name,
      });
    }
  }
  return results;
}

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
  {
    name: "C1: engine rolls fixed/single; zero-dice accumulator does not observe base roll",
    fn: async () => {
      const defs = [
        slot({ name: "single1", type: "single", die: 20, target: 20, cooldown: "none" }),
        slot({ name: "fixed3", type: "fixed", die: 6, fixedCount: 3, target: 6, targetMode: "gte", cooldown: "none" }),
        slot({ name: "acc0", type: "accumulator", die: 20, target: 20, cooldown: "none" }), // depth 0 → 0 dice
      ];
      const host = makeMemoryHost(defs, { rng: makeRng(99) });
      const results = await engineCheckAllSlots(host, coreCtx("s")); // no currentDepth → acc0 = 0
      const single = results.find((r) => r.slotName === "single1");
      const fixed = results.find((r) => r.slotName === "fixed3");
      const acc = results.find((r) => r.slotName === "acc0");
      assertEqual(single?.rolls.length, 1, "single rolls exactly 1 die");
      assertEqual(fixed?.rolls.length, 3, "fixed rolls fixedCount dice");
      assertEqual(acc?.diceCount, 0, "zero-dice accumulator");
      assertEqual(acc?.rolls, [], "zero-dice accumulator observes no base roll");
    },
  },
  {
    name: "C1: same die size shares the base roll; different sizes roll independently",
    fn: async () => {
      const defs = [
        slot({ name: "a", type: "single", die: 20, target: 20, cooldown: "none" }),
        slot({ name: "b", type: "single", die: 20, target: 1, cooldown: "none" }),
        slot({ name: "c", type: "single", die: 6, target: 6, cooldown: "none" }),
      ];
      const host = makeMemoryHost(defs, { rng: makeRng(7) });
      const r = await engineCheckAllSlots(host, coreCtx("s"));
      const a = r.find((x) => x.slotName === "a");
      const b = r.find((x) => x.slotName === "b");
      const c = r.find((x) => x.slotName === "c");
      assertEqual(a?.rolls[0], b?.rolls[0], "same-die singles share base roll");
      assert((c?.rolls[0] ?? 0) >= 1 && (c?.rolls[0] ?? 0) <= 6, "different-die slot rolls its own d6");
    },
  },
  {
    name: "C1: engine accumulator uses currentDepth and persists sentinel calibration",
    fn: async () => {
      const defs = [slot({ name: "acc", type: "accumulator", die: 20, target: 20, accumulationRate: 7, cooldown: "none" })];
      const host = makeMemoryHost(defs, { rng: makeRng(5) });
      await host.saveState("acc", "s", { depth_at_last_trigger: -1, last_reset: "t" });
      const r1 = await engineCheckAllSlots(host, coreCtx("s", 14));
      assertEqual(r1.find((x) => x.slotName === "acc")?.diceCount, 0, "calibration turn → 0 dice");
      assertEqual((await host.loadState("acc", "s")).depth_at_last_trigger, 14, "sentinel persisted to 14");
      const r2 = await engineCheckAllSlots(host, coreCtx("s", 28));
      assertEqual(r2.find((x) => x.slotName === "acc")?.diceCount, 2, "floor((28-14)/7) = 2 dice");
    },
  },
  {
    name: "C1: accumulator resetOnTrigger writes currentDepth before the result resolves",
    fn: async () => {
      // d1 always rolls 1; target 1 exact → guaranteed trigger, no RNG dependence.
      const defs = [
        slot({ name: "t", type: "accumulator", die: 1, target: 1, targetMode: "exact", accumulationRate: 1, resetOnTrigger: true, cooldown: "none" }),
      ];
      const host = makeMemoryHost(defs);
      await host.saveState("t", "s", { depth_at_last_trigger: 0, last_reset: "t" });
      const r = await engineCheckAllSlots(host, coreCtx("s", 5)); // 5 dice, all 1 → trigger
      assert(r.find((x) => x.slotName === "t")?.triggered === true, "d1/target1 triggers");
      assertEqual((await host.loadState("t", "s")).depth_at_last_trigger, 5, "reset persisted currentDepth synchronously");
    },
  },
  {
    name: "C5: cooled-down slot is excluded before grouping; others still roll",
    fn: async () => {
      const defs = [
        slot({ name: "cooled", type: "single", die: 20, target: 20, cooldown: "per-session" }),
        slot({ name: "hot", type: "single", die: 20, target: 1, cooldown: "per-session" }),
      ];
      const host = makeMemoryHost(defs, { rng: makeRng(1) });
      await host.markTriggered("cooled", "s");
      const r = await engineCheckAllSlots(host, coreCtx("s"));
      const cooled = r.find((x) => x.slotName === "cooled");
      const hot = r.find((x) => x.slotName === "hot");
      assertEqual(cooled?.rolls, [], "cooled slot does not roll");
      assertEqual(cooled?.diceCount, 0, "cooled slot 0 dice");
      assertEqual(hot?.rolls.length, 1, "non-cooled slot still rolls");
    },
  },
  {
    name: "C5: trigger marks per-session cooldown",
    fn: async () => {
      const defs = [slot({ name: "cm", type: "single", die: 1, target: 1, targetMode: "exact", cooldown: "per-session" })];
      const host = makeMemoryHost(defs);
      const r = await engineCheckAllSlots(host, coreCtx("s"));
      assert(r.find((x) => x.slotName === "cm")?.triggered === true, "d1 single triggers");
      assert(await host.hasCooldown("cm", "s"), "trigger marked cooldown");
    },
  },
  {
    name: "C5: engine clearSlot removes state and cooldown marker",
    fn: async () => {
      const defs = [slot({ name: "x", type: "accumulator", die: 20, target: 20 })];
      const host = makeMemoryHost(defs);
      await host.saveState("x", "s", { depth_at_last_trigger: 5, last_reset: "t" });
      await host.markTriggered("x", "s");
      await engineClearSlot(host, "x", coreCtx("s"));
      assertEqual((await host.loadState("x", "s")).depth_at_last_trigger, 0, "state cleared to 0");
      assert(!(await host.hasCooldown("x", "s")), "cooldown marker removed");
    },
  },
  {
    name: "perf: depth is resolved lazily — never for single/fixed-only or cooled checks (finding #1)",
    fn: async () => {
      let calls = 0;
      const ctx = { sessionId: "s", getCurrentDepth: async () => { calls++; return 5; } };

      const singleFixed = makeMemoryHost(
        [
          slot({ name: "s1", type: "single", die: 20, target: 20, cooldown: "none" }),
          slot({ name: "f1", type: "fixed", die: 6, fixedCount: 2, target: 6, targetMode: "gte", cooldown: "none" }),
        ],
        { rng: makeRng(3) }
      );
      await engineCheckAllSlots(singleFixed, ctx);
      assertEqual(calls, 0, "single/fixed-only check never resolves depth");

      const cooled = makeMemoryHost([slot({ name: "a1", type: "accumulator", die: 20, target: 20, cooldown: "per-session" })], { rng: makeRng(3) });
      await cooled.markTriggered("a1", "s");
      await engineCheckAllSlots(cooled, ctx);
      assertEqual(calls, 0, "cooled-down accumulator never resolves depth (filtered before dice count)");

      const live = makeMemoryHost([slot({ name: "a2", type: "accumulator", die: 20, target: 20, cooldown: "none" })], { rng: makeRng(3) });
      await engineCheckAllSlots(live, ctx);
      assert(calls >= 1, "an active accumulator does resolve depth");
    },
  },
  {
    name: "C1/D6: core engine matches the independent legacy oracle under one seed",
    fn: async () => {
      const SEED = 12345;
      // single + fixed only → depth-independent; exercises grouping, shared base
      // roll, bonus dice, and RNG consumption order across two die sizes.
      const defs = [
        slot({ name: "s_a", type: "single", die: 20, target: 20, targetMode: "exact", cooldown: "none" }),
        slot({ name: "s_b", type: "single", die: 20, target: 1, targetMode: "exact", cooldown: "none" }),
        slot({ name: "f_d20", type: "fixed", die: 20, fixedCount: 2, target: 15, targetMode: "gte", cooldown: "none" }),
        slot({ name: "f_d6", type: "fixed", die: 6, fixedCount: 3, target: 6, targetMode: "gte", cooldown: "none" }),
      ];
      const engineResults = await engineCheckAllSlots(makeMemoryHost(defs, { rng: makeRng(SEED) }), coreCtx("sessX"));
      const oracleResults = legacyOracle(defs, makeRng(SEED));
      assertEqual(engineResults, oracleResults, "engine matches the independent oracle, not itself");
    },
  },
  {
    name: "C1/D6: engine pins exact seeded outputs (golden anchor)",
    fn: async () => {
      const defs = [
        slot({ name: "g_a", type: "single", die: 20, target: 20, cooldown: "none" }),
        slot({ name: "g_b", type: "single", die: 20, target: 1, cooldown: "none" }),
        slot({ name: "g_c", type: "fixed", die: 6, fixedCount: 2, target: 6, targetMode: "gte", cooldown: "none" }),
      ];
      const r = await engineCheckAllSlots(makeMemoryHost(defs, { rng: makeRng(777) }), coreCtx("s"));
      // Frozen exact values (seed 777) — a regression in grouping or RNG
      // consumption order diverges here even if a future oracle shares the same bug.
      const golden = [["g_a", [14], false], ["g_b", [14], false], ["g_c", [1, 2], false]];
      assertEqual(r.map((x) => [x.slotName, x.rolls, x.triggered]), golden, "exact seeded engine output");
      assertEqual(r[0].rolls[0], r[1].rolls[0], "both d20 singles share the base roll");
    },
  },
];
