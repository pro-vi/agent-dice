/**
 * Codex host wiring conformance — deterministic, no live Codex.
 *
 * Drives the host-agnostic engine through the Codex host + a synthetic rollout
 * transcript. Covers: trigger → cooldown written; accumulator depth resolved FROM
 * the Codex rollout parser (reset writes the parsed depth); session_start clearing;
 * and the no-transcript depth default.
 *
 * Isolation note: createCodexHost() sets AGENT_DICE_BASE via `??=`, which does NOT
 * re-point across blocks. `withCodexBase` therefore resets BOTH AGENT_DICE_BASE and
 * CC_DICE_BASE to a fresh temp dir per block and restores them after.
 */

import { type Check, assert, assertEqual } from "./harness";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import * as engine from "../../src/core/engine";
import { createCodexHost, resolveCodexContext } from "../../src/adapters/codex/host";
import { registerSlot } from "../../src/registry";
import { saveState, loadState } from "../../src/state";
import { hasCooldown } from "../../src/cooldown";

/** Run `fn` with a fresh temp Codex base (both base env vars pinned + restored). */
async function withCodexBase(fn: (base: string) => Promise<void>): Promise<void> {
  const prevAgent = process.env.AGENT_DICE_BASE;
  const prevCc = process.env.CC_DICE_BASE;
  const base = mkdtempSync(join(tmpdir(), "cc-dice-codex-wire-"));
  process.env.AGENT_DICE_BASE = base;
  process.env.CC_DICE_BASE = base;
  try {
    await fn(base);
  } finally {
    if (prevAgent === undefined) delete process.env.AGENT_DICE_BASE;
    else process.env.AGENT_DICE_BASE = prevAgent;
    if (prevCc === undefined) delete process.env.CC_DICE_BASE;
    else process.env.CC_DICE_BASE = prevCc;
    try {
      rmSync(base, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}

/** Write a synthetic rollout with `userTurns` user messages; return its path. */
function rollout(base: string, userTurns: number): string {
  const path = join(base, "rollout.jsonl");
  const lines: string[] = [JSON.stringify({ type: "session_meta", payload: {} })];
  for (let i = 0; i < userTurns; i++) {
    lines.push(JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `t${i}` }] } }));
    lines.push(JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [] } }));
  }
  writeFileSync(path, lines.join("\n"));
  return path;
}

export const checks: Check[] = [
  {
    name: "codex-wiring: Stop trigger via the engine writes a cooldown marker",
    fn: () =>
      withCodexBase(async () => {
        await registerSlot({ name: "t", die: 1, target: 1, targetMode: "exact", type: "single", onTrigger: { message: "go {best}" } });
        const host = createCodexHost();
        const ctx = resolveCodexContext({ session_id: "s1" });
        const results = await engine.checkAllSlots(host, ctx);
        const t = results.find((r) => r.slotName === "t");
        assert(t?.triggered === true, "single d1/target1 slot triggers deterministically");
        assert(await hasCooldown("t", "s1"), "trigger wrote a per-session cooldown marker");
      }),
  },
  {
    name: "codex-wiring: accumulator depth resolves from the Codex rollout (reset writes parsed depth)",
    fn: () =>
      withCodexBase(async (base) => {
        // d1 accumulator, rate 7: depth 14 → floor(14/7)=2 dice → triggers; resetOnTrigger writes currentDepth.
        await registerSlot({ name: "acc", die: 1, target: 1, targetMode: "exact", type: "accumulator", accumulationRate: 7, onTrigger: { message: "m" } });
        await saveState("acc", "s2", { depth_at_last_trigger: 0, last_reset: "t" });
        const host = createCodexHost();
        const ctx = resolveCodexContext({ session_id: "s2", transcript_path: rollout(base, 14) });
        const results = await engine.checkAllSlots(host, ctx);
        assert(results.find((r) => r.slotName === "acc")?.triggered === true, "accumulator triggered at rollout depth 14");
        assertEqual((await loadState("acc", "s2")).depth_at_last_trigger, 14, "reset wrote 14 — depth came from the Codex rollout parser");
      }),
  },
  {
    name: "codex-wiring: sessionStart clears clearOnSessionStart slots for the session",
    fn: () =>
      withCodexBase(async () => {
        await registerSlot({ name: "c", die: 20, target: 20, type: "accumulator", onTrigger: { message: "m" } }); // clearOnSessionStart default true
        await saveState("c", "s3", { depth_at_last_trigger: 5, last_reset: "t" });
        const host = createCodexHost();
        const cleared = await engine.sessionStart(host, resolveCodexContext({ session_id: "s3", source: "startup" }));
        assert(cleared.includes("c"), "slot 'c' reported cleared");
        assertEqual((await loadState("c", "s3")).depth_at_last_trigger, 0, "state reset to 0 on session start");
      }),
  },
  {
    name: "codex-wiring: no transcript_path → depth undefined (accumulator reads default to 0, no dice)",
    fn: () =>
      withCodexBase(async () => {
        await registerSlot({ name: "a", die: 20, target: 20, type: "accumulator", accumulationRate: 7, onTrigger: { message: "m" } });
        const ctx = resolveCodexContext({ session_id: "s4" }); // no transcript_path
        assertEqual(await ctx.getCurrentDepth(), undefined, "no transcript → depth undefined");
        const host = createCodexHost();
        const results = await engine.checkAllSlots(host, ctx);
        assert(results.find((r) => r.slotName === "a")?.diceCount === 0, "depth 0 default → 0 dice, no spurious trigger");
      }),
  },
];
