/**
 * C9: Public docs conformance.
 *
 * Docs must describe cc-dice as the Claude facade over a reusable core, and must
 * NOT claim a Pi (or other) adapter ships now. Kept structural (does the doc say
 * the right things) rather than a brittle exact-string match.
 */

import { type Check, assert } from "./harness";
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..", "..");
const read = (p: string): string => readFileSync(join(ROOT, p), "utf8");

export const checks: Check[] = [
  {
    name: "C9: architecture.md documents the core + adapters structure",
    fn: () => {
      const arch = read("docs/architecture.md");
      for (const needle of ["src/core", "src/adapters", "adapter", "facade"]) {
        assert(arch.includes(needle), `architecture.md should mention "${needle}"`);
      }
      const lower = arch.toLowerCase();
      assert(lower.includes("reusable") && lower.includes("core"), "architecture.md should describe a reusable core");
    },
  },
  {
    name: "C9: README frames cc-dice as a facade over a reusable core",
    fn: () => {
      const readme = read("README.md").toLowerCase();
      assert(readme.includes("facade"), "README should call cc-dice a facade");
      assert(readme.includes("reusable") && readme.includes("core"), "README should mention a reusable core");
    },
  },
  {
    name: "C9: no doc claims a Pi (or other) adapter ships now",
    fn: () => {
      // A positive ship-claim word on a line that mentions Pi, with no negating/
      // future qualifier on that same line, is an overclaim. Negation-aware so
      // "Pi ... is future work — not shipped" is correctly allowed.
      const positive = /\b(ships now|shipped|available now|supported|implemented)\b/i;
      const negated = /\b(not|no|never|future|deferred|planned|yet|would|could|only|today)\b/i;
      const futureQualifier = /future|not yet|deferred|planned|not shipped|only one that ships|only shipped|only adapter|could (later )?implement/i;

      for (const p of ["README.md", "docs/architecture.md", "CLAUDE.md"]) {
        const text = read(p);
        for (const line of text.split("\n")) {
          if (/\bPi\b/.test(line) && positive.test(line) && !negated.test(line)) {
            throw new Error(`${p} claims Pi ships now: "${line.trim()}"`);
          }
        }
        if (/\bPi\b/.test(text)) {
          assert(futureQualifier.test(text), `${p} mentions Pi but must mark it as future/not-shipped`);
        }
      }
    },
  },
];
