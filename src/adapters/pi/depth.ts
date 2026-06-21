/**
 * Session depth for Pi = count of user-message entries in the session.
 *
 * Review finding #1: `turn_end.turnIndex` is NOT session-monotonic — Pi resets it
 * to 0 at each agent_start (once per user prompt; agent-session.ts:615), so it
 * counts turns *within one run*, not conversation depth. The accumulator needs a
 * counter that grows across the whole session. `sessionManager.getEntries()` is
 * session-cumulative; counting role==="user" entries excludes tool results and
 * assistant turns — the exact analog of the Claude adapter's countExchanges
 * (which counts type==="user" && !toolUseResult). So depth is the SAME unit on
 * both hosts; no per-host accumulationRate recalibration is needed.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export function sessionDepth(ctx: ExtensionContext): number {
  return ctx.sessionManager.getEntries().filter((e) => e.type === "message" && e.message.role === "user").length;
}
