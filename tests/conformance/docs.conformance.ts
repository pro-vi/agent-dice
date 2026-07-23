/**
 * C9: Public docs conformance.
 *
 * Docs must describe agent-dice as the facade over a reusable core, and must
 * document the SHIPPED hosts. Claude, Pi, AND Codex now ship (Codex is a
 * hook-based host — the Claude twin); the docs must say so. Kept structural
 * (does the doc say the right things) rather than a brittle exact-string match.
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
    name: "C9: Codex is documented as a SHIPPED host — positive install language, no 'not yet built' hedge",
    fn: () => {
      // Mere presence of the word "codex" is too weak: pristine main satisfied that
      // while saying Codex was "researched but not yet built". This guard requires
      // POSITIVE shipped/install language and REJECTS negated/future claims, so it
      // fails on the pre-ship docs and only passes once Codex actually ships.
      const arch = read("docs/architecture.md").toLowerCase();
      for (const host of ["claude", "pi", "codex"]) {
        assert(arch.includes(host), `architecture.md should document the ${host} host (three hosts now ship)`);
      }
      // README must carry the real install path — only true once it ships.
      const readme = read("README.md");
      assert(/\.\/install\.sh\s+codex/.test(readme), "README should document the `./install.sh codex` install path");

      // No doc may hedge Codex as unbuilt/future on a line that mentions it.
      const future = /\b(not\s+(yet\s+)?built|researched\s+but\s+not|not\s+(yet\s+)?shipped|future\s+work|planned|unbuilt)\b/i;
      for (const p of ["README.md", "docs/architecture.md", "CLAUDE.md"]) {
        for (const line of read(p).split("\n")) {
          if (/\bcodex\b/i.test(line) && future.test(line)) {
            throw new Error(`${p} still hedges Codex as unbuilt/future: "${line.trim()}"`);
          }
        }
      }
    },
  },
];
