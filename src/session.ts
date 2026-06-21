#!/usr/bin/env bun

/**
 * Session ID resolution for Claude Code
 *
 * Resolves the current session identity for state namespacing.
 * Supports multiple resolution strategies with env var overrides.
 */

import { createHash } from "crypto";

/**
 * Get the project hash for the current directory.
 * Used as fallback session identity when no Claude UUID is available.
 *
 * CRITICAL: Use PWD env var (logical path) instead of process.cwd() (physical path)
 * On macOS, /tmp -> /private/tmp causes hash mismatch.
 */
export function getProjectHash(): string {
  const cwd = process.env.PWD || process.cwd();
  return createHash("md5").update(cwd).digest("hex").substring(0, 12);
}

/**
 * Get Claude Code session UUID if available
 *
 * Resolution order:
 * 1. CC_DICE_SESSION_ID env var (set by session-start hook)
 * 2. null (no UUID available)
 */
export function getClaudeSessionId(): string | null {
  // AGENT_DICE_SESSION_ID is current; CC_DICE_SESSION_ID kept for back-compat (e.g. cc-reflection).
  return process.env.AGENT_DICE_SESSION_ID ?? process.env.CC_DICE_SESSION_ID ?? null;
}

/**
 * Extract session ID from a transcript path
 * Transcript path format: ~/.claude/projects/<slug>/<session-id>.jsonl
 */
export function extractSessionFromPath(transcriptPath: string): string | undefined {
  const match = transcriptPath.match(/([a-f0-9-]+)\.jsonl$/);
  return match?.[1];
}

/**
 * Get session ID for current context.
 *
 * Priority:
 * 1. CC_DICE_SESSION_ID env var
 * 2. Project hash (12-char MD5 of directory)
 */
export function getSessionId(): string {
  const claudeSessionId = getClaudeSessionId();
  if (claudeSessionId) return claudeSessionId;
  return getProjectHash();
}

// CLI interface for debugging
if (import.meta.main) {
  const sessionId = getSessionId();
  console.log(sessionId);

  if (process.env.DEBUG === "1") {
    console.error(`[DEBUG] Session ID: ${sessionId}`);
    console.error(`[DEBUG] CC_DICE_SESSION_ID: ${process.env.CC_DICE_SESSION_ID || "<not set>"}`);
    console.error(`[DEBUG] Project hash: ${getProjectHash()}`);

    console.error(`[DEBUG] PWD: ${process.env.PWD || process.cwd()}`);
  }
}
