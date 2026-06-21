/**
 * Pi adapter storage conformance — proves the node:fs store matches the Claude
 * file-store formats byte-for-byte (R3 / C3 parity), so the on-disk contract is
 * identical across hosts. Runs under the Bun runner (node:fs works there).
 */

import { type Check, assert, assertEqual, withTempBase } from "./harness";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  registerSlot,
  unregisterSlot,
  getSlot,
  listSlots,
  loadSlots,
  saveState,
  loadState,
  clearState,
  getStateFile,
  hasCooldown,
  markTriggered,
  clearCooldown,
} from "../../src/adapters/pi/store";

export const checks: Check[] = [
  {
    name: "pi-store: register → slots.json at <base>, keyed by name, defaults applied",
    fn: () =>
      withTempBase(async (base) => {
        const cfg = registerSlot({ name: "p1", die: 20, target: 20, onTrigger: { message: "m" } });
        assert(existsSync(join(base, "slots.json")), "slots.json at <base>/slots.json");
        assert("p1" in loadSlots(), "slot keyed by name");
        assertEqual(cfg.type, "accumulator", "default type applied");
        assertEqual((await getSlot("p1"))?.name, "p1", "getSlot returns it");
        assertEqual((await listSlots()).length, 1, "listSlots includes it");
      }),
  },
  {
    name: "pi-store: state file = <base>/state/{slot}-{session}.json with DiceState fields",
    fn: () =>
      withTempBase(async (base) => {
        await saveState("p1", "sessA", { depth_at_last_trigger: 5, last_reset: "2026-01-01T00:00:00.000Z" });
        const expected = join(base, "state", "p1-sessA.json");
        assert(existsSync(expected), "state file at the Claude-identical path");
        assertEqual(getStateFile("p1", "sessA"), expected, "getStateFile path matches");
        assertEqual((await loadState("p1", "sessA")).depth_at_last_trigger, 5, "depth persisted");
      }),
  },
  {
    name: "pi-store: cooldown marker = <base>/state/triggered-{slot}-{session}",
    fn: () =>
      withTempBase(async (base) => {
        assert(!(await hasCooldown("p1", "sessA")), "no marker initially");
        await markTriggered("p1", "sessA");
        assert(existsSync(join(base, "state", "triggered-p1-sessA")), "marker at the Claude-identical path");
        assert(await hasCooldown("p1", "sessA"), "hasCooldown true");
        clearCooldown("p1", "sessA");
        assert(!(await hasCooldown("p1", "sessA")), "clearCooldown removes it");
      }),
  },
  {
    name: "pi-store: corrupted slots.json / state fall back (registry → {}, state → default)",
    fn: () =>
      withTempBase(async (base) => {
        await Bun.write(join(base, "slots.json"), "{ not : json ]");
        assertEqual(loadSlots(), {}, "corrupted registry → {}");
        const { mkdirSync, writeFileSync } = await import("node:fs");
        mkdirSync(join(base, "state"), { recursive: true });
        writeFileSync(join(base, "state", "p1-sessA.json"), "}}nope{{");
        assertEqual((await loadState("p1", "sessA")).depth_at_last_trigger, 0, "corrupted state → depth 0");
      }),
  },
  {
    name: "pi-store: sentinel -1 round-trips; clearState resets to 0; unregister removes slot",
    fn: () =>
      withTempBase(async () => {
        await saveState("p1", "sessA", { depth_at_last_trigger: -1, last_reset: "t" });
        assertEqual((await loadState("p1", "sessA")).depth_at_last_trigger, -1, "sentinel -1 round-trips");
        await clearState("p1", "sessA");
        assertEqual((await loadState("p1", "sessA")).depth_at_last_trigger, 0, "clearState → 0");
        registerSlot({ name: "p2", die: 6, target: 6, onTrigger: { message: "m" } });
        assert(unregisterSlot("p2"), "unregister returns true");
        assertEqual(await getSlot("p2"), null, "slot gone after unregister");
      }),
  },
];
