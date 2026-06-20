/**
 * Hook helpers for Claude Code integration
 *
 * Stdin parsing, exit code handling for hooks.
 */

import type { DiceResult, DiceSlotConfig } from "./types";
import { applyPlaceholders } from "./adapters/claude-renderer";

interface StopHookInput {
  session_id: string;
  transcript_path: string;
  reason?: string;
  [key: string]: unknown;
}

/**
 * Parse stdin JSON from Claude Code stop hook.
 * Returns session_id and transcript_path.
 */
export async function parseStopHookInput(): Promise<StopHookInput> {
  try {
    const input: StopHookInput = await Bun.stdin.json();
    return input;
  } catch {
    return { session_id: "", transcript_path: "" };
  }
}

/**
 * Handle hook exit with appropriate exit code.
 *
 * Exit codes for Claude Code hooks:
 * - 0: Silent pass (stdout visible to user only)
 * - 2: Show message to Claude via stderr, continue conversation
 *
 * @param result - The dice check result
 * @param slotConfig - The slot configuration (for onTrigger message)
 */
export function exitWithResult(result: DiceResult, slotConfig: DiceSlotConfig): never {
  if (result.triggered) {
    // No flavor prefix here — preserves exitWithResult's current output (U6).
    console.error(applyPlaceholders(slotConfig.onTrigger.message, result));
    process.exit(2);
  }

  // Non-trigger: exit silently
  process.exit(0);
}
