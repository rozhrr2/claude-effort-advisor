// State contract of the effort-advisor mod. Labels and counters only: no prompt,
// message or tool text is ever kept here.

export type EffortAdvisorTip = {
  text: string;
  turnId: string | null;
  event: 'prompt' | 'midTask' | 'stop';
  // shown: waiting for you; busy: switching; done / failed: the switch's outcome.
  status: 'shown' | 'busy' | 'done' | 'failed';
  effort: { from: string; to: string; key: string } | null;
  ultracode: { to: 'on' | 'off'; key: string } | null;
};

export type EffortAdvisorHistory = {
  promptCount: number;
  window: string[];
  lastSuggestion: { from: string; to: string; promptCount: number; event: string } | null;
  pending: { to: string; direction: 'up' | 'down'; promptCount: number; key: string } | null;
  lastUltracode: { to: 'on' | 'off'; promptCount: number; key: string } | null;
  ignored: { up: number; down: number; ultracode: number };
  lastEffort: string | null;
  // null until the session says (a command, or Claude Code's own reminder).
  ultracodeOn: boolean | null;
  // The level the advisor itself switched to, to tell it apart from your own changes.
  expectedEffort: string | null;
  apiScanned: number;
};

declare module 'claude-code' {
  interface PluginState {
    'effort-advisor': {
      tip: EffortAdvisorTip | null;
      history: EffortAdvisorHistory;
    };
  }
}
