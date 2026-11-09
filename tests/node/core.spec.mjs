import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_CONFIG,
  analyzeBatch,
  classifyNextStep,
  classifyPrompt,
  decide,
  formatModelContext,
  formatUserMessage,
  mergeConfig,
  midTaskRecommendation,
  newTurn,
  normalizeLevel,
  offeredLevels,
  updateTurn,
} from "../../lib/core.mjs";

const config = mergeConfig(DEFAULT_CONFIG, {});

test("classifier maps task shapes to the agreed levels", () => {
  const cases = [
    ["add a --dry-run flag to the install script and write tests for it", "high", "build"],
    ["implement the settings sync feature and run the acceptance tests", "high", "build"],
    ["the build is still failing after your fix, find the root cause", "xhigh", "debug"],
    ["debug why the tests are flaky on Windows only", "xhigh", "debug"],
    ["review this PR before I merge it", "xhigh", "review"],
    ["design the architecture for the new sync service and write a spec with trade-offs", "max", "design"],
    ["do deep research on prompt complexity classifiers and compare the main options", "max", "research_hard"],
    ["explain how the router hook classifies prompts", "medium", "explain"],
    ["rename the variable foo to bar in utils.js", "medium", "small_edit"],
    ["quick question: which file holds the router config?", "low", "quick"],
  ];
  for (const [prompt, level, category] of cases) {
    const result = classifyPrompt(prompt);
    assert.equal(result.level, level, prompt);
    assert.equal(result.category, category, prompt);
    assert.ok(result.confidence >= 0.6, `${prompt} → ${result.confidence}`);
  }
});

test("classifier stays silent on confirmations, commands and explicit ultrathink", () => {
  for (const prompt of ["yes", "go ahead", "thanks!", "ok, continue", "/effort max", "", "   ", "ultrathink about this bug"]) {
    const result = classifyPrompt(prompt);
    assert.equal(result.level, null, JSON.stringify(prompt));
    assert.ok(result.skip, JSON.stringify(prompt));
  }
});

test("explicit level requests win and the router vote only strengthens a match", () => {
  const explicit = classifyPrompt("use max effort for this: plan the migration");
  assert.equal(explicit.level, "max");
  assert.equal(explicit.explicit, true);
  const plain = classifyPrompt("install the tool and configure it");
  const voted = classifyPrompt("install the tool and configure it", { routerMode: "change_or_build" });
  assert.equal(voted.level, "high");
  assert.ok(voted.confidence > plain.confidence);
  assert.equal(classifyPrompt("hello there friend", { routerMode: "diagnose" }).level, null);
});

test("ultracode is hinted only for whole-codebase audits or big reviews", () => {
  assert.equal(classifyPrompt("audit the entire codebase for security issues").ultracodeHint, true);
  assert.equal(classifyPrompt("review this PR before I merge it").ultracodeHint, false);
  assert.equal(classifyPrompt("ultracode: audit the entire codebase").ultracodeHint, false);
});

test("classifier output never carries prompt text", () => {
  const marker = "zebra-quartz-7731";
  const result = classifyPrompt(`debug why ${marker} is still failing in production`);
  assert.ok(!JSON.stringify(result).includes(marker));
});

test("next-step prediction reads unresolved failures and ready plans", () => {
  assert.equal(classifyNextStep("I could not reproduce the crash; the root cause is still unknown.").level, "xhigh");
  const plan = classifyNextStep("The plan is ready. Want me to implement it?");
  assert.equal(plan.level, "high");
  assert.ok(plan.confidence >= 0.7);
  assert.equal(classifyNextStep("Next step: write the architecture spec for the sync service.").level, "max");
  assert.equal(classifyNextStep("Summary of the changes above.").level, null);
  assert.equal(classifyNextStep("").level, null);
});

test("tool batches count failures and edits", () => {
  const batch = analyzeBatch([
    { tool_name: "Bash", tool_response: "Exit code 1\nnpm ERR! test failed" },
    { tool_name: "Read", tool_response: "<tool_use_error>File does not exist.</tool_use_error>" },
    { tool_name: "Edit", tool_response: "The file was updated" },
    { tool_name: "Write", tool_response: "File created" },
    { tool_name: "Bash", tool_response: "Exit code 0\nok" },
    { tool_name: "Grep", is_error: true },
  ]);
  assert.deepEqual(batch, { calls: 6, edits: 2, failures: 3 });
  assert.deepEqual(analyzeBatch(null), { calls: 0, edits: 0, failures: 0 });
});

test("mid-task rules spot a debugging spiral and a run of mechanical edits", () => {
  let turn = newTurn("t");
  turn = updateTurn(turn, { calls: 2, edits: 0, failures: 2 });
  assert.equal(midTaskRecommendation(turn, "high", config).level, null, "needs two failing batches and three failures");
  turn = updateTurn(turn, { calls: 1, edits: 0, failures: 1 });
  assert.equal(midTaskRecommendation(turn, "high", config).level, "xhigh");
  assert.equal(midTaskRecommendation(turn, "xhigh", config).level, null, "already high enough");

  let edits = newTurn("e");
  for (let i = 0; i < 6; i += 1) edits = updateTurn(edits, { calls: 1, edits: 1, failures: 0 });
  assert.equal(midTaskRecommendation(edits, "max", config).level, "high");
  assert.equal(midTaskRecommendation(edits, "xhigh", config).level, null, "xhigh needs 8 edits");
  assert.equal(midTaskRecommendation(updateTurn(edits, { calls: 1, edits: 0, failures: 1 }), "max", config).level, null, "a failure resets the streak");
});

test("policy raises when confident and needs a real gap to lower", () => {
  const debug = classifyPrompt("debug why the tests are flaky on Windows only");
  assert.equal(decide({ event: "prompt", current: "high", rec: debug, config }).speak, true);
  assert.equal(decide({ event: "prompt", current: "xhigh", rec: debug, config }).why, "matches_current");

  const build = classifyPrompt("add a --dry-run flag to the install script and write tests for it");
  assert.equal(decide({ event: "prompt", current: "xhigh", rec: build, config }).why, "small_downshift");
  const fromMax = decide({ event: "prompt", current: "max", rec: build, config });
  assert.equal(fromMax.speak, true);
  assert.equal(fromMax.to, "high");

  const review = classifyPrompt("review this PR before I merge it");
  assert.equal(decide({ event: "prompt", current: "max", rec: review, config }).to, "xhigh", "max → xhigh is the one single-step drop");
  assert.equal(decide({ event: "prompt", current: "max", rec: { ...review, confidence: 0.7 }, config }).why, "small_downshift");
});

test("quick answers lower effort only after a sustained run", () => {
  const quick = classifyPrompt("quick question: which file holds the router config?");
  assert.equal(decide({ event: "prompt", current: "high", rec: quick, state: { window: ["low"] }, config }).why, "short_task_not_sustained");
  const sustained = decide({ event: "prompt", current: "high", rec: quick, state: { window: ["medium", "low", "low"] }, config });
  assert.equal(sustained.speak, true);
  assert.equal(sustained.to, "medium", "never below the floor");
  assert.equal(sustained.sustained, true);
});

test("cooldown, ignored backoff, per-turn limit, adaptive and unknown levels keep it quiet", () => {
  const debug = classifyPrompt("debug why the tests are flaky on Windows only");
  const last = { from: "high", to: "xhigh", promptCount: 4 };
  assert.equal(decide({ event: "prompt", current: "high", rec: debug, state: { promptCount: 5, lastSuggestion: last }, config }).why, "cooldown");
  assert.equal(decide({ event: "prompt", current: "high", rec: debug, state: { promptCount: 7, lastSuggestion: last }, config }).speak, true);
  const backedOff = { promptCount: 7, lastSuggestion: last, ignored: { up: 1, down: 0 } };
  assert.equal(decide({ event: "prompt", current: "high", rec: debug, state: backedOff, config }).why, "cooldown", "an ignored tip waits twice as long");
  assert.equal(decide({ event: "prompt", current: "high", rec: debug, state: { turn: { suggestedTo: "xhigh" } }, config }).why, "already_suggested_this_turn");
  assert.equal(decide({ event: "prompt", current: "auto", rec: debug, config }).why, "adaptive_current");
  assert.equal(decide({ event: "prompt", current: null, rec: debug, config }).why, "current_unknown");
  assert.equal(decide({ event: "prompt", current: "high", rec: debug, config: { ...config, enabled: false } }).why, "disabled");
  const explicit = classifyPrompt("use max effort for this");
  assert.equal(decide({ event: "prompt", current: "high", rec: explicit, state: { promptCount: 5, lastSuggestion: { from: "high", to: "max", promptCount: 5 } }, config }).speak, true);
});

test("a tip never names a level the model's effort menu lacks", () => {
  const debug = classifyPrompt("debug why the tests are flaky on Windows only");
  assert.equal(decide({ event: "prompt", current: "high", rec: debug, config, model: "claude-sonnet-4-6" }).why, "level_not_offered");
  assert.equal(decide({ event: "prompt", current: "high", rec: debug, config, model: "claude-opus-5-5" }).speak, true);
  assert.equal(decide({ event: "prompt", current: "high", rec: debug, config }).speak, true, "unknown model: all levels");
  const design = classifyPrompt("design the architecture and write a spec with trade-offs");
  assert.equal(decide({ event: "prompt", current: "high", rec: design, config, model: "claude-opus-4-5-20251101" }).why, "level_not_offered");
  assert.equal(decide({ event: "prompt", current: "high", rec: design, config, model: "claude-sonnet-4-6" }).to, "max");
  assert.deepEqual(offeredLevels("claude-opus-4-6"), ["low", "medium", "high", "max"]);
});

test("turn-end tips need more confidence", () => {
  const weak = { level: "high", confidence: 0.65, category: "build", label: "x", reasons: [] };
  assert.equal(decide({ event: "stop", current: "max", rec: weak, config }).why, "low_confidence");
  assert.equal(decide({ event: "stop", current: "max", rec: { ...weak, confidence: 0.8 }, config }).speak, true);
});

test("messages are short, name the effort menu and how to apply mid-turn", () => {
  const rec = classifyPrompt("debug why the tests are flaky on Windows only");
  const prompt = formatUserMessage({ event: "prompt", from: "high", to: "xhigh", rec });
  assert.match(prompt, /^Effort tip: xhigh suits this/);
  assert.match(prompt, /effort menu next to the model picker/);
  assert.match(prompt, /"keep going"/);
  assert.ok(prompt.length < 260, `${prompt.length} chars`);
  assert.match(formatUserMessage({ event: "stop", from: "max", to: "high", rec: { label: "implementation" } }), /^Effort tip for the next step \(implementation\): high should be enough/);
  assert.match(formatUserMessage({ event: "midTask", from: "max", to: "high", rec: { label: "straightforward edits" } }), /the work is now straightforward edits, so high is enough/);
  const audit = classifyPrompt("audit the entire codebase for security issues");
  assert.match(formatUserMessage({ event: "prompt", from: "high", to: "xhigh", rec: audit }), /Ultracode/);
  assert.doesNotMatch(formatUserMessage({ event: "prompt", from: "high", to: "xhigh", rec: audit, ultracode: false }), /Ultracode/);
  const context = formatModelContext({ event: "prompt", from: "high", to: "xhigh", rec });
  assert.match(context, /suggestion only/);
  assert.match(context, /do not change any settings/);
});

test("config merge keeps known keys and types only; levels normalise", () => {
  const merged = mergeConfig(DEFAULT_CONFIG, {
    minConfidence: 0.8,
    channel: "nonsense",
    events: { stop: false, bogus: true },
    display: { toast: "yes" },
    unknown: 1,
  });
  assert.equal(merged.minConfidence, 0.8);
  assert.equal(merged.channel, "systemMessage");
  assert.equal(merged.events.stop, false);
  assert.equal(merged.events.prompt, true);
  assert.equal("bogus" in merged.events, false);
  assert.equal(merged.display.toast, true);
  assert.equal("unknown" in merged, false);
  assert.equal(normalizeLevel({ level: "X-High" }), "xhigh");
  assert.equal(normalizeLevel("Max"), "max");
  assert.equal(normalizeLevel("auto"), "auto");
  assert.equal(normalizeLevel("ultra"), null);
  assert.equal(normalizeLevel(8000), null);
});
