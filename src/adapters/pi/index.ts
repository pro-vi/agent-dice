/**
 * cc-dice Pi extension.
 *
 * Wires the host-agnostic engine into Pi's lifecycle:
 *   - turn_end      → cache the monotonic turnIndex (free depth, no transcript parse)
 *   - session_start → reset cached depth + clear clearOnSessionStart slots
 *   - agent_end     → run the engine (Claude-Stop cadence) and inject any trigger nudge
 *
 * Resolution is adapter-only (ADR 0001 D1). Render is adapter-owned: nudge text goes
 * in `content`, `display: true` is the UI flag (probe finding — see U1). Handlers
 * fail open: an internal error never breaks Pi's agent loop.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as engine from "../../core/engine";
import { createPiHost, piContext } from "./host";
import { renderTrigger } from "../claude-renderer";

function failOpen(where: string, err: unknown): void {
  if (process.env.DEBUG === "1") console.error(`[cc-dice:${where}]`, err);
}

export default function ccDice(pi: ExtensionAPI): void {
  const host = createPiHost();
  let depth: number | undefined;

  // Free monotonic depth — no transcript parse (cf. the Claude adapter).
  pi.on("turn_end", (event) => {
    depth = event.turnIndex;
  });

  // New session: drop stale depth, then clear slots flagged clearOnSessionStart.
  pi.on("session_start", async (_event, ctx) => {
    depth = undefined;
    try {
      await engine.sessionStart(host, piContext(ctx.sessionManager.getSessionId(), depth));
    } catch (err) {
      failOpen("session_start", err);
    }
  });

  // Agent finished its loop (≈ Claude Stop): roll all slots, surface triggers.
  pi.on("agent_end", async (_event, ctx) => {
    try {
      const ctx2 = piContext(ctx.sessionManager.getSessionId(), depth);
      const results = await engine.checkAllSlots(host, ctx2);
      const slots = new Map((await host.listSlots()).map((s) => [s.name, s]));
      for (const r of results) {
        if (!r.triggered) continue;
        const slot = slots.get(r.slotName);
        if (!slot) continue;
        await pi.sendMessage(
          { customType: "cc-dice", content: renderTrigger(r, slot), display: true },
          { deliverAs: "nextTurn" }
        );
      }
    } catch (err) {
      failOpen("agent_end", err);
    }
  });
}
