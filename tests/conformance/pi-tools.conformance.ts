/**
 * Agent-facing dice tools conformance — deterministic, no live Pi/model.
 *
 * Captures the tools the extension registers via a mock registerTool, then calls
 * execute() directly (as the model would). Proves configure_dice registers/validates,
 * list_dice reports, and remove_dice removes.
 */

import { type Check, assert, assertEqual, withTempBase } from "./harness";
import ccDice from "../../src/adapters/pi/index";
import { getSlot } from "../../src/adapters/pi/store";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tool = { execute: (id: string, params: any, signal: unknown, onUpdate: unknown, ctx: unknown) => Promise<{ content: Array<{ text: string }> }> };

function captureTools(): Record<string, Tool> {
  const tools: Record<string, Tool> = {};
  const pi = {
    on: () => {},
    sendMessage: () => {},
    registerCommand: () => {},
    registerTool: (t: Tool & { name: string }) => {
      tools[t.name] = t;
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ccDice(pi as any);
  return tools;
}

const ctx = (sid = "s") => ({ sessionManager: { getSessionId: () => sid, getEntries: () => [] as unknown[] } });
const out = (r: { content: Array<{ text: string }> }) => r.content[0].text;

export const checks: Check[] = [
  {
    name: "configure_dice: agent registers a slot from structured params",
    fn: () =>
      withTempBase(async () => {
        const tools = captureTools();
        assert(typeof tools.configure_dice?.execute === "function", "configure_dice tool registered");
        const r = await tools.configure_dice.execute(
          "1",
          { name: "refactor", message: "Refactor now ({best})", type: "accumulator", accumulationRate: 7 },
          undefined,
          undefined,
          ctx()
        );
        assert(/Registered dice slot "refactor"/.test(out(r)), `result: ${out(r)}`);
        const slot = await getSlot("refactor");
        assertEqual(slot?.type, "accumulator", "slot persisted as accumulator");
        assertEqual(slot?.die, 20, "die defaulted to 20");
        assertEqual(slot?.onTrigger.message, "Refactor now ({best})", "message persisted");
      }),
  },
  {
    name: "configure_dice: target > die is rejected, not persisted",
    fn: () =>
      withTempBase(async () => {
        const tools = captureTools();
        const r = await tools.configure_dice.execute("1", { name: "bad", message: "m", die: 6, target: 20 }, undefined, undefined, ctx());
        assert(/exceeds die size/.test(out(r)), `result: ${out(r)}`);
        assertEqual(await getSlot("bad"), null, "invalid slot not persisted");
      }),
  },
  {
    name: "configure_dice: an invalid slot name fails gracefully (no throw)",
    fn: () =>
      withTempBase(async () => {
        const tools = captureTools();
        const r = await tools.configure_dice.execute("1", { name: "bad name", message: "m" }, undefined, undefined, ctx());
        assert(/Could not configure dice/.test(out(r)), `result: ${out(r)}`);
      }),
  },
  {
    name: "list_dice / remove_dice round-trip",
    fn: () =>
      withTempBase(async () => {
        const tools = captureTools();
        await tools.configure_dice.execute("1", { name: "rf", message: "m", type: "single", die: 20, target: 1 }, undefined, undefined, ctx());
        const listed = await tools.list_dice.execute("2", {}, undefined, undefined, ctx());
        assert(/rf:/.test(out(listed)) && /dice/.test(out(listed)), `list: ${out(listed)}`);
        const removed = await tools.remove_dice.execute("3", { name: "rf" }, undefined, undefined, ctx());
        assert(/Removed dice slot "rf"/.test(out(removed)), `remove: ${out(removed)}`);
        assertEqual(await getSlot("rf"), null, "slot gone after remove_dice");
      }),
  },
];
