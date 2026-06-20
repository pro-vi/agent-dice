/**
 * Claude Code adapter — the default DiceHost.
 *
 * Composes the existing file stores (registry/state/cooldown) and Claude session/
 * transcript resolution into the host the engine consumes. This is the ONLY layer
 * that knows about Claude transcripts and session env vars; the engine never does.
 */

import type { CheckContext } from "../types";
import type { CoreCheckContext, DiceHost } from "../core/contracts";
import { listSlots, getSlot } from "../registry";
import { loadState, saveState, clearState } from "../state";
import { hasCooldown, markTriggered, clearCooldown } from "../cooldown";
import { extractSessionFromPath, getSessionId } from "../session";
import { countExchanges } from "../transcript";

/** Build the Claude Code DiceHost from the existing file-store modules. */
export function createClaudeHost(): DiceHost {
  return {
    listSlots,
    getSlot,
    loadState,
    saveState,
    clearState,
    hasCooldown,
    markTriggered,
    clearCooldown,
    // rng omitted → engine uses Math.random by default.
  };
}

/**
 * Resolve the session id from a Claude CheckContext: explicit id, else extracted
 * from the transcript path, else the env/project-hash fallback. (Was index.ts's
 * resolveSessionId; moved here so resolution is adapter-only, per D1.)
 */
export function resolveSessionId(ctx: CheckContext): string {
  if (ctx.sessionId) return ctx.sessionId;
  if (ctx.transcriptPath) {
    const extracted = extractSessionFromPath(ctx.transcriptPath);
    if (extracted) return extracted;
  }
  return getSessionId();
}

/**
 * Resolve a Claude CheckContext into the engine's CoreCheckContext.
 *
 * Session id is resolved eagerly; depth is resolved LAZILY and memoized — the
 * transcript is parsed at most once, and only if the engine actually asks (an
 * active accumulator slot, a status/reset on an accumulator). Cheap no-op Stop
 * paths (empty registry, all slots cooled, single/fixed-only) never parse it.
 *
 * Depth resolves to `undefined` when there is no transcript — the engine then
 * applies the correct per-operation default (0 for accumulator reads / trigger
 * reset, -1 sentinel for manual resetSlot). Do NOT coerce to 0 here (D7).
 */
export function resolveCoreContext(ctx: CheckContext): CoreCheckContext {
  const sessionId = resolveSessionId(ctx);
  let resolved = false;
  let depth: number | undefined;
  return {
    sessionId,
    async getCurrentDepth() {
      if (!resolved) {
        depth = ctx.transcriptPath ? await countExchanges(ctx.transcriptPath) : undefined;
        resolved = true;
      }
      return depth;
    },
  };
}
