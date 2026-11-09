#!/usr/bin/env node
// Register or remove the Effort Advisor in Claude Code from a local clone.
// (Installing from the marketplace needs none of this.) Every write backs the file up first.
//
//   node scripts/install.mjs status
//   node scripts/install.mjs claude-mod   [--uninstall] [--dry-run]
//   node scripts/install.mjs claude-hooks [--uninstall] [--dry-run]
//
// Settings live in $CLAUDE_CONFIG_DIR/settings.json, or ~/.claude/settings.json.
// Override for testing with --claude-settings <file>.

import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = join(PLUGIN_ROOT, "command-hook", "effort_advisor.mjs");
const forward = (path) => path.replaceAll("\\", "/");
const MARK = "effort_advisor.mjs";
// Version-pinned install folders: a hook pointing inside one breaks after a Node upgrade.
const PINNED_NODE_RE = /[\\/](?:Cellar|\.nvm|fnm|\.fnm|\.asdf|\.volta|mise|\.local[\\/]share[\\/]mise|n[\\/]versions)[\\/]/i;

function settingsPath(argv, env = process.env) {
  const index = argv.indexOf("--claude-settings");
  if (index >= 0 && argv[index + 1]) return argv[index + 1];
  const dir = env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
  return join(dir, "settings.json");
}

// The first node on PATH, kept as written (a symlink such as /opt/homebrew/bin/node
// survives upgrades), else the node running this script.
export function stableNodePath(env = process.env) {
  const names = process.platform === "win32" ? ["node.exe"] : ["node"];
  for (const dir of String(env.PATH ?? env.Path ?? "").split(delimiter)) {
    if (!dir.trim()) continue;
    for (const name of names) {
      const candidate = join(dir.trim(), name);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        // Not here.
      }
    }
  }
  return process.execPath;
}

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  // Some editors save a byte-order mark; Claude Code accepts it, so this does too.
  return JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, ""));
}

function backupAndWrite(path, value, dryRun) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (dryRun) return { path, backup: null, text };
  let backup = null;
  if (existsSync(path)) {
    const directory = join(dirname(path), "backups");
    mkdirSync(directory, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    backup = join(directory, `${basename(path)}.effort-advisor-${stamp}.bak`);
    copyFileSync(path, backup);
  } else {
    mkdirSync(dirname(path), { recursive: true });
  }
  writeFileSync(path, text, "utf8");
  JSON.parse(readFileSync(path, "utf8")); // the written file must parse
  return { path, backup, text };
}

// ---------------------------------------------------------------- the mod

function pluginDirs(settings) {
  const raw = settings?.env?.CLAUDE_CODE_PLUGIN_DIRS;
  return typeof raw === "string" && raw.trim() ? raw.split(delimiter).map((item) => item.trim()).filter(Boolean) : [];
}

const samePath = (a, b) => forward(resolve(a)).toLowerCase() === forward(resolve(b)).toLowerCase();

export function applyClaudeMod(settings, uninstall) {
  const next = structuredClone(settings ?? {});
  const dirs = pluginDirs(next).filter((dir) => !samePath(dir, PLUGIN_ROOT));
  if (!uninstall) dirs.push(forward(PLUGIN_ROOT));
  next.env = { ...(next.env ?? {}) };
  if (dirs.length) next.env.CLAUDE_CODE_PLUGIN_DIRS = dirs.join(delimiter);
  else delete next.env.CLAUDE_CODE_PLUGIN_DIRS;
  if (!Object.keys(next.env).length) delete next.env;
  return next;
}

// ------------------------------------------------- the fallback settings hooks

const CLAUDE_EVENTS = ["UserPromptSubmit", "PostToolBatch", "Stop"];
const isOurs = (hook) => JSON.stringify(hook ?? {}).includes(MARK);

function withoutOurs(groups) {
  return (Array.isArray(groups) ? groups : [])
    .map((group) => ({ ...group, hooks: (group.hooks ?? []).filter((hook) => !isOurs(hook)) }))
    .filter((group) => group.hooks.length);
}

export function applyClaudeHooks(settings, uninstall, node = stableNodePath()) {
  const next = structuredClone(settings ?? {});
  next.hooks = { ...(next.hooks ?? {}) };
  for (const event of CLAUDE_EVENTS) {
    const groups = withoutOurs(next.hooks[event]);
    if (!uninstall) {
      // Exec form: Node is spawned directly, with no shell start-up cost.
      groups.push({ hooks: [{ type: "command", command: forward(node), args: [forward(ENTRY)], timeout: 5 }] });
    }
    if (groups.length) next.hooks[event] = groups;
    else delete next.hooks[event];
  }
  if (!Object.keys(next.hooks).length) delete next.hooks;
  return next;
}

// ---------------------------------------------------------------------- CLI

export function status(argv = process.argv) {
  const settings = readJson(settingsPath(argv), {});
  return {
    settings: settingsPath(argv),
    claudeMod: pluginDirs(settings).some((dir) => samePath(dir, PLUGIN_ROOT)),
    claudeHooks: CLAUDE_EVENTS.filter((event) => (settings.hooks?.[event] ?? []).some((group) => (group.hooks ?? []).some(isOurs))),
  };
}

export function main(argv = process.argv.slice(2)) {
  const [target] = argv;
  const uninstall = argv.includes("--uninstall");
  const dryRun = argv.includes("--dry-run");
  if (!target || target === "status") {
    console.log(JSON.stringify(status(argv), null, 2));
    return 0;
  }
  if (target !== "claude-mod" && target !== "claude-hooks") {
    console.error(`Unknown target: ${target}. Use status, claude-mod or claude-hooks.`);
    return 2;
  }
  const path = settingsPath(argv);
  const settings = readJson(path, {});
  const node = stableNodePath();
  const next = target === "claude-mod" ? applyClaudeMod(settings, uninstall) : applyClaudeHooks(settings, uninstall, node);
  const result = backupAndWrite(path, next, dryRun);
  if (target === "claude-hooks" && !uninstall && PINNED_NODE_RE.test(node)) {
    console.warn(`Note: the hook runs ${node}, which looks version-specific. Re-run this command after you upgrade Node.`);
  }
  const current = dryRun ? null : status(argv);
  if (current?.claudeMod && current.claudeHooks.length) {
    console.warn("Warning: both the mod and the settings hooks are registered; tips would show twice. Uninstall one.");
  }
  console.log(dryRun ? `[dry run] would write ${result.path}:\n${result.text}` : `Wrote ${result.path}${result.backup ? ` (backup: ${result.backup})` : ""}`);
  return 0;
}

function invokedDirectly() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`Effort Advisor install failed: ${error?.message ?? error}`);
    process.exitCode = 1;
  }
}
