import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { handle } from "../../command-hook/handler.mjs";
import { loadConfig } from "../../command-hook/io.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ENTRY = resolve(HERE, "../../command-hook/effort_advisor.mjs");
const FIXTURES = resolve(HERE, ".fixtures");
const MARKER = "zebra-quartz-7731";

function tempDir(t, label) {
  mkdirSync(FIXTURES, { recursive: true });
  const directory = mkdtempSync(join(FIXTURES, `${label}-`));
  t.after(() => {
    const within = relative(FIXTURES, resolve(directory));
    assert.ok(within && !within.startsWith("..") && !isAbsolute(within));
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

function allStateText(directory) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else out.push(readFileSync(path, "utf8"));
    }
  };
  walk(directory);
  return out.join("\n");
}

const claudeEnv = (stateDir, extra = {}) => ({ EFFORT_ADVISOR_STATE_DIR: stateDir, CLAUDECODE: "1", ...extra });
const run = (input, env, overrides = {}) => handle(input, { env, config: loadConfig(overrides, env) });

// A Claude transcript whose last assistant row ran at `effort` on `model`.
function transcript(directory, effort, model = "claude-opus-5-5") {
  const path = join(directory, "transcript.jsonl");
  writeFileSync(path, [
    JSON.stringify({ type: "user", message: { content: "earlier prompt text" } }),
    JSON.stringify({ type: "assistant", effort, message: { model, content: [{ type: "text", text: "earlier answer" }] } }),
    "",
  ].join("\n"));
  return path;
}

test("UserPromptSubmit: no tip for a level the model's menu lacks", (t) => {
  const state = tempDir(t, "model");
  const env = claudeEnv(state);
  const input = { hook_event_name: "UserPromptSubmit", session_id: "s13", prompt: "debug why the tests are flaky on Windows only" };
  assert.equal(run({ ...input, transcript_path: transcript(state, "high", "claude-sonnet-4-6") }, env), null);
  assert.match(run({ ...input, session_id: "s14", transcript_path: transcript(state, "high", "claude-sonnet-5-5") }, env).systemMessage, /xhigh suits this/);
});

test("UserPromptSubmit: suggests a raise once, then the cooldown keeps it quiet", (t) => {
  const state = tempDir(t, "prompt");
  const env = claudeEnv(state);
  const input = { hook_event_name: "UserPromptSubmit", session_id: "s1", transcript_path: transcript(state, "high"), prompt: `debug why ${MARKER} is flaky on Windows only` };
  const first = run({ ...input, prompt_id: "p1" }, env);
  assert.match(first.systemMessage, /^Effort tip: xhigh suits this \(tricky debugging\); you're on high\./);
  assert.equal(first.hookSpecificOutput, undefined, "default channel is the user-visible systemMessage only");
  assert.equal(run({ ...input, prompt_id: "p2" }, env), null, "same tip, inside the cooldown");
  assert.ok(!allStateText(state).includes(MARKER), "state keeps no prompt text");
  assert.ok(!allStateText(state).includes("Windows"), "state keeps no prompt words");
});

test("UserPromptSubmit: confirmations, matching levels and unknown effort stay silent", (t) => {
  const state = tempDir(t, "silent");
  const env = claudeEnv(state);
  const transcriptPath = transcript(state, "high");
  assert.equal(run({ hook_event_name: "UserPromptSubmit", session_id: "s2", transcript_path: transcriptPath, prompt: "yes, go ahead" }, env), null);
  assert.equal(run({ hook_event_name: "UserPromptSubmit", session_id: "s2", transcript_path: transcriptPath, prompt: "add a flag to the install script and write tests" }, env), null);
  assert.equal(run({ hook_event_name: "UserPromptSubmit", session_id: "s3", prompt: "debug why the tests are flaky" }, env), null);
});

test("UserPromptSubmit: an inherited CLAUDE_EFFORT is not trusted; the tip waits for the first tool batch", (t) => {
  const state = tempDir(t, "deferred");
  const env = claudeEnv(state, { CLAUDE_EFFORT: "max" });
  const prompt = { hook_event_name: "UserPromptSubmit", session_id: "s11", prompt_id: "p1", prompt: "debug why the tests are flaky on Windows only" };
  assert.equal(run(prompt, env), null, "no tip from an env-only reading");
  const batch = { hook_event_name: "PostToolBatch", session_id: "s11", prompt_id: "p1", effort: { level: "high" }, tool_calls: [{ tool_name: "Read", tool_response: "ok" }] };
  const output = run(batch, env);
  assert.match(output.systemMessage, /^Effort tip: xhigh suits this \(tricky debugging\); you're on high\./, "decided with the trusted level");
  assert.equal(run({ ...batch, tool_calls: [{ tool_name: "Read", tool_response: "ok" }] }, env), null, "decided once");
});

test("channel 'context' asks Claude for a one-line mention instead", (t) => {
  const state = tempDir(t, "context");
  const env = claudeEnv(state);
  const output = run({ hook_event_name: "UserPromptSubmit", session_id: "s4", transcript_path: transcript(state, "high"), prompt: "design the architecture and write a spec with trade-offs" }, env, { channel: "context" });
  assert.equal(output.systemMessage, undefined);
  assert.equal(output.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(output.hookSpecificOutput.additionalContext, /Recommended effort: max; current: high/);
});

test("PostToolBatch: a failing run suggests xhigh once per turn; edits at max suggest high", (t) => {
  const state = tempDir(t, "batch");
  const env = claudeEnv(state);
  const failing = (id) => ({
    hook_event_name: "PostToolBatch",
    session_id: "s5",
    prompt_id: "p1",
    effort: { level: "high" },
    tool_calls: [{ tool_name: "Bash", tool_use_id: id, tool_response: "Exit code 1\nFAILED test_x" }, { tool_name: "Bash", tool_use_id: `${id}b`, tool_response: "Exit code 2" }],
  });
  assert.equal(run(failing("a"), env), null, "one failing batch is not a spiral");
  const second = run(failing("b"), env);
  assert.match(second.systemMessage, /this has turned into tricky debugging, so xhigh may help/);
  assert.match(second.systemMessage, /then send "keep going"/);
  assert.equal(run(failing("c"), env), null, "not repeated in the same turn");

  // The turn's task is everyday work (too vague for a tip at prompt time), so a run of
  // plain edits at max can drop to high.
  assert.equal(run({ hook_event_name: "UserPromptSubmit", session_id: "s6", prompt_id: "p1", transcript_path: transcript(state, "max"), prompt: "install the tool and configure it" }, env), null);
  const edits = { hook_event_name: "PostToolBatch", session_id: "s6", prompt_id: "p1", effort: { level: "max" } };
  let output = null;
  for (let i = 0; i < 3; i += 1) {
    output = run({ ...edits, tool_calls: [{ tool_name: "Edit", tool_response: "ok" }, { tool_name: "Edit", tool_response: "ok" }] }, env);
  }
  assert.match(output.systemMessage, /the work is now straightforward edits, so high is enough \(you're on max\)/);

  // When the prompt already got "high is enough", the same tip is not repeated mid-turn.
  assert.match(run({ hook_event_name: "UserPromptSubmit", session_id: "s6c", prompt_id: "p1", transcript_path: transcript(state, "max"), prompt: "add a csv export to the reports page and write tests for it" }, env).systemMessage, /high is enough/);
  let repeat = null;
  for (let i = 0; i < 3; i += 1) repeat = run({ ...edits, session_id: "s6c", tool_calls: [{ tool_name: "Edit", tool_response: "ok" }, { tool_name: "Edit", tool_response: "ok" }] }, env) ?? repeat;
  assert.equal(repeat, null);

  // Inside a hard task the same edits stay quiet.
  run({ hook_event_name: "UserPromptSubmit", session_id: "s6b", prompt_id: "p1", transcript_path: transcript(state, "max"), prompt: "redesign the storage architecture and weigh the trade-offs of each option" }, env);
  let quiet = null;
  for (let i = 0; i < 6; i += 1) {
    quiet = run({ hook_event_name: "PostToolBatch", session_id: "s6b", prompt_id: "p1", effort: { level: "max" }, tool_calls: [{ tool_name: "Edit", tool_response: "ok" }, { tool_name: "Edit", tool_response: "ok" }] }, env) ?? quiet;
  }
  assert.equal(quiet === null || !/straightforward edits/.test(quiet.systemMessage ?? ""), true);
});

test("UserPromptSubmit: a short follow-up is judged by the conversation in the transcript", (t) => {
  const state = tempDir(t, "follow");
  const env = claudeEnv(state);
  const path = join(state, "transcript.jsonl");
  writeFileSync(path, [
    JSON.stringify({ type: "user", message: { content: "the login test fails on CI but passes locally" } }),
    JSON.stringify({ type: "assistant", effort: "high", message: { model: "claude-opus-5-5", content: [{ type: "text", text: "I reproduced it; it looks like a timing issue. Want me to dig into the root cause?" }] } }),
    "",
  ].join("\n"));
  const output = run({ hook_event_name: "UserPromptSubmit", session_id: "s15", transcript_path: path, prompt: "yes go ahead" }, env);
  assert.match(output.systemMessage, /^Effort tip: xhigh suits this \(you accepted: tricky debugging\); you're on high\./);
  assert.ok(!allStateText(state).replace(readFileSync(path, "utf8"), "").includes("timing issue"), "no conversation text in the advisor's state");
});

test("UserPromptSubmit: a whole-codebase audit also gets the Ultracode tip", (t) => {
  const state = tempDir(t, "ultracode");
  const env = claudeEnv(state);
  const output = run({ hook_event_name: "UserPromptSubmit", session_id: "s16", transcript_path: transcript(state, "xhigh"), prompt: "audit the entire codebase for unsafe sql queries" }, env);
  assert.match(output.systemMessage, /Ultracode tip: .*\/effort ultracode on/);
});

test("Stop: a turn-end tip is a systemMessage only and never continues the turn", (t) => {
  const state = tempDir(t, "stop");
  const env = claudeEnv(state);
  const stop = { hook_event_name: "Stop", session_id: "s7", effort: { level: "max" }, stop_hook_active: false, last_assistant_message: "The plan is ready. Want me to implement it?" };
  const output = run(stop, env);
  assert.match(output.systemMessage, /^Effort tip for the next step \(implementation\): high should be enough \(you're on max\)\./);
  assert.deepEqual(Object.keys(output), ["systemMessage"]);
  assert.equal(output.decision, undefined);
  assert.equal(run({ ...stop, session_id: "s8", stop_hook_active: true }, env), null, "silent while a stop hook is continuing");
  assert.equal(run({ ...stop, session_id: "s9" }, env, { channel: "context" }), null, "context would continue the turn, so nothing");
});

test("subagent loops and sessions without ids are ignored", (t) => {
  const state = tempDir(t, "skip");
  const env = claudeEnv(state, { CLAUDE_EFFORT: "high" });
  const prompt = { hook_event_name: "UserPromptSubmit", prompt: "debug why the tests are flaky" };
  assert.equal(run({ ...prompt, session_id: "s10", agent_id: "a1" }, env), null);
  assert.equal(run(prompt, env), null);
});

test("the transcript's last assistant row gives the previous turn's level", (t) => {
  const state = tempDir(t, "transcript");
  const env = claudeEnv(state);
  const prompt = { hook_event_name: "UserPromptSubmit", session_id: "s12", transcript_path: transcript(state, "medium"), prompt: "implement the export feature and run the tests" };
  assert.match(run(prompt, env).systemMessage, /high suits this .*you're on medium/);
});

test("entry script: fail-open on bad input, valid JSON on a tip, fast enough", (t) => {
  const state = tempDir(t, "entry");
  const env = { ...process.env, EFFORT_ADVISOR_STATE_DIR: state, CLAUDECODE: "1" };
  delete env.CLAUDE_EFFORT;
  const transcriptPath = transcript(state, "high");
  for (const stdin of ["", "not json", "{\"hook_event_name\":"]) {
    const result = spawnSync(process.execPath, [ENTRY], { input: stdin, env, encoding: "utf8" });
    assert.equal(result.status, 0, `exit code for ${JSON.stringify(stdin)}`);
    assert.equal(result.stdout, "", `no output for ${JSON.stringify(stdin)}`);
  }
  const timings = [];
  let stdout = "";
  for (let i = 0; i < 5; i += 1) {
    const input = JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: `e${i}`, transcript_path: transcriptPath, prompt: "debug why the tests are flaky on Windows only" });
    const started = performance.now();
    const result = spawnSync(process.execPath, [ENTRY], { input, env, encoding: "utf8" });
    timings.push(performance.now() - started);
    assert.equal(result.status, 0);
    stdout = result.stdout;
  }
  const output = JSON.parse(stdout);
  assert.match(output.systemMessage, /^Effort tip: xhigh/);
  timings.sort((a, b) => a - b);
  const median = timings[2];
  t.diagnostic(`entry median ${median.toFixed(0)} ms (min ${timings[0].toFixed(0)}, max ${timings[4].toFixed(0)})`);
  assert.ok(median < 400, `median ${median} ms`);
});
