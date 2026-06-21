#!/usr/bin/env bun

/**
 * SessionStart Hook - Register session UUID as environment variable
 *
 * CLAUDE_ENV_FILE is only available in SessionStart hooks.
 * Writing `export VAR=value` to it persists the variable for the entire session.
 *
 * This makes CC_DICE_SESSION_ID available to:
 * - cc-dice (dice mechanics, cooldown, state)
 * - cc-reflection's session-id.ts getClaudeSessionId()
 * - Any hook or skill that needs the current session UUID
 */

try {
  const input: { session_id?: string } = await Bun.stdin.json();
  const envFile = process.env.CLAUDE_ENV_FILE;
  const sessionId = input.session_id;

  if (envFile && sessionId && /^[A-Za-z0-9-]{1,128}$/.test(sessionId)) {
    const { appendFileSync } = await import("fs");
    // Set both names: AGENT_DICE_SESSION_ID (current) + CC_DICE_SESSION_ID (back-compat,
    // e.g. cc-reflection still reads it).
    appendFileSync(
      envFile,
      `export AGENT_DICE_SESSION_ID="${sessionId}"\nexport CC_DICE_SESSION_ID="${sessionId}"\n`
    );
  }
} catch {
  // Fail silently — don't block session start
}

// Mark this entry script as a module so top-level await type-checks (TS1375).
export {};
