/**
 * Pi extension wiring conformance — deterministic, no live Pi.
 *
 * Drives the extension's handlers via a mock ExtensionAPI + a mock ctx whose
 * sessionManager.getEntries() models session-cumulative user messages (the real
 * depth source — review #1). Covers: depth from user-message count, session_start
 * gating on `reason` (review #2), trigger→nudge, and fail-open.
 */

import { type Check, assert, assertEqual, withTempBase } from "./harness";
import ccDice from "../../src/adapters/pi/index";
import { registerSlot, hasCooldown, saveState, loadState } from "../../src/adapters/pi/store";

type Handler = (event: unknown, ctx: unknown) => unknown;

function mockPi() {
  const handlers: Record<string, Handler> = {};
  const sent: Array<{ customType: string; content: unknown; display: unknown }> = [];
  const pi = {
    on: (event: string, h: Handler) => {
      handlers[event] = h;
    },
    sendMessage: (m: { customType: string; content: unknown; display: unknown }) => {
      sent.push(m); // real Pi sendMessage is fire-and-forget + never throws
    },
    registerCommand: () => {},
    registerTool: () => {},
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { pi: pi as any, handlers, sent };
}

/** ctx whose getEntries() yields `userMsgs` user-message entries (session-cumulative depth). */
function ctx(sessionId: string, userMsgs = 0) {
  return {
    sessionManager: {
      getSessionId: () => sessionId,
      getEntries: () => Array.from({ length: userMsgs }, () => ({ type: "message", message: { role: "user" } })),
    },
  };
}

export const checks: Check[] = [
  {
    name: "pi-wiring: agent_end trigger → sendMessage with content + display:true; cooldown written",
    fn: () =>
      withTempBase(async () => {
        registerSlot({ name: "t", die: 1, target: 1, targetMode: "exact", type: "single", onTrigger: { message: "go {best}" } });
        const m = mockPi();
        ccDice(m.pi);
        await m.handlers["agent_end"]({ messages: [] }, ctx("s"));
        assertEqual(m.sent.length, 1, "one nudge for the triggered slot");
        assertEqual(m.sent[0].display, true, "display is the boolean UI flag");
        assert(String(m.sent[0].content).includes("🎲 Nat 1!"), "content carries the rendered nudge");
        assert(await hasCooldown("t", "s"), "trigger wrote a cooldown marker");
      }),
  },
  {
    name: "pi-wiring: depth comes from session user-message count (NOT per-prompt turnIndex) — review #1",
    fn: () =>
      withTempBase(async () => {
        // d1 accumulator rate 7: needs depth 14 → 2 dice → triggers; resetOnTrigger writes the depth.
        registerSlot({ name: "acc", die: 1, target: 1, targetMode: "exact", type: "accumulator", accumulationRate: 7, onTrigger: { message: "m" } });
        await saveState("acc", "s", { depth_at_last_trigger: 0, last_reset: "t" });
        const m = mockPi();
        ccDice(m.pi);
        // 14 user messages in the session → sessionDepth 14.
        await m.handlers["agent_end"]({ messages: [] }, ctx("s", 14));
        assertEqual(m.sent.length, 1, "accumulator triggered at session depth 14");
        assertEqual((await loadState("acc", "s")).depth_at_last_trigger, 14, "reset wrote 14 — depth came from getEntries count");
      }),
  },
  {
    name: "pi-wiring: session_start clears only on reason 'new'/'startup', NOT resume/reload/fork — review #2",
    fn: () =>
      withTempBase(async () => {
        registerSlot({ name: "c", die: 20, target: 20, type: "accumulator", onTrigger: { message: "m" } }); // clearOnSessionStart default true
        await saveState("c", "s", { depth_at_last_trigger: 5, last_reset: "t" });
        const m = mockPi();
        ccDice(m.pi);

        await m.handlers["session_start"]({ type: "session_start", reason: "resume" }, ctx("s"));
        assertEqual((await loadState("c", "s")).depth_at_last_trigger, 5, "resume must NOT clear (state preserved)");
        await m.handlers["session_start"]({ type: "session_start", reason: "reload" }, ctx("s"));
        assertEqual((await loadState("c", "s")).depth_at_last_trigger, 5, "reload must NOT clear");
        await m.handlers["session_start"]({ type: "session_start", reason: "new" }, ctx("s"));
        assertEqual((await loadState("c", "s")).depth_at_last_trigger, 0, "new DOES clear");
      }),
  },
  {
    name: "pi-wiring: a throwing ctx (getEntries) is swallowed in agent_end (fail-open)",
    fn: () =>
      withTempBase(async () => {
        registerSlot({ name: "t", die: 1, target: 1, targetMode: "exact", type: "single", onTrigger: { message: "m" } });
        const m = mockPi();
        ccDice(m.pi);
        const badCtx = {
          sessionManager: {
            getSessionId: () => "s",
            getEntries: () => {
              throw new Error("boom");
            },
          },
        };
        await m.handlers["agent_end"]({ messages: [] }, badCtx);
        assert(true, "agent_end resolved despite ctx.getEntries throwing");
      }),
  },
];
