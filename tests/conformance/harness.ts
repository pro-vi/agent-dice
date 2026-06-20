/**
 * Minimal conformance test harness.
 *
 * These are plain modules — NOT *.test.ts — so Bun's native `bun test` runner
 * never auto-discovers them. `tests/conformance/run.ts` is the only entry point;
 * it imports each module's exported `checks` and runs them. (See plan D3.)
 */

import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

export type Check = { name: string; fn: () => void | Promise<void> };

export function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

export function assertEqual<T>(actual: T, expected: T, msg = "values differ"): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg}\n      expected: ${e}\n      actual:   ${a}`);
}

export async function assertThrows(fn: () => unknown, msg = "expected a throw"): Promise<void> {
  let threw = false;
  try {
    await fn();
  } catch {
    threw = true;
  }
  if (!threw) throw new Error(`Assertion failed: ${msg}`);
}

/**
 * Run `fn` with a fresh temp `CC_DICE_BASE`, restoring the prior env afterward.
 * Mirrors the BATS isolation pattern (per-test temp base dir).
 */
export async function withTempBase(fn: (base: string) => void | Promise<void>): Promise<void> {
  const prev = process.env.CC_DICE_BASE;
  const base = mkdtempSync(join(tmpdir(), "cc-dice-conf-"));
  process.env.CC_DICE_BASE = base;
  try {
    await fn(base);
  } finally {
    if (prev === undefined) delete process.env.CC_DICE_BASE;
    else process.env.CC_DICE_BASE = prev;
    try {
      rmSync(base, { recursive: true, force: true });
    } catch {
      // best effort cleanup
    }
  }
}
