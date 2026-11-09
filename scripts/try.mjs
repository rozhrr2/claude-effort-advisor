#!/usr/bin/env node
// Try the advisor on any prompt, without Claude Code:
//
//   node scripts/try.mjs "debug why the tests are flaky" --on high
//   node scripts/try.mjs --end "The plan is ready. Want me to implement it?" --on max
//
// --on is the level you are on now (default: high). --end tries the turn-end tip
// for a final answer instead of a prompt. Nothing is stored; this is the same
// classifier and policy the mod uses, with a fresh session (no cooldowns yet).

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { classifyNextStep, classifyPrompt, decide, DEFAULT_CONFIG, formatUserMessage, mergeConfig, normalizeLevel } from "../lib/core.mjs";

const QUIET = {
  matches_current: (r, on) => `${on} is already right for this`,
  low_confidence: (r) => `not sure enough (confidence ${r.confidence}; it needs 0.6, or 0.7 at turn end)`,
  small_downshift: () => "the saving is too small to interrupt you",
  short_task_not_sustained: () => "one quick request is not a pattern; it waits for three in a row",
  adaptive_current: () => "your level already adapts by itself",
  level_not_offered: () => "your model's effort menu does not offer that level",
  continuation: () => "a confirmation keeps the level of the task it confirms",
  slash_command: () => "slash commands are left alone",
  ultrathink_requested: () => "you already asked for deeper thinking with ultrathink",
  no_signal: () => "no clear sign of what kind of work this is",
  no_next_step: () => "the answer names no clear next step",
  empty: () => "nothing to read",
};

export function explain(text, { on = "high", end = false } = {}) {
  const config = mergeConfig(DEFAULT_CONFIG, {});
  const current = normalizeLevel(on) ?? "high";
  const rec = end ? classifyNextStep(text) : classifyPrompt(text);
  const event = end ? "stop" : "prompt";
  const decision = decide({ event, current, rec, state: {}, config });
  const lines = [];
  lines.push(`${end ? "Answer" : "Prompt"}: ${JSON.stringify(text)}`);
  lines.push(`You're on: ${current}`);
  if (rec.level) {
    lines.push(`Looks like: ${rec.label}${rec.reasons?.length ? ` (${rec.reasons.join(", ")})` : ""}`);
    lines.push(`Best level: ${rec.level} (confidence ${rec.confidence})`);
  }
  if (decision.speak) {
    lines.push(`Shows: ${formatUserMessage({ event, from: decision.from, to: decision.to, rec, sustained: decision.sustained })}`);
  } else {
    const reason = QUIET[decision.why] ?? QUIET[rec.skip] ?? (() => decision.why);
    lines.push(`Stays quiet: ${reason(rec, current)}.`);
  }
  return { lines, speak: decision.speak, to: decision.to ?? null, rec };
}

function main(argv) {
  const args = [...argv];
  const take = (flag) => {
    const index = args.indexOf(flag);
    if (index < 0) return null;
    const [value] = args.splice(index, 2).slice(1);
    return value ?? "";
  };
  const on = take("--on") ?? "high";
  const endText = take("--end");
  const text = endText ?? args.join(" ");
  if (!text.trim()) {
    console.log('Usage: node scripts/try.mjs "your prompt" [--on high]\n       node scripts/try.mjs --end "a final answer" [--on max]');
    return 1;
  }
  console.log(explain(text, { on, end: endText !== null }).lines.join("\n"));
  return 0;
}

function invokedDirectly() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) process.exitCode = main(process.argv.slice(2));
