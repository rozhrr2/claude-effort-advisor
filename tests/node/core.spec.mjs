import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_CONFIG,
  adviseUltracode,
  analyzeBatch,
  classifyNextStep,
  classifyPrompt,
  decide,
  decideUltracode,
  describeLearning,
  emptyLearning,
  formatModelContext,
  formatUltracodeMessage,
  formatUserMessage,
  mergeConfig,
  recordOutcome,
  thresholdOffset,
  midTaskRecommendation,
  newTurn,
  normalizeLevel,
  offeredLevels,
  updateTurn,
  windowEntry,
} from "../../lib/core.mjs";

const config = mergeConfig(DEFAULT_CONFIG, {});

// Replays a session the way the mod does: each prompt sees the messages and window before it.
function replaySession(messages, prompt) {
  let window = [];
  messages.forEach((message, index) => {
    if (message.role !== "user") return;
    const rec = classifyPrompt(message.text, { history: messages.slice(0, index), window });
    const entry = windowEntry(rec, message.text);
    if (entry) window = [...window, entry];
  });
  const rec = classifyPrompt(prompt, { history: messages, window });
  const entry = windowEntry(rec, prompt);
  return { rec, window: entry ? [...window, entry] : window };
}

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

  const everyday = classifyPrompt("add a csv export to the reports page and write tests for it");
  let edits = newTurn("e");
  for (let i = 0; i < 6; i += 1) edits = updateTurn(edits, { calls: 1, edits: 1, failures: 0 });
  assert.equal(midTaskRecommendation(edits, "max", config, { turnRec: everyday }).level, "high");
  assert.equal(midTaskRecommendation(edits, "xhigh", config, { turnRec: everyday }).level, null, "xhigh needs 8 edits");
  const oneStray = updateTurn(edits, { calls: 1, edits: 0, failures: 1 });
  assert.equal(midTaskRecommendation(oneStray, "max", config, { turnRec: everyday }).level, "high", "one stray failure keeps the streak");
  assert.equal(midTaskRecommendation(updateTurn(oneStray, { calls: 1, edits: 0, failures: 1 }), "max", config, { turnRec: everyday }).level, null, "a second failure resets it");
  assert.equal(midTaskRecommendation(edits, "max", config).level, null, "an unknown task needs a longer run");
});

test("edits inside a hard task never trigger the 'high is enough' tip", () => {
  const hard = classifyPrompt("redesign the sync architecture and migrate the storage layer, weigh the trade-offs");
  let edits = newTurn("h");
  for (let i = 0; i < 20; i += 1) edits = updateTurn(edits, { calls: 1, edits: 1, failures: 0 });
  assert.equal(midTaskRecommendation(edits, "max", config, { turnRec: hard }).skip, "edits_inside_hard_task");
});

test("follow-ups are judged by what they continue, not on their own", () => {
  const offer = [
    { role: "user", text: "the login test fails on CI but passes locally" },
    { role: "assistant", text: "I reproduced it; it looks like a timing issue. Want me to dig into the root cause?" },
  ];
  const accepted = classifyPrompt("yes go ahead", { history: offer });
  assert.equal(accepted.level, "xhigh");
  assert.equal(accepted.followUp, "accept");
  assert.ok(accepted.confidence >= 0.6);

  const retry = classifyPrompt("nope, still failing", { history: [{ role: "user", text: "fix the flaky upload test" }, { role: "assistant", text: "I changed the retry logic." }] });
  assert.equal(retry.level, "xhigh");
  assert.equal(retry.followUp, "retry");

  const implement = classifyPrompt("yes", { history: [{ role: "user", text: "design the sync service architecture" }, { role: "assistant", text: "Here is the spec with trade-offs. Want me to implement it?" }] });
  assert.equal(implement.level, "high");

  assert.equal(classifyPrompt("yes go ahead").level, null, "with no history it stays silent");
  const marker = "zebra-quartz-7731";
  assert.ok(!JSON.stringify(classifyPrompt("yes", { history: [{ role: "user", text: `debug why ${marker} is flaky` }] })).includes(marker), "no text leaks into the result");
});

test("a run of small requests suggests going lower; one small request does not", () => {
  const messages = [
    { role: "user", text: "change the primary button color to the brand blue" },
    { role: "assistant", text: "Done." },
    { role: "user", text: "make the header sticky" },
    { role: "assistant", text: "Done, position: sticky with top 0." },
    { role: "user", text: "bump the footer link font size a bit" },
    { role: "assistant", text: "Changed from 12px to 14px." },
  ];
  const { rec, window } = replaySession(messages, "now round the corners on the cards");
  assert.equal(rec.category, "light_run");
  const decision = decide({ event: "prompt", current: "xhigh", rec, state: { window }, config });
  assert.equal(decision.speak, true);
  assert.equal(decision.to, "medium");
  assert.equal(decision.sustained, true);
  // A run is only ever a reason to go lower.
  assert.equal(decide({ event: "prompt", current: "low", rec, state: { window }, config }).speak, false);
  // Short prompts with no signal extend a run, but two known light ones are needed.
  assert.equal(windowEntry(classifyPrompt("hmm"), "hmm"), "unknown");
  assert.equal(classifyPrompt("ok and the footer", { window: ["unknown", "unknown"] }).category === "light_run", false);
  // One small request at a high level is not a pattern.
  assert.equal(decide({ event: "prompt", current: "xhigh", rec: classifyPrompt("round the corners on the cards"), state: { window: ["medium"] }, config }).speak, false);
});

test("a bug still failing after Claude's fixes is tricky debugging, whatever the wording", () => {
  const saga = [
    { role: "user", text: "memory on the ingest workers climbs ~200mb/hr until they get oomkilled" },
    { role: "assistant", text: "Heap snapshot points at the parser cache. I bounded it with an LRU." },
    { role: "user", text: "still climbing, slower though" },
    { role: "assistant", text: "The remaining growth is outside the JS heap. I switched the gzip stream to be closed explicitly." },
  ];
  const rec = classifyPrompt("didnt help. try again, and this time figure out what's holding the native memory", { history: saga });
  assert.equal(rec.level, "xhigh");
  assert.equal(rec.saga, 2);
  assert.ok(rec.confidence >= 0.85);
  // Once it works, the saga is over.
  const solved = [...saga, { role: "user", text: "works now, thanks" }, { role: "assistant", text: "Great." }];
  assert.notEqual(classifyPrompt("quick q, where is the config file?", { history: solved }).category, "debug");
  // One failed fix of an ordinary error is still everyday fixing.
  const once = [
    { role: "user", text: "build fails: Module not found: can't resolve '@/lib/env'" },
    { role: "assistant", text: "Added the @ path alias to tsconfig.json." },
  ];
  assert.notEqual(classifyPrompt("same error", { history: once }).level, "xhigh");
});

test("broad sweeps get Ultracode; their effort stays high unless the sweep is about security", () => {
  const sweep = classifyPrompt("review the entire codebase for dead code, unused exports and stale feature flags");
  assert.equal(sweep.level, "high");
  assert.equal(adviseUltracode({ kind: "prompt", prompt: "review the entire codebase for dead code, unused exports and stale feature flags", ultracodeOn: false, rec: sweep }).advice, "on");
  const security = classifyPrompt("audit every endpoint in the api for missing auth checks");
  assert.equal(security.level, "xhigh");
  // One coherent change is never many independent parts.
  assert.equal(adviseUltracode({ kind: "prompt", prompt: "find all bugs in this function: ```js\nconst a = 1\n```", ultracodeOn: false, rec: classifyPrompt("find all bugs in this function") }).advice, "keep");
  // "just that one for now" narrows a broad task.
  const audit = [
    { role: "user", text: "audit the whole codebase for unsafe deserialization" },
    { role: "assistant", text: "Audit complete: 14 findings, 2 critical. Want me to fix the pickle.loads one?" },
  ];
  const narrowed = classifyPrompt("yeah just that one for now", { history: audit });
  assert.equal(adviseUltracode({ kind: "prompt", prompt: "yeah just that one for now", history: audit, ultracodeOn: true, rec: narrowed }).advice, "off");
  // An acknowledgement is no task at all.
  assert.equal(adviseUltracode({ kind: "prompt", prompt: "perfect thanks", ultracodeOn: true, rec: classifyPrompt("perfect thanks") }).advice, "keep");
});

test("turn end reads decisions, plans and recommendations, not only the offer sentence", () => {
  const choice = classifyNextStep("Profiling shows the fan-out blocks each request. There are three ways out: a queue, async sends, or batching. Which do you prefer?");
  assert.equal(choice.level, "max");
  const plan = classifyNextStep("Got it, the queue approach. Implementation plan: add a producer, a worker with backoff and a dead-letter topic.");
  assert.equal(plan.level, "high");
  const recommended = classifyNextStep("Compared three hosts. Recommendation: stay on S3 plus CDN and add preview deploys.");
  assert.equal(recommended.level, "high");
  // A passing mention of flaky tests is not an open problem.
  assert.notEqual(classifyNextStep("Done. Note the existing tests rely on real timers and two of them were already flaky.").category, "debug");
  // At turn end, what was done ("all 212 tests pass") is not the work ahead.
  assert.equal(adviseUltracode({ kind: "turnEnd", answer: "All 34 repository files are migrated and the full suite is green.", ultracodeOn: false }).advice, "keep");
  assert.equal(adviseUltracode({ kind: "turnEnd", answer: "Here's the migration plan: 212 call sites across 9 packages, in 5 phases. Approve it and I'll start.", ultracodeOn: false }).advice, "on");
});

test("an explicit 'Next steps' list predicts the next step from its first item", () => {
  const rec = classifyNextStep("Done with the parser.\n\nNext steps:\n1. Write the architecture spec for the plugin system\n2. Update the docs");
  assert.equal(rec.level, "max");
  assert.equal(classifyNextStep("All tests pass and the branch is merged.").skip, "done");
});

test("Ultracode: on for broad sweeps, off for small work while on, keep otherwise", () => {
  const audit = "audit the entire codebase for unsafe sql queries";
  assert.equal(adviseUltracode({ prompt: audit, ultracodeOn: false, rec: classifyPrompt(audit) }).advice, "on");
  assert.equal(adviseUltracode({ prompt: audit, ultracodeOn: true, rec: classifyPrompt(audit) }).advice, "keep", "already on");
  const rename = "rename the helper to formatDate";
  assert.equal(adviseUltracode({ prompt: rename, ultracodeOn: true, rec: classifyPrompt(rename) }).advice, "off");
  assert.equal(adviseUltracode({ prompt: rename, ultracodeOn: false, rec: classifyPrompt(rename) }).advice, "keep");
  assert.equal(adviseUltracode({ prompt: "ultracode: audit everything", ultracodeOn: false, rec: null }).advice, "keep", "the keyword is the user's own choice");
  const design = "design the architecture for multi-region failover";
  assert.equal(adviseUltracode({ prompt: design, ultracodeOn: true, rec: classifyPrompt(design) }).advice, "keep", "hard work keeps it");
  const advice = adviseUltracode({ prompt: audit, ultracodeOn: false, rec: classifyPrompt(audit) });
  assert.equal(decideUltracode({ advice, state: {}, config }).speak, true);
  assert.equal(decideUltracode({ advice, state: { promptCount: 2, lastUltracode: { to: "on", promptCount: 1 } }, config }).why, "cooldown");
  assert.match(formatUltracodeMessage({ to: "on", advice }), /\/effort ultracode on/);
  assert.doesNotMatch(formatUltracodeMessage({ to: "on", advice, buttons: true }), /\/effort/);
});

test("learning: followed tips lower the bar, dismissed ones raise it, counts only", () => {
  let learning = emptyLearning();
  const key = "prompt:debug:up";
  for (let i = 0; i < 5; i += 1) learning = recordOutcome(learning, key, "dismissed");
  assert.equal(thresholdOffset(learning, key), 0.2);
  const debug = classifyPrompt("why does the hook crash when the transcript is empty?");
  assert.equal(decide({ event: "prompt", current: "high", rec: debug, config, learning }).why, "learned_quiet");
  for (let i = 0; i < 8; i += 1) learning = recordOutcome(learning, key, "accepted");
  assert.ok(thresholdOffset(learning, key) < 0);
  assert.equal(decide({ event: "prompt", current: "high", rec: debug, config, learning }).speak, true);
  assert.equal(decide({ event: "prompt", current: "high", rec: debug, config: { ...config, learning: false }, learning: recordOutcome(emptyLearning(), key, "dismissed") }).speak, true, "learning off ignores counts");
  assert.match(describeLearning(learning), /prompt · debug · up/);
  assert.deepEqual(Object.keys(learning.keys[key]).sort(), ["accepted", "dismissed", "ignored", "manual"]);
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

  // max is a fair choice for a review; one step down from it is no tip.
  const review = classifyPrompt("review this PR before I merge it");
  assert.equal(decide({ event: "prompt", current: "max", rec: review, config }).why, "max_fits_hard_work");
  // One small request at max stays quiet; two actions are worth the tip.
  const spinner = classifyPrompt("add a loading spinner to the submit button on the login form");
  assert.equal(decide({ event: "prompt", current: "max", rec: spinner, config }).why, "one_off_down");
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
  assert.doesNotMatch(formatUserMessage({ event: "prompt", from: "high", to: "xhigh", rec: audit }), /Ultracode/, "Ultracode advice is its own message now");
  assert.doesNotMatch(formatUserMessage({ event: "prompt", from: "high", to: "xhigh", rec, buttons: true }), /effort menu/, "a band with a Switch button needs no how-to");
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
