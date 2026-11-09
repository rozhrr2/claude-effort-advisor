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
  // Turn-end tips go to the band (with its Switch button) unless beneathAnswer is on.
  display: Object.freeze({ band: true, toast: true, beneathAnswer: false }),
  events: Object.freeze({ prompt: true, midTask: true, stop: true }),
  // How many earlier messages a prompt is read against (follow-ups, task context).
  contextMessages: 12,
  // Learn from which tips you follow or dismiss (mod only; counts, no text).
  learning: true,
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
      signal(/\barchitect(?:ure|ural|ing)?\b(?!\s+(?:diagrams?|sections?|docs?|notes|pages?|overview|readme|folder))/, 1, "architecture"),
      signal(/\b(?:design|rethink|redesign|re-architect|plan|propose|restructure)\b[^.?!\n]{0,40}\barchitecture\b(?!\s+(?:diagrams?|sections?|docs?|notes|pages?|overview|readme|folder))|\barchitecture\b(?!\s+(?:diagrams?|sections?|docs?|notes|pages?|overview|readme|folder))[^.?!\n]{0,30}\b(?:for|of) (?:the|a|our|this) (?:new|whole|entire)?\s*\w+/, 2, "architecture work"),
      // A spec as a reference ("per the spec", "in the design doc") or a test file ("e2e specs")
      // is not a spec to write.
      signal(/(?<!\b(?:test|tests|e2e|unit|cypress|playwright|jest|vitest|~?\d+|per|from|in|into|to|with|against|following|according to|for)\s+(?:the\s+|our\s+|this\s+)?)\b(?:spec(?:ification)?s?|prd|rfc|adr|design doc(?:ument)?s?)\b(?!\s+(?:files?|runner|suite|says)\b)/, 1, "spec"),
      signal(/\b(?:need|want|give me|looking for) (?:an? )?(?:actual |real |concrete |clear |solid )?recommendation\b/, 2, "decision"),
      signal(/\btrade[- ]?offs?\b/, 2, "trade-offs"),
      signal(/\b(?:decide|choose|pick)\s+(?:between|on|whether|which)\b|\bwhich\s+(?:approach|option|design|architecture|strategy|stack)\b/, 2, "decision"),
      signal(/\b(?:data model(?:ing)?|schema design|api design|protocol design|domain model(?:ing)?)\b/, 2, "modeling"),
      signal(/\b(?:strategy|roadmap|long[- ]term plan|migration plan)\b/, 2, "strategy"),
      signal(/\bfrom first principles\b/, 2, "first principles"),
      signal(/\b(?:design|plan)\s+(?:out\s+)?(?:the|a|an|our|how)\b/, 1, "plan"),
      signal(/\bshould (?:we|i)\s+(?:split|merge|move|switch|migrate|use|adopt|rewrite|keep|go with|choose|break|replace|consolidate|introduce)\b|\bwhether (?:we|i) should\b/, 2, "should-we decision"),
      signal(/\b[\w.+-]+\s+vs\.?\s+(?!code\b)[\w.+-]+\b|\bversus\b/, 2, "comparison"),
      signal(/\b(?:no redo|no going back|can'?t (?:undo|roll (?:it )?back)|irreversible|one[- ]way door|hard to (?:reverse|undo|change later))\b|\b(?:is (?:it|this|that|a [\w-]+(?: [\w-]+)?) )?worth it or overkill\b|\bis (?:it|this) overkill\b/, 2, "decision"),
      signal(/\b(?:monolith|micro-?services?|(?:into|as) (?:its|their) own (?:service|package|repo)|service boundar(?:y|ies)|event[- ]driven|cqrs|event sourcing|shard(?:ing|ed)|multi[- ]region|consistency model|eventual consistency|caching (?:strategy|layer)|cache invalidation|schema evolution|offline[- ]first|conflict resolution|crdts?|multi[- ]tenan(?:t|cy)|plugin system|permission model|shard (?:by|on|key)|partition (?:by|key))\b/, 1, "architecture topic"),
      signal(/\b(?:poke holes|tear (?:it|this) apart|be brutal|critique (?:the|this|my) (?:design|plan|proposal|approach|architecture)|devil'?s advocate|stress[- ]test (?:the|this|my) (?:design|plan|idea|proposal))\b/, 3, "design critique"),
      signal(/\b(?:need to decide|help me decide|which (?:one|option|approach) (?:should|do|would)|what would you (?:pick|choose|recommend)|your take on|pros and cons|the right approach|how should we (?:structure|model|handle|design|split|organi[sz]e))\b|^\s*(?:ok(?:ay)?\s+)?so which (?:one|option)\b/, 2, "decision"),
      signal(/\b(?:pick|choose|select|settle on) (?:a|an|the|our|one) [\w-]+(?: [\w-]+)? (?:for|to)\b|\boptions (?:on the table|we have|are)\b|\brecommend (?:one|a|an|the best|which)\b|\bwhich (?:one|option|approach|library|lib|tool|db|database|framework)\b[^.?!\n]{0,24}\bshould\b|\bshould (?:our|the|this|we) [\w-]+(?: [\w-]+)? be\b/, 2, "decision"),
      signal(/\b(?:exactly[- ]once|at[- ]least[- ]once|idempoten(?:t|cy)|back-?pressure|consensus|leader election|two[- ]phase commit|saga pattern|outbox pattern)\b/, 1, "architecture topic"),
    ],
  },
  research_hard: {
    level: "max",
    label: "hard research",
    signals: [
      signal(/\bdeep(?:[- ]dive|ly)?\s+research\b|\bresearch\s+(?:deeply|thoroughly|extensively|in depth)\b/, 3, "deep research"),
      signal(/\b(?:comprehensive|exhaustive|systematic|in[- ]depth|full|detailed|thorough|deep(?:er)?)\s+(?:research|survey|comparison|analysis|evaluation|study)\b/, 3, "in-depth analysis"),
      signal(/\bliterature review\b|\bstate[- ]of[- ]the[- ]art\b/, 2, "literature"),
      signal(/\b(?:compare|evaluate|assess|weigh)\s+(?:all|several|multiple|many|the main|different|competing|various)\s+(?:options|alternatives|approaches|tools|libraries|frameworks|vendors|solutions|candidates)\b/, 2, "compare options"),
      signal(/\b(?:full|broad|wide) survey\b|\bsurvey (?:of|the) (?:open[- ]source |available |existing |all )?[\w-]+|\bsurvey (?:how|what|which|where)\b|\bresearch (?:every|all|each) \b/, 3, "survey"),
      // Three or more named options to compare ("compare nx, turborepo, bazel and moonrepo").
      signal(/\b(?:compare|evaluate|benchmark|weigh)\s+[\w.@/-]+(?:,\s*[\w.@/-]+){1,}(?:,)?\s+(?:and|or|vs\.?)\s+[\w.@/-]+/, 3, "compare named options"),
      signal(/\bcompare (?:the |all (?:the )?|every )?(?:[\w-]+ ){0,4}?(?:libs?|librar(?:y|ies)|tools|frameworks|options|providers|vendors|queues|databases|dbs|orms|clients|sdks|engines|approaches)\b/, 2, "compare options"),
    ],
  },
  debug: {
    level: "xhigh",
    label: "tricky debugging",
    signals: [
      // "debug" as a log level, flag or build is not debugging work.
      signal(/(?<!\b(?:to|level|=|-)\s?)\bdebug(?:ging)?\b(?!\s+(?:mode|flag|level|logging|logs?|builds?|output|prints?|statements?|symbols?|info|menu|panel|toolbar|endpoint|page|log|messages?|config))|\b(?:diagnos(?:e|is|ing)|root[- ]causes?|troubleshoot(?:ing)?|bisect(?:ing)?)\b/, 2, "debugging"),
      signal(/\b(?:flaky|intermittent(?:ly)?|race condition|deadlock(?:s|ed)?|memory leak|heisenbug|segfault|segmentation fault|corrupt(?:s|ed|ing|ion)?|hangs|hanging|freez(?:es|ing))\b/, 3, "hard failure"),
      signal(/\bstill\s+(?:fail(?:s|ing)?|broken|crash(?:es|ing)?|not working|doesn'?t work|happening|wrong|slow)\b/, 3, "still failing"),
      signal(/\bwhy\s+(?:does|is|did|do|are|would|won'?t|can'?t|isn'?t|doesn'?t)\b[^?.!\n]{0,80}\b(?:fail|break|crash|hang|error|slow|wrong|differ|miss|5\d\d|throw|timing out|time out|take|so long|flak)/, 2, "why it fails"),
      signal(/\b(?:was|used to (?:be|take)) (?:only )?~?\d+(?:\.\d+)?\s*(?:ms|s|secs?|seconds?|mins?|minutes?|hours?|mb|gb)?\s+(?:a (?:week|month|year|day) ago|before|last (?:week|month|release))\b|\bit was \d+\s*(?:ms|s|mins?|minutes?|seconds?)?\b[^.?!]{0,20}\bago\b/, 2, "regression"),
      signal(/\b(?:doesn'?t|does not|isn'?t|is not|won'?t|stopped)\s+work(?:ing)?\b|\bnot working\b/, 1, "not working"),
      signal(/\b(?:regression|performance (?:issue|problem|regression|bug)|slowdown)\b/, 1, "regression"),
      signal(/\b(?:\d+|one|two|three)\s*(?:in|out of)\s*\d+\s+(?:runs?|requests?|times|builds?|tries|attempts|calls|deploys?|jobs?)\b|\b\d+\s*%\s+of\s+(?:the\s+)?(?:runs?|requests?|builds?|calls|jobs?)\b/, 3, "intermittent"),
      signal(/\b(?:sometimes|randomly|occasionally|every (?:now and then|so often)|now and then|on and off|from time to time|some of the time|at random)\b|\b(?:once|twice|\d+ times|a few times) (?:a|an|per) (?:day|hour|week|minute|night)\b/, 2, "intermittent"),
      signal(/\b(?:only (?:on|in|under|with|for) (?:ci|prod(?:uction)?|staging|the (?:production|release|prod) build|safari|firefox|chrome|windows|mac(?:os)?|linux|android|ios|arm|docker|kubernetes|k8s|load|heavy load|some users)|never (?:locally|on my machine|in dev)|works (?:fine |perfectly )?(?:locally|on my machine|in dev(?:elopment)?)|passes locally|can'?t reproduce|cannot reproduce|(?:not|isn'?t|doesn'?t|won'?t|never) reproduc(?:e|es|ing|ible)|no (?:clear |obvious )?pattern)\b/, 3, "environment-specific"),
      // (A p95 target, "p95 has to stay under 50ms", is a requirement, not a regression.)
      signal(/\b(?:nothing (?:in [\w-]+ )?(?:has )?changed|(?:after|since) (?:the |a |tuesday'?s |monday'?s |last |yesterday'?s |yesterdays |this week'?s )?(?:deploy|release|upgrade|update|bump|merge|migration)|went from\s+~?\d[\d.,]*\s*\w*\s+to\s+~?\d|got (?:slower|worse)|memory (?:keeps |is |usage )?(?:growing|climbing|climbs|grows|leaking|leaks)|climbs? ~?\d+\s*(?:mb|gb|kb|%)|p9\d(?: latency)? (?:went|jumped|is up|spiked|regressed|doubled|climbed|increased)|out of memory|oom(?:-?kill(?:ed|s|er)?|ed)?)\b/, 2, "regression"),
      signal(/\bfigure out (?:what'?s|why|where|how come|what is)\b|\bwhat'?s (?:holding|causing|eating|leaking|using|blocking|keeping)\b|\bkeep digging\b|\bdig (?:deeper|further|into)\b/, 2, "investigation"),
      // (A regression test for a bug already fixed is not the bug.)
      signal(/(?<!\b(?:regression tests?|a test|tests?) (?:for|covering|against) (?:the |a |that )?)\b(?:hydration (?:mismatch|error)|timing (?:issue|problem|bug)|data race|ordering (?:issue|bug)|stale (?:data|cache|reads?|state)|double[- ](?:charg|submit|count)\w*|duplicate (?:charges|rows|events|messages|jobs)|lost (?:updates|writes|messages)|silently (?:fails?|drops?|ignores?)|(?:drops?|dropping|loses|losing) (?:\w+ ){0,3}?(?:rows|records|data|messages|events|writes|updates|items)|data loss|(?:the )?same \w+ twice|(?:twice|double)[- ]?(?:processed|shipped|sent|charged|delivered|billed))\b/, 2, "subtle bug"),
    ],
  },
  review: {
    level: "xhigh",
    label: "reviewing a big change",
    signals: [
      signal(/\bcode[- ]review\b|\breview\s+(?:of\s+)?(?:the|this|my|our|a|all|these|every)?\s*(?:[\w-]+\s+){0,3}?(?:pr|prs|pull requests?|diff|change(?:s|set)?|branch|commits?|patch|implementation|code(?:base)?|repo(?:sitory)?|module|service)\b|\breview (?:the )?(?:whole|entire) (?:thing|lot|change|feature|implementation|work)\b|\breview (?:it|everything|all of it) (?:properly|carefully|thoroughly)\b/, 3, "code review"),
      signal(/\b(?:check|look at|go over|look over|double[- ]check|sanity[- ]check|eyeball|review)\b[^.?!]{0,40}\bbefore (?:i|we) (?:merge|ship|release|deploy)\b/, 2, "check before merging"),
      signal(/\bfind (?:every|all (?:the )?|any|as many) (?:bugs?|issues?|problems?|vulnerabilit(?:y|ies)|race conditions?|leaks?|security (?:holes?|issues?))\b|\bevery bug (?:you can|in)\b/, 3, "bug hunt"),
      signal(/\bmissing (?:auth(?:orization|entication)?|permission|access|csrf|input validation|rate[- ]limit(?:ing)?) checks?\b|\b(?:security|auth) (?:holes?|gaps?)\b/, 2, "security check"),
      signal(/\bgo (?:thru|through) (?:the |our |every |all |each )/, 1, "sweep"),
      signal(/\b(?:tell me|let me know) (?:if|whether) (?:the |this |my |our )?[\w-]+(?: [\w-]+)? (?:is|looks|seems) (?:sane|ok|okay|right|reasonable|sound|correct)\b|\bis (?:this|the|my) [\w-]+(?: [\w-]+)? sane\b|\bhere'?s the diff\b/, 2, "sanity review"),
      signal(/\baudit\b(?!\s+(?:reports?|logs?|trail|history|entries|table|events?))|\b(?:security review|threat model(?:ing)?|pen ?test(?:ing)?)\b/, 2, "audit"),
      signal(/\breview\b/, 1, "review"),
      signal(/\b(?:critique|double[- ]check|sanity[- ]check|look over|go over)\b/, 1, "check"),
    ],
  },
  build: {
    level: "high",
    label: "everyday build or fix work",
    signals: [
      // "port" and "patch" count only as verbs ("the default port" and "the latest patch" are nouns).
      signal(/\b(?:implement|build|create|develop|make|generate|scaffold|wire up|hook up|integrate)\b|\bport(?:ing)? (?:the|it|this|that|our|over|everything|all|them)\b/, 1, "build"),
      signal(/\b(?:add|write)\s+(?:a|an|the|some|new|support|tests?|docs?|code)\b/, 1, "add"),
      signal(/\b(?:fix|repair|resolve)\b|\bpatch (?:the|it|this|that|up|over|them)\b/, 1, "fix"),
      signal(/\bfix\s+(?:the|this|that|a|an|these|those)?\s*(?:bug|error|crash|issue|failing|broken|test|build|exception)/, 1, "fix error"),
      signal(/\b(?:install|configure|set ?up|deploy|migrat(?:e|ion|ing)|upgrade|refactor|convert|automate)\b/, 1, "setup"),
      // Tests, plural or a suite; one small test is a small edit (below).
      signal(/\b(?:write|add|run|update|rerun|re-run|fix)\s+(?:the\s+|some\s+|more\s+)?(?:[\w-]+\s+){0,2}?tests\b|\b(?:run|rerun|re-run) (?:the )?(?:[\w-]+ )?test (?:suite|again)\b|\b(?:now|then|and|also|plus) (?:the |some |a few )?(?:unit |integration |e2e |regression )?tests\b|\bacceptance (?:tests?|checks?|checklist)\b/, 2, "tests"),
      signal(/\badd(?:ing)? (?!(?:a |an |the )?(?:short |brief )?(?:comment|docstring|todo|log line|blank line|newline|link|badge)s?\b)(?:[\w-]+ ){1,3}?(?:to|for|in|on|into) (?:the|our|this|that|a|an|each|every|all|my)\b/, 1, "add"),
      signal(/\btranslat(?:e|ing) (?:all |the |our )?(?:user[- ]facing |ui |app )?(?:strings|copy|text|messages|labels|keys)\b|\b(?:locali[sz](?:e|ation)|internationali[sz](?:e|ation)|i18n)\b/, 1, "localization"),
      signal(/\bnew (?:sub-?command|command|endpoint|page|feature|component|flag|option|route|screen|service|job|migration|table|integration)\b/, 1, "new thing"),
      signal(/\b(?:need|want) (?:a|an) (?:new )?(?:[\w-]+ )?(?:command|subcommand|endpoint|flag|option|page|feature|job|script|tool|service|screen|integration|webhook)\b/, 2, "new thing"),
      // Building what a finished plan describes is implementation, not more design.
      signal(/\bimplement (?:phase|step|part|stage|milestone|item|batch) \w+|\bnow (?:build|implement|code) (?:it|this|that)\b|\b(?:spec|plan|design) is (?:final|done|approved|ready)\b|\bdo the (?:whole|entire|full|rest of the) (?:migration|refactor|rollout|implementation|port|conversion|upgrade|thing)\b|\bbuild the (?:whole|entire|full) (?:thing|feature|app|system|flow)\b|\bplan (?:is )?approved\b|\bapproved the plan\b/, 3, "implementation"),
    ],
  },
  research: {
    level: "high",
    label: "research",
    signals: [
      signal(/\b(?:research|investigate|explore|survey|look into|study)\b/, 2, "research"),
      signal(/\b(?:compare|comparison|evaluate|evaluation|benchmark|assess(?:ment)?)\b/, 1, "compare"),
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
      signal(/\b(?:rename|typo|reword|rephrase|retitle|reformat|indent|bump (?:the )?version|tweak|nits?|nitpicks?|naming)\b|\b(?:small|minor|style) comments\b/, 2, "small edit"),
      signal(/\bmake (?:the |it |this |that )?(?:[\w-]+ ){0,2}?(?:sticky|bold|bigger|smaller|wider|narrower|taller|shorter|rounded|italic|centered|visible|hidden|darker|lighter|transparent|clickable|full[- ]width|friendlier|clearer|warmer|punchier|more (?:concise|formal|casual|friendly)|less (?:formal|wordy|stiff))\b|\b(?:replace|swap|switch|change) (?:all |every |the )?(?:hard-?coded |old |legacy )?(?:hex )?(?:colou?rs?|strings|urls?|links?|icons?|imports|constants|magic numbers|class names|font sizes)\b|\bupdate (?:the )?(?:[\w-]+ )?(?:copy|text|wording|faq|hero|headline|tagline|blurb|labels?)\b|\btag (?:it|this|that)\b/, 2, "cosmetic"),
      signal(/\brelease (?:day|steps|checklist|process)\b|\bdoing the release\b|\bsteps are in\b|\bgo one at a time\b|\bchecklist:/, 2, "routine steps"),
      signal(/\b(?:remove|drop|delete|strip|rip out|take out) (?:the |all the )?(?:debug(?:ging)? (?:logs?|logging|prints?|statements?|output)|logging you added|sleep hack|hacks?|temp(?:orary)? [\w-]+|console\.logs?|print statements?)\b|\b(?:put|set|change|revert) (?:the )?[\w-]+(?: [\w-]+)? back to\b|\bclean(?:ing)? up:/, 2, "cleanup"),
      signal(/\b(?:one[- ]line(?:r)?|single[- ]line|small|tiny|minor|trivial|little|quick)\s+(?:change|edit|fix|tweak|update|thing|cleanup)\b/, 3, "small change"),
      signal(/\bchange\s+(?:the\s+)?(?:[\w-]+\s+){0,2}?(?:colou?r|text|label|title|name|wording|font|icon|copy|spelling|year|date|copyright|string|message|value|default|url|link|timeout|env var)\b/, 2, "cosmetic"),
      signal(/\b(?:say|read|show|print|log)s? ['"`‘“][^'"`’”]{1,40}['"`’”] instead of\b|\binstead of ['"`‘“][^'"`’”]{1,40}['"`’”]/, 2, "wording"),
      // Size wins over type: one test, one link, one doc sentence is a small edit.
      signal(/\b(?:add|write) (?:a|one|a single|a quick|a small|a tiny) (?:unit |regression )?test\b(?! (?:suite|plan|harness))|\bfix (?:the |a |that |this |two |both )?(?:broken |dead )?(?:links?|typos?|spelling|indentation|import paths?)\b/, 3, "small edit"),
      // A pasted error whose trivial cause is already named ("prob the trailing comma").
      signal(/\b(?:prob(?:ably)?|must be|i think it'?s|pretty sure it'?s|looks like|it'?s (?:just )?)(?: the| a)? (?:trailing comma|typo|missing (?:comma|bracket|brace|semicolon|quote|import|paren)|extra (?:comma|bracket|brace))\b|\b(?:says|has|reads|spells it) ['"‘“][\w-]{3,24}['"’”]/, 3, "small edit"),
      signal(/\b(?:add|write) (?:a )?(?:short|brief|quick) (?:summary|note|paragraph|section|comment)\b|\b(?:readme|changelog|docs?) (?:section|paragraph|line|sentence|wording)\b|\bsection (?:of|in) the (?:readme|docs?)\b|\b(?:one|two|a) (?:or two )?sentences?\b|\bcommit (?:that|this|it|the changes?)\b|\bversion badge\b/, 2, "doc edit"),
      // Chores: a comment, a version bump, lint and formatting, a PR or a tag.
      signal(/\badd (?:a |an |the )?(?:short |brief |quick )?(?:code )?(?:comment|docstring|todo|log line|blank line|newline|link|badge)s?\b|\bbump (?:up )?(?:the )?[\w@./-]+(?: [\w@./-]+){0,4}? (?:to|from) v?\d|\bbump (?:all )?(?:the |our )?(?:deps|dependencies|versions?|packages?|year|copyright(?: year)?|date)\b|\bchange (?:the )?[\w-]+(?: [\w-]+){0,3}? from [\w#.%-]+ to [\w#.%-]+/, 2, "chore"),
      signal(/\b(?:lint (?:warnings?|errors?|issues?)|eslint (?:warnings?|errors?)|unused (?:imports?|variables?|vars)|sort (?:the )?imports|import order|run (?:the )?(?:formatter|prettier|black|gofmt|rustfmt|linter)|format (?:the|this|all|that) (?:file|files|code|module)|trailing whitespace|console\.logs?|print statements?)\b|\b(?:open|create|raise|file) (?:a |the )?(?:draft )?(?:pr|pull request)\b|\btag (?:the |a )?(?:release|commit|version)\b|\bcut (?:a |the )?release\b|\bupdate (?:the )?(?:changelog|copyright(?: year)?|license headers?)\b/, 2, "chore"),
      signal(/\b(?:round (?:the )?corners|padding|margins?|spacing|font size|alt text|placeholder text|tooltip text|button text|bump (?:the )?(?:version|dependency)|set (?:the )?\w+(?: \w+)? to \d+\s*(?:mb|kb|gb|ms|s|px|%)?)\b/, 2, "cosmetic"),
    ],
  },
  quick: {
    level: "low",
    label: "a quick question",
    signals: [
      signal(/^\s*(?:quick (?:question|q)|qq)\b/, 3, "quick question"),
      signal(/\b(?:what time|which (?:file|folder|branch|version|port)|where (?:is|are|do i find)|is there (?:a|an)|how many)\b/, 1, "lookup"),
      signal(/\bwhat'?s the (?:command|path|shortcut|name|flag|option|url|port|env var)\b|\bhow do i (?:run|start|open|find|get to|see|check|view|get|list|show)\b|\bfact[- ]check\b|\bjust need (?:a )?yes\/no\b|\b(?:quick )?sanity check:/, 3, "lookup"),
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
// A guess ("prob something simple") is not a request to be quick.
const QUICK_CUE_RE = /(?<!\b(?:prob(?:ably)?|maybe|might be|could be|hopefully|likely|seems|seemed|looks like|looked like|should be|i think|i guess|i bet|surely|supposedly)\s+(?:something\s+|a\s+|just\s+|pretty\s+|really\s+|fairly\s+)?)\b(?:quick(?:ly)?|simple|tiny|minor|trivial|brief(?:ly)?|short answer|one[- ]liner|real quick)\b/g;
const DEPTH_CUE_RE = /\b(?:careful(?:ly)?|thorough(?:ly)?|rigorous(?:ly)?|in[- ]depth|deep(?:ly|er)?(?!\s*(?:links?|linking|clone|copy|equal|merge|learning|freeze|compare|sleep))|deep[- ]dive|think (?:hard|deeply|carefully)|tricky|subtle|complex|complicated|difficult|high[- ]stakes|security[- ]sensitive|more depth|in (?:more|much more) detail|money is involved|properly)\b/g;
// Hard-failure markers inside pasted output (prose signals skip code blocks).
const CODE_HARD_FAILURE_RE = /\bdeadlock(?: detected)?\b|segmentation fault|\bsigsegv\b|\bsigabrt\b|data race|out of memory|oom-?kill|heap (?:corruption|use after free)|use-after-free|stack overflow|double free/i;
// Actions at the start of a clause ("add X and write tests"), so "the install script" or
// "the build step" do not count as actions.
const ACTION_VERB_RE = /(?:^|[,;:.!?]\s*|\b(?:and|then|also|plus|please|pls|to|&)\s+)(install|configure|set up|setup|write|add|build|implement|create|fix|update|migrate|refactor|run|deploy|hook up|wire up|verify|handle|remove|replace|cache|document)\b/g;
const ULTRACODE_SCOPE_RE = /\b(?:entire|whole|full|complete|every)\s+(?:code ?base|repo(?:sitory)?|project|system|monorepo|app(?:lication)?|change ?set)\b|\b(?:big|large|huge|massive|sweeping)\s+(?:pr|pull request|change|refactor|diff|migration|branch)\b/;
const ERROR_DUMP_RE = /traceback \(most recent call last\)|^\s+at [\w.$<>[\]]+ \(.*:\d+:\d+\)|\bexception in thread\b|\bnpm err!|\berror\[e\d{4}\]|\bpanic:|segmentation fault|\bassertionerror\b|^\s*failed\b.*::/im;
const QUESTION_START_RE = /^\s*(?:what|which|where|when|who|whose|is|are|does|do|did|can|could|should|how|why)\b/;
// A polite request ("can you add…", "do the atomic one") is work, not a quick question.
const REQUEST_START_RE = /^\s*(?:(?:can|could|would|will) (?:you|u) (?:please )?(?!tell|explain|remind|clarify|show me what|confirm whether)|please\b|pls\b|do (?:the|it|that|this|a|an|all|both|one)\b)/;
// "don't fix anything", "no need to write tests": work the user ruled out is not the task.
const NEGATION_RE = /\b(?:do(?:n'?t|nt| not)|no need to|without|skip(?:ping)?|instead of)\s+(?:\w+\s+){0,2}?(?:fix(?:ing)?|refactor(?:ing)?|redesign(?:ing)?|re-?architect(?:ing)?|touch(?:ing)?|chang(?:e|ing)|writ(?:e|ing)|add(?:ing)?|build(?:ing)?|implement(?:ing)?|tests?|testing|review(?:ing)?|debug(?:ging)?|migrat(?:e|ing)|deploy(?:ing)?|design(?:ing)?|rewrit(?:e|ing)|optimi[sz](?:e|ing))\b(?:(?!\b(?:and|but|then|also|just|instead|so|while|because|plus)\b)[^.?!,;\n])*/g;
// "this 'quick fix' double-charged customers": a cue word in scare quotes is not a cue.
const SCARE_QUOTE_RE = /['"“‘]([^'"”’\n]{0,15}\b(?:quick|simple|tiny|small|minor|trivial|easy|harmless|safe)\b[^'"”’\n]{0,15})['"”’]/g;
const FILE_NAME_RE = /\b[\w-]+\.(?:md|mdx|ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|php|cs|cpp|h|json|ya?ml|toml|scss|css|html|sh|txt|lock|cfg|ini|sql|proto)\b/g;
// Common misspellings of the words the signals listen for.
const TYPOS = [
  [/\b(?:reveiw|reivew|reveiew|reviw)(s|ed|ing)?\b/g, "review$1"],
  [/\b(?:desgin|desing|dseign)(s|ed|ing)?\b/g, "design$1"],
  [/\b(?:architecure|architechture|archtecture|architeture)\b/g, "architecture"],
  [/\b(?:implment|impliment|implemnt)(s|ed|ing|ation)?\b/g, "implement$1"],
  [/\b(?:refacor|refator|refactr)(s|ed|ing)?\b/g, "refactor$1"],
  [/\b(?:migraiton|migartion|migation)(s)?\b/g, "migration$1"],
  [/\b(?:perfomance|preformance|performace)\b/g, "performance"],
  [/\b(?:intermitent|intermittant|intermitant)(ly)?\b/g, "intermittent$1"],
  [/\bflakey\b/g, "flaky"],
  [/\b(?:recomendation|reccomendation|recommandation)(s)?\b/g, "recommendation$1"],
  [/\b(?:debgu|degub)\b/g, "debug"],
];

// The prose the signals read: file paths, file names and backticked names are not words
// of the task ("MIGRATION.md", "docs/design/*.md"), misspellings are fixed, and cue words
// in scare quotes are dropped.
function cleanProse(lower) {
  let text = lower
    .replace(/`[^`\n]{1,80}`/g, " ")
    .replace(/\S*\/\S*/g, (token) => {
      const bare = token.replace(/[),.;:!?]+$/, "");
      const path = (bare.match(/\//g) ?? []).length >= 2 || /\.[a-z0-9]{1,5}$/.test(bare) || /^(?:\.{1,2}|~)?\//.test(bare) || bare.endsWith("/");
      return path ? " " : token;
    })
    .replace(FILE_NAME_RE, " ")
    .replace(SCARE_QUOTE_RE, " ");
  for (const [re, to] of TYPOS) text = text.replace(re, to);
  // One space where a token was removed, so "need a `cleanup` command" reads "need a command".
  return text.replace(/[ \t]{2,}/g, " ");
}

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
  const clean = cleanProse(lower);
  const lines = prose.split(/\r?\n/).filter((line) => line.trim());
  const code = blocks.join("\n");
  return {
    prose: lower,
    clean,
    // What the category signals read: the clean prose without work the user ruled out.
    scoring: clean.replace(NEGATION_RE, " "),
    length: raw.length,
    wordCount: (lower.match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu) ?? []).length,
    lineCount: lines.length,
    listItems: lines.filter((line) => /^\s*(?:[-*•]|\d+[.)]|[a-z][.)])\s+/i.test(line)).length,
    questions: countMatches(/\?/g, prose),
    pastedError: ERROR_DUMP_RE.test(code) || ERROR_DUMP_RE.test(prose),
    quickCues: countMatches(QUICK_CUE_RE, clean),
    depthCues: countMatches(DEPTH_CUE_RE, clean),
    actionVerbs: new Set([...lower.matchAll(ACTION_VERB_RE)].map((match) => match[1])).size,
    codeHardFailure: CODE_HARD_FAILURE_RE.test(code),
  };
}

function scoreCategories(features, routerMode, options = {}) {
  const scores = Object.fromEntries(CATEGORY_NAMES.map((name) => [name, 0]));
  const tags = Object.fromEntries(CATEGORY_NAMES.map((name) => [name, []]));
  const text = features.scoring ?? features.prose;
  for (const name of CATEGORY_NAMES) {
    for (const item of CATEGORIES[name].signals) {
      if (item.re.test(text)) {
        scores[name] += item.weight;
        tags[name].push(item.tag);
      }
    }
  }
  // A pasted error with a stack trace is usually an ordinary fix; tricky debugging has
  // its own signals (intermittent, only on CI, still failing, no pattern).
  if (features.pastedError) {
    scores.build += 1;
    tags.build.push("pasted error output");
  }
  if (features.codeHardFailure) {
    scores.debug += 3;
    tags.debug.push("hard failure in pasted output");
  }
  // A security review is review work at its hardest.
  if (scores.review > 0 && SECURITY_RE.test(text)) {
    scores.review += 1;
    tags.review.push("security-sensitive");
  }
  const vote = ROUTER_VOTES[routerMode];
  if (vote && scores[vote] > 0) {
    scores[vote] += 1;
    tags[vote].push(`router:${routerMode}`);
  }
  const others = Math.max(...CATEGORY_NAMES.filter((name) => name !== "quick").map((name) => scores[name]));
  // A next-step offer ("should I keep digging?") is not a quick question either.
  const request = options.nextStep || REQUEST_START_RE.test(features.prose);
  if (!request && features.wordCount <= 15 && (features.questions > 0 || QUESTION_START_RE.test(features.prose)) && others <= 1) {
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

const round2 = (value) => Math.round(Math.max(0, Math.min(0.95, value)) * 100) / 100;

// ---------------------------------------------------------------------------
// Conversation context: a short follow-up is judged by what it continues.

const RETRY_RE = /^(?:(?:no|nope|nah|hmm+|ugh|still|ok(?:ay)?|sadly|unfortunately)\b[\s,.!]*)*(?:try (?:it |that )?again|retry|one more (?:time|try)|still (?:fail(?:s|ing)?|broken|crash(?:es|ing)?|not working|the same|happening|hangs|flaky)|same (?:error|problem|issue|thing|result)|(?:it |that )?(?:didn'?t|did not|doesn'?t|does not|still doesn'?t) (?:work|help|fix (?:it|anything))|not fixed|nope\b|no luck|no change|nothing changed|(?:it |the [\w-]+ )?(?:failed|broke|crashed|timed out) again)/i;
const ACCEPT_RE = /^(?:(?:yes+|yep|yeah|yup|ya|yah|yea|ok(?:ay)?|okk*|kk|sure(?: thing)?|great|perfect|cool|nice|sounds (?:good|great)|looks good|lgtm|approved?|agreed|go ahead|go for it|please(?: do)?|pls|do it|do that|let'?s do (?:it|that|this)|lets do (?:it|that|this)|let'?s go|proceed|continue|keep going|carry on|next|y)\b[\s,.!]*)+/i;
const PRONOUN_FOLLOW_RE = /^(?:(?:ok(?:ay)?|now|and|then|also|great|cool|nice|good|so|hm+|ugh|pls|please|thx|thanks|ty|cheers|(?:can|could|would) (?:you|u)(?: please)?)[\s,.!]+)*(?:(?:do|apply|fix|implement|finish|handle|run|add|write|update|ship|build|redo|check|double[- ]check|verify|test|review|look (?:at|into)|dig into|poke holes in|clean up|polish|revert|undo) (?:it|that|this|them|those|the rest|the others?|the same|these)\b|now (?:the|do|run|fix|add|write|update|for)\b|(?:and|what about|how about) (?:the|for)\b|the (?:rest|others?|remaining)\b|same (?:for|with|thing)\b|next (?:one|step|part|file|item|batch)\b|keep (?:digging|looking|pushing|investigating|at it)\b|(?:go|dig) (?:deeper|further)\b|(?:in )?(?:more|much more) (?:detail|depth)\b|the [\w-]+ one\b)/i;
// Picking one of the options Claude laid out: the next step is building it.
const EITHER_OR_RE = /\b(?:want me to|should i|shall i|would you like me to|do you want me to)\b[^?]{2,160}?,?\s+or\s+(?:should i\s+|do you want me to\s+|(?:first|just|instead)\s+)?[a-z]+[^?]{0,120}\?/i;
const CHOICE_RE = /^(?:(?:ok(?:ay)?|yes|yeah|great|cool|fine|alright|right|perfect)[\s,.!]+)*(?:(?:let'?s |we'?ll |i'?ll |we )?(?:go(?:ing)?|stick) with|(?:let'?s )?(?:pick|choose|take|use) (?:option|plan|approach|the (?:first|second|third|last)|[a-d]\b|#?\d)|(?:let'?s )?(?:do|take|use|try|pick|choose) the [\w-]+ (?:one|option|version|approach|variant)\b)|^(?:option|plan|approach)\s+(?:\d|[a-d]|one|two|three)\b|(?:^|^[^.!?]{0,30}[.!]\s+)(?:approved|lgtm|ship it)\b|\bkick (?:it |this )?off\b|\bstart (?:on|with) (?:step|batch|phase|part|stage) \w+/i;
const STOPWORDS = new Set("about above after again against also and any are because been before being below between both but can could did does doing down during each few for from further had has have having here how into its itself just more most other our ours out over own same should some such than that the their them then there these they this those through too under until very was were what when where which while who whom why will with would you your".split(" "));

// A fix that did not hold: Claude reported a fix or a change, and the next user message
// says the problem is still there. Two of those make a debugging saga.
const FIX_CLAIM_RE = /\b(?:fixed|i (?:changed|switched|bounded|added|removed|bumped|patched|updated|replaced|moved|rewrote|set|raised|lowered|increased|decreased|disabled|enabled|wrapped|pinned|reverted|tweaked|adjusted|made)|(?:should|this will|that should|which should|it should) (?:fix|solve|resolve|help|stop)|try (?:it |that )?(?:again|now)|give it (?:a|another) (?:try|go)|(?:it |this )?(?:works|passes) (?:now|locally)|the fix is (?:in|pushed|deployed|live)|tests? pass(?:es|ed)?)\b|(?:^|[.!?]\s+|\n)\s*(?:raised|changed|added|bounded|switched|enabled|disabled|increased|decreased|lowered|patched|updated|replaced|bumped|pinned|reverted|wrapped|moved|rewrote|tweaked|adjusted|rolled back|restarted|cleared|reset)\b/i;
const PERSISTS_RE = /\bstill\b(?! (?:want|need|like|think|prefer))|\b(?:fail(?:s|ed|ing)?|broke|breaks|crash(?:es|ed)?|happen(?:s|ed|ing)?|timed out|times out|showed up|shows up|hangs?|hung) again\b|\b(?:same (?:error|thing|issue|problem|result|crash|failure)|came back|comes back|didn'?t (?:help|work|fix|change)|did not (?:help|work|fix)|doesn'?t (?:help|work)|no (?:luck|change|difference)|not fixed|nope|(?:now )?(?:it'?s )?worse|another one)\b/i;
const IMPROVING_RE = /\b(?:less (?:often|frequent(?:ly)?)|(?:a lot |much |way )?(?:better|rarer) (?:than before|now)|fewer (?:than before|now)|improved|almost (?:fixed|there|gone))\b/i;
const SOLVED_RE = /\b(?:works now|working now|that (?:did it|fixed it|worked)|it'?s fixed|fixed it|passes now|(?:all )?green now|all good now|resolved|no more (?:errors|crashes|failures))\b/i;

// The conversation is about a bug, not taste: "still kinda stiff" after a copy edit is
// feedback, not a fix that failed.
const BUG_RE = /\b(?:fail(?:s|ed|ing|ure)?|error|errors|crash(?:es|ed|ing)?|broken|bug|timeout|timing out|times out|exception|5\d\d|leak(?:s|ing)?|flaky|oom|hang(?:s|ing)?|wrong (?:result|value|total|output|data)|drops?|dropped|dropping|missing|duplicate|deadlock|panic|segfault|not working|doesn'?t work|stopped working|climb(?:s|ing)?|regress(?:ed|ion)?|corrupt\w*|stuck|freez\w*|blank|nan|null|undefined)\b/i;

function failedAttempts(history, prompt) {
  const messages = [...history, { role: "user", text: prompt }];
  const aboutBug = messages.some((message) => message.role === "user" && BUG_RE.test(message.text));
  if (!aboutBug) return 0;
  let attempts = 0;
  for (let index = 1; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role !== "user") continue;
    if (SOLVED_RE.test(message.text)) {
      attempts = 0;
      continue;
    }
    const before = messages[index - 1];
    if (before?.role === "assistant" && FIX_CLAIM_RE.test(before.text) && PERSISTS_RE.test(message.text)) attempts += 1;
  }
  return attempts;
}

/** "retry", "choice", "accept", "pronoun" or null: what kind of follow-up a short prompt is. */
export function followUpKind(prompt) {
  const text = typeof prompt === "string" ? prompt.trim() : "";
  if (!text) return null;
  const words = (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu) ?? []).length;
  if (words > 24) return null;
  if (RETRY_RE.test(text)) return "retry";
  if (CHOICE_RE.test(text)) return "choice";
  if (words <= 12 && ACCEPT_RE.test(text)) return "accept";
  // A bare "go" accepts too; "go through every file" does not.
  if (/^(?:ok(?:ay)?[\s,.!]+)?(?:go|go go|go on)[\s.!]*$/i.test(text)) return "accept";
  if (PRONOUN_FOLLOW_RE.test(text)) return "pronoun";
  return null;
}

// Content words two texts share: a cheap sign a question belongs to the ongoing task.
function sharedWords(a, b) {
  const words = (text) => new Set((String(text).toLowerCase().match(/[\p{L}][\p{L}\p{N}_-]{3,}/gu) ?? []).filter((word) => !STOPWORDS.has(word)));
  const left = words(a);
  let count = 0;
  for (const word of words(b)) if (left.has(word)) count += 1;
  return count;
}

function isSubstantial(text) {
  return typeof text === "string" && !followUpKind(text) && !CONTINUE_RE.test(text.trim()) && text.trim().split(/\s+/).length >= 4;
}

// Claude's latest message can say the work is weighing a design when the user's words
// do not: options laid out, a drafted design, a decision named as such.
const DESIGN_PHASE_RE = /\boptions?:|\b(?:two|three|four|five|[2-9]) (?:options|approaches|alternatives|designs|ways (?:out|forward|to (?:fix|do|handle|solve))|paths forward)\b|\boption (?:a|1|one)\b[^.]{0,200}\boption (?:b|2|two)\b|\bdrafted (?:the|a) [\w-]+ (?:design|spec|proposal)\b|\b(?:a|the|this is (?:really )?an?) (?:real |big |key )?(?:design|architecture) (?:decision|choice|question)\b|\bwhich (?:one|option|approach) do you (?:prefer|want)\b/i;

function assistantPhase(history) {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];
    if (message?.role !== "assistant") continue;
    if (!DESIGN_PHASE_RE.test(message.text)) return null;
    return { level: "max", confidence: 0.7, category: "design", label: CATEGORIES.design.label, reasons: ["the conversation is weighing a design"], shortTask: false, fromAssistant: true };
  }
  return null;
}

// The task the conversation is about: the latest substantial request, classified alone,
// or else what Claude's latest message says the work is.
function taskContext(history) {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];
    if (message?.role !== "user" || !isSubstantial(message.text)) continue;
    const rec = classifyPrompt(message.text);
    if (rec.level) return rec;
  }
  return assistantPhase(history);
}

function lastAssistantText(history) {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index]?.role === "assistant" && typeof history[index].text === "string") return history[index].text;
  }
  return "";
}

function inherit(rec, confidence, reason, extra = {}) {
  return { ...rec, confidence: round2(confidence), reasons: [reason, ...(rec.reasons ?? [])].slice(0, 4), inherited: true, ...extra };
}

const BACK_TO_RE = /\b(?:back to|going back to|returning to|re the|re:) (?:the |that |our |this )?([\w-]+(?: [\w-]+){0,4}?)(?: thing| issue| bug| problem| stuff| question)?(?=[,.!?:;]|\s*$|\s+(?:again|now|from|with|for a sec)\b)/i;
const ORDINALS = { one: "1", two: "2", three: "3", four: "4", first: "1", second: "2", third: "3", fourth: "4" };

// The text of the option a choice picks: a numbered or lettered item, or the line that
// names it ("go with redis").
function pickedOption(prompt, assistant) {
  if (!assistant) return null;
  const match = /\b(?:go(?:ing)? with|stick with|pick|choose|take|use|option|plan|approach|let'?s do)\s+(?:option\s+|plan\s+|approach\s+|the\s+|#)?([a-z0-9][\w.+-]*)/i.exec(prompt);
  if (!match) return null;
  const token = match[1].toLowerCase();
  const key = ORDINALS[token] ?? token;
  const items = assistant.split(/\n+|\s(?=\(?(?:\d|[a-d])[.)]\s)/i).map((item) => item.trim()).filter(Boolean);
  let item = null;
  if (/^(?:\d|[a-d])$/.test(key)) item = items.find((line) => new RegExp(`^(?:option\\s+)?\\(?${key}[.):]\\s`, "i").test(line)) ?? null;
  else if (token.length >= 3 && !["the", "it", "that", "this", "one", "last"].includes(token)) item = items.find((line) => line.toLowerCase().includes(token)) ?? null;
  // Only an option that is itself a task to do ("3. write an ADR first") changes the next
  // step; an option that describes a design is what gets built.
  return item && OPTION_TASK_RE.test(item) ? item : null;
}

const OPTION_TASK_RE = /^(?:option\s+)?\(?(?:\d|[a-d])?[.):]?\s*(?:first,?\s+)?(?:write|draft|design|research|investigate|review|compare|prototype|spike|benchmark|evaluate|audit|explore|think (?:it )?through|plan|dig into|profile|measure)\b/i;

// What a follow-up continues, or null when the history does not say.
function resolveFollowUp(kind, history, prompt = "") {
  const resolved = followUpBase(kind, history, prompt);
  // "yes, and go deeper": the same work, with more depth (once).
  if (resolved?.level && kind !== "retry" && !resolved.reasons?.includes("asked for depth") && countMatches(DEPTH_CUE_RE, prompt.toLowerCase()) > 0) {
    return { ...resolved, level: shiftLevel(resolved.level, 1), reasons: ["asked for more depth", ...(resolved.reasons ?? [])].slice(0, 4) };
  }
  return resolved;
}

function followUpBase(kind, history, prompt) {
  const task = taskContext(history);
  const assistant = lastAssistantText(history);
  if (kind === "choice") {
    // "go with 3", where option 3 was "write an ADR first": the option picked decides.
    const picked = pickedOption(prompt, assistant);
    if (picked) {
      const option = classifyOne(picked, { noSplit: true });
      if (option.level && levelIndex(option.level) > levelIndex("high") && option.confidence >= 0.6) return inherit(option, option.confidence, `you picked: ${option.label}`);
    }
    // The rest of the message may ask for more than building the choice ("go with A, but write the design doc first").
    const own = classifyPrompt(prompt.replace(CHOICE_RE, " "));
    if (own.level && levelIndex(own.level) > levelIndex("high") && own.confidence >= 0.65) return inherit(own, own.confidence, `after choosing: ${own.label}`);
    // Building the chosen plan is long, ordinary work: high is enough, even from xhigh.
    return inherit({ level: "high", category: "build", label: "implementation", reasons: [], shortTask: false }, 0.75, "you picked an option: building it", { allowSingleStep: true });
  }
  if (kind === "retry") {
    // Still failing after more than one attempt is no longer everyday work; a first
    // retry keeps the task's own level.
    const failures = Math.max(
      failedAttempts(history, prompt),
      history.filter((message) => (message.role === "user" ? RETRY_RE.test(message.text.trim()) : UNRESOLVED_RE.test(message.text) || /\b(?:still (?:fails?|failing|broken)|same error|didn'?t (?:work|fix))\b/i.test(message.text))).length,
    );
    const base = { level: "xhigh", category: "debug", label: "tricky debugging", reasons: [], shortTask: false };
    // One failed fix of an ordinary error is still everyday fixing; a second one, or a
    // bug that is tricky by nature, is not.
    const tricky = task?.category === "debug" || classifyOne(prompt).category === "debug";
    if (failures >= 2 || tricky) return inherit(base, failures >= 2 ? 0.85 : 0.75, "still failing after a fix");
    if (failures === 1 && task) return inherit({ ...task, level: LEVELS[Math.max(levelIndex(task.level), levelIndex("high"))] }, 0.6, "one more attempt");
    if (task) return inherit({ ...task, level: LEVELS[Math.max(levelIndex(task.level), levelIndex("high"))] }, 0.55, "another attempt");
    return null;
  }
  if (kind === "accept") {
    // "yes, and also check X": the extra request counts too; the harder of the two wins.
    const rest = prompt.replace(ACCEPT_RE, " ").trim();
    // A bare "yes" to "fix it now, or write it up first?" says nothing about which.
    if (!rest && EITHER_OR_RE.test(assistant.slice(-600))) return null;
    // The extra request read on its own; the conversation is weighed separately below.
    const own = rest.split(/\s+/).length >= 2 ? classifyPrompt(rest) : null;
    const next = assistant ? classifyNextStep(assistant, {}) : null;
    const ownOk = Boolean(own?.level && own.confidence >= 0.5);
    // A vague reading of the offer gives way to the user's own words ("ok tag it").
    const nextOk = Boolean(next?.level && (next.confidence >= 0.6 || !ownOk));
    const candidates = [
      nextOk ? inherit(next, Math.max(next.confidence, 0.7), `you accepted: ${next.label}`, { nextStep: false }) : null,
      ownOk ? own : null,
    ].filter(Boolean);
    // "yep do the rest", "fix them all": several items of the same work, so long work;
    // "just that one for now" is one item.
    const narrowed = NARROW_RE.test(prompt);
    const many = narrowed ? { longWork: false, multiStep: false } : MULTI_ITEM_RE.test(rest.toLowerCase()) || MANY_FOLLOW_RE.test(rest) ? { longWork: true, multiStep: true } : {};
    if (candidates.length) {
      const best = candidates.sort((a, b) => levelIndex(b.level) - levelIndex(a.level))[0];
      // The request agrees with the task or the offer it answers ("ok now the tests"
      // after a feature): more certain than either alone.
      const agrees = [task?.level, ...candidates.filter((item) => item !== best).map((item) => item.level)].includes(best.level);
      return { ...best, ...many, confidence: round2(best.confidence + (agrees ? 0.15 : 0)) };
    }
    if (task && many.longWork) return inherit(task, Math.max(task.confidence * 0.85, Math.min(task.confidence, 0.6)), `the rest of: ${task.label}`, many);
  }
  if (kind === "pronoun") {
    // "the rest of the small comments", "the same review for every open PR": the user's
    // own words describe the work better than the task they continue.
    const own = classifyOne(prompt);
    if (own.level && own.confidence >= (isLight(own.level) ? 0.6 : 0.65)) return { ...own, reasons: [`continues: ${own.label}`, ...(own.reasons ?? [])].slice(0, 4) };
  }
  // A plain "yes" or "continue" keeps the task's certainty, short of a fresh signal.
  if (task) return inherit(task, Math.max(task.confidence * (kind === "pronoun" ? 0.75 : 0.85), kind === "accept" ? Math.min(task.confidence, 0.6) : 0), `continues: ${task.label}`);
  return null;
}

// A light standalone reading of a prompt that clearly belongs to a hard ongoing task.
function withinHardTask(rec, prompt, history) {
  if (!history.length || (rec.level && !rec.shortTask && levelIndex(rec.level) >= levelIndex("high"))) return null;
  const task = taskContext(history);
  if (!task || !isHardTask(task)) return null;
  // A phase read from Claude's message alone needs a clearer link to the prompt.
  const related = sharedWords(prompt, history.map((message) => message.text).join(" ")) >= (task.fromAssistant ? 2 : 1);
  if (!related) return null;
  return inherit(task, Math.max(0.6, task.confidence * 0.75), `part of: ${task.label}`);
}

/**
 * Classify one prompt into a recommended effort level.
 * Returns derived labels only; the text itself is never part of the result.
 *
 * `options.history`: earlier messages ({ role, text }), read in memory only.
 * `options.window`: the window entries of earlier prompts (levels, see windowEntry).
 */
export function classifyPrompt(prompt, options = {}) {
  const rec = classifyOne(prompt, options);
  return Array.isArray(options.window) && options.window.length ? withLightRun(rec, prompt, options.window, options.history ?? []) : rec;
}

const wordsIn = (text) => (String(text ?? "").match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu) ?? []).length;

// Quick back-and-forth: short requests answered by short replies ("Done.", "Changed it.").
function shortReplies(history) {
  let count = 0;
  for (let index = history.length - 1; index >= 1; index -= 2) {
    const reply = history[index];
    const ask = history[index - 1];
    if (reply?.role !== "assistant" || ask?.role !== "user") break;
    if (wordsIn(reply.text) > 30 || wordsIn(ask.text) > 15) break;
    count += 1;
  }
  return count;
}

const isLight = (level) => levelIndex(level) >= 0 && levelIndex(level) <= levelIndex("medium");

/**
 * What one prompt adds to the session window: its level, or "medium" for a short
 * prompt with no signal of its own (a chore or an aside), so an unknown extends a run
 * of light work instead of breaking it. Null adds nothing.
 */
export function windowEntry(rec, prompt) {
  if (rec?.level) return rec.level;
  if (!rec || ["empty", "slash_command", "ultrathink_requested"].includes(rec.skip)) return null;
  const words = (String(prompt ?? "").match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu) ?? []).length;
  return words > 0 && words <= 12 ? "unknown" : null;
}

const lightish = (entry) => entry === "unknown" || isLight(entry);

// Three or more light requests in a row: the session is doing small things, whatever this
// one prompt says on its own. At least two must be recognisably light, or Claude's replies
// to them must have been short. Only ever a reason to go down.
function withLightRun(rec, prompt, window, history = []) {
  if (rec.explicit || !(rec.level || rec.skip === "no_signal")) return rec;
  const entry = windowEntry(rec, prompt);
  if (!entry || !lightish(entry)) return rec;
  const run = [entry];
  for (let index = window.length - 1; index >= 0 && lightish(window[index]); index -= 1) run.push(window[index]);
  const known = run.filter(isLight);
  if (run.length < 3 || (known.length < 2 && shortReplies(history) < 2)) return rec;
  // Short questions inside a design or debugging discussion are part of that hard work.
  const task = history.length ? taskContext(history) : null;
  if (task && isHardTask(task) && sharedWords(prompt, history.map((message) => message.text).join(" ")) >= 2) return rec;
  const level = known.length ? known.reduce((top, item) => (levelIndex(item) > levelIndex(top) ? item : top), "low") : "medium";
  const confidence = round2(Math.max(rec.level ? rec.confidence : 0, 0.6 + 0.05 * Math.min(run.length - 3, 4)));
  return {
    ...(rec.level ? rec : { features: rec.features }),
    level,
    confidence,
    category: "light_run",
    label: "a run of small tasks",
    reasons: [`${run.length} small requests in a row`],
    shortTask: false,
    downOnly: true,
    ultracodeHint: false,
  };
}

function classifyOne(prompt, options = {}) {
  const text = typeof prompt === "string" ? prompt : String(prompt ?? "");
  const trimmed = text.trim();
  if (!trimmed) return silent("empty");
  if (trimmed.startsWith("/")) return silent("slash_command");
  const history = Array.isArray(options.history)
    ? options.history.filter((message) => message && typeof message.text === "string").slice(-(options.contextMessages ?? DEFAULT_CONFIG.contextMessages))
    : [];
  // A bug still failing after Claude's fixes is tricky debugging, whatever this message says
  // ("quick q" included), until the user reports it solved or moves on.
  const attempts = history.length ? failedAttempts(history, trimmed) : 0;
  if (attempts >= 1 && !SOLVED_RE.test(trimmed)) {
    const words = (trimmed.match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu) ?? []).length;
    const reportsIt = PERSISTS_RE.test(trimmed);
    const continues = reportsIt || words <= 15 || sharedWords(trimmed, history.map((message) => message.text).join(" ")) >= 2;
    // After one failed fix, only a bug that is tricky by nature (intermittent, a crash, a
    // leak) moves up; an ordinary error that came back is still everyday fixing.
    const tricky = attempts >= 2 || [taskContext(history), classifyOne(trimmed)].some((rec) => rec?.category === "debug");
    if (tricky && ((attempts >= 2 && continues) || (attempts === 1 && reportsIt))) {
      const fixes = attempts >= 2 ? `${attempts} fixes` : "a fix";
      // "less often than before": the last fix helped, so the next step may not need more.
      const improving = attempts === 1 && IMPROVING_RE.test(trimmed);
      return { level: "xhigh", confidence: attempts >= 2 ? 0.85 : improving ? 0.6 : 0.75, category: "debug", label: "tricky debugging", reasons: [`still failing after ${fixes}`], shortTask: false, saga: attempts, followUp: followUpKind(trimmed) ?? undefined, ultracodeHint: false };
    }
  }
  // "back to the duplicate jobs thing": the earlier task it names, not the detour since.
  const back = history.length ? BACK_TO_RE.exec(trimmed) : null;
  if (back) {
    const topic = back[1];
    for (let index = history.length - 1; index >= 0; index -= 1) {
      const message = history[index];
      if (message.role !== "user" || sharedWords(topic, message.text) < 1) continue;
      const earlier = classifyOne(message.text, { history: history.slice(0, index), noSplit: true });
      const own = classifyOne(trimmed, { noSplit: true });
      if (earlier.level && (!own.level || levelIndex(earlier.level) > levelIndex(own.level))) {
        return { ...inherit(earlier, Math.max(0.6, earlier.confidence * 0.9), `back to: ${earlier.label}`), ultracodeHint: false };
      }
      break;
    }
  }
  // A follow-up ("yes do it", "try again", "now the tests") takes the level of what it continues.
  const follow = followUpKind(trimmed);
  if (follow && history.length) {
    const resolved = resolveFollowUp(follow, history, trimmed);
    if (resolved) return { ...resolved, followUp: follow, ultracodeHint: false };
  }
  if (trimmed.length <= 60 && CONTINUE_RE.test(trimmed)) return silent("continuation");
  const lowered = trimmed.toLowerCase();
  if (/\bultrathink\b/.test(lowered)) return silent("ultrathink_requested");
  const ultracodeRequested = /\bultracode\b/.test(lowered);

  const explicit = EXPLICIT_RE.exec(trimmed);
  // "no need to switch to max effort" names a level to avoid, not one to use.
  const negatedLevel = explicit && /\b(?:no need to|don'?t|dont|do not|never|not|without|no)\b[^.?!]{0,20}$/i.test(trimmed.slice(Math.max(0, explicit.index - 30), explicit.index));
  if (explicit && !negatedLevel) {
    const level = normalizeLevel((explicit[1] ?? explicit[2] ?? "").replace(/\s+/g, ""));
    if (level && !isAdaptive(level)) {
      return { level, confidence: 0.95, category: "explicit", label: "the level you asked for", reasons: ["explicit request"], explicit: true, ultracodeHint: false };
    }
  }

  const features = textFeatures(trimmed);
  // Many parts ("~140 files", "every endpoint", "one by one", "create, list and void").
  const manyItems = broadness(features.prose) >= 2 || MULTI_ITEM_RE.test(features.prose) || LOTS_RE.test(features.prose) || INLINE_LIST_RE.test(features.prose);
  const { scores, tags } = scoreCategories(features, options.routerMode, { nextStep: options.nextStep });
  const ranked = CATEGORY_NAMES
    .filter((name) => scores[name] > 0)
    .sort((a, b) => scores[b] - scores[a] || closenessToDefault(a) - closenessToDefault(b));
  if (!ranked.length) {
    // A prompt with no signal of its own continues the conversation's task: firmly when it
    // plainly belongs to a hard task, weakly otherwise.
    const hard = withinHardTask({ level: null }, trimmed, history);
    if (hard) return { ...hard, ultracodeHint: false };
    if (history.length && features.wordCount <= 12) {
      const task = taskContext(history);
      // A weak guess: never enough for a jump of two levels.
      if (task) return { ...inherit(task, task.confidence * 0.75, `continues: ${task.label}`), weak: true, ultracodeHint: false };
    }
    return silent("no_signal", { features: summarizeFeatures(features) });
  }

  let top = ranked[0];
  // A small-edit phrase inside a bigger build request ("build the export and add a
  // test") does not make the request small.
  const actionful = features.wordCount >= 40 || features.listItems >= 2 || features.actionVerbs >= 2;
  if (top === "small_edit" && scores.build >= 2 && actionful) top = "build";
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
  // Several actions, a list or a long request is real work, whatever it is called.
  // (Four short lines alone are not a substantial request.)
  const substantial = features.wordCount >= 40 || features.listItems >= 2 || (features.lineCount >= 4 && features.wordCount >= 25) || features.pastedError || features.actionVerbs >= 3 || manyItems;
  // "quick one:" in front of a substantial task does not make the task quick.
  if (features.quickCues > 0 && !substantial && !["quick", "small_edit"].includes(category)) {
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
  // A broad sweep for cleanup or occurrences (dead code, every place we log X) is breadth,
  // not depth: Ultracode covers the breadth, and each part is ordinary work. Security
  // reviews keep their depth.
  // (Also a sweep for flaky tests: finding each one is ordinary work.)
  if ((category === "review" || category === "debug") && levelIndex(level) > levelIndex("high") && broadness(features.prose) >= 3 && !SECURITY_RE.test(features.scoring)) {
    level = "high";
    reasons.push("a broad sweep: breadth, not depth");
  }

  let confidence = 0.35 + 0.15 * Math.min(scores[top], 4);
  const runnerUp = ranked[1];
  const contested = Boolean(runnerUp && scores[runnerUp] >= scores[top] * 0.75 && CATEGORIES[runnerUp].level !== CATEGORIES[top].level && category === top);
  if (contested) confidence -= 0.15;
  // "~60 files, but most of it is generated": a lighter review than its size suggests.
  if (category === "review" && GENERATED_RE.test(features.prose)) {
    confidence -= 0.1;
    if (levelIndex(level) > levelIndex("high")) level = "high";
    reasons.push("mostly generated code");
  }
  if (features.wordCount < 4) confidence -= 0.1;
  // A substantial request (several sentences, a list, pasted output, several actions) is
  // real work: the category is more certain and the level matters more.
  if (substantial && SUBSTANTIAL_CATEGORIES.has(category)) {
    confidence += 0.1;
    reasons.push("substantial request");
  }
  // Long work with nothing competing (several actions, a list, many parts, a plan to build).
  const longWork = features.listItems >= 2 || features.wordCount >= 60 || features.actionVerbs >= 3 || manyItems || tags.build.includes("implementation");
  if (SUBSTANTIAL_CATEGORIES.has(category) && ranked.length === 1) confidence += 0.05;
  if (SUBSTANTIAL_CATEGORIES.has(category) && longWork) confidence += 0.05;
  confidence = round2(confidence);

  const reviewLike = category === "review" || scores.review >= 3 || (category === "research_hard" && /\baudit\b/.test(features.prose));
  const rec = {
    level,
    confidence,
    category,
    label: CATEGORIES[category].label,
    reasons: [...new Set(reasons)].slice(0, 4),
    // Asked for something quick: the answer is over before a switch could help it.
    // (A pasted error alone does not make a small fix long.)
    shortTask: !(features.wordCount >= 40 || features.listItems >= 2 || features.actionVerbs >= 3 || manyItems) && (!substantial || features.pastedError) && (SHORT_TASKS.has(category) || features.quickCues > 0),
    substantial,
    // Long work ahead: several actions or a list (pasted output alone is not long work).
    longWork,
    // Two actions or more ("add the flag and write tests"): more than a one-off.
    multiStep: features.actionVerbs >= 2,
    // Building right after a design or research discussion: the implementation phase.
    afterDesign: category === "build" && history.length > 0 && ["design", "research_hard", "research"].includes(taskContext(history)?.category),
    // One weak or contested keyword: fine for a tip close by, not for a jump of two levels.
    weak: (scores[top] <= 1 && !substantial) || contested,
    // A refactor, migration or split: edits in the middle of it are not routine.
    // ("mostly mechanical", a mapping table or a codemod make it routine again.)
    riskyChange: RISKY_CHANGE_RE.test(features.clean) && !MECHANICAL_RE.test(features.clean),
    ultracodeHint: reviewLike && !ultracodeRequested && ULTRACODE_SCOPE_RE.test(features.prose),
    features: summarizeFeatures(features),
  };
  // Two tasks in one message ("quick q: where's X? also the webhook randomly 500s"): the
  // harder part sets the level.
  if (!options.noSplit) {
    const part = hardestClause(trimmed);
    if (part && levelIndex(part.level) > levelIndex(rec.level) && part.confidence >= 0.65) {
      return { ...part, reasons: [`the harder part: ${part.label}`, ...(part.reasons ?? [])].slice(0, 4), substantial: rec.substantial || part.substantial, longWork: rec.longWork || part.longWork, multiStep: true, shortTask: false, ultracodeHint: rec.ultracodeHint };
    }
  }
  // A question or explanation inside a hard ongoing task is part of that task.
  if (["quick", "explain"].includes(category)) {
    const hard = withinHardTask(rec, trimmed, history);
    if (hard) return { ...hard, ultracodeHint: false };
  }
  return rec;
}

const CLAUSE_SPLIT_RE = /(?<=[.?!])\s+|\n+|;\s*|,?\s*\b(?:and also|also|separately|unrelated(?:ly)?|another thing|btw|plus|and then)\b[,:]?\s*|\s+and (?=(?:help|tell|figure|decide|check|review|look|debug|fix|investigate|find|add|build|write|explain|compare|research|design)\b)/i;

// The hardest part of a message with several, each read on its own.
function hardestClause(text) {
  const clauses = stripCode(text).split(CLAUSE_SPLIT_RE).map((clause) => (clause ?? "").trim()).filter((clause) => wordsIn(clause) >= 5);
  if (clauses.length < 2) return null;
  let best = null;
  for (const clause of clauses) {
    const rec = classifyOne(clause, { noSplit: true });
    if (rec.level && rec.confidence >= 0.65 && (!best || levelIndex(rec.level) > levelIndex(best.level))) best = rec;
  }
  return best;
}

const SUBSTANTIAL_CATEGORIES = new Set(["build", "debug", "design", "review", "research", "research_hard"]);
const MULTI_ITEM_RE = /\b(?:one by one|one at a time|each of (?:them|these|those)|all of (?:them|these|those)|the rest of (?:the |them|these)|item by item|file by file|(?:do|finish|fix) the rest|the remaining (?:ones|\d+)|the other \d+)\b/;
const LOTS_RE = /\bthere (?:are|is) (?:like |about |around |roughly |~)?\d{2,}\b|\ball \d{2,}\b|\b\d{2,}\s+(?:items|files|checks|steps|tests|endpoints|services|call sites|places|packages|components|pages|modules|screens|tables|keys)\b/;
// "create, list and void", or four parts in a row without a colon.
const INLINE_LIST_RE = /:\s*[^,.:;\n]{2,40},\s*[^,.:;\n]{2,40},?\s+(?:and|or)\s+[^,.:;\n]{2,40}|[^,.:;\n]{2,40},\s*[^,.:;\n]{2,40},\s*[^,.:;\n]{2,40},?\s+and\s+[^,.:;\n]{2,40}/;
const SECURITY_RE = /\b(?:auth(?:z|n|orization|entication|enticated)?|injection|injectable|sql injection|string-built sql|unsafe (?:sql|quer(?:y|ies)|deserialization|eval|html|input|redirects?)|xss|csrf|ssrf|redos|catastrophic backtracking|(?:untrusted|user) input|permissions?|privilege|secrets?|credentials?|crypto(?:graphy)?|vulnerab(?:le|ility|ilities)|exploit(?:able)?|security|payments?|billing|ledger|money|rate[- ]limit(?:ing|s)?|lockouts?|brute[- ]force)\b/;
const GENERATED_RE = /\bmost(?:ly)? (?:of (?:it|them|the (?:diff|files|changes)) )?(?:is |are )?(?:just )?(?:the )?(?:generated|auto-?generated|boilerplate|renames?|formatting|lock ?files?|snapshots?)\b|\b(?:generated|auto-?generated) (?:code|types|files|clients?)\b(?=[^.?!]*\b(?:most|mostly|majority)\b)/;
const RISKY_CHANGE_RE = /\b(?:refactor(?:ing)?|migrat(?:e|ion|ing)|split(?:ting)?|restructur(?:e|ing)|rewrit(?:e|ing)|re-?architect(?:ing)?|untangl(?:e|ing)|decoupl(?:e|ing)|god object|(?:behaviou?r|output|api) (?:has to|must|should|needs to) stay (?:the same|identical|unchanged)|without changing (?:any )?behaviou?r|(?:stay|keep (?:it|them)?) (?:identical|backwards?[- ]compatible)|keep (?:the )?(?:behaviou?r|output|api|results?|semantics) (?:identical|the same|unchanged|exactly as (?:it is|is))|error paths|pull (?:\w+ ){0,3}?out (?:of|into)|extract (?:\w+ ){0,3}?(?:into|out of)|move (?:\w+ ){0,3}?into (?:its|their) own|split (?:\w+ )?out)\b/;
const MECHANICAL_RE = /\b(?:(?:mostly|purely|just|all|pretty) )?mechanical\b|\b(?:search|find) and replace\b|\bcodemod\b|\bmapping table\b|\bsame (?:change|pattern|edit) (?:in|for|across|everywhere)\b/;

function summarizeFeatures(features) {
  return {
    wordCount: features.wordCount,
    listItems: features.listItems,
    pastedError: features.pastedError,
  };
}

// ---------------------------------------------------------------------------
// End of turn: predict the effort the likely next step needs.

// A passing mention ("two of them were already flaky") is not an open problem.
const UNRESOLVED_RE = /\bstill\s+(?:fail(?:s|ing)?|broken|crash(?:es|ing)?|flaky|not working|reproduc(?:es|ing)|happening|leaking|climbing)\b|\bcould(?:n'?t| not)\s+(?:reproduce|find the cause|determine|fix|explain)\b|\broot cause\s+(?:is\s+)?(?:still\s+)?(?:unknown|unclear|not (?:yet )?(?:found|known|clear))\b|\bnot\s+(?:yet\s+)?(?:fixed|resolved)\b|\b(?:is|are|remains?|stays?) (?:still )?(?:flaky|intermittent)\b|\bfails? intermittently\b|\b(?:didn'?t|did not|doesn'?t) hold\b|\bneither (?:change|fix|attempt|of (?:them|those|these)) (?:fixed|helped|worked|changed)\b|\bha(?:ve|s)(?:n'?t| not) (?:yet )?found\b|\bcan'?t (?:yet )?explain\b|\bno (?:clear )?(?:cause|explanation) yet\b/i;
const UNRESOLVED_ALL_RE = new RegExp(UNRESOLVED_RE.source, "gi");
const IMPLEMENT_NEXT_RE =/\b(?:approve|approval of)\s+(?:the|this)\s+(?:plan|design|spec|approach)\b|\b(?:plan|design|spec) is ready\b|\bready to (?:implement|build|start)\b|\b(?:shall|should|can) i (?:start|go ahead|implement|build|apply|make the changes)\b|\b(?:want|like) me to (?:implement|build|apply|make|start|proceed)\b|\bgo ahead and (?:implement|build)\b|\bimplementation plan\b|\bhere'?s the (?:[\w-]+ )?plan\b|\bapprove (?:it|this|that) and i'?ll (?:start|begin|implement|build|go)\b/i;
const PLAN_READY_RE = /\b(?:approve|approval of)\s+(?:the|this)\s+(?:plan|design|spec|approach)\b|\b(?:plan|design|spec) is ready\b|\bready to (?:implement|build|start)\b|\bimplementation plan\b|\bhere'?s the (?:[\w-]+ )?plan\b|\bapprove (?:it|this|that) and i'?ll\b|\b(?:want|like) me to (?:implement|build|start) (?:it|the plan|this|that)\b/i;
// Turn-end evidence beyond the offer sentence.
const MULTI_ATTEMPT_RE = /\b(?:tried (?:two|three|several|a few|both|\d) (?:things|fixes|approaches|changes|ways)|neither (?:change|fix|attempt|of (?:them|those|these))|both (?:changes|fixes|attempts) (?:made|failed|didn'?t|only)|(?:second|third|another) (?:fix|attempt) (?:didn'?t|did not|also)|still (?:fails?|happens|reproduces) after|(?:two|three|four|several|\d) (?:hypotheses|theories|possible causes|candidate causes))\b/i;
const CHOOSE_Q_RE = /\b(?:which (?:do you prefer|one do you want|would you (?:like|prefer|pick)|direction|option|approach)|do you (?:prefer|want) [^?.]{0,60}\bor\b|let me know which|your call|up to you|(?:which|what) should we (?:go with|pick|choose|do))\b/i;
const RECOMMEND_RE = /\brecommendation:|\bi (?:would |'d )?recommend (?:we )?(?:go with|stay|stick|use|pick|keep|switch)\b|\bmy recommendation is\b/i;
const TRADEOFF_RE = /\b(?:trade-?offs?|on the other hand|would also cost|the downside|the upside|at the cost of|in exchange for|technically (?:yes|possible|doable|feasible),? but|(?:failure|consistency|ordering|delivery) semantics)\b|\b(?:pros|cons):/i;
const NEXT_MARKER_RE = /\b(?:next step|next,|next i|want me to|would you like me to|should i|shall i|i can (?:now |also )?|ready to|remaining|left to do|follow[- ]up|then i'll|after that|todo|want (?:a|an|the|us)|would you like (?:a|an|the)|shall we|move on to|happy to|which (?:do you prefer|direction|one do you want|would you like|should we)|i'?d (?:suggest|recommend)|i'?ll start (?:with|on)|approve (?:it|this|that) and i'?ll|let me know (?:which|if you want))\b/i;

const NEXT_LIST_RE = /(?:^|\n)\s*(?:#+\s*)?(?:\*\*)?(?:next steps?|what'?s next|to do next|remaining work|follow[- ]ups?|still to do|left to do|to ?do|remaining)(?:\*\*)?\s*:?\s*\n((?:\s*(?:[-*•]|\d+[.)])\s+.+\n?)+)/i;
const DONE_RE = /^\s*(?:fixed|done|resolved)\b|\b(?:all (?:tests|checks) pass(?:ed)?|(?:is |are )?(?:now )?(?:done|complete|finished|merged|pushed|shipped|deployed)\b|nothing (?:else )?(?:left|remaining)|that'?s everything|(?:ci|the build|build|tests?|everything|the suite) (?:is|are) (?:now )?green|all green)/i;
const INLINE_NEXT_LIST_RE = /\b(?:next steps?|still to do|left to do|to ?do|remaining)\s*:\s*((?:[-*•]|\d+[.)])\s+[^\n]+)/i;
// "Batch 1 of 4 is done": progress, not the end of the work.
const PARTIAL_RE = /\b(?:batch|step|phase|part|stage|wave|chunk) \d+(?: of \d+)? (?:is |are )?(?:done|complete|finished)\b|\b\d+ of \d+ (?:are |is )?(?:done|complete|finished|migrated|converted)\b|\bnext (?:batch|step|phase|wave)\b/i;
// "Note: not fixed upstream yet" in a finished report is a side note, not an open bug.
const SIDE_NOTE_RE = /^\s*(?:note|nb|fyi|aside|side note|separately|unrelated(?:ly)?|for the record)\b|\bupstream\b/i;
// What was found so far, with the cause still open.
const INVESTIGATING_RE = /\b(?:found so far|so far (?:i|we) (?:found|know|ruled out|checked)|ruled out|still (?:digging|investigating|looking into)|not sure (?:yet )?why|haven'?t (?:yet )?pinned (?:it )?down|unclear why|no idea why yet|next i'?d (?:check|look at|try|bisect))\b/i;
// A choice of a format, a name or a colour is no design decision.
const SMALL_CHOICE_RE = /\b(?:date|time|number|file|log|output) format\b|\bnaming\b|\b(?:a |the )?name (?:for|of)\b|\bwording\b|\blabels?\b|\bcolou?rs?\b|\bcasing\b|\bicons?\b|\border of\b|\btone\b/i;
const BIG_CHOICE_RE = /\b(?:architecture|database|schema|data model|consistency|queue|cach(?:e|ing)|storage|sync|protocol|shard(?:ing)?|replication|monolith|micro-?services?|framework|infrastructure|security|auth\w*|encryption)\b/i;
const OPEN_DECISION_RE = /\bfirst,? (?:we|you) (?:need|have) to (?:decide|choose|pick)\b|\bbefore (?:that|i start|we start|building)\b[^.?!]{0,40}\b(?:decide|choose|pick)\b|\bneeds? a decision\b|\b(?:decision|choice) first\b|\bdecision that blocks\b|\bblocking decision\b|\bblocked on a decision\b|\bone decision (?:first|to make|before)\b/i;
// A review with a list of smaller findings: the next step is fixing them.
// (Minor findings only: blockers, critical or security findings need care, and "tell me
// which to fix first" leaves the next step open.)
const FINDINGS_RE = /\b\d+ (?:smaller|minor|small|non-blocking|style|cosmetic) (?:findings|issues|nits|comments|warnings|suggestions)\b|\b\d+ nits\b|\bnothing blocking\b/i;
const SERIOUS_FINDINGS_RE = /\b(?:blockers?|blocking issues?|critical|high[- ]severity|security|vulnerab\w+)\b/i;
const SKETCH_RE = /\b(?:rough sketch|first sketch|draft (?:design|proposal)|strawman|here'?s a (?:rough )?(?:sketch|design|proposal))\b/i;

export function classifyNextStep(lastMessage, turn = {}, options = {}) {
  const text = typeof lastMessage === "string" ? lastMessage : "";
  if (!text.trim()) return silent("no_message");
  const tail = text.slice(-2000);
  const open = tail.split(/(?<=[.?!])\s+|\n+/).filter((sentence) => !SIDE_NOTE_RE.test(sentence)).join(" ");
  if (UNRESOLVED_RE.test(open) || INVESTIGATING_RE.test(open)) {
    // Several fixes tried and none held, or two separate signs it is still open
    // ("could not reproduce", "root cause still unknown"): a tricky bug for sure.
    // ("What I found so far" is an investigation in progress: as telling as two signs.)
    const openSigns = (open.match(UNRESOLVED_ALL_RE) ?? []).length + (INVESTIGATING_RE.test(open) ? 2 : 0);
    const strong = (turn.failures ?? 0) >= 2 || MULTI_ATTEMPT_RE.test(open) || openSigns >= 2;
    return { level: "xhigh", confidence: strong ? 0.85 : 0.75, category: "debug", label: "debugging", reasons: ["unresolved failure"], nextStep: true };
  }
  // Options laid out and a choice asked for: the next step is a design decision, before
  // any plan in the same answer. A small choice (a format, a name) is not one.
  const weighing = DESIGN_PHASE_RE.test(tail) || TRADEOFF_RE.test(tail) || SKETCH_RE.test(tail);
  const smallChoice = SMALL_CHOICE_RE.test(tail) && !BIG_CHOICE_RE.test(tail);
  const decision = { level: "max", category: "design", label: "a design decision", nextStep: true };
  if ((weighing && CHOOSE_Q_RE.test(tail)) || OPEN_DECISION_RE.test(tail)) {
    if (smallChoice) return { level: "medium", confidence: 0.6, category: "small_edit", label: "a small choice", reasons: ["a small choice is next"], nextStep: true, shortTask: true };
    return { ...decision, confidence: 0.75, reasons: ["a choice between options is next"] };
  }
  if (IMPLEMENT_NEXT_RE.test(tail)) {
    // Building a plan is long work; "want me to apply the fix?" is not.
    return { level: "high", confidence: 0.8, category: "build", label: "implementation", reasons: ["plan ready for implementation"], nextStep: true, longWork: PLAN_READY_RE.test(tail) };
  }
  // A recommendation made: the next step is acting on it.
  if (RECOMMEND_RE.test(tail)) return { level: "high", confidence: 0.75, category: "build", label: "implementation", reasons: ["a recommendation to act on"], nextStep: true };
  if (FINDINGS_RE.test(tail) && !SERIOUS_FINDINGS_RE.test(tail.replace(/\bnothing blocking\b/gi, " ")) && !CHOOSE_FINDINGS_RE.test(tail)) {
    return { level: "high", confidence: 0.75, category: "build", label: "fixing the findings", reasons: ["a list of minor findings to fix"], nextStep: true, longWork: true };
  }
  if (weighing && !smallChoice) return { ...decision, confidence: 0.7, reasons: ["trade-offs still open"] };
  // An explicit "Next steps" list: the first item is what comes next.
  // (Also inline: "Still to do: 1. Query each user… 2. …".)
  const list = NEXT_LIST_RE.exec(tail) ?? INLINE_NEXT_LIST_RE.exec(tail);
  if (list) {
    const first = list[1].split(/\n|\s(?=\d+[.)]\s)/).map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim()).find(Boolean);
    const rec = first ? classifyPrompt(first, { nextStep: true }) : null;
    if (rec?.level) return { ...rec, confidence: round2(rec.confidence - 0.05), nextStep: true, ultracodeHint: false, reasons: ["first listed next step", ...rec.reasons].slice(0, 4) };
  }
  const sentences = tail.split(/(?<=[.?!])\s+|\n+/).filter((sentence) => NEXT_MARKER_RE.test(sentence)).slice(-3);
  if (!sentences.length) return silent(DONE_RE.test(tail) && !PARTIAL_RE.test(tail) ? "done" : "no_next_step");
  const result = classifyPrompt(sentences.join(" ").replace(/\b(?:want|would you like) me to\b|\b(?:should|shall|can) i\b/gi, " "), { nextStep: true });
  if (!result.level) return result;
  void options;
  return { ...result, confidence: round2(result.confidence - 0.05), nextStep: true, ultracodeHint: false };
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
  return { key, batches: 0, calls: 0, edits: 0, editStreak: 0, streakFailures: 0, failures: 0, failingBatches: 0, suggestedTo: null };
}

export function updateTurn(turn, batch) {
  const next = { ...turn };
  next.batches += 1;
  next.calls += batch.calls;
  next.edits += batch.edits;
  next.failures += batch.failures;
  if (batch.failures > 0) {
    next.failingBatches += 1;
    // One stray failure (a grep with no match, a lint run) does not end a run of edits;
    // a second one does.
    next.streakFailures = (next.streakFailures ?? 0) + batch.failures;
    if (next.streakFailures > 1) {
      next.editStreak = 0;
      next.streakFailures = 0;
    }
  } else {
    next.editStreak += batch.edits;
  }
  return next;
}

const HARD_CATEGORIES = new Set(["design", "research_hard", "debug", "review", "debug_spiral"]);

// Is the task this turn serves hard work, whatever the latest tool calls look like?
export function isHardTask(rec) {
  return Boolean(rec?.level) && (HARD_CATEGORIES.has(rec.category) || levelIndex(rec.level) >= levelIndex("xhigh"));
}

export function midTaskRecommendation(turn, current, config = DEFAULT_CONFIG, options = {}) {
  const task = options.turnRec ?? turn.promptRec ?? null;
  // Failing runs are expected while fixing lint or type errors in a light task: it takes
  // twice as many before they look like a debugging spiral.
  const spiralAt = task?.level && isLight(task.level) ? config.debugFailureThreshold * 2 : config.debugFailureThreshold;
  if (turn.failures >= spiralAt && turn.failingBatches >= 2 && levelIndex(current) < levelIndex("xhigh")) {
    return { level: "xhigh", confidence: 0.75, category: "debug_spiral", label: "tricky debugging", reasons: [`${turn.failures} failed tool runs this turn`], midTask: true };
  }
  const threshold = config.mechanicalEditThreshold?.[current];
  if (Number.isFinite(threshold)) {
    // Edits in the middle of a hard task, or of a refactor or migration, are part of that
    // task: no "high is enough" there.
    if (isHardTask(task) || task?.riskyChange) return silent("edits_inside_hard_task");
    // With no idea what the turn is for, ask for a longer run before calling it routine.
    const needed = task?.level ? threshold : Math.ceil(threshold * 1.5);
    if (turn.editStreak >= needed) {
      // A light task's edits can go lower than high; anything else stops at high.
      const level = task?.level && levelIndex(task.level) < levelIndex("high") ? LEVELS[Math.max(levelIndex(task.level), levelIndex(config.downshiftFloor))] : "high";
      // An unknown task already waited for a longer run, so that run is as telling.
      return { level, confidence: task?.level ? 0.8 : 0.75, category: "mechanical", label: "straightforward edits", reasons: [`${turn.editStreak} edits in a row without failures`], midTask: true, allowSingleStep: true };
    }
  }
  // The turn's own task needs more than the current level and the turn is well under
  // way: say so once (the prompt-time tip may not have shown).
  if (task?.level && !task.downOnly && levelIndex(task.level) > levelIndex(current) && (turn.calls ?? 0) >= 4) {
    return { ...task, reasons: ["what this turn is for", ...(task.reasons ?? [])].slice(0, 4), midTask: true };
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
export function decide({ event, current, rec, state = {}, config = DEFAULT_CONFIG, model = null, learning = null }) {
  if (!config.enabled) return { speak: false, why: "disabled" };
  if (!rec?.level) return { speak: false, why: rec?.skip ?? "no_recommendation" };
  if (!current) return { speak: false, why: "current_unknown" };
  // An adaptive level already picks its own depth; comparing against it would only add noise.
  if (isAdaptive(current)) return { speak: false, why: "adaptive_current" };

  let target = rec.level;
  const currentIndex = levelIndex(current);
  if (levelIndex(target) < currentIndex && !rec.explicit) {
    target = LEVELS[Math.max(levelIndex(target), levelIndex(config.downshiftFloor))];
  }
  const delta = levelIndex(target) - currentIndex;
  if (delta === 0) return { speak: false, why: "matches_current" };
  const direction = delta > 0 ? "up" : "down";

  // Turn-end tips are never less strict than the others. A level two or more steps
  // off is worth a tip at lower confidence; one step up needs more. What you followed
  // or dismissed before moves the bar for this kind of tip (counts only).
  const key = learnKey(event, rec, direction);
  if (direction === "up" && rec.downOnly) return { speak: false, why: "light_run_up", key };
  const steps = Math.abs(delta);
  if (direction === "up" && rec.shortTask && steps < 2 && !rec.explicit) return { speak: false, why: "short_task_small_gain", key };
  // One small build request ("add a --verbose flag") is over before a higher level pays off;
  // going up is for substantial work.
  if (direction === "up" && event === "prompt" && rec.category === "build" && !rec.substantial && !rec.multiStep && !rec.longWork && !rec.inherited && rec.confidence < 0.8) {
    return { speak: false, why: "one_off_up", key };
  }
  // The lower bar for a big gap needs a clear reading, not one weak or contested keyword.
  const gap = direction === "up" ? (steps >= 2 && !rec.weak ? -0.1 : 0.1) : 0;
  const base = (event === "stop" ? Math.max(config.stopMinConfidence, config.minConfidence) : config.minConfidence) + gap;
  const offset = config.learning && learning ? thresholdOffset(learning, key) : 0;
  if (rec.confidence < base + offset && !rec.explicit) return { speak: false, why: offset > 0 ? "learned_quiet" : "low_confidence", key };

  let sustained = false;
  if (direction === "down" && !rec.explicit) {
    const downSteps = -delta;
    // A run of lighter work (the light-run reading is one already), not a pause inside hard work.
    sustained = rec.category === "light_run" || (!HARD_CATEGORIES.has(rec.category) && recentAgree(state.window, target, event, config.sustainedWindow));
    // A quick answer is finished before a switch could help it; wait for a pattern.
    if (rec.shortTask && !sustained) return { speak: false, why: "short_task_not_sustained" };
    // max is a fair choice for hard debugging, reviews and design; one step down is no tip.
    if (current === "max" && downSteps === 1 && HARD_CATEGORIES.has(rec.category)) return { speak: false, why: "max_fits_hard_work" };
    // So is one small request: going down needs a run of lighter work or long work ahead.
    // (A "yes" to a small fix is a small request too: what it inherits decides.)
    if (event === "prompt" && !sustained && !rec.longWork && !rec.multiStep && !rec.substantial && !rec.allowSingleStep && !rec.downOnly && !rec.afterDesign) {
      return { speak: false, why: "one_off_down" };
    }
    // max → xhigh is worth saying for ordinary work, not for hard debugging, reviews or
    // design, where max is a fair choice.
    // From max, or the build phase right after a design: one step down is worth saying.
    const fromMaxOk = (current === "max" || rec.afterDesign) && !HARD_CATEGORIES.has(rec.category);
    // Long ordinary work on xhigh (several actions, a list, a big spec): high is enough,
    // and the saving adds up over the whole task.
    const longWorkOk = current === "xhigh" && rec.longWork && !HARD_CATEGORIES.has(rec.category) && rec.confidence >= 0.75;
    const singleStepOk = downSteps === 1 && (fromMaxOk || rec.allowSingleStep || longWorkOk) && rec.confidence >= config.maxSingleStepConfidence;
    if (downSteps < config.downshiftMinSteps && !singleStepOk && !sustained) {
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
  return { speak: true, from: current, to: target, direction, sustained, why: "suggest", key };
}

// ---------------------------------------------------------------------------
// Learning: counts per kind of tip, never text. Followed tips lower the bar for
// that kind, dismissed ones raise it; a level you pick yourself counts as followed.

export const learnKey = (event, rec, direction) => `${event}:${rec?.category ?? "unknown"}:${direction}`;

export function emptyLearning() {
  return { v: 1, keys: {} };
}

const LEARN_CAP = 40;

export function recordOutcome(learning, key, outcome) {
  if (!key || !["accepted", "dismissed", "ignored", "manual"].includes(outcome)) return learning ?? emptyLearning();
  const base = learning?.v === 1 ? learning : emptyLearning();
  const counts = { accepted: 0, dismissed: 0, ignored: 0, manual: 0, ...(base.keys[key] ?? {}) };
  counts[outcome] = Math.min(LEARN_CAP, counts[outcome] + 1);
  return { v: 1, keys: { ...base.keys, [key]: counts } };
}

export function thresholdOffset(learning, key) {
  const counts = learning?.keys?.[key];
  if (!counts) return 0;
  const raw = 0.04 * (counts.dismissed ?? 0) + 0.015 * (counts.ignored ?? 0) - 0.05 * (counts.accepted ?? 0) - 0.04 * (counts.manual ?? 0);
  return Math.round(Math.max(-0.15, Math.min(0.3, raw)) * 100) / 100;
}

export function describeLearning(learning) {
  const rows = Object.entries(learning?.keys ?? {})
    .map(([key, counts]) => ({ key, offset: thresholdOffset(learning, key), ...counts }))
    .filter((row) => row.offset !== 0 || row.accepted || row.dismissed);
  if (!rows.length) return "Effort Advisor has not learned anything yet.";
  return [
    "Effort Advisor has learned (higher bar = quieter for that kind of tip):",
    ...rows.map((row) => `- ${row.key.replaceAll(":", " · ")}: followed ${row.accepted + row.manual}, dismissed ${row.dismissed}, ignored ${row.ignored} → bar ${row.offset >= 0 ? "+" : ""}${row.offset}`),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Ultracode: multi-agent workflows on every task. Worth it for broad sweeps that
// split into many independent parts; wasteful for small or everyday work.

const SWEEP_RE = /\b(?:audit|review|migrat(?:e|ion|ing)|port(?:ing)?|upgrade|refactor|rename|convert|translat(?:e|ing)|locali[sz](?:e|ing)|sweep|scan|inventory|catalog(?:ue)?|survey|go (?:thru|through)|find (?:all|every|any)|fix (?:all|every|them all)|check (?:all|every|each)|update (?:all|every)|list (?:all|every)|add (?:docstrings|comments|type hints|types|annotations|tests|logging) to (?:every|all|each)|(?:move|switch|replace|convert) (?:all|every))\b/i;
const BROAD_UNITS = "files?|modules?|services?|micro-?services?|packages?|components?|endpoints?|pages?|tests?|crates?|repos?|routes?|screens?|tables?|call ?sites?|usages?|places?|occurrences?|instances?|functions?|classes|methods|jobs?|prs?|pull requests?|bugs?|issues?|vulnerabilit(?:y|ies)|dependenc(?:y|ies)|libs?|librar(?:y|ies)|tools?|options?|vendors?|systems?|pieces?|parts?|areas?|teams?|strings|keys|docstrings|translations|dockerfiles|configs|manifests|workflows|pipelines|charts";
// "every time" and "each day" are not scope.
const BROAD_RE = new RegExp(
  String.raw`\b(?:entire|whole|full|complete)\s+(?:[\w-]+\s+)?(?:code ?base|repo(?:sitory)?|project|system|monorepo|app(?:lication)?|front-?end|back-?end|stack|org|lot)\b` +
    String.raw`|\b(?:(?:every|each)(?! (?:time|day|night|morning|week|so often|now and then))|all (?:of )?(?:the |our )?)\s*(?:[\w-]+\s){0,4}?(?:${BROAD_UNITS})\b` +
    String.raw`|\ball \d{2,}\b|\beverywhere\b|\bacross the board\b|\bthroughout (?:the |our )?(?:code ?base|repo|app|project|monorepo)\b` +
    String.raw`|\b(?:in|across) (?:\d{1,3}|several|many|multiple) (?:packages|services|modules|repos|apps|teams)\b|\bacross (?:the |all |our |every |\d+ )?(?:[\w-]+ )?(?:code ?base|repo(?:sitory)?|project|monorepo|app(?:lication)?|front-?end|back-?end|stack|services|modules|packages|files|teams?|src\/?)` +
    String.raw`|\b(?:a bunch|lots|loads|many|dozens|hundreds|several) of (?:our |the |these )?(?:services|modules|repos|packages|files|places)\b`,
  "i",
);
// Many parts: 20 or more small units, or 10 or more big ones (packages, services, repos).
const MANY_RE = /(?:^|[^\w.])~?(?:[2-9]\d|\d{3,})(?:ish|\+)?\s+(?:\w+\s){0,2}?(?:of (?:them|these)|files|endpoints|tests|components|call ?sites|functions|classes|jobs|prs|tables|screens|places|keys|strings|docstrings|findings|occurrences|usages|pages|routes)\b|(?:^|[^\w.])~?(?:[1-9]\d|\d{3,})(?:ish|\+)?\s+(?:\w+\s){0,2}?(?:modules|services|packages|repos|apps)\b|\b(?:like|roughly) \d{2,}\+?(?!\s*(?:ms|s|sec|seconds?|min|minutes?|%|mb|gb|kb|px))\b|\bthere are a lot of (?:them|these)\b|\b(?:[2-9]|\d{2,}) (?:batches|phases|waves|chunks)\b|\b(?:package|module|file|service|repo|team) by (?:package|module|file|service|repo|team)\b/i;
const EXHAUSTIVE_RE = /\b(?:exhaustive(?:ly)?|comprehensive(?:ly)?|leave no stone|every single|all possible|go wide|full (?:audit|review|inventory|sweep|survey|search|comparison|scan|list)|thorough (?:audit|review|sweep|survey)|(?:find|list) (?:every|all)\b)/i;
// One coherent change, however many files it touches, is not many independent parts.
const SINGLE_CHANGE_RE = /\breview (?:the|this|my|our|a|that) (?:\w+ ){0,3}?(?:pr|pull request|branch|diff|change(?:set)?|patch|commit)\b|\breview (?:pr|pull request|mr) #?\d+\b|\baudit (?:trail|log|report)s?\b|\bin (?:this|that|the following) (?:function|file|snippet|method|class|component|query|regex|line|script)\b|\bin this:|\brename (?:the )?`?[\w.]+`?(?: \w+)? to `?[\w.]+`?/i;
// One file named as the target, when nothing else says the work is wider.
const ONE_FILE_RE = /\bin [\w./-]+\.(?:py|js|ts|tsx|jsx|go|rs|java|rb|cs|cpp|c|h|md|json|ya?ml)\b/i;
// "all of them" is breadth only when there are many of them.
const ALL_OF_RE = /\ball (?:of )?(?:them|these|those)\b/i;
// "no need to go through the entire repo": breadth the user ruled out.
const NEG_SCOPE_RE = /\b(?:no need to|don'?t|dont|do not|without|never|not)\s+(?:\w+\s+){0,4}?(?:the\s+)?(?:entire|whole|every|all|each|across)\b(?:(?!\b(?:and|but|then|just|instead)\b)[^.?!,;\n])*/gi;
const ULTRACODE_WORD_RE = /\bultra-?code\b/i;
const ANYTHING_ELSE_RE = /\b(?:anything else|what'?s next|let me know if|no other occurrences|that'?s (?:it|all))\b/i;

function stripCode(text) {
  return String(text ?? "").replace(/```[\s\S]*?(?:```|$)/g, " ");
}

/** How much a request splits into many independent parts (0 = none). */
export function broadness(text) {
  const prose = stripCode(text).replace(NEG_SCOPE_RE, " ");
  let score = 0;
  const broad = BROAD_RE.test(prose);
  const many = MANY_RE.test(prose);
  if (SWEEP_RE.test(prose)) score += 1;
  if (broad) score += 2;
  if (many) score += 1;
  if (ALL_OF_RE.test(prose)) score += 1;
  if (EXHAUSTIVE_RE.test(prose)) score += 2;
  // (Every function in one file is still one file; "45 files ... in lib/http.ts" is not.)
  if (SINGLE_CHANGE_RE.test(prose) || (ONE_FILE_RE.test(prose) && !many)) score -= 2;
  return Math.max(0, score);
}

function lastSubstantialUser(history) {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index]?.role === "user" && isSubstantial(history[index].text)) return history[index].text;
  }
  return "";
}

const ACK_RE = /^(?:(?:perfect|great|thanks?(?: you)?|ty|thx|cool|nice|awesome|cheers|ok(?:ay)?|got it|sounds good|looks good)[\s,.!]*)+$/i;
// "just that one for now", "just billing first": the user narrowed the scope.
const NARROW_RE = /\bjust (?:that|this|the) (?:one|file|bit|part|function)\b|\bonly (?:that|this|the) one\b|\b(?:just|only) [\w-]+(?: [\w-]+)? (?:first|for now)\b/i;
// An explicit Ultracode choice earlier in the session ("leave ultracode off"), not a question about it.
const ULTRACODE_CHOICE_RE = /\b(?:use|turn (?:on|off)|enable|disable|keep|leave|no|without|skip|stop using)\s+(?:the\s+)?ultra-?code\b|\bultra-?code\s+(?:on|off|for (?:this|that|these|those|now|it))\b/i;
// "only 2 files left", "3 tests in one file": the work ahead is small, whatever came before.
const SMALL_REMAINDER_RE = /\b(?:only |just )?(?:one|two|three|four|[1-4]) (?:\w+ )?(?:files?|places?|call ?sites?|items?|tests?|modules?|errors?|warnings?) (?:left|remaining|to go)\b|\b(?:one|two|three|four|[1-4]) (?:failing )?(?:tests?|errors?|warnings?) in (?:one|a single|the same) file\b|\b(?:one|two|three|four|[1-4]) (?:lint |type |small |minor )(?:errors?|warnings?|nits?|issues?)\b/i;
// "fix them all", "the rest": several items, so not a small step.
const MANY_FOLLOW_RE = /\b(?:them all|all of them|every one of them|each of them|the rest)\b/i;
// "Small change, three steps:", or a short explanation with nothing left to do.
const SMALL_NEXT_RE = /^\s*(?:small|tiny|quick|minor|simple) (?:change|fix|tweak|one)\b/i;
const QUICK_ASK_RE = /\b(?:short answer|quick answer|just pick one|one word|yes\/no|yes or no|tl;?dr)\b/i;
// A sentence that reports what was done ("all 212 tests pass") is not the work ahead.
const STATUS_RE = /\b(?:is|are|was|were|now) (?:all )?(?:done|complete|finished|migrated|green|passing|fixed|merged|updated|converted)\b|\b(?:tests?|suite|checks?|ci|build) (?:all )?(?:pass(?:es|ed)?|(?:is|are) (?:now )?green)\b|^\s*(?:i |we )?(?:fixed|added|switched|updated|migrated|moved|changed|converted|renamed)\b/i;
const CHOOSE_FINDINGS_RE = /\b(?:tell me which|let me know which|which ones? (?:to|should|do you)|your call)\b/i;

function forwardText(answer) {
  return String(answer ?? "")
    .split(/(?<=[.?!])\s+|\n+/)
    .filter((sentence) => !STATUS_RE.test(sentence) || NEXT_MARKER_RE.test(sentence))
    .join(" ");
}

// Small or everyday work that Ultracode's multi-agent workflows would only make costlier.
function smallWork(rec, text, contextBroad, history = []) {
  if (NARROW_RE.test(text) || SMALL_REMAINDER_RE.test(lastAssistantText(history))) return { confidence: 0.75, label: "a narrower step" };
  if (rec?.category === "light_run") return { confidence: 0.8, label: rec.label };
  if (QUICK_ASK_RE.test(text)) return { confidence: 0.8, label: "a quick answer" };
  if (isHardTask(rec) || MANY_FOLLOW_RE.test(text)) return null;
  // Inside a broad sweep a vague follow-up belongs to the sweep; a clear small request does not.
  if (contextBroad && (!rec?.level || rec.inherited)) return null;
  if (rec?.shortTask) return { confidence: 0.85, label: rec.label };
  if (rec?.level && levelIndex(rec.level) <= levelIndex("medium")) return { confidence: 0.8, label: rec.label };
  // Long everyday work (a phase to implement) or security work can use the parallel agents.
  if (rec?.longWork || SECURITY_RE.test(stripCode(text).toLowerCase())) return null;
  const words = wordsIn(stripCode(text));
  if (rec?.level === "high" && !rec.multiStep && words < 35) return { confidence: 0.7, label: "everyday work" };
  // "perfect thanks" is no task at all: nothing to advise.
  if (!rec?.level && rec?.skip !== "continuation" && words <= 12) return { confidence: 0.7, label: "a small step" };
  return null;
}

export function adviseUltracode({ kind = "prompt", prompt = "", answer = "", history = [], ultracodeOn = false, rec = null } = {}) {
  const keep = (reason) => ({ advice: "keep", reason });
  // Mid-turn a switch would only apply from the next message; the turn-end advice covers that.
  if (kind === "midTask") return keep("mid_task");
  const text = kind === "turnEnd" ? String(answer ?? "") : String(prompt ?? "");
  if (!text.trim() || text.trim().startsWith("/")) return keep("no_text");
  if (kind === "prompt" && ULTRACODE_WORD_RE.test(text)) return keep("asked_by_keyword");
  // "perfect, thanks" is no task: nothing to advise.
  if (kind === "prompt" && ACK_RE.test(text.trim())) return keep("acknowledgement");
  // At a turn end, the work ahead is in what is left to do, not in what was reported done.
  const scope = kind === "turnEnd" ? forwardText(text) : text;
  // One coherent change ("review this PR", "bugs in this function") is never many parts.
  const single = SINGLE_CHANGE_RE.test(stripCode(scope));
  const own = single ? 0 : broadness(scope);
  // An explicit choice earlier in the session ("leave ultracode off") is respected, unless
  // the new work is plainly broad.
  const messages = Array.isArray(history) ? history : [];
  if (own < 3 && messages.some((message) => message?.role === "user" && ULTRACODE_CHOICE_RE.test(String(message.text ?? "")))) return keep("chosen_earlier");
  const follow = kind === "prompt" ? followUpKind(text) : null;
  // A broad task the user set (a sweep, a migration), which Claude's plan may spell out
  // but not create.
  const userTask = broadness(lastSubstantialUser(messages));
  const context = userTask >= 1 ? broadness([lastSubstantialUser(messages), lastAssistantText(messages)].join("\n")) : 0;
  // "just that one for now" narrows a broad task to one part; "only 2 files left" ends it.
  const narrowed = kind === "prompt" && (NARROW_RE.test(text) || SMALL_REMAINDER_RE.test(lastAssistantText(messages)));
  // A follow-up with a clear small reading of its own ("now fix the typo") is not the sweep.
  const continuesBroad = !single && !narrowed && Boolean(rec?.inherited || (follow && !rec?.level)) && context >= 3;
  const broad = own >= 3 || (own >= 2 && Boolean(follow || rec?.inherited || ["review", "research", "research_hard", "debug"].includes(rec?.category))) || continuesBroad;
  if (!ultracodeOn && broad) {
    return { advice: "on", confidence: continuesBroad && own < 2 ? 0.7 : 0.8, label: kind === "turnEnd" ? "a next step with many independent parts" : "a broad sweep with many independent parts", reason: "broad_sweep" };
  }
  if (ultracodeOn && !broad) {
    const next = kind === "turnEnd" ? classifyNextStep(text, {}) : null;
    // "Tell me which of the 23 findings to fix first": the next step is not known yet.
    // "Batch 1 of 4 is done" is not the end of the work.
    const quickAnswer = !next?.level && wordsIn(stripCode(text)) <= 60 && !NEXT_MARKER_RE.test(text) && !UNRESOLVED_RE.test(text);
    const small = kind === "turnEnd"
      ? (!CHOOSE_FINDINGS_RE.test(text) && !PARTIAL_RE.test(text) && (DONE_RE.test(text) || ANYTHING_ELSE_RE.test(text) || SMALL_NEXT_RE.test(text) || SMALL_REMAINDER_RE.test(text) || quickAnswer || next?.shortTask || (next?.level && levelIndex(next.level) <= levelIndex("medium"))) ? { confidence: 0.75, label: "a small next step" } : null)
      : smallWork(rec, text, context >= 3, messages);
    if (small) return { advice: "off", confidence: small.confidence, label: small.label, reason: "small_task" };
  }
  return keep(ultracodeOn ? "fits_ultracode" : "not_broad");
}

export function decideUltracode({ advice, state = {}, config = DEFAULT_CONFIG, learning = null }) {
  if (!config.enabled || !config.ultracodeHints) return { speak: false, why: "disabled" };
  if (!advice || advice.advice === "keep") return { speak: false, why: advice?.reason ?? "keep" };
  const key = `ultracode:${advice.reason}:${advice.advice}`;
  const offset = config.learning && learning ? thresholdOffset(learning, key) : 0;
  if ((advice.confidence ?? 0) < config.minConfidence + offset) return { speak: false, why: offset > 0 ? "learned_quiet" : "low_confidence", key };
  const last = state.lastUltracode;
  if (last && last.to === advice.advice) {
    const since = (state.promptCount ?? 0) - (last.promptCount ?? 0);
    if (since < cooldownFor({ ignored: { u: state.ignored?.ultracode ?? 0 } }, "u", config)) return { speak: false, why: "cooldown", key };
  }
  return { speak: true, to: advice.advice, why: "suggest", key };
}

// Recent prompts agree the work is lighter (the window already holds this prompt's
// entry). A short prompt with no signal ("unknown") counts as light, but at least two
// of the recent entries must be known.
function recentAgree(window, target, event, size = 3) {
  if (event !== "prompt" || !Array.isArray(window) || window.length < size) return false;
  const recent = window.slice(-size);
  if (recent.filter((entry) => entry !== "unknown").length < 2) return false;
  return recent.every((entry) => {
    const index = entry === "unknown" ? levelIndex("medium") : levelIndex(entry);
    return index >= 0 && index <= levelIndex(target);
  });
}

// ---------------------------------------------------------------------------
// Messages (short, answer first).

const EFFORT_MENU = "the effort menu next to the model picker";

// `buttons`: the tip is drawn with a Switch button, so it needs no how-to sentence.
export function formatUserMessage({ event, from, to, rec, sustained = false, buttons = false }) {
  const label = rec?.label ?? "this";
  const up = levelIndex(to) > levelIndex(from);
  const applyNow = `To use it for this task, pick ${to} in ${EFFORT_MENU}, then send "keep going".`;
  const parts = [];
  if (event === "midTask") {
    parts.push(up
      ? `Effort tip: this has turned into ${label}, so ${to} may help (you're on ${from}).`
      : `Effort tip: the work is now ${label}, so ${to} is enough (you're on ${from}).`);
    parts.push(buttons ? `Switching applies once the current tool calls finish.` : applyNow);
  } else if (event === "stop") {
    parts.push(up
      ? `Effort tip for the next step (${label}): ${to} may help (you're on ${from}).`
      : `Effort tip for the next step (${label}): ${to} should be enough (you're on ${from}).`);
    if (!buttons) parts.push(`Switch in ${EFFORT_MENU} before you send it.`);
  } else if (rec?.explicit) {
    parts.push(`Effort tip: you asked for ${to}, but this session is on ${from}.`);
    if (!buttons) parts.push(applyNow);
  } else if (sustained) {
    parts.push(`Effort tip: your recent requests are lighter, so ${to} is enough (you're on ${from}).`);
    if (!buttons) parts.push(`Switch in ${EFFORT_MENU}; it applies from your next message.`);
  } else {
    const why = rec?.inherited && rec?.reasons?.[0] ? rec.reasons[0] : label;
    parts.push(up
      ? `Effort tip: ${to} suits this (${why}); you're on ${from}.`
      : `Effort tip: ${to} is enough for this (${why}); you're on ${from}, which is slower.`);
    if (!buttons) parts.push(applyNow);
  }
  return parts.join(" ");
}

export function formatUltracodeMessage({ to, advice, buttons = false }) {
  const label = advice?.label ?? (to === "on" ? "broad work" : "a small task");
  if (to === "on") {
    return `Ultracode tip: this looks like ${label}, which Ultracode (multi-agent workflows, uses much more) handles well.${buttons ? "" : ' Turn it on with "/effort ultracode on".'}`;
  }
  return `Ultracode tip: Ultracode is on, but this is ${label}; it runs multi-agent workflows on every task and uses much more.${buttons ? "" : ' Turn it off with "/effort ultracode off".'}`;
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
