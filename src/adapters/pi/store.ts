/**
 * Pi adapter storage — node:fs implementation of the DiceHost storage primitives.
 *
 * Deliberately uses node:fs (not Bun.*) so it runs under Pi's Node runtime. Mirrors
 * the Claude file-store formats byte-for-byte (slots.json, state/{slot}-{session}.json,
 * state/triggered-{slot}-{session}) so the on-disk contract (R3 / C3) is identical;
 * only the default base differs. Base = CC_DICE_BASE ?? ~/.pi/agent/dice.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { DiceSlotConfig, DiceState } from "../../types";

const SAFE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
// Pi session ids may contain dots (assertValidSessionId, pi session-manager.ts:208):
// start/end alphanumeric, [A-Za-z0-9._-] within. Rejecting dots (review #5) silently
// disabled dice for `pi --session foo.bar`. Still filename-safe: no leading dot, no / or \.
const SAFE_SESSION_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

/** Validate a slot name used in file paths (strict — no dots; mirrors src/registry.ts). */
export function validateName(name: string, label = "name"): void {
  if (!SAFE_NAME_RE.test(name)) {
    throw new Error(`Invalid ${label} "${name}": must start with alphanumeric, contain only [a-zA-Z0-9_-]`);
  }
}

/** Validate a session id, matching Pi's contract (allows dots; rejects path traversal). */
export function validateSessionId(id: string): void {
  if (!SAFE_SESSION_RE.test(id)) {
    throw new Error(`Invalid session ID "${id}": must start/end alphanumeric with [A-Za-z0-9._-] within`);
  }
}

/** Defaults applied on register (mirrors src/registry.ts SLOT_DEFAULTS). */
export const SLOT_DEFAULTS: Partial<DiceSlotConfig> = {
  targetMode: "exact",
  type: "accumulator",
  accumulationRate: 7,
  maxDice: 100,
  fixedCount: 1,
  cooldown: "per-session",
  clearOnSessionStart: true,
  resetOnTrigger: true,
  flavor: true,
};

/** Base dir for cc-dice data under Pi. Default ~/.pi/agent/dice, overridable via CC_DICE_BASE. */
export function getBaseDir(): string {
  const base = process.env.AGENT_DICE_BASE ?? process.env.CC_DICE_BASE; // CC_DICE_BASE: back-compat
  if (base) return base;
  return join(homedir(), ".pi", "agent", "dice");
}

function ensureDir(dir: string): string {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function stateDir(): string {
  return ensureDir(join(getBaseDir(), "state"));
}

function slotsFile(): string {
  return join(ensureDir(getBaseDir()), "slots.json");
}

function readJson<T>(file: string, fallback: T): T {
  try {
    if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    // corrupted — fall back
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export function loadSlots(): Record<string, DiceSlotConfig> {
  return readJson<Record<string, DiceSlotConfig>>(slotsFile(), {});
}

function saveSlots(slots: Record<string, DiceSlotConfig>): void {
  writeFileSync(slotsFile(), JSON.stringify(slots, null, 2));
}

export function registerSlot(
  config: Partial<DiceSlotConfig> & { name: string; die: number; target: number; onTrigger: { message: string } }
): DiceSlotConfig {
  validateName(config.name, "slot name");
  const full = { ...SLOT_DEFAULTS, ...config } as DiceSlotConfig;
  const slots = loadSlots();
  slots[full.name] = full;
  saveSlots(slots);
  return full;
}

export function unregisterSlot(name: string): boolean {
  const slots = loadSlots();
  if (!(name in slots)) return false;
  delete slots[name];
  saveSlots(slots);
  return true;
}

export async function getSlot(name: string): Promise<DiceSlotConfig | null> {
  return loadSlots()[name] ?? null;
}

export async function listSlots(): Promise<DiceSlotConfig[]> {
  return Object.values(loadSlots());
}

// ---------------------------------------------------------------------------
// Per-slot, per-session state
// ---------------------------------------------------------------------------

export function getStateFile(slotName: string, sessionId: string): string {
  validateName(slotName, "slot name");
  validateSessionId(sessionId);
  return join(stateDir(), `${slotName}-${sessionId}.json`);
}

export async function loadState(slotName: string, sessionId: string): Promise<DiceState> {
  return readJson<DiceState>(getStateFile(slotName, sessionId), {
    depth_at_last_trigger: 0,
    last_reset: new Date().toISOString(),
  });
}

export async function saveState(slotName: string, sessionId: string, state: DiceState): Promise<void> {
  writeFileSync(getStateFile(slotName, sessionId), JSON.stringify(state, null, 2));
}

export async function clearState(slotName: string, sessionId: string): Promise<void> {
  await saveState(slotName, sessionId, { depth_at_last_trigger: 0, last_reset: new Date().toISOString() });
}

// ---------------------------------------------------------------------------
// Per-session cooldown markers
// ---------------------------------------------------------------------------

function markerFile(slotName: string, sessionId: string): string {
  validateName(slotName, "slot name");
  validateSessionId(sessionId);
  return join(stateDir(), `triggered-${slotName}-${sessionId}`);
}

export async function hasCooldown(slotName: string, sessionId: string): Promise<boolean> {
  return existsSync(markerFile(slotName, sessionId));
}

export async function markTriggered(slotName: string, sessionId: string): Promise<void> {
  writeFileSync(markerFile(slotName, sessionId), new Date().toISOString());
}

export function clearCooldown(slotName: string, sessionId: string): void {
  const f = markerFile(slotName, sessionId);
  if (existsSync(f)) unlinkSync(f);
}

/** Listing helper for diagnostics/tests. */
export function stateFiles(): string[] {
  const dir = join(getBaseDir(), "state");
  return existsSync(dir) ? readdirSync(dir) : [];
}
