/**
 * C2: Public facade export conformance.
 * C10: Package conformance.
 *
 * Locks the public surface of src/index.ts and the package.json shape so the
 * core/adapter extraction cannot silently drop or rename a consumer-facing symbol.
 */

import { type Check, assert, assertEqual } from "./harness";
import * as api from "../../src/index";

// Every runtime (value) export the CLI, hooks, tests, and docs rely on.
// Type-only exports (DiceSlotConfig, DiceState, CheckContext, DiceResult,
// SlotStatus) are erased at runtime and cannot be probed here.
const EXPECTED_EXPORTS = [
  // registry
  "registerSlot", "unregisterSlot", "getSlot", "listSlots", "getBaseDir", "validateName",
  // state
  "loadState", "saveState", "resetState", "clearState",
  // cooldown
  "hasCooldown", "markTriggered", "clearCooldown",
  // roll
  "rollDice", "checkTarget", "findTriggerValue", "calculateProbability",
  // transcript
  "getTranscriptPath", "countExchanges",
  // session
  "getClaudeSessionId", "getSessionId", "extractSessionFromPath", "getProjectHash",
  // hook helpers
  "parseStopHookInput", "exitWithResult",
  // accumulator
  "getAccumulatorDiceCount",
  // high-level API
  "resetSlot", "clearSlot", "getSlotStatus", "checkAllSlots", "sessionStart",
] as const;

export const checks: Check[] = [
  {
    name: "C2: index.ts exports every current runtime symbol",
    fn: () => {
      const missing = EXPECTED_EXPORTS.filter(
        (name) => typeof (api as Record<string, unknown>)[name] !== "function"
      );
      assert(missing.length === 0, `missing/changed facade exports: ${missing.join(", ")}`);
    },
  },
  {
    name: "U6: renderer + preview helpers are exported for hooks/CLI",
    fn: () => {
      for (const name of ["renderTrigger", "applyPlaceholders", "previewSlot"]) {
        assert(typeof (api as Record<string, unknown>)[name] === "function", `missing export: ${name}`);
      }
    },
  },
  {
    name: "C10: package.json — name agent-dice, agent-dice bin + cc-dice alias, main",
    fn: async () => {
      const pkg = (await Bun.file(new URL("../../package.json", import.meta.url)).json()) as {
        name: string;
        bin?: Record<string, string>;
        main: string;
      };
      assertEqual(pkg.name, "agent-dice", "package.name");
      assertEqual(pkg.bin?.["agent-dice"], "./bin/agent-dice.ts", "package.bin.agent-dice");
      assertEqual(pkg.bin?.["cc-dice"], "./bin/agent-dice.ts", "cc-dice alias preserved (back-compat)");
      assertEqual(pkg.main, "src/index.ts", "package.main");
    },
  },
];
