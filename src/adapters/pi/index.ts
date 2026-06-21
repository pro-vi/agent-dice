/**
 * cc-dice Pi extension.
 *
 * Wires the host-agnostic engine into Pi's lifecycle:
 *   - session_start (reason "new"/"startup") → clear clearOnSessionStart slots
 *   - agent_end (≈ Claude Stop)             → run the engine, inject any trigger nudge
 *
 * Depth comes from the session's user-message count (see depth.ts) — NOT turnIndex,
 * which resets per prompt (review #1). Resolution is adapter-only (ADR 0001 D1).
 * Render is adapter-owned: nudge text in `content`, `display: true` is the UI flag.
 *
 * Delivery is best-effort / at-most-once: the engine commits cooldown + reset at roll
 * time, but the nudge rides Pi's in-memory nextTurn queue, which is dropped if the
 * session ends before the next prompt (review #3 — documented in ADR 0001). Handlers
 * fail open: an internal error never breaks Pi's agent loop.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as engine from "../../core/engine";
import { createPiHost, piContext } from "./host";
import { registerDiceCommands } from "./commands";
import { registerDiceTools } from "./tools";
import { sessionDepth } from "./depth";
import { renderTrigger } from "../claude-renderer";

function failOpen(where: string, err: unknown): void {
  if (process.env.DEBUG === "1") console.error(`[cc-dice:${where}]`, err);
}

export default function ccDice(pi: ExtensionAPI): void {
  const host = createPiHost();

  // Config UX: agent-facing tools (natural language → configure_dice) + the /dice
  // slash command for humans who prefer typing it.
  registerDiceTools(pi);
  registerDiceCommands(pi);

  // Only a genuinely new session clears clearOnSessionStart slots — NOT resume /
  // reload / fork, which are continuations of the same logical session (review #2).
  pi.on("session_start", async (event, ctx) => {
    if (event.reason !== "new" && event.reason !== "startup") return;
    try {
      await engine.sessionStart(host, piContext(ctx.sessionManager.getSessionId(), undefined));
    } catch (err) {
      failOpen("session_start", err);
    }
  });

  // Agent finished its loop (≈ Claude Stop): roll all slots, surface triggers.
  pi.on("agent_end", async (_event, ctx) => {
    try {
      const ctx2 = piContext(ctx.sessionManager.getSessionId(), sessionDepth(ctx));
      const results = await engine.checkAllSlots(host, ctx2);
      const slots = new Map((await host.listSlots()).map((s) => [s.name, s]));
      for (const r of results) {
        if (!r.triggered) continue;
        const slot = slots.get(r.slotName);
        if (!slot) continue;
        // Fire-and-forget: sendMessage returns void and never throws (it has an
        // internal catch); do NOT await it. Best-effort delivery — see header.
        void pi.sendMessage(
          { customType: "cc-dice", content: renderTrigger(r, slot), display: true },
          { deliverAs: "nextTurn" }
        );
      }
    } catch (err) {
      failOpen("agent_end", err);
    }
  });
}
