/**
 * cc-dice Pi extension (entry point).
 *
 * U1 probe stub: exercises every Pi API surface the design depends on, so `tsc`
 * against the published @earendil-works/pi-coding-agent types validates the
 * snapshot-based design. Real wiring lands in U4.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export default function ccDice(pi: ExtensionAPI): void {
  let depth = 0;

  // Depth source (G3): turn_end carries a monotonic turnIndex.
  pi.on("turn_end", (event) => {
    depth = event.turnIndex;
  });

  // Session lifecycle (clearOnSessionStart): reset the cached depth.
  pi.on("session_start", () => {
    depth = 0;
  });

  // Trigger point (G2): agent_end ≈ Claude Stop cadence; ctx resolves session id.
  pi.on("agent_end", async (event, ctx: ExtensionContext) => {
    const sessionId = ctx.sessionManager.getSessionId();
    void sessionId;
    void event.messages;
    void depth;
    // Render path (G2-render): inject a model-visible message. NOTE (probe finding):
    // in published 0.79.x, `content` holds the text and `display` is a boolean UI flag
    // — NOT the string the badlogic/pi-mono snapshot implied.
    await pi.sendMessage(
      { customType: "cc-dice", content: "probe", display: true },
      { deliverAs: "nextTurn" }
    );
  });
}
