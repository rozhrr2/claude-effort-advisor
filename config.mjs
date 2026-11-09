// Effort Advisor tuning, shared by the Claude mod and the fallback command hook.
// Uncomment and change a value to override the default in lib/core.mjs; values here
// win over the plugin's settings rows. Unknown keys and values of the wrong type are
// ignored. See README.md, "Settings".
export default {
  // enabled: true,
  // minConfidence: 0.6,          // speak only above this classifier confidence
  // stopMinConfidence: 0.7,      // end-of-turn tips need more confidence
  // downshiftMinSteps: 2,        // lower-effort tips need a gap of 2 levels, except:
  // maxSingleStepConfidence: 0.75, //  from max, one step down needs this confidence
  // downshiftFloor: "medium",    // never suggest below this unless you ask for a level
  // cooldownPrompts: 3,          // same tip stays quiet this many prompts, doubling each time you ignore it
  // maxCooldownPrompts: 24,
  // sustainedWindow: 3,          // light requests in a row before a lower-level tip
  // debugFailureThreshold: 3,    // failed tool runs in one turn before the debugging tip
  // mechanicalEditThreshold: { max: 6, xhigh: 8 },  // edits in a row before the "high is enough" tip
  // events: { prompt: true, midTask: true, stop: true },
  // display: { band: true, toast: true, beneathAnswer: true },  // mod only
  // channel: "systemMessage",    // command hook only: "systemMessage" | "context" | "both"
  // ultracodeHints: true,
  // logDecisions: false,         // command hook only: label-only decision log for tuning
};
