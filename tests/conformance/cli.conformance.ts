/**
 * CLI surface conformance.
 *
 * Drives the real `bin/agent-dice.ts` as a subprocess and pins stdout + exit code for
 * EVERY command and error path. This is the gate that would have caught the
 * reset/clear exit-code inconsistency without anyone having to test by hand — it
 * runs on every `bun run test`. Each check uses its own temp CC_DICE_BASE.
 */

import { type Check, assert } from "./harness";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

const CLI = resolve(import.meta.dir, "../../bin/agent-dice.ts");

type Result = { stdout: string; stderr: string; code: number };

async function cli(args: string[], env: Record<string, string> = {}): Promise<Result> {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

/** Fresh isolated base + a non-UUID session so getTranscriptPath resolves to null (depth 0). */
function freshEnv(): Record<string, string> {
  const base = mkdtempSync(join(tmpdir(), "cc-dice-cli-"));
  mkdirSync(join(base, "state"), { recursive: true });
  return { CC_DICE_BASE: base, CC_DICE_SESSION_ID: "cliconf" };
}

const reg = (env: Record<string, string>, name: string, ...opts: string[]) =>
  cli(["register", name, "--message", "m", ...opts], env);

export const checks: Check[] = [
  {
    name: "CLI: help / no-arg / --help print usage and exit 0",
    fn: async () => {
      for (const args of [[], ["help"], ["--help"], ["-h"]]) {
        const r = await cli(args, freshEnv());
        assert(r.code === 0, `\`${args.join(" ") || "<none>"}\` exits 0 (got ${r.code})`);
        assert(r.stdout.includes("Usage: agent-dice"), `\`${args.join(" ")}\` prints usage`);
      }
    },
  },
  {
    name: "CLI: register all three types → exit 0 with confirmation",
    fn: async () => {
      const env = freshEnv();
      const a = await reg(env, "acc", "--type", "accumulator", "--die", "20", "--target", "20");
      assert(a.code === 0 && a.stdout.includes("Registered: acc (accumulator, d20, target=20 exact)"), `register accumulator: ${a.stdout}${a.stderr}`);
      const s = await reg(env, "sng", "--type", "single", "--die", "20", "--target", "1");
      assert(s.code === 0 && s.stdout.includes("Registered: sng (single, d20, target=1 exact)"), `register single: ${s.stdout}${s.stderr}`);
      const f = await reg(env, "fix", "--type", "fixed", "--die", "6", "--target", "6", "--target-mode", "gte", "--fixed-count", "3");
      assert(f.code === 0 && f.stdout.includes("Registered: fix (fixed, d6, target=6 gte)"), `register fixed: ${f.stdout}${f.stderr}`);
    },
  },
  {
    name: "CLI: list shows all registered slots",
    fn: async () => {
      const env = freshEnv();
      const empty = await cli(["list"], env);
      assert(empty.code === 0 && empty.stdout.includes("No slots registered."), `empty list: ${empty.stdout}`);
      await reg(env, "acc", "--type", "accumulator");
      await reg(env, "sng", "--type", "single");
      const r = await cli(["list"], env);
      assert(r.code === 0, "list exits 0");
      assert(r.stdout.includes("acc (accumulator") && r.stdout.includes("sng (single"), `list contents: ${r.stdout}`);
    },
  },
  {
    name: "CLI: status reflects dice count per type (depth 0)",
    fn: async () => {
      const env = freshEnv();
      await reg(env, "acc", "--type", "accumulator", "--accumulation-rate", "7");
      await reg(env, "sng", "--type", "single");
      await reg(env, "fix", "--type", "fixed", "--die", "6", "--fixed-count", "3");
      const a = await cli(["status", "acc"], env);
      assert(a.code === 0 && a.stdout.includes("Dice count:      0") && a.stdout.includes("Next die at:     depth 7"), `acc status: ${a.stdout}`);
      const s = await cli(["status", "sng"], env);
      assert(s.code === 0 && s.stdout.includes("Dice count:      1"), `sng status: ${s.stdout}`);
      const f = await cli(["status", "fix"], env);
      assert(f.code === 0 && f.stdout.includes("Dice count:      3"), `fix status: ${f.stdout}`);
    },
  },
  {
    name: "CLI: roll is a dry-run with correct shape per type",
    fn: async () => {
      const env = freshEnv();
      await reg(env, "acc", "--type", "accumulator");
      await reg(env, "sng", "--type", "single", "--die", "20");
      await reg(env, "fix", "--type", "fixed", "--die", "6", "--fixed-count", "3");
      const a = await cli(["roll", "acc"], env);
      assert(a.code === 0 && a.stdout.includes("acc: 0 dice (no roll)"), `roll acc (0 dice): ${a.stdout}`);
      const s = await cli(["roll", "sng"], env);
      assert(s.code === 0 && /sng: 1d20 = \[\d+\]/.test(s.stdout), `roll sng: ${s.stdout}`);
      const f = await cli(["roll", "fix"], env);
      assert(f.code === 0 && /fix: 3d6 = \[\d+, \d+, \d+\]/.test(f.stdout), `roll fix: ${f.stdout}`);
    },
  },
  {
    name: "CLI: reset / clear / unregister on an existing slot → exit 0",
    fn: async () => {
      const env = freshEnv();
      await reg(env, "acc", "--type", "accumulator");
      const rst = await cli(["reset", "acc"], env);
      assert(rst.code === 0 && rst.stdout.includes("Reset slot: acc"), `reset: ${rst.stdout}${rst.stderr}`);
      const clr = await cli(["clear", "acc"], env);
      assert(clr.code === 0 && clr.stdout.includes("Cleared slot: acc"), `clear: ${clr.stdout}${clr.stderr}`);
      const unr = await cli(["unregister", "acc"], env);
      assert(unr.code === 0 && unr.stdout.includes("Removed slot: acc"), `unregister: ${unr.stdout}${unr.stderr}`);
    },
  },
  {
    name: "CLI: every per-slot command errors on a missing slot (exit 1 + 'Slot not found')",
    fn: async () => {
      const env = freshEnv();
      for (const cmd of ["status", "roll", "reset", "clear", "unregister"]) {
        const r = await cli([cmd, "ghost"], env);
        assert(r.code === 1, `\`${cmd} ghost\` exits 1 (got ${r.code})`);
        assert(r.stderr.includes("Slot not found: ghost"), `\`${cmd} ghost\` says Slot not found (got: ${r.stderr || r.stdout})`);
      }
    },
  },
  {
    name: "CLI: missing name and unknown command → exit 1",
    fn: async () => {
      const env = freshEnv();
      for (const cmd of ["register", "status", "roll", "reset", "clear", "unregister"]) {
        const r = await cli([cmd], env);
        assert(r.code === 1, `\`${cmd}\` with no name exits 1 (got ${r.code})`);
        assert(r.stderr.includes("slot name required"), `\`${cmd}\` reports missing name (got: ${r.stderr})`);
      }
      const bogus = await cli(["frobnicate"], env);
      assert(bogus.code === 1 && bogus.stderr.includes("Unknown command: frobnicate"), `unknown command: ${bogus.stderr}`);
    },
  },
  {
    name: "CLI: accumulator depth resolves from the transcript (status + roll)",
    fn: async () => {
      const base = mkdtempSync(join(tmpdir(), "cc-dice-cli-"));
      mkdirSync(join(base, "state"), { recursive: true });
      const home = join(base, "home");
      const session = "abcdef01-2345-6789-abcd-ef0123456789";
      const pwd = process.env.PWD || process.cwd();
      const slug = pwd.replace(/[/_]/g, "-");
      const projDir = join(home, ".claude", "projects", slug);
      mkdirSync(projDir, { recursive: true });
      // 14 user exchanges + a tool-result and an assistant line that must NOT count.
      const lines = Array.from({ length: 14 }, () => '{"type":"user","message":{"role":"user"}}');
      lines.push('{"type":"user","toolUseResult":{"x":1}}', '{"type":"assistant"}');
      writeFileSync(join(projDir, `${session}.jsonl`), lines.join("\n"));

      const env = { CC_DICE_BASE: base, CC_DICE_SESSION_ID: session, HOME: home };
      await reg(env, "acc", "--type", "accumulator", "--die", "20", "--target", "20", "--accumulation-rate", "7");
      const status = await cli(["status", "acc"], env);
      assert(status.code === 0, "status exits 0");
      assert(status.stdout.includes("Current depth:   14"), `depth 14 expected: ${status.stdout}`);
      assert(status.stdout.includes("Dice count:      2"), `dice floor(14/7)=2 expected: ${status.stdout}`);
      const roll = await cli(["roll", "acc"], env);
      assert(roll.code === 0 && /acc: 2d20 = \[\d+, \d+\]/.test(roll.stdout), `2d20 roll expected: ${roll.stdout}`);
    },
  },
];
