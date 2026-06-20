/**
 * C8: Core boundary conformance (import-graph closure check).
 *
 * Per plan D4 this is an import-graph walk, not a raw token grep: it parses
 * import/export-from/dynamic/side-effect specifiers, follows relative imports
 * transitively, and matches forbidden host modules by resolved path (so
 * `sessionId` does not trip the `session` rule). Hardened per review finding #4:
 *   - side-effect imports (`import "../state"`) are detected;
 *   - builtin subpaths (`node:fs/promises`) normalize to their root (`fs`);
 *   - the host-global token scan (Bun / process.env) runs over EVERY module in the
 *     closure, not just files authored under src/core (catches transitive leaks);
 *   - the analyzer is pure (driven by a source-reader) so negative fixtures can
 *     prove it actually catches violations.
 *
 * src/roll.ts is allowed (pure; its Math.random is replaced by injected rng).
 * Until src/core/** exists the closure is empty and this passes vacuously.
 */

import { type Check, assert } from "./harness";
import { readdirSync, existsSync, readFileSync, statSync } from "fs";
import { join, dirname, resolve, relative } from "path";

const SRC = resolve(import.meta.dir, "../../src");
const CORE = join(SRC, "core");

const FORBIDDEN_MODULES = ["transcript", "session", "hook-helpers", "registry", "state", "cooldown"];
const FORBIDDEN_BUILTINS = new Set(["fs", "path", "os", "crypto", "child_process", "process", "net", "http", "https"]);
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

/** Strip comments so token rules and import extraction match code, not prose. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/**
 * All module specifiers: `import/export ... from "x"`, dynamic `import("x")`, and
 * bare side-effect `import "x"`. The side-effect form (finding #4) has no `from`.
 */
function importSpecifiers(src: string): string[] {
  const specs: string[] = [];
  const fromRe = /(?:import|export)\b[^"';]*?\bfrom\s*["']([^"']+)["']/g;
  const dynRe = /import\s*\(\s*["']([^"']+)["']\s*\)/g;
  const sideRe = /import\s*["']([^"']+)["']\s*;?/g;
  for (const re of [fromRe, dynRe, sideRe]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) specs.push(m[1]);
  }
  return specs;
}

/** Pure resolver: relative specifier → absolute .ts path (no index.ts dirs in core). */
function resolveRelative(fromFile: string, spec: string): string {
  const p = resolve(dirname(fromFile), spec);
  return p.endsWith(".ts") ? p : `${p}.ts`;
}

/**
 * Pure boundary analyzer over a source-reader. `srcRoot` defines where the
 * forbidden host modules live, so synthetic fixtures can reuse it.
 */
export function analyze(
  srcRoot: string,
  entryFiles: string[],
  readSource: (abs: string) => string | null
): string[] {
  const forbiddenPaths = new Set(FORBIDDEN_MODULES.map((m) => join(srcRoot, `${m}.ts`)));
  const rel = (p: string) => relative(srcRoot, p);
  const problems: string[] = [];
  const seen = new Set<string>();
  const queue = entryFiles.map((f) => resolve(f));

  while (queue.length) {
    const file = resolve(queue.shift()!);
    if (seen.has(file)) continue;
    seen.add(file);
    const raw = readSource(file);
    if (raw == null) continue;
    const src = stripComments(raw);

    // Host-global token scan over EVERY reached module (transitive leaks too).
    for (const [re, label] of FORBIDDEN_TOKENS) {
      if (re.test(src)) problems.push(`${rel(file)} references ${label}`);
    }

    for (const spec of importSpecifiers(src)) {
      if (spec.startsWith(".")) {
        const resolved = resolveRelative(file, spec);
        if (forbiddenPaths.has(resolved)) {
          problems.push(`${rel(file)} reaches forbidden host module "${spec}" (${rel(resolved)})`);
        }
        queue.push(resolved); // follow transitively
      } else {
        const root = spec.replace(/^node:/, "").split("/")[0]; // node:fs/promises → fs
        if (FORBIDDEN_BUILTINS.has(root)) {
          problems.push(`${rel(file)} imports forbidden builtin "${spec}"`);
        }
      }
    }
  }
  return problems;
}

const realReader = (abs: string): string | null => (existsSync(abs) ? readFileSync(abs, "utf8") : null);

export const checks: Check[] = [
  {
    name: "C8: src/core/** import graph reaches no host module, node builtin, or host global",
    fn: () => {
      const problems = analyze(SRC, listTs(CORE), realReader);
      assert(problems.length === 0, `core boundary violations:\n      - ${problems.join("\n      - ")}`);
    },
  },
  {
    name: "C8 self-test: analyzer catches side-effect import, builtin subpath, and transitive host global (negative fixtures)",
    fn: () => {
      const root = resolve("/virt/src");
      const files: Record<string, string> = {
        [join(root, "core/side_effect.ts")]: `import "../state";\nexport const a = 1;`,
        [join(root, "core/builtin_subpath.ts")]: `import { readFile } from "node:fs/promises";\nexport const b = readFile;`,
        [join(root, "core/via_helper.ts")]: `import { h } from "../helper";\nexport const c = h;`,
        [join(root, "helper.ts")]: `export const h = process.env.LEAK;`,
        [join(root, "core/clean.ts")]: `import type { X } from "../types";\nimport { roll } from "../roll";\nexport const ok: X = roll;`,
        [join(root, "types.ts")]: `export type X = unknown;`,
        [join(root, "roll.ts")]: `export const roll = () => Math.random();`,
        [join(root, "state.ts")]: `export const s = 1;`,
      };
      const reader = (abs: string): string | null => files[abs] ?? null;
      const entries = Object.keys(files).filter((p) => p.includes("/core/"));
      const problems = analyze(root, entries, reader);
      const joined = problems.join("\n");

      assert(/side_effect\.ts reaches forbidden host module "\.\.\/state"/.test(joined), "side-effect import of a host module is caught");
      assert(/builtin_subpath\.ts imports forbidden builtin "node:fs\/promises"/.test(joined), "builtin subpath is caught");
      assert(/helper\.ts references process\.env/.test(joined), "transitive host global in a non-core helper is caught");
      assert(!/clean\.ts/.test(joined), "clean core file (types + roll) is NOT flagged");
    },
  },
];
