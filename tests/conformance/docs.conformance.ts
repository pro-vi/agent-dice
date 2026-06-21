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
    name: "C9: architecture.md documents the core + adapters structure (incl. the Pi adapter)",
    fn: () => {
      const arch = read("docs/architecture.md");
      for (const needle of ["src/core", "src/adapters", "adapter", "facade"]) {
        assert(arch.includes(needle), `architecture.md should mention "${needle}"`);
      }
      const lower = arch.toLowerCase();
      assert(lower.includes("reusable") && lower.includes("core"), "architecture.md should describe a reusable core");
      assert(lower.includes("pi"), "architecture.md should document the Pi adapter (a second host now ships)");
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
    name: "C9: Pi is a shipped adapter; no doc claims a Codex adapter ships (it's researched, not built)",
    fn: () => {
      // Pi now ships, so claiming "Pi is supported" is correct. The live overclaim
      // risk is Codex: a positive ship-claim on a line mentioning codex, with no
      // negating/future qualifier on that line, is an overclaim (negation-aware).
      const positive = /\b(ships|shipped|available now|supported|implemented)\b/i;
      const negated = /\b(not|no|never|future|deferred|planned|yet|would|could|only|today|research)\b/i;
      for (const p of ["README.md", "docs/architecture.md", "CLAUDE.md", "docs/adr/0001-host-agnostic-core-and-adapters.md"]) {
        const text = read(p);
        for (const line of text.split("\n")) {
          if (/\bcodex\b/i.test(line) && positive.test(line) && !negated.test(line)) {
            throw new Error(`${p} claims a Codex adapter ships now: "${line.trim()}"`);
          }
        }
      }
    },
  },
];
