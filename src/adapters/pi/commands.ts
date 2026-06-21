/**
 * `/dice` slash command for Pi — the config UX (mirrors the cc-dice CLI surface):
 *   /dice register <name> [flags] | list | status <name> | roll <name> | reset <name> | clear <name>
 *
 * Delegates to the node:fs store + the engine. Output goes through ctx.ui.notify.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as engine from "../../core/engine";
import { createPiHost, piContext } from "./host";
import { registerSlot, unregisterSlot, getSlot, listSlots } from "./store";

/** Tokenize a command arg string, honoring double-quotes (for --message "..."). */
function tokenize(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push(m[1] ?? m[2]);
  return out;
}

function flagVal(tokens: string[], flag: string): string | undefined {
  const i = tokens.indexOf(flag);
  return i >= 0 && i + 1 < tokens.length ? tokens[i + 1] : undefined;
}
const hasFlag = (tokens: string[], flag: string): boolean => tokens.includes(flag);

const USAGE = [
  "/dice register <name> [--die N --target N --target-mode exact|gte|lte --type accumulator|fixed|single",
  "                       --accumulation-rate N --max-dice N --fixed-count N --cooldown per-session|none",
  "                       --no-clear-on-start --no-reset-on-trigger --no-flavor --message \"...\"]",
  "/dice list | status <name> | roll <name> | reset <name> | clear <name>",
].join("\n");

/** Register the `/dice` command. `getDepth` returns the cached turn depth for status/roll. */
export function registerDiceCommands(pi: ExtensionAPI, getDepth: () => number | undefined): void {
  pi.registerCommand("dice", {
    description: "cc-dice — probabilistic dice triggers",
    handler: async (args, ctx) => {
      const host = createPiHost();
      const sessionId = ctx.sessionManager.getSessionId();
      const cctx = () => piContext(sessionId, getDepth());
      const t = tokenize(args);
      const sub = (t[0] ?? "help").toLowerCase();
      const name = t[1];
      const notify = (text: string, type: "info" | "warning" | "error" = "info") => ctx.ui.notify(text, type);
      // Returns the validated name (narrowed to string) or null after notifying.
      const requireName = (): string | null => {
        if (!name) {
          notify("Error: slot name required", "error");
          return null;
        }
        return name;
      };

      try {
        switch (sub) {
          case "register": {
            const slotName = requireName();
            if (!slotName) return;
            const cfg = registerSlot({
              name: slotName,
              die: Number(flagVal(t, "--die") ?? "20"),
              target: Number(flagVal(t, "--target") ?? "20"),
              targetMode: (flagVal(t, "--target-mode") ?? "exact") as "exact" | "gte" | "lte",
              type: (flagVal(t, "--type") ?? "accumulator") as "accumulator" | "fixed" | "single",
              accumulationRate: Number(flagVal(t, "--accumulation-rate") ?? "7"),
              maxDice: Number(flagVal(t, "--max-dice") ?? "100"),
              fixedCount: Number(flagVal(t, "--fixed-count") ?? "1"),
              cooldown: (flagVal(t, "--cooldown") ?? "per-session") as "per-session" | "none",
              clearOnSessionStart: !hasFlag(t, "--no-clear-on-start"),
              resetOnTrigger: !hasFlag(t, "--no-reset-on-trigger"),
              flavor: !hasFlag(t, "--no-flavor"),
              onTrigger: { message: flagVal(t, "--message") ?? `Dice trigger: ${name}` },
            });
            notify(`Registered: ${cfg.name} (${cfg.type}, d${cfg.die}, target=${cfg.target} ${cfg.targetMode})`);
            return;
          }
          case "list": {
            const slots = await listSlots();
            notify(
              slots.length === 0
                ? "No slots registered."
                : slots.map((s) => `  ${s.name} (${s.type}, ${s.die}-sided, target=${s.target} ${s.targetMode})`).join("\n")
            );
            return;
          }
          case "status": {
            const slotName = requireName();
            if (!slotName) return;
            const status = await engine.getSlotStatus(host, slotName, cctx());
            if (!status) {
              notify(`Slot not found: ${slotName}`, "error");
              return;
            }
            const lines = [
              `Slot: ${status.name} (${status.type})`,
              `  Dice count:    ${status.diceCount}`,
              `  Current depth: ${status.currentDepth}`,
              `  Since trigger: ${status.depthSinceTrigger}`,
              `  Probability:   ${status.probability}%`,
            ];
            if (status.type === "accumulator") lines.push(`  Next die at:   depth ${status.nextDiceAt}`);
            notify(lines.join("\n"));
            return;
          }
          case "roll": {
            const slotName = requireName();
            if (!slotName) return;
            const config = await getSlot(slotName);
            if (!config) {
              notify(`Slot not found: ${slotName}`, "error");
              return;
            }
            const status = await engine.getSlotStatus(host, slotName, cctx());
            const diceCount = status?.diceCount ?? 0;
            if (diceCount <= 0) {
              notify(`${slotName}: 0 dice (no roll)`);
              return;
            }
            const preview = engine.previewSlot(config, diceCount);
            notify(
              `${slotName}: ${diceCount}d${config.die} = [${preview.rolls.join(", ")}] (best: ${preview.best}, ${preview.probability}%)${preview.triggered ? " TRIGGERED!" : ""}`
            );
            return;
          }
          case "reset":
          case "clear": {
            const slotName = requireName();
            if (!slotName) return;
            if (!(await getSlot(slotName))) {
              notify(`Slot not found: ${slotName}`, "error");
              return;
            }
            if (sub === "reset") {
              await engine.resetSlot(host, slotName, cctx());
              notify(`Reset slot: ${slotName}`);
            } else {
              await engine.clearSlot(host, slotName, cctx());
              notify(`Cleared slot: ${slotName}`);
            }
            return;
          }
          case "unregister": {
            const slotName = requireName();
            if (!slotName) return;
            const removed = unregisterSlot(slotName);
            notify(removed ? `Removed slot: ${slotName}` : `Slot not found: ${slotName}`, removed ? "info" : "error");
            return;
          }
          default:
            notify(USAGE);
            return;
        }
      } catch (err) {
        notify(`cc-dice error: ${(err as Error).message ?? err}`, "error");
      }
    },
  });
}
