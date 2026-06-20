#!/usr/bin/env bun
/**
 * Conformance runner (plan D3): the ONLY entry point for the conformance suite.
 *
 * Auto-discovers every `*.conformance.ts` module in this directory, imports it,
 * and runs its exported `checks`. Exits non-zero on any failure. Invoked by
 * `bun run test` (via a BATS case) — NOT by bare `bun test` (Bun's native runner
 * ignores `*.conformance.ts`, which is exactly why that suffix is used).
 */

import { readdirSync } from "fs";
import { join } from "path";
import type { Check } from "./harness";

const dir = import.meta.dir;
const files = readdirSync(dir)
  .filter((f) => f.endsWith(".conformance.ts"))
  .sort();

let passed = 0;
let failed = 0;
const failures: string[] = [];

for (const file of files) {
  const mod = (await import(join(dir, file))) as { checks?: Check[] };
  const suite = file.replace(/\.conformance\.ts$/, "");
  if (!Array.isArray(mod.checks)) continue;
  for (const check of mod.checks) {
    try {
      await check.fn();
      passed++;
    } catch (err) {
      failed++;
      failures.push(`✗ [${suite}] ${check.name}\n    ${(err as Error).message}`);
    }
  }
}

console.log(`conformance: ${passed} passed, ${failed} failed (${files.length} suites)`);
if (failed > 0) {
  console.error(`\n${failures.join("\n\n")}`);
  process.exit(1);
}
process.exit(0);
