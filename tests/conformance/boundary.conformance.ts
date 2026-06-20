/**
 * C8: Core boundary conformance (import-graph closure check).
 *
 * Per plan D4, this is NOT a raw token grep. It parses import/export-from/dynamic
 * specifiers, follows relative imports transitively, and fails if any module
 * reachable from src/core/** resolves to a forbidden host module or node builtin.
 * Matching is by resolved module path (not substring), so `sessionId` does not
 * trip the `session` rule and a leak hidden behind a "clean" local module is still
 * caught. src/roll.ts is allowed (pure; its Math.random is replaced by injected rng).
 *
 * Until src/core/** exists (pre-U4) the closure is empty and this passes vacuously.
 */

import { type Check, assert } from "./harness";
import { readdirSync, existsSync, readFileSync, statSync } from "fs";
import { join, dirname, resolve, relative } from "path";

const SRC = resolve(import.meta.dir, "../../src");
const CORE = join(SRC, "core");

// Top-level src modules the core must never reach.
const FORBIDDEN_MODULES = ["transcript", "session", "hook-helpers", "registry", "state", "cooldown"];
const FORBIDDEN_MODULE_PATHS = new Set(FORBIDDEN_MODULES.map((m) => join(SRC, `${m}.ts`)));
// Node builtins that would make core non-portable / host-coupled.
const FORBIDDEN_BUILTINS = new Set(["fs", "path", "os", "crypto", "child_process", "process"]);
// Host-coupled globals that imports alone won't reveal.
const FORBIDDEN_TOKENS: Array<[RegExp, string]> = [
  [/\bBun\b/, "Bun global"],
  [/process\s*\.\s*env/, "process.env"],
];

function listTs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listTs(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

/**
 * Strip comments so token rules (Bun, process.env) and import extraction match
 * real code, not prose. This is the comment-side of the D4 false-positive fix:
 * a doc-comment naming a forbidden token must not trip the check.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1"); // line comments (':' guard skips URLs)
}

function importSpecifiers(src: string): string[] {
  const specs: string[] = [];
  const re =
    /(?:import|export)\b[^"';]*?\bfrom\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) specs.push(m[1] ?? m[2]);
  return specs;
}

function resolveRelative(fromFile: string, spec: string): string {
  const p = resolve(dirname(fromFile), spec);
  if (p.endsWith(".ts")) return p;
  if (existsSync(`${p}.ts`)) return `${p}.ts`;
  if (existsSync(join(p, "index.ts"))) return join(p, "index.ts");
  return `${p}.ts`;
}

function rel(p: string): string {
  return relative(SRC, p);
}

function findViolations(): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  const coreFiles = new Set(listTs(CORE).map((f) => resolve(f)));
  const queue = [...coreFiles];

  while (queue.length) {
    const file = resolve(queue.shift()!);
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    const src = stripComments(readFileSync(file, "utf8"));

    // Token scan applies to files authored under src/core (their own surface).
    if (coreFiles.has(file)) {
      for (const [re, label] of FORBIDDEN_TOKENS) {
        if (re.test(src)) problems.push(`${rel(file)} references ${label}`);
      }
    }

    for (const spec of importSpecifiers(src)) {
      if (spec.startsWith(".")) {
        const resolved = resolveRelative(file, spec);
        if (FORBIDDEN_MODULE_PATHS.has(resolved)) {
          problems.push(`${rel(file)} reaches forbidden host module "${spec}" (${rel(resolved)})`);
        }
        queue.push(resolved); // follow transitively
      } else {
        const bare = spec.replace(/^node:/, "");
        if (FORBIDDEN_BUILTINS.has(bare)) {
          problems.push(`${rel(file)} imports forbidden builtin "${spec}"`);
        }
      }
    }
  }
  return problems;
}

export const checks: Check[] = [
  {
    name: "C8: src/core/** import graph reaches no host module, node builtin, or host global",
    fn: () => {
      const problems = findViolations();
      assert(problems.length === 0, `core boundary violations:\n      - ${problems.join("\n      - ")}`);
    },
  },
];
