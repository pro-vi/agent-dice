#!/usr/bin/env bun

/**
 * Codex adapter — builds the DiceHost and resolves the engine's CoreCheckContext
 * from a Codex hook payload. The structural twin of src/adapters/claude-code.ts:
 * Codex's hooks are Claude-compatible (stdin JSON, exit-2/stderr nudge), so the
 * only host-specific pieces are depth resolution (./transcript over the rollout)
 * and locating that rollout. Everything else reuses the Claude file stores — Codex
 * hooks run under Bun, and `getBaseDir()` (src/registry.ts:18) reads
 * `AGENT_DICE_BASE` at call time, so pointing those stores at
 * `${CODEX_HOME:-~/.codex}/dice` needs one guarded env line, not a second store.
 *
 * DEPTH SOURCE (real-Codex correction): the live Codex `Stop` payload does NOT
 * include `transcript_path` (its fields are session_id, cwd, stop_hook_active,
 * last_assistant_message). So an accumulator would forever see depth 0. We instead
 * LOCATE the rollout by session_id — Codex names rollout files
 * `${CODEX_HOME}/sessions/YYYY/MM/DD/rollout-<ts>-<session_id>.jsonl` — and count
 * user turns in it. An explicit transcript_path, if ever present, still wins.
 *
 * Resolution is adapter-only (ADR 0001 D1): the engine never reaches for session
 * id or depth.
 */

import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { CoreCheckContext, DiceHost } from "../../core/contracts";
import { createClaudeHost } from "../claude-code";
import { getProjectHash } from "../../session";
import { countExchanges } from "./transcript";

/** Minimal shape of the fields we read off a Codex hook's stdin payload. */
export interface CodexHookInput {
  session_id?: string;
  transcript_path?: string;
  source?: string;
}

/**
 * Locate the live rollout transcript for a Codex session by its id, since the Stop
 * payload doesn't carry a path. Walks `${CODEX_HOME}/sessions/YYYY/MM/DD` newest
 * first (dir names sort chrono-descending, so the current session is found fast)
 * and returns the first `rollout-*-<sessionId>.jsonl`. Only the hot `.jsonl` (not a
 * cold `.jsonl.zst`) is matched — the active session is always uncompressed.
 * Returns undefined if none is found or the sessions dir is absent.
 */
export function findCodexRollout(sessionId: string): string | undefined {
  const root = join(codexRoot(), "sessions");
  if (!existsSync(root)) return undefined;
  const suffix = `-${sessionId}.jsonl`;
  const dirsDesc = (d: string): string[] => {
    try {
      return readdirSync(d).sort().reverse();
    } catch {
      return [];
    }
  };
  const isDir = (p: string): boolean => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  };
  for (const y of dirsDesc(root)) {
    const yp = join(root, y);
    if (!isDir(yp)) continue;
    for (const m of dirsDesc(yp)) {
      const mp = join(yp, m);
      if (!isDir(mp)) continue;
      for (const dd of dirsDesc(mp)) {
        const dp = join(mp, dd);
        if (!isDir(dp)) continue;
        for (const f of dirsDesc(dp)) {
          if (f.startsWith("rollout-") && f.endsWith(suffix)) return join(dp, f);
        }
      }
    }
  }
  return undefined;
}

/**
 * The single boundary where a Codex hook's untrusted stdin JSON is narrowed to
 * `CodexHookInput`. Every field is optional and every consumer reads defensively,
 * so this assertion never grounds an unsafe dereference — it just gives the two
 * hook entry scripts one shared, documented parse point instead of restating the
 * cast. Throws on absent/malformed stdin; the hooks catch and fail open.
 */
export async function readCodexInput(): Promise<CodexHookInput> {
  return (await Bun.stdin.json()) as CodexHookInput;
}

/**
 * Codex home root. `CODEX_HOME` when set (and non-empty), else `~/.codex`.
 *
 * Uses `||`, NOT `??`, so an empty-string `CODEX_HOME` falls through to the
 * default — matching Bash `${CODEX_HOME:-$HOME/.codex}` in install.sh, so the
 * runtime and installer resolve the same root in every case.
 */
export function codexRoot(): string {
  const raw = process.env.CODEX_HOME || join(homedir(), ".codex");
  // Physically resolve so a symlinked/aliased CODEX_HOME maps to ONE identity —
  // matching the installer's `pwd -P` (canonicalize_codex_root in install.sh), so
  // both sides agree on the store path. Falls back to a lexical-absolute path when
  // the dir doesn't exist yet (realpathSync throws), collapsing "/.", "//", trailing.
  try {
    return realpathSync(raw);
  } catch {
    return resolve(raw);
  }
}

/**
 * Base dir for Codex dice data. A NON-EMPTY `AGENT_DICE_BASE`/`CC_DICE_BASE`
 * override wins (opt-in sharing with another host); otherwise `${codexRoot()}/dice`.
 *
 * Uses `||`, NOT `??`: the reused Claude store (`getBaseDir`, src/registry.ts:18)
 * treats an empty string as "unset" and falls back to `~/.claude/dice`. Selecting
 * with `??` would let `AGENT_DICE_BASE=""` escape into Claude's store — a
 * host-isolation leak — so an empty override must fall through here too.
 */
export function codexBaseDir(): string {
  return process.env.AGENT_DICE_BASE || process.env.CC_DICE_BASE || join(codexRoot(), "dice");
}

/**
 * Point the shared file stores at the Codex base. Override-safe: a non-empty
 * `AGENT_DICE_BASE` is left untouched (explicit sharing); an unset OR EMPTY value
 * is assigned the resolved Codex base — matching codexBaseDir's non-empty
 * selection so `AGENT_DICE_BASE=""` can't leak into Claude's store. Called by
 * `createCodexHost()` so no entry point (hook/CLI) has to repeat the shim.
 */
export function codexBootstrap(): void {
  if (!process.env.AGENT_DICE_BASE) process.env.AGENT_DICE_BASE = codexBaseDir();
}

/**
 * DiceHost for Codex. Establishes the Codex base (Refinement B — the host owns
 * base selection) then returns the Claude file-store host verbatim. The returned
 * value is type-identical to createClaudeHost()'s DiceHost; only the base differs.
 */
export function createCodexHost(): DiceHost {
  codexBootstrap();
  return createClaudeHost();
}

/**
 * Resolve a Codex hook payload into the engine's CoreCheckContext.
 *
 * Session id is eager: `session_id` from the payload (Codex always supplies it for
 * Stop/SessionStart), else the project-hash fallback. Depth is LAZY + memoized via
 * the Codex rollout parser — the transcript is read at most once, and only if the
 * engine actually asks (an active accumulator slot). Resolves to `undefined` when
 * there is no transcript path, so the engine applies its per-op default (0 for
 * accumulator reads / trigger reset, -1 sentinel for manual reset). Do NOT coerce
 * to 0 here.
 */
export function resolveCodexContext(input: CodexHookInput): CoreCheckContext {
  const sessionId = input.session_id ?? getProjectHash();
  let resolved = false;
  let depth: number | undefined;
  return {
    sessionId,
    async getCurrentDepth() {
      if (!resolved) {
        // Explicit transcript_path wins; otherwise locate the rollout by session id
        // (the live Codex Stop payload omits transcript_path). Undefined when no
        // rollout is found → engine applies the per-op default.
        const path = input.transcript_path ?? (input.session_id ? findCodexRollout(input.session_id) : undefined);
        depth = path ? await countExchanges(path) : undefined;
        resolved = true;
      }
      return depth;
    },
  };
}
