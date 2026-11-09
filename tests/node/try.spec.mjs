import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_CONFIG, classifyPrompt, decide, formatUserMessage, mergeConfig, windowEntry } from "../../lib/core.mjs";
import { explain } from "../../scripts/try.mjs";

// The README's examples table must stay true: each row here mirrors one row there.
const ROWS = [
  { on: "high", text: "debug why the tests are flaky on Windows only", to: "xhigh", shows: /xhigh suits this \(tricky debugging\)/ },
  { on: "high", text: "design the architecture for the sync service and write a spec with trade-offs", to: "max", shows: /max suits this \(a design or architecture decision\)/ },
  { on: "max", text: "add a --dry-run flag to the install script and write tests for it", to: "high", shows: /high is enough for this \(everyday build or fix work\)/ },
  { on: "max", text: "review this PR before I merge it", to: null, shows: /Stays quiet: max is a fair choice for this kind of work/ },
  { on: "max", text: "add a loading spinner to the submit button on the login form", to: null, shows: /Stays quiet: one small request/ },
  { on: "high", end: true, text: "There are three ways out: a queue, async sends, or batching. Which do you prefer?", to: "max", shows: /next step \(a design decision\): max may help/ },
  { on: "high", text: "add a --dry-run flag to the install script and write tests for it", to: null, shows: /Stays quiet: high is already right/ },
  { on: "high", text: "yes, go ahead", to: null, shows: /Stays quiet: a confirmation/ },
  { on: "high", text: "quick question: which file holds the config?", to: null, shows: /Stays quiet: one quick request is not a pattern/ },
  { on: "max", end: true, text: "The plan is ready. Want me to implement it?", to: "high", shows: /next step \(implementation\): high should be enough/ },
  { on: "high", end: true, text: "I could not reproduce the crash; the root cause is still unknown.", to: "xhigh", shows: /next step \(debugging\): xhigh may help/ },
];

test("the README examples match what the advisor really shows", () => {
  for (const row of ROWS) {
    const result = explain(row.text, { on: row.on, end: Boolean(row.end) });
    assert.equal(result.to, row.to, row.text);
    assert.match(result.lines.join("\n"), row.shows, row.text);
  }
});

// The README's examples that need a conversation before them.
test("the README's conversation examples match what the advisor really shows", () => {
  const config = mergeConfig(DEFAULT_CONFIG, {});
  const shows = (messages, prompt, current) => {
    let window = [];
    messages.forEach((message, index) => {
      if (message.role !== "user") return;
      const rec = classifyPrompt(message.text, { history: messages.slice(0, index), window });
      const entry = windowEntry(rec, message.text);
      if (entry) window = [...window, entry];
    });
    const rec = classifyPrompt(prompt, { history: messages, window });
    const entry = windowEntry(rec, prompt);
    const decision = decide({ event: "prompt", current, rec, state: { window: entry ? [...window, entry] : window }, config });
    return decision.speak ? formatUserMessage({ event: "prompt", from: decision.from, to: decision.to, rec, sustained: decision.sustained, buttons: true }) : null;
  };
  const chores = [
    { role: "user", text: "change the primary button color to the brand blue" },
    { role: "assistant", text: "Done." },
    { role: "user", text: "make the header sticky" },
    { role: "assistant", text: "Done, position: sticky with top 0." },
  ];
  assert.match(shows(chores, "bump the footer link font size a bit", "xhigh"), /your recent requests are lighter, so medium is enough/);
  const saga = [
    { role: "user", text: "the export job drops rows when the batch is bigger than 500" },
    { role: "assistant", text: "Found an off-by-one in the cursor. I changed the loop bound; this should fix it." },
    { role: "user", text: "still drops rows" },
    { role: "assistant", text: "The retry re-reads the page without the cursor. I added the cursor to the retry." },
  ];
  assert.match(shows(saga, "nope, same thing", "high"), /xhigh suits this \(tricky debugging\)/);
  const options = [
    { role: "user", text: "we need a new caching layer for the catalog api, lay out options" },
    { role: "assistant", text: "Options: an in-process LRU, Redis with a TTL, or a CDN in front of the API. Each trades freshness against cost. Which do you prefer?" },
  ];
  assert.match(shows(options, "go with redis", "max"), /high is enough for this \(you picked an option: building it\)/);
});

test("try.mjs explains the README's 'try it' sample exactly", () => {
  const { lines } = explain("debug why the tests are flaky on Windows only", { on: "high" });
  assert.deepEqual(lines.slice(0, 4), [
    'Prompt: "debug why the tests are flaky on Windows only"',
    "You're on: high",
    "Looks like: tricky debugging (debugging, hard failure)",
    "Best level: xhigh (confidence 0.95)",
  ]);
});
