/**
 * Pi extension wiring conformance — deterministic, no live Pi.
 *
 * Drives the extension's event handlers via a mock ExtensionAPI (the `import type`
 * in index.ts is erased at runtime, so this runs under Bun). Proves: turn_end
 * caches depth, agent_end fires the engine + injects a nudge (content + display),
 * session_start clears, and handlers fail open.
 */

import { type Check, assert, assertEqual, withTempBase } from "./harness";
import ccDice from "../../src/adapters/pi/index";
import { registerSlot, hasCooldown, saveState, loadState } from "../../src/adapters/pi/store";

type Handler = (event: unknown, ctx: unknown) => unknown;

function mockPi(opts: { throwOnSend?: boolean } = {}) {
  const handlers: Record<string, Handler> = {};
  const sent: Array<{ customType: string; content: unknown; display: unknown }> = [];
  const pi = {
    on: (event: string, h: Handler) => {
      handlers[event] = h;
    },
    sendMessage: async (m: { customType: string; content: unknown; display: unknown }) => {
      if (opts.throwOnSend) throw new Error("boom");
      sent.push(m);
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { pi: pi as any, handlers, sent };
}

const ctx = (sessionId: string) => ({ sessionManager: { getSessionId: () => sessionId } });

export const checks: Check[] = [
  {
    name: "pi-wiring: agent_end trigger → sendMessage with content + display:true; cooldown written",
    fn: () =>
      withTempBase(async () => {
        registerSlot({ name: "t", die: 1, target: 1, targetMode: "exact", type: "single", onTrigger: { message: "go {best}" } });
        const m = mockPi();
        ccDice(m.pi);
        await m.handlers["turn_end"]({ turnIndex: 3 }, ctx("s"));
        await m.handlers["agent_end"]({ messages: [] }, ctx("s"));
        assertEqual(m.sent.length, 1, "one nudge sent for the triggered slot");
        assertEqual(m.sent[0].customType, "cc-dice", "customType");
        assertEqual(m.sent[0].display, true, "display is the boolean UI flag");
        assert(String(m.sent[0].content).includes("go 1"), `content has the rendered message: ${m.sent[0].content}`);
        assert(String(m.sent[0].content).includes("🎲 Nat 1!"), "content has the dice flavor prefix");
        assert(await hasCooldown("t", "s"), "trigger wrote a cooldown marker");
      }),
  },
  {
    name: "pi-wiring: turn_end depth flows into accumulator reset-on-trigger",
    fn: () =>
      withTempBase(async () => {
        // d1 accumulator, rate 7: at depth 14 → 2 dice, all 1s → triggers; resetOnTrigger writes current depth.
        registerSlot({ name: "acc", die: 1, target: 1, targetMode: "exact", type: "accumulator", accumulationRate: 7, onTrigger: { message: "m" } });
        await saveState("acc", "s", { depth_at_last_trigger: 0, last_reset: "t" });
        const m = mockPi();
        ccDice(m.pi);
        await m.handlers["turn_end"]({ turnIndex: 14 }, ctx("s"));
        await m.handlers["agent_end"]({ messages: [] }, ctx("s"));
        assertEqual(m.sent.length, 1, "accumulator triggered at depth 14");
        assertEqual((await loadState("acc", "s")).depth_at_last_trigger, 14, "reset wrote the cached depth (14) — proves depth flowed");
      }),
  },
  {
    name: "pi-wiring: session_start clears clearOnSessionStart slots",
    fn: () =>
      withTempBase(async () => {
        registerSlot({ name: "c", die: 20, target: 20, type: "accumulator", onTrigger: { message: "m" } }); // clearOnSessionStart defaults true
        await saveState("c", "s", { depth_at_last_trigger: 5, last_reset: "t" });
        const m = mockPi();
        ccDice(m.pi);
        await m.handlers["session_start"]({}, ctx("s"));
        assertEqual((await loadState("c", "s")).depth_at_last_trigger, 0, "state cleared on session_start");
      }),
  },
  {
    name: "pi-wiring: a throwing sendMessage is swallowed (fail-open — never breaks the agent loop)",
    fn: () =>
      withTempBase(async () => {
        registerSlot({ name: "t", die: 1, target: 1, targetMode: "exact", type: "single", onTrigger: { message: "m" } });
        const m = mockPi({ throwOnSend: true });
        ccDice(m.pi);
        await m.handlers["turn_end"]({ turnIndex: 1 }, ctx("s"));
        // Must resolve, not reject, even though sendMessage throws.
        await m.handlers["agent_end"]({ messages: [] }, ctx("s"));
        assert(true, "agent_end handler resolved despite sendMessage throwing");
      }),
  },
];
