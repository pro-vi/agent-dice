/**
 * Codex rollout depth parser conformance (U1).
 *
 * Pins `countExchanges` against a synthetic Codex rollout: it must count only
 * genuine user turns (response_item + payload.message + role user) and exclude
 * assistant/developer/reasoning messages and every tool-call/output payload.
 * Also pins the documented behavior that the leading <environment_context>
 * bootstrap user record IS counted (the accepted constant initial offset), plus
 * the missing-file and malformed-line fallbacks.
 */

import { type Check, assert, assertEqual } from "./harness";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { countExchanges } from "../../src/adapters/codex/transcript";

/** Write JSONL lines to a fresh temp rollout file and return its path. */
function writeRollout(lines: string[]): { path: string; base: string } {
  const base = mkdtempSync(join(tmpdir(), "cc-dice-codex-"));
  const path = join(base, "rollout-test.jsonl");
  writeFileSync(path, lines.join("\n"));
  return { path, base };
}

// A realistic mix: session meta, a bootstrap <environment_context> user message,
// two ordinary user turns, assistant + reasoning + developer + tool payloads, and
// a turn_context — only the 3 user messages count.
const userMsg = (text: string) =>
  JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
const assistantMsg = JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [] } });
const developerMsg = JSON.stringify({ type: "response_item", payload: { type: "message", role: "developer", content: [] } });
const reasoning = JSON.stringify({ type: "response_item", payload: { type: "reasoning" } });
const functionCall = JSON.stringify({ type: "response_item", payload: { type: "function_call" } });
const functionOutput = JSON.stringify({ type: "response_item", payload: { type: "function_call_output" } });
const sessionMeta = JSON.stringify({ type: "session_meta", payload: { id: "x" } });
const turnContext = JSON.stringify({ type: "turn_context", payload: {} });

export const checks: Check[] = [
  {
    name: "Codex depth: counts only response_item message role=user; excludes assistant/developer/reasoning/tool payloads",
    fn: async () => {
      const { path, base } = writeRollout([
        sessionMeta,
        userMsg("<environment_context>\n<cwd>/x</cwd>\n</environment_context>"), // bootstrap — counted (offset)
        assistantMsg,
        reasoning,
        functionCall,
        functionOutput,
        userMsg("first real request"),
        assistantMsg,
        developerMsg,
        turnContext,
        userMsg("second real request"),
      ]);
      try {
        assertEqual(await countExchanges(path), 3, "3 user messages (incl. bootstrap) counted, everything else excluded");
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    },
  },
  {
    name: "Codex depth: leading <environment_context> bootstrap is counted (documents the constant initial offset)",
    fn: async () => {
      const { path, base } = writeRollout([sessionMeta, userMsg("<environment_context></environment_context>")]);
      try {
        assertEqual(await countExchanges(path), 1, "bootstrap-only rollout has depth 1, not 0");
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    },
  },
  {
    name: "Codex depth: malformed lines are skipped, remainder counted",
    fn: async () => {
      const { path, base } = writeRollout([userMsg("a"), "{not valid json", "", userMsg("b")]);
      try {
        assertEqual(await countExchanges(path), 2, "two valid user messages counted, junk line skipped");
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    },
  },
  {
    name: "Codex depth: missing file → 0",
    fn: async () => {
      assert((await countExchanges(join(tmpdir(), "cc-dice-codex-does-not-exist-xyz.jsonl"))) === 0, "missing file resolves to depth 0");
    },
  },
];
