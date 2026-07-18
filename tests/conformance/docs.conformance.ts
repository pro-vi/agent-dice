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
    name: "C9: Codex now ships as the third host — architecture.md + README document it alongside Claude and Pi",
    fn: () => {
      // Codex shipped as a hook-based host (the Claude twin), so the docs must
      // document it. architecture.md is the host-of-record: it must name all three
      // shipped hosts; README must mention Codex so installers can find it.
      const arch = read("docs/architecture.md").toLowerCase();
      for (const host of ["claude", "pi", "codex"]) {
        assert(arch.includes(host), `architecture.md should document the ${host} host (three hosts now ship)`);
      }
      const readme = read("README.md").toLowerCase();
      assert(readme.includes("codex"), "README should mention Codex so users can find the install path");
    },
  },
];
