// Effort Advisor core: pure functions only (no filesystem, no network, no clock).
// Prompt and message text is inspected in memory and never returned, stored or logged;
// only derived labels (category, level, signal tags) leave these functions.

export const LEVELS = Object.freeze(["low", "medium", "high", "xhigh", "max"]);
const LEVEL_INDEX = new Map(LEVELS.map((level, index) => [level, index]));
// A level that already adapts by itself ("/effort auto" leaves it to the model).
export const ADAPTIVE_LEVELS = Object.freeze(["auto"]);

export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  // Command hook only. Where suggestions go: "systemMessage" (shown to the user by
  // the host), "context" (Claude mentions it in one line) or "both".
  channel: "systemMessage",
  // Claude mod only: where tips are drawn. All display-only; Claude never sees them.
  display: Object.freeze({ band: true, toast: true, beneathAnswer: true }),
  events: Object.freeze({ prompt: true, midTask: true, stop: true }),
  minConfidence: 0.6,
  stopMinConfidence: 0.7,
  // Downshifts need a gap of at least this many levels, except from max (costly).
  downshiftMinSteps: 2,
  maxSingleStepConfidence: 0.75,
  // Never suggest going below this level unless the user asked for it explicitly.
  downshiftFloor: "medium",
  // Same suggestion stays quiet for this many prompts; doubles each time it is ignored.
  cooldownPrompts: 3,
  maxCooldownPrompts: 24,
  // Quick-answer downshifts wait until this many recent prompts agree.
  sustainedWindow: 3,
  // Mid-task rules.
  debugFailureThreshold: 3,
  mechanicalEditThreshold: Object.freeze({ max: 6, xhigh: 8 }),
  ultracodeHints: true,
  logDecisions: false,
});

// Categories whose answers usually finish before a switch could matter.
const SHORT_TASKS = new Set(["quick", "explain", "small_edit"]);

export function normalizeLevel(value) {
  let level = value;
  if (level && typeof level === "object") level = level.level ?? level.effort ?? level.value;
  if (typeof level !== "string") return null;
  level = level.trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (level === "extrahigh") level = "xhigh";
  if (level === "maximum") level = "max";
  if (LEVEL_INDEX.has(level) || ADAPTIVE_LEVELS.includes(level)) return level;
  return null;
}

export const levelIndex = (level) => LEVEL_INDEX.get(level) ?? -1;
export const isAdaptive = (level) => ADAPTIVE_LEVELS.includes(level);
const clampIndex = (index) => Math.max(0, Math.min(LEVELS.length - 1, index));
const shiftLevel = (level, steps) => LEVELS[clampIndex(levelIndex(level) + steps)];

const NESTED_KEYS = ["display", "events", "mechanicalEditThreshold"];

export function mergeConfig(base = DEFAULT_CONFIG, override = {}) {
  const merged = { ...base };
  for (const key of NESTED_KEYS) merged[key] = { ...base[key] };
  if (!override || typeof override !== "object") return merged;
  for (const [key, value] of Object.entries(override)) {
    if (!(key in base)) continue;
    if (NESTED_KEYS.includes(key)) {
      if (!value || typeof value !== "object") continue;
      for (const [inner, innerValue] of Object.entries(value)) {
        if (inner in base[key] && typeof innerValue === typeof base[key][inner]) merged[key][inner] = innerValue;
      }
    } else if (typeof value === typeof base[key]) {
      merged[key] = value;
    }
  }
  if (!["systemMessage", "context", "both"].includes(merged.channel)) merged.channel = base.channel;
  if (levelIndex(merged.downshiftFloor) < 0) merged.downshiftFloor = base.downshiftFloor;
  return merged;
}

// ---------------------------------------------------------------------------
// Prompt features and classification

const signal = (re, weight, tag) => ({ re, weight, tag });

// Ordered by the level each category usually needs. Weights: 1 weak, 2 medium, 3 strong.
const CATEGORIES = Object.freeze({
  design: {
    level: "max",
    label: "a design or architecture decision",
    signals: [
      signal(/\b(?:system|software|solution|overall|high[- ]level|target)\s+(?:design|architecture)\b/, 3, "system design"),
      signal(/\b(?:design|write|draft|create|outline|propose|produce)\s+(?:a|an|the|our|my)?\s*(?:spec(?:ification)?|design doc(?:ument)?|prd|rfc|adr|technical design|architecture)\b/, 3, "write a spec"),
      signal(/\barchitect(?:ure|ural|ing)?\b/, 2, "architecture"),
      signal(/\b(?:spec(?:ification)?s?|prd|rfc|adr|design doc(?:ument)?s?)\b/, 2, "spec"),
      signal(/\btrade[- ]?offs?\b/, 2, "trade-offs"),
      signal(/\b(?:decide|choose|pick)\s+(?:between|on|whether|which)\b|\bwhich\s+(?:approach|option|design|architecture|strategy|stack)\b/, 2, "decision"),
      signal(/\b(?:data model(?:ing)?|schema design|api design|protocol design|domain model(?:ing)?)\b/, 2, "modeling"),
      signal(/\b(?:strategy|roadmap|long[- ]term plan|migration plan)\b/, 2, "strategy"),
      signal(/\bfrom first principles\b/, 2, "first principles"),
      signal(/\b(?:design|plan)\s+(?:out\s+)?(?:the|a|an|our|how)\b/, 1, "plan"),
    ],
  },
  research_hard: {
    level: "max",
    label: "hard research",
    signals: [
      signal(/\bdeep(?:[- ]dive|ly)?\s+research\b|\bresearch\s+(?:deeply|thoroughly|extensively|in depth)\b/, 3, "deep research"),
      signal(/\b(?:comprehensive|exhaustive|systematic|in[- ]depth)\s+(?:research|survey|comparison|analysis|review|evaluation|study)\b/, 3, "in-depth analysis"),
      signal(/\bliterature review\b|\bstate[- ]of[- ]the[- ]art\b/, 2, "literature"),
      signal(/\b(?:compare|evaluate|assess|weigh)\s+(?:all|several|multiple|many|the main|different|competing|various)\s+(?:options|alternatives|approaches|tools|libraries|frameworks|vendors|solutions|candidates)\b/, 2, "compare options"),
    ],
  },
  debug: {
    level: "xhigh",
    label: "tricky debugging",
    signals: [
      signal(/\b(?:debug(?:ging)?|diagnos(?:e|is|ing)|root[- ]cause|troubleshoot(?:ing)?|bisect(?:ing)?)\b/, 2, "debugging"),
      signal(/\b(?:flaky|intermittent(?:ly)?|race condition|deadlock(?:s|ed)?|memory leak|heisenbug|segfault|segmentation fault|corrupt(?:ed|ion)|hangs|hanging|freez(?:es|ing))\b/, 3, "hard failure"),
      signal(/\bstill\s+(?:fail(?:s|ing)?|broken|crash(?:es|ing)?|not working|doesn'?t work|happening|wrong|slow)\b/, 3, "still failing"),
      signal(/\bwhy\s+(?:does|is|did|do|are|would|won'?t|can'?t|isn'?t|doesn'?t)\b[^?.!\n]{0,80}\b(?:fail|break|crash|hang|error|slow|wrong|differ|miss)/, 2, "why it fails"),
      signal(/\b(?:doesn'?t|does not|isn'?t|is not|won'?t|stopped)\s+work(?:ing)?\b|\bnot working\b/, 1, "not working"),
      signal(/\b(?:regression|performance (?:issue|problem|regression|bug)|slowdown)\b/, 1, "regression"),
    ],
  },
  review: {
    level: "xhigh",
    label: "reviewing a big change",
    signals: [
      signal(/\bcode[- ]review\b|\breview\s+(?:the|this|my|our|a|all|these)?\s*(?:pr|pull request|diff|change(?:s|set)?|branch|commits?|patch|implementation|code(?:base)?|repo(?:sitory)?)\b/, 3, "code review"),
      signal(/\b(?:audit|security review|threat model(?:ing)?|pen ?test(?:ing)?)\b/, 2, "audit"),
      signal(/\breview\b/, 1, "review"),
      signal(/\b(?:critique|double[- ]check|sanity[- ]check|look over|go over)\b/, 1, "check"),
    ],
  },
  build: {
    level: "high",
    label: "everyday build or fix work",
    signals: [
      signal(/\b(?:implement|build|create|develop|make|generate|scaffold|wire up|hook up|integrate|port)\b/, 1, "build"),
      signal(/\b(?:add|write)\s+(?:a|an|the|some|new|support|tests?|docs?|code)\b/, 1, "add"),
      signal(/\b(?:fix|repair|resolve|patch)\b/, 1, "fix"),
      signal(/\bfix\s+(?:the|this|that|a|an|these|those)?\s*(?:bug|error|crash|issue|failing|broken|test|build|exception)/, 1, "fix error"),
      signal(/\b(?:install|configure|set ?up|deploy|migrate|upgrade|refactor|convert|automate)\b/, 1, "setup"),
      signal(/\b(?:write|add|run|update|rerun|re-run)\s+(?:the\s+)?(?:unit |integration |e2e |acceptance |smoke )?tests?\b|\bacceptance (?:test|check)s?\b/, 2, "tests"),
    ],
  },
  research: {
    level: "high",
    label: "research",
    signals: [
      signal(/\b(?:research|investigate|explore|survey|look into|study)\b/, 2, "research"),
      signal(/\b(?:compare|evaluate|benchmark|assess)\b/, 1, "compare"),
    ],
  },
  explain: {
    level: "medium",
    label: "an explanation",
    signals: [
      signal(/^\s*(?:please\s+)?(?:explain|summari[sz]e|describe|clarify|define|tl;?dr|eli5)\b/, 3, "explain"),
      signal(/\b(?:explain|summari[sz]e|walk me through|tell me about|what does|how does|what is|what are|what's|meaning of|difference between)\b/, 2, "explain"),
    ],
  },
  small_edit: {
    level: "medium",
    label: "a small edit",
    signals: [
      signal(/\b(?:rename|typo|reword|rephrase|retitle|reformat|indent|bump the version|tweak)\b/, 2, "small edit"),
      signal(/\b(?:one[- ]line(?:r)?|single[- ]line|small|tiny|minor|trivial|little|quick)\s+(?:change|edit|fix|tweak|update|thing|cleanup)\b/, 3, "small change"),
      signal(/\bchange\s+(?:the\s+)?(?:colou?r|text|label|title|name|wording|font|icon|copy|spelling)\b/, 2, "cosmetic"),
    ],
  },
  quick: {
    level: "low",
    label: "a quick question",
    signals: [
      signal(/^\s*(?:quick question|qq)\b/, 3, "quick question"),
      signal(/\b(?:what time|which (?:file|folder|branch|version|port)|where (?:is|are|do i find)|is there (?:a|an)|how many|what's the (?:command|path|shortcut|name))\b/, 1, "lookup"),
    ],
  },
});

const CATEGORY_NAMES = Object.keys(CATEGORIES);
// An optional external classifier's task mode adds one weak vote (it never replaces the signals).
const ROUTER_VOTES = Object.freeze({
  diagnose: "debug",
  research_or_review: "research",
  change_or_build: "build",
  answer_or_explain: "explain",
});

const CONTINUE_RE = /^(?:(?:yes|yep|yeah|yup|ok(?:ay)?|sure|fine|great|perfect|cool|nice|thanks?(?: you)?|ty|go(?: ahead| on| for it)?|do it|do that|proceed|continue|keep going|carry on|sounds good|looks good|lgtm|approved?|confirm(?:ed)?|agreed|next|resume|retry|try again|again|please|pls|y|k|done)[\s,.!]*)+$/iu;
const EXPLICIT_RE = /\b(?:use|using|at|with|switch(?:ing)? to|set(?: it)? to|on)\s+(low|medium|high|x-?high|extra[- ]high|max(?:imum)?)\s+effort\b|\beffort\s*(?:level)?\s*(?:[:=]|to|at|of)\s*(low|medium|high|x-?high|max)\b/i;
const QUICK_CUE_RE = /\b(?:quick(?:ly)?|simple|tiny|minor|trivial|brief(?:ly)?|short answer|one[- ]liner|real quick)\b/g;
const DEPTH_CUE_RE = /\b(?:careful(?:ly)?|thorough(?:ly)?|rigorous(?:ly)?|in[- ]depth|deep(?:ly)?|deep[- ]dive|think (?:hard|deeply|carefully)|tricky|subtle|complex|complicated|difficult|high[- ]stakes|security[- ]sensitive)\b/g;
const ULTRACODE_SCOPE_RE = /\b(?:entire|whole|full|complete|every)\s+(?:code ?base|repo(?:sitory)?|project|system|monorepo|app(?:lication)?|change ?set)\b|\b(?:big|large|huge|massive|sweeping)\s+(?:pr|pull request|change|refactor|diff|migration|branch)\b/;
const ERROR_DUMP_RE = /traceback \(most recent call last\)|^\s+at [\w.$<>[\]]+ \(.*:\d+:\d+\)|\bexception in thread\b|\bnpm err!|\berror\[e\d{4}\]|\bpanic:|segmentation fault|\bassertionerror\b|^\s*failed\b.*::/im;
const QUESTION_START_RE = /^\s*(?:what|which|where|when|who|whose|is|are|does|do|did|can|could|should|how|why)\b/;

function countMatches(re, text) {
  re.lastIndex = 0;
  return (text.match(re) ?? []).length;
}

export function textFeatures(text) {
  const raw = typeof text === "string" ? text : String(text ?? "");
  const blocks = [];
  const prose = raw.replace(/```[\s\S]*?(?:```|$)/g, (block) => {
    blocks.push(block);
    return " ";
  });
  const lower = prose.toLowerCase();
  const lines = prose.split(/\r?\n/).filter((line) => line.trim());
  const code = blocks.join("\n");
  return {
    prose: lower,
    length: raw.length,
    wordCount: (lower.match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu) ?? []).length,
    lineCount: lines.length,
    listItems: lines.filter((line) => /^\s*(?:[-*•]|\d+[.)]|[a-z][.)])\s+/i.test(line)).length,
    questions: countMatches(/\?/g, prose),
    pastedError: ERROR_DUMP_RE.test(code) || ERROR_DUMP_RE.test(prose),
    quickCues: countMatches(QUICK_CUE_RE, lower),
    depthCues: countMatches(DEPTH_CUE_RE, lower),
  };
}

function scoreCategories(features, routerMode) {
  const scores = Object.fromEntries(CATEGORY_NAMES.map((name) => [name, 0]));
  const tags = Object.fromEntries(CATEGORY_NAMES.map((name) => [name, []]));
  for (const name of CATEGORY_NAMES) {
    for (const item of CATEGORIES[name].signals) {
      if (item.re.test(features.prose)) {
        scores[name] += item.weight;
        tags[name].push(item.tag);
      }
    }
  }
  if (features.pastedError) {
    scores.debug += 1;
    tags.debug.push("pasted error output");
  }
  const vote = ROUTER_VOTES[routerMode];
  if (vote && scores[vote] > 0) {
    scores[vote] += 1;
    tags[vote].push(`router:${routerMode}`);
  }
  const others = Math.max(...CATEGORY_NAMES.filter((name) => name !== "quick").map((name) => scores[name]));
  if (features.wordCount <= 15 && (features.questions > 0 || QUESTION_START_RE.test(features.prose)) && others <= 1) {
    scores.quick += 2;
    tags.quick.push("short question");
  }
  return { scores, tags };
}

// Ties go to the category whose level is closest to "high", the usual default.
const closenessToDefault = (name) => Math.abs(levelIndex(CATEGORIES[name].level) - levelIndex("high"));

function silent(reason, extra = {}) {
  return { level: null, confidence: 0, category: null, reasons: [], skip: reason, ...extra };
}

/**
 * Classify one prompt into a recommended effort level.
 * Returns derived labels only; the text itself is never part of the result.
 */
export function classifyPrompt(prompt, options = {}) {
  const text = typeof prompt === "string" ? prompt : String(prompt ?? "");
  const trimmed = text.trim();
  if (!trimmed) return silent("empty");
  if (trimmed.startsWith("/")) return silent("slash_command");
  if (trimmed.length <= 60 && CONTINUE_RE.test(trimmed)) return silent("continuation");
  const lowered = trimmed.toLowerCase();
  if (/\bultrathink\b/.test(lowered)) return silent("ultrathink_requested");
  const ultracodeRequested = /\bultracode\b/.test(lowered);

  const explicit = EXPLICIT_RE.exec(trimmed);
  if (explicit) {
    const level = normalizeLevel((explicit[1] ?? explicit[2] ?? "").replace(/\s+/g, ""));
    if (level && !isAdaptive(level)) {
      return { level, confidence: 0.95, category: "explicit", label: "the level you asked for", reasons: ["explicit request"], explicit: true, ultracodeHint: false };
    }
  }

  const features = textFeatures(trimmed);
  const { scores, tags } = scoreCategories(features, options.routerMode);
  const ranked = CATEGORY_NAMES
    .filter((name) => scores[name] > 0)
    .sort((a, b) => scores[b] - scores[a] || closenessToDefault(a) - closenessToDefault(b));
  if (!ranked.length) return silent("no_signal", { features: summarizeFeatures(features) });

  const top = ranked[0];
  let category = top;
  let level = CATEGORIES[top].level;
  // A strong secondary signal for a harder category raises the level (build + architecture → max).
  for (const name of ranked.slice(1)) {
    if (scores[name] >= 3 && levelIndex(CATEGORIES[name].level) > levelIndex(level)) {
      level = CATEGORIES[name].level;
      category = name;
    }
  }

  let shift = 0;
  const reasons = [...tags[category]];
  if (features.quickCues > 0 && !["quick", "small_edit"].includes(category)) {
    shift -= 1;
    reasons.push("asked for something quick");
  }
  if (features.depthCues > 0) {
    shift += 1;
    reasons.push("asked for depth");
  }
  const multiPart = features.listItems >= 5 || (features.wordCount >= 200 && features.lineCount >= 6);
  if (multiPart && ["build", "research", "review", "debug"].includes(category)) {
    shift += 1;
    reasons.push("multi-part task");
  }
  shift = Math.max(-1, Math.min(1, shift));
  level = shiftLevel(level, shift);

  let confidence = 0.35 + 0.15 * Math.min(scores[top], 4);
  const runnerUp = ranked[1];
  if (runnerUp && scores[runnerUp] >= scores[top] * 0.75 && CATEGORIES[runnerUp].level !== CATEGORIES[top].level && category === top) {
    confidence -= 0.15;
  }
  if (features.wordCount < 4) confidence -= 0.1;
  confidence = Math.round(Math.max(0, Math.min(0.95, confidence)) * 100) / 100;

  const reviewLike = category === "review" || scores.review >= 3 || (category === "research_hard" && /\baudit\b/.test(features.prose));
  return {
    level,
    confidence,
    category,
    label: CATEGORIES[category].label,
    reasons: [...new Set(reasons)].slice(0, 4),
    shortTask: SHORT_TASKS.has(category),
    ultracodeHint: reviewLike && !ultracodeRequested && ULTRACODE_SCOPE_RE.test(features.prose),
    features: summarizeFeatures(features),
  };
}

function summarizeFeatures(features) {
  return {
    wordCount: features.wordCount,
    listItems: features.listItems,
    pastedError: features.pastedError,
  };
}

// ---------------------------------------------------------------------------
// End of turn: predict the effort the likely next step needs.

const UNRESOLVED_RE = /\bstill\s+(?:fail(?:s|ing)?|broken|crash(?:es|ing)?|flaky|not working|reproduc(?:es|ing))\b|\bcould(?:n'?t| not)\s+(?:reproduce|find the cause|determine|fix|explain)\b|\broot cause\s+(?:is\s+)?(?:still\s+)?(?:unknown|unclear|not (?:yet )?(?:found|known|clear))\b|\bnot\s+(?:yet\s+)?(?:fixed|resolved)\b|\bintermittent(?:ly)?\b|\bflaky\b/i;
const IMPLEMENT_NEXT_RE = /\b(?:approve|approval of)\s+(?:the|this)\s+(?:plan|design|spec|approach)\b|\b(?:plan|design|spec) is ready\b|\bready to (?:implement|build|start)\b|\b(?:shall|should|can) i (?:start|go ahead|implement|build|apply|make the changes)\b|\b(?:want|like) me to (?:implement|build|apply|make|start|proceed)\b|\bgo ahead and (?:implement|build)\b/i;
const NEXT_MARKER_RE = /\b(?:next step|next,|next i|want me to|would you like me to|should i|shall i|i can (?:now |also )?|ready to|remaining|left to do|follow[- ]up|then i'll|after that|todo)\b/i;

export function classifyNextStep(lastMessage, turn = {}) {
  const text = typeof lastMessage === "string" ? lastMessage : "";
  if (!text.trim()) return silent("no_message");
  const tail = text.slice(-2000);
  if (UNRESOLVED_RE.test(tail)) {
    const strong = (turn.failures ?? 0) >= 2;
    return { level: "xhigh", confidence: strong ? 0.85 : 0.75, category: "debug", label: "debugging", reasons: ["unresolved failure"], nextStep: true };
  }
  if (IMPLEMENT_NEXT_RE.test(tail)) {
    return { level: "high", confidence: 0.8, category: "build", label: "implementation", reasons: ["plan ready for implementation"], nextStep: true };
  }
  const sentences = tail.split(/(?<=[.?!])\s+|\n+/).filter((sentence) => NEXT_MARKER_RE.test(sentence)).slice(-3);
  if (!sentences.length) return silent("no_next_step");
  const result = classifyPrompt(sentences.join(" ").replace(/\b(?:want|would you like) me to\b|\b(?:should|shall|can) i\b/gi, " "));
  if (!result.level) return result;
  return { ...result, confidence: Math.max(0, Math.round((result.confidence - 0.05) * 100) / 100), nextStep: true, ultracodeHint: false };
}

// ---------------------------------------------------------------------------
// Mid-task: tool batches.

const EDIT_TOOLS_RE = /^(?:Edit|Write|MultiEdit|NotebookEdit|apply_patch|edit_file|write_file)$/;
const FAILURE_RE = /^\s*(?:Exit code [1-9]\d*|<tool_use_error>|Error:|error:|Command failed|Command timed out)/;

function responseHead(response) {
  if (typeof response === "string") return response.slice(0, 300);
  if (Array.isArray(response)) {
    const first = response.find((part) => typeof part?.text === "string");
    return first ? first.text.slice(0, 300) : "";
  }
  if (response && typeof response === "object" && typeof response.error === "string") {
    return `Error: ${response.error.slice(0, 200)}`;
  }
  return "";
}

export function analyzeBatch(toolCalls) {
  const calls = Array.isArray(toolCalls) ? toolCalls : [];
  let edits = 0;
  let failures = 0;
  for (const call of calls) {
    const name = String(call?.tool_name ?? call?.name ?? "");
    const failed = call?.is_error === true || call?.error != null || FAILURE_RE.test(responseHead(call?.tool_response ?? call?.output));
    if (failed) failures += 1;
    else if (EDIT_TOOLS_RE.test(name)) edits += 1;
  }
  return { calls: calls.length, edits, failures };
}

export function newTurn(key) {
  return { key, batches: 0, calls: 0, edits: 0, editStreak: 0, failures: 0, failingBatches: 0, suggestedTo: null };
}

export function updateTurn(turn, batch) {
  const next = { ...turn };
  next.batches += 1;
  next.calls += batch.calls;
  next.edits += batch.edits;
  next.failures += batch.failures;
  if (batch.failures > 0) {
    next.failingBatches += 1;
    next.editStreak = 0;
  } else {
    next.editStreak += batch.edits;
  }
  return next;
}

export function midTaskRecommendation(turn, current, config = DEFAULT_CONFIG) {
  if (turn.failures >= config.debugFailureThreshold && turn.failingBatches >= 2 && levelIndex(current) < levelIndex("xhigh")) {
    return { level: "xhigh", confidence: 0.75, category: "debug_spiral", label: "tricky debugging", reasons: [`${turn.failures} failed tool runs this turn`], midTask: true };
  }
  const threshold = config.mechanicalEditThreshold?.[current];
  if (Number.isFinite(threshold) && turn.editStreak >= threshold) {
    return { level: "high", confidence: 0.75, category: "mechanical", label: "straightforward edits", reasons: [`${turn.editStreak} edits in a row without failures`], midTask: true, allowSingleStep: true };
  }
  return silent("no_mid_task_signal");
}

// ---------------------------------------------------------------------------
// Policy: decide whether to speak.

export function cooldownFor(state, direction, config = DEFAULT_CONFIG) {
  const ignored = state?.ignored?.[direction] ?? 0;
  return Math.min(config.maxCooldownPrompts, config.cooldownPrompts * 2 ** ignored);
}

// Some older models leave levels out of the effort menu (Claude Code 2.1.317).
// Best effort: an unknown or newer model is assumed to offer all five.
const LIMITED_MODELS = Object.freeze([
  [/claude-(?:opus|sonnet)-4-6/i, ["low", "medium", "high", "max"]],
  [/claude-(?:opus|sonnet)-4-5/i, ["low", "medium", "high"]],
]);

export function offeredLevels(model) {
  if (typeof model !== "string" || !model) return LEVELS;
  const limited = LIMITED_MODELS.find(([pattern]) => pattern.test(model));
  return limited ? limited[1] : LEVELS;
}

/**
 * @param {object} args
 * @param {"prompt"|"midTask"|"stop"} args.event
 * @param {string|null} args.current  current effort level as reported by the host
 * @param {object} args.rec           a classifier result
 * @param {object} args.state         per-session state (derived labels only)
 * @param {string} [args.model]       the model in use, when known
 */
export function decide({ event, current, rec, state = {}, config = DEFAULT_CONFIG, model = null }) {
  if (!config.enabled) return { speak: false, why: "disabled" };
  if (!rec?.level) return { speak: false, why: rec?.skip ?? "no_recommendation" };
  if (!current) return { speak: false, why: "current_unknown" };
  // An adaptive level already picks its own depth; comparing against it would only add noise.
  if (isAdaptive(current)) return { speak: false, why: "adaptive_current" };
  // Turn-end tips are never less strict than the others.
  const minConfidence = event === "stop" ? Math.max(config.stopMinConfidence, config.minConfidence) : config.minConfidence;
  if (rec.confidence < minConfidence) return { speak: false, why: "low_confidence" };

  let target = rec.level;
  const currentIndex = levelIndex(current);
  if (levelIndex(target) < currentIndex && !rec.explicit) {
    target = LEVELS[Math.max(levelIndex(target), levelIndex(config.downshiftFloor))];
  }
  const delta = levelIndex(target) - currentIndex;
  if (delta === 0) return { speak: false, why: "matches_current" };
  const direction = delta > 0 ? "up" : "down";

  let sustained = false;
  if (direction === "down" && !rec.explicit) {
    const steps = -delta;
    sustained = recentAgree(state.window, target, event, config.sustainedWindow);
    // A quick answer is finished before a switch could help it; wait for a pattern.
    if (rec.shortTask && !sustained) return { speak: false, why: "short_task_not_sustained" };
    const singleStepOk = steps === 1 && (current === "max" || rec.allowSingleStep) && rec.confidence >= config.maxSingleStepConfidence;
    if (steps < config.downshiftMinSteps && !singleStepOk && !sustained) {
      return { speak: false, why: "small_downshift" };
    }
  }

  // A tip the user cannot follow (the model has no such level) is worse than none.
  if (!offeredLevels(model).includes(target)) return { speak: false, why: "level_not_offered" };
  if (state.turn?.suggestedTo === target) return { speak: false, why: "already_suggested_this_turn" };
  const last = state.lastSuggestion;
  if (!rec.explicit && last && last.to === target && last.from === current) {
    const since = (state.promptCount ?? 0) - (last.promptCount ?? 0);
    if (since < cooldownFor(state, direction, config)) return { speak: false, why: "cooldown" };
  }
  return { speak: true, from: current, to: target, direction, sustained, why: "suggest" };
}

// Recent prompts agree the work is lighter (the window already holds this prompt's level).
function recentAgree(window, target, event, size = 3) {
  if (event !== "prompt" || !Array.isArray(window) || window.length < size) return false;
  return window.slice(-size).every((entry) => levelIndex(entry) >= 0 && levelIndex(entry) <= levelIndex(target));
}

// ---------------------------------------------------------------------------
// Messages (short, answer first).

const EFFORT_MENU = "the effort menu next to the model picker";

export function formatUserMessage({ event, from, to, rec, sustained = false, ultracode = true }) {
  const label = rec?.label ?? "this";
  const up = levelIndex(to) > levelIndex(from);
  const applyNow = `To use it for this task, pick ${to} in ${EFFORT_MENU}, then send "keep going".`;
  const parts = [];
  if (event === "midTask") {
    parts.push(up
      ? `Effort tip: this has turned into ${label}, so ${to} may help (you're on ${from}).`
      : `Effort tip: the work is now ${label}, so ${to} is enough (you're on ${from}).`);
    parts.push(applyNow);
  } else if (event === "stop") {
    parts.push(up
      ? `Effort tip for the next step (${label}): ${to} may help (you're on ${from}).`
      : `Effort tip for the next step (${label}): ${to} should be enough (you're on ${from}).`);
    parts.push(`Switch in ${EFFORT_MENU} before you send it.`);
  } else if (rec?.explicit) {
    parts.push(`Effort tip: you asked for ${to}, but this session is on ${from}.`);
    parts.push(applyNow);
  } else if (sustained) {
    parts.push(`Effort tip: your recent requests are lighter, so ${to} is enough (you're on ${from}).`);
    parts.push(`Switch in ${EFFORT_MENU}; it applies from your next message.`);
  } else {
    parts.push(up
      ? `Effort tip: ${to} suits this (${label}); you're on ${from}.`
      : `Effort tip: ${to} is enough for this (${label}); you're on ${from}, which is slower.`);
    parts.push(applyNow);
  }
  if (ultracode && rec?.ultracodeHint) {
    parts.push(`For a full audit, Ultracode (multi-agent, much more usage) is an option: include the word "ultracode" in a prompt.`);
  }
  return parts.join(" ");
}

export function formatModelContext({ event, from, to, rec }) {
  const when = event === "prompt"
    ? "Mention it once, in one short line at the start of your reply, then continue at the current level."
    : "Mention it once, in one short line in your next message to the user, then continue at the current level.";
  return [
    "[Effort advisor — suggestion only; fail-open hook]",
    `Recommended effort: ${to}; current: ${from}; reason: ${rec?.label ?? "task shape"}${rec?.reasons?.length ? ` (${rec.reasons.join(", ")})` : ""}.`,
    `Only the user can change effort, in ${EFFORT_MENU}. ${when}`,
    "Do not wait for the switch, do not repeat the tip later in this turn, and do not change any settings.",
  ].join("\n");
}
