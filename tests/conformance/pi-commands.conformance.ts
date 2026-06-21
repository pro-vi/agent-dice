/**
 * /dice command conformance — deterministic, no live Pi.
 *
 * Captures the registered command handler via a mock registerCommand and drives it
 * with a mock ctx (records ui.notify). Proves register/list/status/roll/reset and
 * the not-found parity with the CLI.
 */

import { type Check, assert, assertEqual, withTempBase } from "./harness";
import ccDice from "../../src/adapters/pi/index";

type CmdHandler = (args: string, ctx: unknown) => Promise<void>;

function capture() {
  let handler: CmdHandler | undefined;
  const pi = {
    on: () => {},
    sendMessage: async () => {},
    registerCommand: (_name: string, opts: { handler: CmdHandler }) => {
      handler = opts.handler;
    },
    registerTool: () => {},
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ccDice(pi as any);
  return handler as CmdHandler;
}

function ctx(sessionId: string, out: Array<{ text: string; type?: string }>) {
  return {
    sessionManager: {
      getSessionId: () => sessionId,
      getEntries: () => [] as unknown[], // depth 0 — command tests use depth-independent slots
    },
    ui: { notify: (text: string, type?: string) => out.push({ text, type }) },
  };
}

export const checks: Check[] = [
  {
    name: "/dice: register → list → status round-trip",
    fn: () =>
      withTempBase(async () => {
        const dice = capture();
        const out: Array<{ text: string; type?: string }> = [];
        await dice('register t --die 1 --target 1 --type single --message "go {best}"', ctx("s", out));
        assert(out.at(-1)?.text.includes("Registered: t (single, d1, target=1 exact)"), `register: ${out.at(-1)?.text}`);
        await dice("list", ctx("s", out));
        assert(out.at(-1)?.text.includes("t (single, 1-sided"), `list: ${out.at(-1)?.text}`);
        await dice("status t", ctx("s", out));
        assert(out.at(-1)?.text.includes("Slot: t (single)"), `status: ${out.at(-1)?.text}`);
      }),
  },
  {
    name: "/dice: roll dry-run renders; reset/clear on missing slot report not-found (CLI parity)",
    fn: () =>
      withTempBase(async () => {
        const dice = capture();
        const out: Array<{ text: string; type?: string }> = [];
        await dice('register t --die 1 --target 1 --type single --message "m"', ctx("s", out));
        await dice("roll t", ctx("s", out));
        assert(out.at(-1)?.text.includes("t: 1d1 = [1] (best: 1, 100%) TRIGGERED!"), `roll: ${out.at(-1)?.text}`);
        await dice("reset ghost", ctx("s", out));
        assertEqual(out.at(-1)?.text, "Slot not found: ghost", "reset missing → not-found");
        assertEqual(out.at(-1)?.type, "error", "reported as error");
        await dice("clear ghost", ctx("s", out));
        assertEqual(out.at(-1)?.text, "Slot not found: ghost", "clear missing → not-found");
      }),
  },
  {
    name: "/dice: missing name and unknown subcommand are handled",
    fn: () =>
      withTempBase(async () => {
        const dice = capture();
        const out: Array<{ text: string; type?: string }> = [];
        await dice("status", ctx("s", out));
        assertEqual(out.at(-1)?.text, "Error: slot name required", "missing name");
        await dice("frobnicate", ctx("s", out));
        assert(out.at(-1)?.text.includes("/dice register"), "unknown subcommand → usage");
      }),
  },
  {
    name: "/dice register: invalid flags are rejected, not persisted (review #4)",
    fn: () =>
      withTempBase(async () => {
        const { getSlot } = await import("../../src/adapters/pi/store");
        const dice = capture();
        const out: Array<{ text: string; type?: string }> = [];
        await dice("register bad1 --die abc", ctx("s", out));
        assert(out.at(-1)?.type === "error" && /Invalid --die/.test(out.at(-1)!.text), `NaN die rejected: ${out.at(-1)?.text}`);
        assertEqual(await getSlot("bad1"), null, "corrupt slot not persisted");
        await dice("register bad2 --cooldown bogus", ctx("s", out));
        assert(out.at(-1)?.type === "error" && /Invalid --cooldown/.test(out.at(-1)!.text), `bad enum rejected: ${out.at(-1)?.text}`);
        assertEqual(await getSlot("bad2"), null, "bad-enum slot not persisted");
        await dice("register bad3 --die 6 --target 20", ctx("s", out));
        assert(out.at(-1)?.type === "error" && /exceeds die size/.test(out.at(-1)!.text), `target>die rejected: ${out.at(-1)?.text}`);
      }),
  },
];
