#!/usr/bin/env bun

/**
 * Generic stop hook for cc-dice
 *
 * Reads all registered slots, checks each one.
 * On trigger: stderr + exit 2 (shows to Claude, continues conversation)
 * No trigger: stdout + exit 0 (shows to user only)
 *
 * Installation:
 * 1. Symlink to ~/.claude/hooks/dice-stop.ts
 * 2. Register in settings.json Stop hook
 */

// Import from installed location or relative
let mod: typeof import("../src/index");
try {
  const homeDir = process.env.HOME || "";
  // Try installed location first
  mod = await import(`${homeDir}/.claude/dice/cc-dice.ts`);
} catch {
  // Fall back to relative import (development)
  mod = await import("../src/index");
}

const { listSlots, checkAllSlots, parseStopHookInput } = mod;

// Local fallback renderer. The hook dynamically imports the *installed* module,
// which may be version-skewed and predate the exported renderTrigger. Without a
// fallback, calling an undefined renderTrigger would throw and fail-open (exit 0),
// silently dropping a trigger AFTER its reset/cooldown side effects already ran
// (review finding #2). Prefer the shared renderer when present; fall back otherwise.
function localRenderTrigger(result: any, slot: any): string {
  const msg = String(slot.onTrigger.message)
    .replace("{rolls}", result.rolls.join(", "))
    .replace("{best}", String(result.best))
    .replace("{diceCount}", String(result.diceCount))
    .replace("{slotName}", result.slotName);
  return slot.flavor !== false ? `🎲 Nat ${result.best}! ${msg}` : msg;
}
const renderTrigger =
  typeof (mod as any).renderTrigger === "function" ? (mod as any).renderTrigger : localRenderTrigger;

async function main() {
  try {
    const input = await parseStopHookInput();

    const ctx = {
      transcriptPath: input.transcript_path,
      sessionId: input.session_id,
    };

    const slots = await listSlots();
    const slotMap = new Map(slots.map((s: any) => [s.name, s]));
    const results = await checkAllSlots(ctx);
    const triggered: string[] = [];

    for (const result of results) {
      const slot = slotMap.get(result.slotName);
      if (!slot) continue;

      if (result.triggered) {
        triggered.push(renderTrigger(result, slot));
      } else if (result.diceCount > 0) {
        // Log non-trigger rolls (visible to user only via stdout)
        console.log(
          `${slot.name}: ${result.diceCount}d${slot.die} = [${result.rolls.join(", ")}] (best: ${result.best})`
        );
      }
    }

    if (triggered.length > 0) {
      console.error(triggered.join("\n"));
      process.exit(2);
    }

    process.exit(0);
  } catch (error) {
    if (process.env.DEBUG === "1") {
      console.error("cc-dice stop hook error:", error);
    }
    process.exit(0); // fail gracefully - never block Claude Code
  }
}

main();

// Mark this entry script as a module so top-level await type-checks (TS1375).
export {};
