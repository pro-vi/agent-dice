#!/usr/bin/env bun

/**
 * Codex Stop hook for agent-dice (≈ Claude's Stop hook).
 *
 * Codex fires `Stop` when a turn ends, handing the hook a Claude-compatible JSON
 * payload on stdin (`session_id`, `transcript_path`, …). We roll all slots and,
 * on a trigger, write the nudge to stderr and exit 2 — Codex re-injects that text
 * to the model, exactly like Claude. No trigger → exit 0 (silent).
 *
 * Registered by `install.sh codex` in `${CODEX_HOME:-~/.codex}/hooks.json`.
 *
 * Statically imports the matching source version (the installer symlinks this repo
 * under $CODEX_ROOT/dice, and ESM resolves `../src/**` against the real path), so —
 * unlike hooks/stop.ts, which dynamically imports a possibly version-skewed
 * INSTALLED module — there is no version-skew fallback to guard against.
 */

import * as engine from "../src/core/engine";
import { createCodexHost, resolveCodexContext, type CodexHookInput } from "../src/adapters/codex/host";
import { renderTrigger } from "../src/adapters/claude-renderer";

async function main(): Promise<void> {
  try {
    const input = (await Bun.stdin.json()) as CodexHookInput;

    // createCodexHost() points the file stores at the Codex base BEFORE any
    // registry/state read, so listSlots + the engine both see ~/.codex/dice.
    const host = createCodexHost();
    const ctx = resolveCodexContext(input);

    const slots = await host.listSlots();
    const slotMap = new Map(slots.map((s) => [s.name, s]));
    const results = await engine.checkAllSlots(host, ctx);

    const triggered: string[] = [];
    for (const result of results) {
      const slot = slotMap.get(result.slotName);
      if (!slot) continue;
      if (result.triggered) {
        triggered.push(renderTrigger(result, slot));
      } else if (result.diceCount > 0 && process.env.DEBUG === "1") {
        // Non-trigger rolls go to stderr under DEBUG only. Unlike Claude (where a
        // Stop hook's exit-0 stdout is harmless user-visible text), Codex PARSES a
        // Stop hook's stdout as JSON (stop.command.output.schema.json), so stdout is
        // kept clean — a non-trigger Stop is silent (exit 0, no output).
        console.error(`${slot.name}: ${result.diceCount}d${slot.die} = [${result.rolls.join(", ")}] (best: ${result.best})`);
      }
    }

    if (triggered.length > 0) {
      console.error(triggered.join("\n"));
      process.exit(2); // Codex re-injects stderr to the model
    }
    process.exit(0);
  } catch (error) {
    if (process.env.DEBUG === "1") console.error("agent-dice codex-stop hook error:", error);
    process.exit(0); // fail-open — never block Codex
  }
}

main();

// Mark this entry script as a module so top-level constructs type-check (TS1375).
export {};
