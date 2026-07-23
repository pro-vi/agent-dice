#!/usr/bin/env bun

/**
 * Codex adapter — conversation-depth parser over a Codex "rollout" transcript.
 *
 * Codex persists one JSONL rollout file per session at
 * `${CODEX_HOME:-~/.codex}/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`, and the
 * Stop-hook stdin payload hands us its path as `transcript_path`. Each line is a
 * `RolloutLine` — a tagged object whose `type` is one of `session_meta`,
 * `response_item`, `turn_context`, `event_msg`. The conversation turns live under
 * `type === "response_item"` with a `payload` that is itself tagged (`message`,
 * `function_call`, `function_call_output`, `reasoning`, …).
 *
 * Depth = count of genuine user turns. That is `response_item` + `payload.type ===
 * "message"` + `payload.role === "user"`. This deliberately excludes assistant /
 * developer / reasoning messages and every tool-call/output payload
 * (`function_call_output`, `custom_tool_call_output`, …) — the faithful analog of
 * the Claude adapter's `type === "user" && !toolUseResult` (src/transcript.ts:80)
 * and Pi's `role === "user"` count (src/adapters/pi/depth.ts). Because it counts
 * the same unit, `accumulationRate` transfers across hosts with no recalibration.
 *
 * Note on the initial offset (documented, accepted): Codex records the leading
 * `<environment_context>` bootstrap as a `role:"user"` message, so a fresh session
 * starts one turn "ahead". This preserves the accumulation slope (every ordinary
 * turn still adds 1) — the only effect is that the first threshold arrives one turn
 * early; after the first trigger/reset the state rebases to the current depth.
 *
 * Only the live (hot) `.jsonl` is ever handed to a Stop hook. Codex compresses cold
 * rollouts to `.jsonl.zst`, but an active session's file is always uncompressed, so
 * we never need to decompress here.
 */

/**
 * Count user turns in a Codex rollout transcript file (conversation depth).
 * Missing / unreadable / empty file → 0. Malformed lines are skipped.
 */
export async function countExchanges(transcriptPath: string): Promise<number> {
  try {
    const file = Bun.file(transcriptPath);
    if (!(await file.exists())) return 0;

    const content = await file.text();
    const lines = content.trim().split("\n").filter(Boolean);

    let count = 0;
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        // Genuine user turns only: exclude assistant/developer/reasoning messages
        // and every tool-call/output payload (those are not payload.type "message").
        if (
          entry?.type === "response_item" &&
          entry?.payload?.type === "message" &&
          entry?.payload?.role === "user"
        ) {
          count++;
        }
      } catch {
        // Skip malformed lines
      }
    }
    return count;
  } catch {
    return 0;
  }
}
