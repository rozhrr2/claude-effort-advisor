#!/usr/bin/env node
// Replay the labeled corpus in tests/eval/cases through the real classifier and policy.
//
//   node scripts/eval.mjs                      summary
//   node scripts/eval.mjs --failures 40        also list the first 40 failures
//   node scripts/eval.mjs --kind prompt --tag short-followup
//   node scripts/eval.mjs --validate           check the case files only
//   node scripts/eval.mjs --json report.json   also write the full report
//
// The harness uses only the public functions of lib/core.mjs, and newer ones when
// they exist (history-aware classification, adviseUltracode), so it measures
// every version the same way.

import { readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as core from "../lib/core.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CASES_DIR = join(ROOT, "tests", "eval", "cases");
const LEVELS = core.LEVELS;
const EDIT_TOOLS = /^(?:Edit|Write|MultiEdit|NotebookEdit)$/;

// ------------------------------------------------------------------ loading

export function loadCases(dir = CASES_DIR) {
  const cases = [];
  const problems = [];
  let files = [];
  try {
    files = readdirSync(dir).filter((name) => name.endsWith(".jsonl")).sort();
  } catch {
    return { cases, problems: [`no case folder at ${dir}`] };
  }
  for (const file of files) {
    const lines = readFileSync(join(dir, file), "utf8").split(/\r?\n/);
    lines.forEach((line, index) => {
      if (!line.trim()) return;
      try {
        cases.push({ ...JSON.parse(line), _file: file, _line: index + 1 });
      } catch (error) {
        problems.push(`${file}:${index + 1}: not JSON (${error.message})`);
      }
    });
  }
  return { cases, problems };
}

const isLevel = (value) => LEVELS.includes(value);
const rank = (level) => core.levelIndex(level);

export function validateCase(c) {
  const where = `${c._file}:${c._line} ${c.id ?? "(no id)"}`;
  const errors = [];
  if (typeof c.id !== "string" || !c.id) errors.push("id missing");
  if (!["prompt", "midTask", "turnEnd"].includes(c.kind)) errors.push(`kind ${JSON.stringify(c.kind)}`);
  if (!isLevel(c.current)) errors.push(`current ${JSON.stringify(c.current)}`);
  if (!isLevel(c.best)) errors.push(`best ${JSON.stringify(c.best)}`);
  if (!Array.isArray(c.acceptable) || !c.acceptable.length || !c.acceptable.every(isLevel)) errors.push("acceptable must be a list of levels");
  else if (!c.acceptable.includes(c.best)) errors.push("acceptable must include best");
  if (!["up", "down", "none"].includes(c.tip)) errors.push(`tip ${JSON.stringify(c.tip)}`);
  if (!["on", "off", "keep"].includes(c.ultracode)) errors.push(`ultracode ${JSON.stringify(c.ultracode)}`);
  if (typeof c.ultracodeOn !== "boolean") errors.push("ultracodeOn must be true or false");
  if (c.kind === "prompt" && (typeof c.prompt !== "string" || !c.prompt.trim())) errors.push("prompt missing");
  if (c.kind === "midTask" && (!Array.isArray(c.trajectory) || !c.trajectory.length)) errors.push("trajectory missing");
  if (c.kind === "turnEnd" && (typeof c.answer !== "string" || !c.answer.trim())) errors.push("answer missing");
  if (c.history !== undefined && (!Array.isArray(c.history) || !c.history.every((m) => ["user", "assistant"].includes(m?.role) && typeof m?.text === "string"))) {
    errors.push("history must be [{ role: user|assistant, text }]");
  }
  if (Array.isArray(c.acceptable) && c.acceptable.every(isLevel) && isLevel(c.current)) {
    const low = Math.min(...c.acceptable.map(rank));
    const high = Math.max(...c.acceptable.map(rank));
    if (c.tip === "up" && rank(c.current) >= low) errors.push("tip up, but current is not below the acceptable range");
    if (c.tip === "down" && rank(c.current) <= high) errors.push("tip down, but current is not above the acceptable range");
  }
  if (c.ultracode === "on" && c.ultracodeOn) errors.push("ultracode on, but it is already on");
  if (c.ultracode === "off" && !c.ultracodeOn) errors.push("ultracode off, but it is already off");
  return errors.map((error) => `${where}: ${error}`);
}

// ------------------------------------------------------------------ replay

const config = core.mergeConfig(core.DEFAULT_CONFIG, {});
const userPrompts = (history = []) => history.filter((m) => m.role === "user").map((m) => m.text);

const entryOf = (rec, text) => (typeof core.windowEntry === "function" ? core.windowEntry(rec, text) : rec.level ?? null);

// The advisor's session state after the earlier prompts, as the mod builds it: each
// earlier prompt classified with the messages and window it had at the time.
function stateFromHistory(history) {
  let window = [];
  let promptCount = 0;
  history.forEach((message, index) => {
    if (message.role !== "user") return;
    promptCount += 1;
    const rec = core.classifyPrompt(message.text, { history: history.slice(0, index), window });
    const entry = entryOf(rec, message.text);
    if (entry) window = [...window, entry].slice(-6);
  });
  return { promptCount, window, ignored: { up: 0, down: 0 }, lastSuggestion: null, turn: null };
}

function adviseUltracode(c, rec) {
  if (typeof core.adviseUltracode === "function") {
    const advice = core.adviseUltracode({ kind: c.kind, prompt: c.prompt ?? c.turnPrompt ?? "", history: c.history ?? [], ultracodeOn: c.ultracodeOn, rec, answer: c.answer ?? "" });
    if (typeof advice === "string") return advice;
    if (!advice || advice.advice === "keep") return "keep";
    // The same bar the mod applies before showing it.
    const decision = core.decideUltracode ? core.decideUltracode({ advice, state: {}, config }) : { speak: true, to: advice.advice };
    return decision.speak ? decision.to : "keep";
  }
  return rec?.ultracodeHint && !c.ultracodeOn ? "on" : "keep";
}

export function replay(c) {
  const history = c.history ?? [];
  const model = c.model ?? null;
  if (c.kind === "prompt") {
    const state = stateFromHistory(history);
    const rec = core.classifyPrompt(c.prompt, { history, window: state.window });
    const entry = entryOf(rec, c.prompt);
    if (entry) state.window = [...state.window, entry].slice(-6);
    state.promptCount += 1;
    const decision = core.decide({ event: "prompt", current: c.current, rec, state, config, model });
    return { level: rec.level ?? null, decision, ultracode: adviseUltracode(c, rec), category: rec.category ?? rec.skip ?? null };
  }
  if (c.kind === "midTask") {
    const turnRec = c.turnPrompt ? core.classifyPrompt(c.turnPrompt, { history }) : null;
    let turn = { ...core.newTurn("t"), promptRec: turnRec };
    let decision = { speak: false, why: "no_mid_task_signal" };
    let rec = null;
    for (const call of c.trajectory) {
      const failed = call.failed === true;
      turn = { ...core.updateTurn(turn, { calls: 1, edits: !failed && EDIT_TOOLS.test(String(call.tool)) ? 1 : 0, failures: failed ? 1 : 0 }), promptRec: turnRec, tools: [...(turn.tools ?? []), call.tool] };
      rec = core.midTaskRecommendation(turn, c.current, config, { turnRec, history });
      if (!rec?.level) continue;
      decision = core.decide({ event: "midTask", current: c.current, rec, state: { turn }, config, model });
      if (decision.speak) break;
    }
    return { level: rec?.level ?? null, decision, ultracode: adviseUltracode(c, turnRec), category: rec?.category ?? rec?.skip ?? null };
  }
  const turnRec = c.turnPrompt ? core.classifyPrompt(c.turnPrompt, { history }) : null;
  const rec = core.classifyNextStep(c.answer, { promptRec: turnRec }, { history, turnRec });
  const decision = core.decide({ event: "stop", current: c.current, rec, state: {}, config, model });
  return { level: rec.level ?? null, decision, ultracode: adviseUltracode(c, turnRec), category: rec.category ?? rec.skip ?? null };
}

// ------------------------------------------------------------------ scoring

function tipOf(decision) {
  if (!decision?.speak) return "none";
  return decision.direction === "up" ? "up" : "down";
}

export function score(c, got) {
  const tip = tipOf(got.decision);
  const targetOk = tip === "none" || c.acceptable.includes(got.decision.to);
  const tipOk = tip === c.tip && targetOk;
  const levelOk = got.level ? c.acceptable.includes(got.level) : null;
  const ultracodeOk = got.ultracode === c.ultracode;
  return { tip, tipOk, targetOk, levelOk, ultracodeOk, ok: tipOk && ultracodeOk };
}

function pct(part, whole) {
  return whole ? `${((100 * part) / whole).toFixed(1)}%` : "n/a";
}

export function evaluate(cases) {
  const rows = cases.map((c) => {
    const got = replay(c);
    return { c, got, s: score(c, got) };
  });
  const confusion = {};
  for (const gold of ["up", "down", "none"]) confusion[gold] = { up: 0, down: 0, none: 0 };
  const ultra = {};
  for (const gold of ["on", "off", "keep"]) ultra[gold] = { on: 0, off: 0, keep: 0 };
  for (const { c, s, got } of rows) {
    confusion[c.tip][s.tip] += 1;
    ultra[c.ultracode][got.ultracode] = (ultra[c.ultracode][got.ultracode] ?? 0) + 1;
  }
  const byKind = {};
  const byTag = {};
  for (const { c, s } of rows) {
    for (const [bucket, key] of [[byKind, c.kind], ...(c.tags ?? []).map((tag) => [byTag, tag])]) {
      bucket[key] ??= { n: 0, ok: 0 };
      bucket[key].n += 1;
      if (s.ok) bucket[key].ok += 1;
    }
  }
  const goldNone = rows.filter((r) => r.c.tip === "none").length;
  const goldTip = rows.length - goldNone;
  const noise = rows.filter((r) => r.c.tip === "none" && r.s.tip !== "none").length;
  const missed = rows.filter((r) => r.c.tip !== "none" && r.s.tip === "none").length;
  const wrongWay = rows.filter((r) => r.c.tip !== "none" && r.s.tip !== "none" && r.s.tip !== r.c.tip).length;
  const wrongTarget = rows.filter((r) => r.s.tip !== "none" && !r.s.targetOk).length;
  const levelRows = rows.filter((r) => r.s.levelOk !== null);
  const summary = {
    cases: rows.length,
    overall: pct(rows.filter((r) => r.s.ok).length, rows.length),
    tipAccuracy: pct(rows.filter((r) => r.s.tipOk).length, rows.length),
    noiseRate: `${pct(noise, goldNone)} (${noise} of ${goldNone} quiet cases got a tip)`,
    missRate: `${pct(missed, goldTip)} (${missed} of ${goldTip} tip-worthy cases got none)`,
    wrongDirection: wrongWay,
    wrongTarget,
    levelWithinAcceptable: `${pct(levelRows.filter((r) => r.s.levelOk).length, levelRows.length)} of ${levelRows.length} with a level`,
    noOpinion: rows.filter((r) => r.s.levelOk === null).length,
    ultracodeAccuracy: pct(rows.filter((r) => r.s.ultracodeOk).length, rows.length),
  };
  return { summary, confusion, ultra, byKind, byTag, rows };
}

function failureLine({ c, got, s }) {
  const gold = `gold ${c.tip}/${c.best} [${c.acceptable.join(",")}] uc:${c.ultracode}`;
  const seen = `got ${s.tip}${got.decision?.to ? "->" + got.decision.to : ""} level:${got.level ?? "-"} (${got.category ?? "?"}; ${got.decision?.why ?? "?"}) uc:${got.ultracode}`;
  return `${c.id} [${c.kind}; ${(c.tags ?? []).join(",")}] on ${c.current}${c.ultracodeOn ? "+UC" : ""}: ${gold} | ${seen}`;
}

// ------------------------------------------------------------------ CLI

function option(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
}

export function main(argv = process.argv.slice(2)) {
  const { cases, problems } = loadCases(option(argv, "--dir") ?? CASES_DIR);
  const invalid = [...problems, ...cases.flatMap(validateCase)];
  const ids = new Map();
  for (const c of cases) ids.set(c.id, (ids.get(c.id) ?? 0) + 1);
  for (const [id, n] of ids) if (n > 1) invalid.push(`duplicate id ${id} (${n} times)`);
  if (argv.includes("--validate")) {
    console.log(invalid.length ? invalid.join("\n") : `${cases.length} cases, all valid.`);
    return invalid.length ? 1 : 0;
  }
  if (invalid.length) console.warn(`Skipping ${invalid.length} problem(s):\n  ${invalid.slice(0, 20).join("\n  ")}`);
  const bad = new Set(invalid.map((line) => line.split(": ")[0]));
  const kind = option(argv, "--kind");
  const tag = option(argv, "--tag");
  const selected = cases
    .filter((c) => !bad.has(`${c._file}:${c._line} ${c.id ?? "(no id)"}`))
    .filter((c) => !kind || c.kind === kind)
    .filter((c) => !tag || (c.tags ?? []).includes(tag));
  const report = evaluate(selected);
  console.log(JSON.stringify(report.summary, null, 2));
  console.log("tip confusion (rows: gold, cols: got):", JSON.stringify(report.confusion));
  console.log("ultracode confusion (rows: gold, cols: got):", JSON.stringify(report.ultra));
  console.log("by kind:", Object.entries(report.byKind).map(([k, v]) => `${k} ${v.ok}/${v.n}`).join(" | "));
  const worstTags = Object.entries(report.byTag).filter(([, v]) => v.n >= 3).sort((a, b) => a[1].ok / a[1].n - b[1].ok / b[1].n).slice(0, 12);
  console.log("weakest tags:", worstTags.map(([k, v]) => `${k} ${v.ok}/${v.n}`).join(" | "));
  const limit = Number(option(argv, "--failures") ?? 0);
  if (limit > 0) {
    const failures = report.rows.filter((r) => !r.s.ok);
    console.log(`\nfailures (${failures.length}):`);
    for (const row of failures.slice(0, limit)) console.log(`- ${failureLine(row)}`);
  }
  const jsonPath = option(argv, "--json");
  if (jsonPath) {
    const rows = report.rows.map(({ c, got, s }) => ({ id: c.id, kind: c.kind, tags: c.tags, gold: { tip: c.tip, best: c.best, acceptable: c.acceptable, ultracode: c.ultracode }, got: { tip: s.tip, to: got.decision?.to ?? null, level: got.level, category: got.category, why: got.decision?.why ?? null, ultracode: got.ultracode }, ok: s.ok }));
    writeFileSync(jsonPath, `${JSON.stringify({ ...report, rows }, null, 2)}\n`);
  }
  return 0;
}

function invokedDirectly() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) process.exitCode = main();
