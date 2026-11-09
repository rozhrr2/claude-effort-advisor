import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { applyClaudeHooks, applyClaudeMod, main, stableNodePath, status } from "../../scripts/install.mjs";

const FIXTURES = resolve(fileURLToPath(new URL(".", import.meta.url)), ".fixtures");
// Wherever the repo was cloned, under whatever folder name.
const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url))).replaceAll("\\", "/");

function tempDir(t) {
  mkdirSync(FIXTURES, { recursive: true });
  const directory = mkdtempSync(join(FIXTURES, "install-"));
  t.after(() => {
    const within = relative(FIXTURES, resolve(directory));
    assert.ok(within && !within.startsWith("..") && !isAbsolute(within));
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

const EXISTING = {
  env: { MCP_TIMEOUT: "120000" },
  hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "node router.mjs" }] }] },
  effortLevel: "high",
};

test("mod registration adds and removes only its own plugin folder", () => {
  const added = applyClaudeMod(EXISTING, false);
  assert.equal(added.env.CLAUDE_CODE_PLUGIN_DIRS, ROOT);
  assert.equal(added.env.MCP_TIMEOUT, "120000");
  assert.deepEqual(applyClaudeMod(added, false).env, added.env, "idempotent");
  const withOther = applyClaudeMod({ env: { CLAUDE_CODE_PLUGIN_DIRS: "/some/other/plugin" } }, false);
  assert.equal(withOther.env.CLAUDE_CODE_PLUGIN_DIRS, ["/some/other/plugin", ROOT].join(delimiter), "other folders kept");
  assert.deepEqual(applyClaudeMod(added, true), EXISTING);
});

test("settings hooks use exec form with the given node, keep other hooks and uninstall cleanly", () => {
  const added = applyClaudeHooks(EXISTING, false, "/opt/homebrew/bin/node");
  assert.equal(added.hooks.UserPromptSubmit.length, 2, "router hook kept");
  const ours = added.hooks.PostToolBatch[0].hooks[0];
  assert.equal(ours.type, "command");
  assert.equal(ours.command, "/opt/homebrew/bin/node");
  assert.deepEqual(ours.args, [`${ROOT}/command-hook/effort_advisor.mjs`]);
  assert.deepEqual(applyClaudeHooks(added, false, "/opt/homebrew/bin/node"), added, "idempotent");
  assert.deepEqual(applyClaudeHooks(added, true), EXISTING);
});

test("the hook's node comes from PATH as written, not a resolved versioned path", (t) => {
  const dir = tempDir(t);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const name = process.platform === "win32" ? "node.exe" : "node";
  writeFileSync(join(bin, name), "");
  assert.equal(stableNodePath({ PATH: ["/nowhere", bin].join(delimiter) }), join(bin, name));
  assert.equal(stableNodePath({ PATH: "" }), process.execPath, "falls back to the running node");
});

test("CLI writes a backup, reports status and supports dry runs", (t) => {
  const dir = tempDir(t);
  const settings = join(dir, "settings.json");
  writeFileSync(settings, JSON.stringify(EXISTING));
  const args = ["--claude-settings", settings];
  assert.equal(main(["unknown-target", ...args]), 2, "unknown targets are refused");
  assert.equal(main(["claude-mod", "--dry-run", ...args]), 0);
  assert.deepEqual(JSON.parse(readFileSync(settings, "utf8")), EXISTING, "dry run writes nothing");
  assert.equal(main(["claude-mod", ...args]), 0);
  assert.equal(readdirSync(join(dir, "backups")).length, 1);
  assert.equal(status(["node", "x", ...args]).claudeMod, true);
  assert.equal(main(["claude-mod", "--uninstall", ...args]), 0);
  assert.deepEqual(JSON.parse(readFileSync(settings, "utf8")), EXISTING);
  assert.equal(status(["node", "x", ...args]).claudeMod, false);
});

test("a settings file with a byte-order mark is read, and a missing folder is created", (t) => {
  const dir = tempDir(t);
  const settings = join(dir, "settings.json");
  writeFileSync(settings, `﻿${JSON.stringify(EXISTING)}`);
  assert.equal(main(["claude-mod", "--claude-settings", settings]), 0);
  assert.equal(JSON.parse(readFileSync(settings, "utf8")).env.CLAUDE_CODE_PLUGIN_DIRS, ROOT);
  const fresh = join(dir, "new-config", "settings.json");
  assert.equal(main(["claude-mod", "--claude-settings", fresh]), 0);
  assert.equal(JSON.parse(readFileSync(fresh, "utf8")).env.CLAUDE_CODE_PLUGIN_DIRS, ROOT);
});
