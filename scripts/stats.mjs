#!/usr/bin/env node
// Summarise the command hook's label-only decision log, for tuning.
//   node scripts/stats.mjs [path-to-decisions.jsonl]
// The log exists only while `logDecisions: true` is set in config.mjs.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { stateRoot } from "../command-hook/io.mjs";

const path = process.argv[2] || join(stateRoot(), "decisions.jsonl");
if (!existsSync(path)) {
  console.log(`No decision log at ${path}. Set logDecisions: true in config.mjs to collect one.`);
  process.exit(0);
}
const rows = readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}).filter(Boolean);
const count = (items, key) => items.reduce((acc, item) => ({ ...acc, [key(item)]: (acc[key(item)] ?? 0) + 1 }), {});
const decisions = rows.filter((row) => row.event !== "resolution");
const resolutions = rows.filter((row) => row.event === "resolution");
console.log(JSON.stringify({
  file: path,
  decisions: decisions.length,
  tipsShown: decisions.filter((row) => row.spoke).length,
  byEvent: count(decisions, (row) => row.event),
  quietBecause: count(decisions.filter((row) => !row.spoke), (row) => row.why),
  tipsByCategory: count(decisions.filter((row) => row.spoke), (row) => `${row.current}->${row.recommended} (${row.category})`),
  followed: count(resolutions, (row) => row.outcome),
}, null, 2));
