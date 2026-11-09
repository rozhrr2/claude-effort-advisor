// State contract of the effort-advisor mod. Labels and counters only: no prompt,
// message or tool text is ever kept here.

export type EffortAdvisorTip = {
  text: string;
  from: string;
  to: string;
  event: 'prompt' | 'midTask' | 'stop';
  turnId: string | null;
};

export type EffortAdvisorHistory = {
  promptCount: number;
  window: string[];
  lastSuggestion: { from: string; to: string; promptCount: number; event: string } | null;
  pending: { to: string; direction: 'up' | 'down'; promptCount: number } | null;
  ignored: { up: number; down: number };
  lastEffort: string | null;
};

declare module 'claude-code' {
  interface PluginState {
    'effort-advisor': {
      tip: EffortAdvisorTip | null;
      history: EffortAdvisorHistory;
    };
  }
}
