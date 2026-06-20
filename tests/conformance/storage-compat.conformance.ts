/**
 * C3: Storage compatibility conformance.
 *
 * Pins the on-disk contract the refactor must not break: slots.json location,
 * per-slot/per-session state filenames, the markerless cooldown filename, the
 * corrupted-file fallback, and sentinel `-1` calibration semantics.
 */

import { type Check, assert, assertEqual, withTempBase } from "./harness";
import { existsSync } from "fs";
import { join } from "path";
import { registerSlot, loadSlots } from "../../src/registry";
import { saveState, loadState, getStateFile } from "../../src/state";
import { markTriggered } from "../../src/cooldown";
import { getAccumulatorDiceCount } from "../../src/accumulator";

export const checks: Check[] = [
  {
    name: "C3: slots.json lives at <base>/slots.json keyed by slot name",
    fn: () =>
      withTempBase(async (base) => {
        const cfg = await registerSlot({ name: "s1", die: 20, target: 20, onTrigger: { message: "m" } });
        assert(existsSync(join(base, "slots.json")), "slots.json at <base>/slots.json");
        const slots = await loadSlots();
        assert("s1" in slots, "slot keyed by name");
        assertEqual(slots["s1"].name, "s1", "persisted slot name");
        assertEqual(cfg.type, "accumulator", "default type preserved");
      }),
  },
  {
    name: "C3: state file = <base>/state/{slot}-{session}.json with DiceState fields",
    fn: () =>
      withTempBase(async (base) => {
        await saveState("s1", "sessA", { depth_at_last_trigger: 5, last_reset: "2026-01-01T00:00:00.000Z" });
        const expected = join(base, "state", "s1-sessA.json");
        assert(existsSync(expected), "state file at <base>/state/{slot}-{session}.json");
        assertEqual(getStateFile("s1", "sessA"), expected, "getStateFile path matches");
        const st = await loadState("s1", "sessA");
        assertEqual(st.depth_at_last_trigger, 5, "depth_at_last_trigger persisted");
        assert(typeof st.last_reset === "string", "last_reset is an ISO string");
      }),
  },
  {
    name: "C3: cooldown marker = <base>/state/triggered-{slot}-{session} (markerless)",
    fn: () =>
      withTempBase(async (base) => {
        await markTriggered("s1", "sessA");
        assert(existsSync(join(base, "state", "triggered-s1-sessA")), "cooldown marker at expected path");
      }),
  },
  {
    name: "C3: corrupted slots.json falls back to empty registry",
    fn: () =>
      withTempBase(async (base) => {
        await Bun.write(join(base, "slots.json"), "{ this is : not valid json ]");
        assertEqual(await loadSlots(), {}, "corrupted registry → {}");
      }),
  },
  {
    name: "C3: corrupted state falls back to default DiceState",
    fn: () =>
      withTempBase(async (base) => {
        await Bun.write(join(base, "state", "s1-sessA.json"), "}}not json{{");
        const st = await loadState("s1", "sessA");
        assertEqual(st.depth_at_last_trigger, 0, "corrupted state → depth 0 default");
      }),
  },
  {
    name: "C3: sentinel -1 calibrates to current depth (0 without transcript) and persists once",
    fn: () =>
      withTempBase(async () => {
        const cfg = await registerSlot({ name: "acc", die: 20, target: 20, onTrigger: { message: "m" } });
        await saveState("acc", "sessA", { depth_at_last_trigger: -1, last_reset: "2026-01-01T00:00:00.000Z" });
        const r = await getAccumulatorDiceCount(cfg, "sessA", {}); // no transcriptPath → currentDepth 0
        assertEqual(r.currentDepth, 0, "currentDepth defaults to 0 without transcript");
        const st = await loadState("acc", "sessA");
        assertEqual(st.depth_at_last_trigger, 0, "sentinel -1 calibrated and persisted to 0");
      }),
  },
];
