#!/usr/bin/env bun

/**
 * Codex SessionStart hook for agent-dice.
 *
 * Codex fires `SessionStart` with a `source` of `startup` | `resume` | `clear` |
 * `compact`. We clear `clearOnSessionStart` slots only on a GENUINELY new session
 * — `startup` (fresh) or `clear` (context cleared) — and skip `resume`/`compact`,
 * which are continuations of the same logical session (mirrors the Pi adapter's
 * reason-gating, src/adapters/pi/index.ts:40).
 *
 * Unlike Claude's session-start hook there is no `CLAUDE_ENV_FILE` analog to
 * persist a session-id env var, and none is needed: the Stop payload always
 * carries `session_id`. Fail-open silent — never block Codex startup.
 *
 * Registered by `install.sh codex` in `${CODEX_HOME:-~/.codex}/hooks.json`.
 */

import * as engine from "../src/core/engine";
import { createCodexHost, resolveCodexContext, readCodexInput } from "../src/adapters/codex/host";

async function main(): Promise<void> {
  try {
    const input = await readCodexInput();
    if (input.source !== "startup" && input.source !== "clear") return; // continuation — leave state

    const host = createCodexHost();
    await engine.sessionStart(host, resolveCodexContext(input));
  } catch (error) {
    if (process.env.DEBUG === "1") console.error("agent-dice codex-session-start hook error:", error);
    // fail-open silent
  }
}

main();

// Mark this entry script as a module so top-level constructs type-check (TS1375).
export {};
