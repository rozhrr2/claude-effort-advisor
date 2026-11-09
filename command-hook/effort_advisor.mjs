#!/usr/bin/env node
// Effort Advisor command hook for Claude Code settings hooks (the fallback to the mod).
// Fail-open: always exits 0; prints one JSON object only when it has a tip.
// Never blocks a prompt or tool, never calls the network, never stores prompt text.

import module from "node:module";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

try {
  module.enableCompileCache?.();
} catch {
  // Optional speed-up only.
}

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_STDIN_BYTES = 64 * 1024 * 1024;

async function readStdin() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_STDIN_BYTES) return "";
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// Optional: an external classifier module whose classifyPrompt(prompt).taskMode
// (diagnose, research_or_review, change_or_build, answer_or_explain) adds one weak vote.
async function loadRouterTaskMode(env) {
  try {
    const path = env.EFFORT_ADVISOR_ROUTER_PATH;
    if (!path || !existsSync(path)) return null;
    const router = await import(pathToFileURL(path).href);
    if (typeof router.classifyPrompt !== "function") return null;
    return (prompt) => router.classifyPrompt(prompt)?.taskMode ?? null;
  } catch {
    return null;
  }
}

async function loadOverrides() {
  try {
    const path = join(PLUGIN_ROOT, "config.mjs");
    if (!existsSync(path)) return {};
    return (await import(pathToFileURL(path).href)).default ?? {};
  } catch {
    return {};
  }
}

export async function main(argv = process.argv, env = process.env) {
  try {
    const raw = await readStdin();
    if (!raw.trim()) return;
    const input = JSON.parse(raw);
    const isPrompt = /^userpromptsubmit$/i.test(String(input?.hook_event_name ?? "").replace(/[^a-z]/gi, ""));
    const [{ handle }, { loadConfig }, overrides, taskMode] = await Promise.all([
      import("./handler.mjs"),
      import("./io.mjs"),
      loadOverrides(),
      isPrompt ? loadRouterTaskMode(env) : Promise.resolve(null),
    ]);
    const output = handle(input, { env, config: loadConfig(overrides, env), taskMode });
    if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
  } catch {
    // Fail open: no output and a successful exit.
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) await main();
