import assert from "node:assert/strict";
import test from "node:test";

import { explain } from "../../scripts/try.mjs";

// The README's examples table must stay true: each row here mirrors one row there.
const ROWS = [
  { on: "high", text: "debug why the tests are flaky on Windows only", to: "xhigh", shows: /xhigh suits this \(tricky debugging\)/ },
  { on: "high", text: "design the architecture for the sync service and write a spec with trade-offs", to: "max", shows: /max suits this \(a design or architecture decision\)/ },
  { on: "max", text: "add a --dry-run flag to the install script and write tests for it", to: "high", shows: /high is enough for this \(everyday build or fix work\)/ },
  { on: "max", text: "review this PR before I merge it", to: "xhigh", shows: /xhigh is enough for this \(reviewing a big change\)/ },
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

test("try.mjs explains the README's 'try it' sample exactly", () => {
  const { lines } = explain("debug why the tests are flaky on Windows only", { on: "high" });
  assert.deepEqual(lines.slice(0, 4), [
    'Prompt: "debug why the tests are flaky on Windows only"',
    "You're on: high",
    "Looks like: tricky debugging (debugging, hard failure)",
    "Best level: xhigh (confidence 0.95)",
  ]);
});
