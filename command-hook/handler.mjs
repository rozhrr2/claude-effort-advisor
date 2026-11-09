// Command-hook orchestration for Claude Code settings hooks (the fallback to the mod).
// Fail-open by design: every path returns null (no output) or a small JSON object.

import { dirname } from "node:path";

import {
  adviseUltracode,
  analyzeBatch,
  classifyNextStep,
  classifyPrompt,
  decide,
  decideUltracode,
  formatModelContext,
  formatUltracodeMessage,
  formatUserMessage,
  labelLevels,
  midTaskRecommendation,
  newTurn,
  offeredLevels,
  updateTurn,
  windowEntry,
} from "../lib/core.mjs";
import {
  currentEffort,
  lastModelInTranscript,
  logDecision,
  recentHistoryFromTranscript,
  pruneStates,
  readState,
  stateRoot,
  statePath,
  writeState,
} from "./io.mjs";

const WINDOW_SIZE = 6;

export function eventKind(name) {
  const key = String(name ?? "").toLowerCase().replace(/[^a-z]/g, "");
  if (key === "userpromptsubmit") return "prompt";
  if (key === "posttoolbatch" || key === "posttooluse" || key === "posttoolusefailure") return "midTask";
  if (key === "stop") return "stop";
  return null;
}

// Was the last suggestion taken up? Ignored tips back off (cooldown doubles).
export function resolvePending(state, level, isNewPrompt) {
  const pending = state.pending;
  if (!pending || !level) return { state, outcome: null };
  if (level === pending.to) {
    return {
      state: { ...state, pending: null, ignored: { ...state.ignored, [pending.direction]: 0 } },
      outcome: "accepted",
    };
  }
  if (isNewPrompt && state.promptCount > pending.promptCount) {
    const ignored = Math.min(5, (state.ignored?.[pending.direction] ?? 0) + 1);
    return {
      state: { ...state, pending: null, ignored: { ...state.ignored, [pending.direction]: ignored } },
      outcome: "ignored",
    };
  }
  return { state, outcome: null };
}

function toolCallsFrom(input) {
  if (Array.isArray(input?.tool_calls)) return input.tool_calls;
  if (input?.tool_name) {
    const failed = input.error != null || /failure/i.test(String(input.hook_event_name));
    return [{ tool_name: input.tool_name, tool_response: input.tool_response, error: failed ? "failed" : undefined }];
  }
  return [];
}

// Only fixed labels, signal tags and yes/no flags are kept between events, never text.
const KEPT_FLAGS = ["shortTask", "explicit", "ultracodeHint", "substantial", "longWork", "multiStep", "weak", "riskyChange", "allowSingleStep", "inherited", "downOnly", "afterDesign"];

function labelsOf(rec) {
  if (!rec?.level) return null;
  const { level, confidence, category, label, reasons } = rec;
  const flags = Object.fromEntries(KEPT_FLAGS.filter((name) => rec[name] === true).map((name) => [name, true]));
  return { level, confidence, category, label, reasons, ...flags };
}

function buildOutput({ hookEventName, kind, channel, userText, modelText }) {
  const output = {};
  const wantsSystem = channel === "systemMessage" || channel === "both";
  const wantsContext = channel === "context" || channel === "both";
  if (kind === "stop") {
    // Stop context would make the agent continue the turn; only a user-visible note is safe.
    if (!wantsSystem) return null;
    output.systemMessage = userText;
    return output;
  }
  if (wantsSystem) output.systemMessage = userText;
  if (wantsContext) output.hookSpecificOutput = { hookEventName, additionalContext: modelText };
  return Object.keys(output).length ? output : null;
}

/**
 * Handle one hook event.
 * @param {object} input  the hook's stdin JSON
 * @param {object} options { env, config, taskMode(prompt) -> string|null, now }
 * @returns {object|null} hook output JSON, or null for no output
 */
export function handle(input, options = {}) {
  const env = options.env ?? process.env;
  const config = options.config;
  if (!config?.enabled) return null;
  const kind = eventKind(input?.hook_event_name);
  if (!kind || !config.events?.[kind]) return null;
  if (input?.agent_id) return null; // a subagent's loop: its effort is not the menu's
  const sessionId = input?.session_id;
  if (!sessionId) return null;

  const root = stateRoot(env);
  const path = statePath(root, sessionId);
  let state = readState(path);
  const current = currentEffort(input, env, state, { forPrompt: kind === "prompt" });
  const at = new Date(options.now ?? Date.now()).toISOString();
  const logs = [];

  // What is decided, and as which kind of tip: a prompt tip can wait for a trusted level.
  let rec = null;
  let tipKind = kind;
  let decision = null;
  let ultracodeAdvice = null;
  if (kind === "prompt") {
    state = { ...state, promptCount: state.promptCount + 1 };
    const resolved = resolvePending(state, current.trusted ? current.level : null, true);
    state = resolved.state;
    if (resolved.outcome) logs.push({ at, event: "resolution", outcome: resolved.outcome });
    const prompt = typeof input.prompt === "string" ? input.prompt : String(input.prompt ?? input.message ?? "");
    let taskMode = null;
    try {
      taskMode = options.taskMode ? options.taskMode(prompt) : null;
    } catch {
      taskMode = null;
    }
    // The conversation so far, read in memory from the transcript, so follow-ups are judged in context.
    const history = recentHistoryFromTranscript(input.transcript_path, config.contextMessages)
      .filter((message, index, all) => !(index === all.length - 1 && message.role === "user" && message.text.trim() === prompt.trim()));
    rec = classifyPrompt(prompt, { routerMode: taskMode, history, window: state.window ?? [] });
    ultracodeAdvice = config.ultracodeHints ? adviseUltracode({ kind: "prompt", prompt, history, ultracodeOn: false, rec }) : null;
    if (!config.ultracodeHints) rec = { ...rec, ultracodeHint: false };
    state.turn = { ...newTurn(input.prompt_id ?? `p${state.promptCount}`), promptRec: labelsOf(rec), promptDecided: current.trusted };
    // A level, or "unknown" for a short prompt with no signal: never the text.
    const entry = windowEntry(rec, prompt);
    if (entry) state.window = [...(state.window ?? []), entry].slice(-WINDOW_SIZE);
    decision = current.trusted ? null : { speak: false, why: "deferred_until_effort_known" };
  } else {
    const resolved = resolvePending(state, current.level, false);
    state = resolved.state;
    if (resolved.outcome) logs.push({ at, event: "resolution", outcome: resolved.outcome });
    const key = input.prompt_id ?? state.turn?.key ?? "unknown";
    if (!state.turn || (input.prompt_id && state.turn.key !== input.prompt_id)) state.turn = newTurn(key);
    if (kind === "midTask") {
      state.turn = updateTurn(state.turn, analyzeBatch(toolCallsFrom(input)));
      // The prompt's tip, if it waited for the level, is decided now with the trusted one.
      if (state.turn.promptRec && !state.turn.promptDecided && current.trusted) {
        state.turn = { ...state.turn, promptDecided: true };
        const promptDecision = decide({ event: "prompt", current: current.level, rec: state.turn.promptRec, state, config });
        if (promptDecision.speak) {
          rec = state.turn.promptRec;
          tipKind = "prompt";
          decision = promptDecision;
        }
      }
      if (!decision) rec = current.level ? midTaskRecommendation(state.turn, current.level, config, { turnRec: state.turn.promptRec }) : null;
    } else if (input.stop_hook_active !== true) {
      rec = classifyNextStep(typeof input.last_assistant_message === "string" ? input.last_assistant_message : "", state.turn, { turnRec: state.turn.promptRec });
    }
  }

  decision ??= decide({ event: tipKind, current: current.level, rec, state, config });
  // Only xhigh and max can be missing from a model's menu; look the model up only then.
  if (decision.speak && (decision.to === "xhigh" || decision.to === "max")) {
    const model = typeof input.model === "string" ? input.model : lastModelInTranscript(input.transcript_path);
    if (!offeredLevels(model).includes(decision.to)) decision = { speak: false, why: "level_not_offered" };
  }
  // A hook can't see whether Ultracode is on, so it only ever suggests turning it on.
  const ultracodeDecision = ultracodeAdvice?.advice === "on" ? decideUltracode({ advice: ultracodeAdvice, state, config }) : null;
  const ultracodeText = ultracodeDecision?.speak ? formatUltracodeMessage({ to: "on", advice: ultracodeAdvice, buttons: false }) : "";
  let output = null;
  if (decision.speak || ultracodeText) {
    const effortText = decision.speak ? formatUserMessage({ event: tipKind, from: decision.from, to: decision.to, rec, sustained: decision.sustained }) : "";
    // The desktop app names xhigh "Extra" in its effort menu; Claude's own note keeps the codes.
    const surface = env.CLAUDE_CODE_ENTRYPOINT === "claude-desktop" ? "desktop" : "terminal";
    const userText = labelLevels([effortText, ultracodeText].filter(Boolean).join(" "), surface);
    const modelText = decision.speak
      ? formatModelContext({ event: tipKind, from: decision.from, to: decision.to, rec })
      : `[Effort advisor — suggestion only] ${ultracodeText} Mention it once, in one short line, then continue.`;
    output = buildOutput({ hookEventName: input.hook_event_name, kind, channel: config.channel, userText, modelText });
    if (output && decision.speak) {
      state.lastSuggestion = { from: decision.from, to: decision.to, promptCount: state.promptCount, event: tipKind };
      state.pending = { to: decision.to, direction: decision.direction, promptCount: state.promptCount };
      state.turn = { ...state.turn, suggestedTo: decision.to };
    }
    if (output && ultracodeText) state.lastUltracode = { to: "on", promptCount: state.promptCount };
  }
  if (current.level && current.trusted) state.lastEffort = current.level;
  writeState(path, state);
  if (kind === "prompt") pruneStates(dirname(path));
  if (config.logDecisions) {
    logs.push({
      at,
      event: kind,
      current: current.level,
      source: current.source,
      trusted: current.trusted,
      tip: output ? tipKind : null,
      recommended: rec?.level ?? null,
      category: rec?.category ?? null,
      confidence: rec?.confidence ?? null,
      spoke: Boolean(output),
      why: decision.why,
    });
    for (const entry of logs) logDecision(root, entry);
  }
  return output;
}
