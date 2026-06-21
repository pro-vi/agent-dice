#!/usr/bin/env bun

/**
 * agent-dice CLI entrypoint (also available as the `cc-dice` alias)
 *
 * Usage: agent-dice <command> [options]
 *
 * Slot Management:
 *   register <name> [options]    Register a dice slot
 *   unregister <name>            Remove a slot
 *   list                         List all registered slots
 *
 * Per-Slot Operations:
 *   status <name>                Show current dice status
 *   roll <name>                  Roll without state change (dry run)
 *   reset <name>                 Reset accumulator
 *   clear <name>                 Clear state
 *
 * Session:
 */

import {
  registerSlot,
  unregisterSlot,
  listSlots,
  getSlot,
  getSlotStatus,
  resetSlot,
  clearSlot,
  previewSlot,
  getTranscriptPath,
} from "../src/index";
import type { CheckContext } from "../src/types";

const args = process.argv.slice(2);
const command = args[0];

function printUsage(): void {
  console.log(`Usage: agent-dice <command> [options]

Slot Management:
  register <name> [options]    Register a dice slot
  unregister <name>            Remove a slot
  list                         List all registered slots

Per-Slot Operations:
  status <name>                Show current dice status
  roll <name>                  Roll without state change (dry run)
  reset <name>                 Reset accumulator
  clear <name>                 Clear state

Register Options:
  --die <n>                    Die size (default: 20)
  --target <n>                 Target number (default: 20)
  --target-mode <mode>         exact|gte|lte (default: exact)
  --type <type>                accumulator|fixed|single (default: accumulator)
  --accumulation-rate <n>      Turns per +1 die (default: 7)
  --max-dice <n>               Max dice cap (default: 100)
  --fixed-count <n>            Dice count for fixed type (default: 1)
  --cooldown <mode>            per-session|none (default: per-session)
  --no-clear-on-start          Don't clear on session start
  --no-reset-on-trigger        Don't reset accumulator on trigger
  --no-flavor                  Don't prepend dice emoji + roll lingo
  --message <msg>              Trigger message for stderr`);
}

function parseArg(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  return undefined;
}

function hasFlag(flag: string): boolean {
  return args.includes(flag);
}

function buildContext(): CheckContext {
  const transcriptPath = getTranscriptPath() ?? undefined;
  return { transcriptPath };
}

async function main(): Promise<void> {
  if (!command || command === "help" || command === "--help" || command === "-h") {
    printUsage();
    process.exit(0);
  }

  switch (command) {
    case "register": {
      const name = args[1];
      if (!name) {
        console.error("Error: slot name required");
        process.exit(1);
      }

      const die = Number(parseArg("--die") ?? "20");
      const target = Number(parseArg("--target") ?? "20");
      const targetMode = (parseArg("--target-mode") ?? "exact") as "exact" | "gte" | "lte";
      const type = (parseArg("--type") ?? "accumulator") as "accumulator" | "fixed" | "single";
      const accumulationRate = Number(parseArg("--accumulation-rate") ?? "7");
      const maxDice = Number(parseArg("--max-dice") ?? "100");
      const fixedCount = Number(parseArg("--fixed-count") ?? "1");
      const cooldown = (parseArg("--cooldown") ?? "per-session") as "per-session" | "none";
      const clearOnSessionStart = !hasFlag("--no-clear-on-start");
      const resetOnTrigger = !hasFlag("--no-reset-on-trigger");
      const flavor = !hasFlag("--no-flavor");
      const message = parseArg("--message") ?? `Dice trigger: ${name}`;

      const config = await registerSlot({
        name,
        die,
        target,
        targetMode,
        type,
        accumulationRate,
        maxDice,
        fixedCount,
        cooldown,
        clearOnSessionStart,
        resetOnTrigger,
        flavor,
        onTrigger: { message },
      });

      console.log(`Registered: ${config.name} (${config.type}, d${config.die}, target=${config.target} ${config.targetMode})`);
      break;
    }

    case "unregister": {
      const name = args[1];
      if (!name) {
        console.error("Error: slot name required");
        process.exit(1);
      }
      const removed = await unregisterSlot(name);
      if (removed) {
        console.log(`Removed slot: ${name}`);
      } else {
        console.error(`Slot not found: ${name}`);
        process.exit(1);
      }
      break;
    }

    case "list": {
      const slots = await listSlots();
      if (slots.length === 0) {
        console.log("No slots registered.");
      } else {
        for (const slot of slots) {
          console.log(`  ${slot.name} (${slot.type}, ${slot.die}-sided, target=${slot.target} ${slot.targetMode})`);
        }
      }
      break;
    }

    case "status": {
      const name = args[1];
      if (!name) {
        console.error("Error: slot name required");
        process.exit(1);
      }
      const ctx = buildContext();
      const status = await getSlotStatus(name, ctx);
      if (!status) {
        console.error(`Slot not found: ${name}`);
        process.exit(1);
      }
      console.log(`Slot: ${status.name} (${status.type})`);
      console.log(`  Dice count:      ${status.diceCount}`);
      console.log(`  Current depth:   ${status.currentDepth}`);
      console.log(`  Since trigger:   ${status.depthSinceTrigger}`);
      console.log(`  Probability:     ${status.probability}%`);
      if (status.type === "accumulator") {
        console.log(`  Next die at:     depth ${status.nextDiceAt}`);
      }
      break;
    }

    case "roll": {
      const name = args[1];
      if (!name) {
        console.error("Error: slot name required");
        process.exit(1);
      }
      const config = await getSlot(name);
      if (!config) {
        console.error(`Slot not found: ${name}`);
        process.exit(1);
      }
      const ctx = buildContext();
      const status = await getSlotStatus(name, ctx);
      if (!status) {
        process.exit(1);
        return; // unreachable, satisfies TS
      }
      const diceCount = status.diceCount;
      if (diceCount <= 0) {
        console.log(`${name}: 0 dice (no roll)`);
        break;
      }
      // Dry-run preview via the engine (no shared pool, no side effects) — D8.
      const preview = previewSlot(config, diceCount);
      console.log(`${name}: ${diceCount}d${config.die} = [${preview.rolls.join(", ")}] (best: ${preview.best}, ${preview.probability}%)${preview.triggered ? " TRIGGERED!" : ""}`);
      break;
    }

    case "reset": {
      const name = args[1];
      if (!name) {
        console.error("Error: slot name required");
        process.exit(1);
      }
      if (!(await getSlot(name))) {
        console.error(`Slot not found: ${name}`);
        process.exit(1);
      }
      const ctx = buildContext();
      await resetSlot(name, ctx);
      console.log(`Reset slot: ${name}`);
      break;
    }

    case "clear": {
      const name = args[1];
      if (!name) {
        console.error("Error: slot name required");
        process.exit(1);
      }
      if (!(await getSlot(name))) {
        console.error(`Slot not found: ${name}`);
        process.exit(1);
      }
      const ctx = buildContext();
      await clearSlot(name, ctx);
      console.log(`Cleared slot: ${name}`);
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      printUsage();
      process.exit(1);
  }
}

main().catch((error) => {
  console.error(`Error: ${error.message ?? error}`);
  if (process.env.DEBUG === "1") {
    console.error(error);
  }
  process.exit(1);
});
