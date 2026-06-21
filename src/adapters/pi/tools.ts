/**
 * Agent-facing tools for Pi — the natural-language config path.
 *
 * Instead of a human typing `/dice register --die 20 …`, the model calls these
 * tools when you describe intent ("nudge me to refactor as the session grows").
 * Params are TypeBox schemas, so the model gets typed/validated arguments and the
 * usual NaN/bogus-enum problems can't reach execute(). The `/dice` command
 * (commands.ts) stays for humans who prefer it.
 */

import { type Static, Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as engine from "../../core/engine";
import { createPiHost, piContext } from "./host";
import { sessionDepth } from "./depth";
import { registerSlot, unregisterSlot, listSlots } from "./store";

// AgentToolResult requires `details`; we have no structured details to attach.
const text = (s: string) => ({ content: [{ type: "text" as const, text: s }], details: null });

const ConfigureParams = Type.Object({
  name: Type.String({ description: "Unique slot id: starts alphanumeric, then [a-zA-Z0-9_-]" }),
  message: Type.String({ description: "Nudge text shown when the slot triggers. Supports {best} {rolls} {diceCount} {slotName}." }),
  type: Type.Optional(
    Type.Union([Type.Literal("accumulator"), Type.Literal("single"), Type.Literal("fixed")], {
      description: "accumulator: probability escalates with conversation depth. single/fixed: flat odds every turn.",
    })
  ),
  die: Type.Optional(Type.Integer({ minimum: 1, description: "Die size (d20 = 20). Default 20." })),
  target: Type.Optional(Type.Integer({ minimum: 1, description: "Winning value; must be <= die. Default 20." })),
  targetMode: Type.Optional(
    Type.Union([Type.Literal("exact"), Type.Literal("gte"), Type.Literal("lte")], { description: "How a roll matches target. Default exact." })
  ),
  accumulationRate: Type.Optional(Type.Integer({ minimum: 1, description: "User messages per +1 die (accumulator). Default 7." })),
  maxDice: Type.Optional(Type.Integer({ minimum: 1, description: "Dice cap (accumulator). Default 100." })),
  fixedCount: Type.Optional(Type.Integer({ minimum: 1, description: "Dice count (fixed type). Default 1." })),
  cooldown: Type.Optional(
    Type.Union([Type.Literal("per-session"), Type.Literal("none")], { description: "per-session: fire at most once per session. Default per-session." })
  ),
  flavor: Type.Optional(Type.Boolean({ description: "Prepend the '🎲 Nat <n>!' prefix to the nudge. Default true." })),
});
type ConfigureInput = Static<typeof ConfigureParams>;

const NoParams = Type.Object({});
type NoInput = Static<typeof NoParams>;

const RemoveParams = Type.Object({ name: Type.String({ description: "Slot id to remove" }) });
type RemoveInput = Static<typeof RemoveParams>;

export function registerDiceTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "configure_dice",
    label: "Configure dice",
    description:
      "Register or update a probabilistic dice trigger ('slot'). On each agent turn the slot rolls; when it hits its target a short nudge is injected. Use type 'accumulator' to make a nudge more likely the longer the conversation runs, or 'single'/'fixed' for flat per-turn odds. Call this when the user asks to be reminded/nudged about something on a chance basis.",
    parameters: ConfigureParams,
    async execute(_id: string, params: ConfigureInput) {
      try {
        const die = params.die ?? 20;
        const target = params.target ?? 20;
        if (target > die) return text(`Error: target ${target} exceeds die size ${die}.`);
        const cfg = registerSlot({
          name: params.name,
          die,
          target,
          targetMode: params.targetMode ?? "exact",
          type: params.type ?? "accumulator",
          accumulationRate: params.accumulationRate ?? 7,
          maxDice: params.maxDice ?? 100,
          fixedCount: params.fixedCount ?? 1,
          cooldown: params.cooldown ?? "per-session",
          flavor: params.flavor ?? true,
          onTrigger: { message: params.message },
        });
        return text(
          `Registered dice slot "${cfg.name}" (${cfg.type}, d${cfg.die}, target ${cfg.target} ${cfg.targetMode}). It will nudge: "${cfg.onTrigger.message}"`
        );
      } catch (err) {
        return text(`Could not configure dice: ${(err as Error).message ?? err}`);
      }
    },
  });

  pi.registerTool({
    name: "list_dice",
    label: "List dice",
    description: "List configured dice slots with their current dice count and trigger probability for this session.",
    parameters: NoParams,
    async execute(_id: string, _params: NoInput, _signal: unknown, _onUpdate: unknown, ctx: ExtensionContext) {
      try {
        const slots = await listSlots();
        if (slots.length === 0) return text("No dice slots configured.");
        const host = createPiHost();
        const cctx = piContext(ctx.sessionManager.getSessionId(), sessionDepth(ctx));
        const lines: string[] = [];
        for (const s of slots) {
          const st = await engine.getSlotStatus(host, s.name, cctx);
          lines.push(`${s.name}: ${s.type} d${s.die} target ${s.target} ${s.targetMode} — ${st?.diceCount ?? 0} dice, ${st?.probability ?? 0}% this turn`);
        }
        return text(lines.join("\n"));
      } catch (err) {
        return text(`Could not list dice: ${(err as Error).message ?? err}`);
      }
    },
  });

  pi.registerTool({
    name: "remove_dice",
    label: "Remove dice",
    description: "Remove a configured dice slot by name.",
    parameters: RemoveParams,
    async execute(_id: string, params: RemoveInput) {
      return text(unregisterSlot(params.name) ? `Removed dice slot "${params.name}".` : `No dice slot named "${params.name}".`);
    },
  });
}
