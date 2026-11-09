# Evaluation corpus

Labeled situations for stress-testing the advisor. `node scripts/eval.mjs` replays every case through the real classifier and policy, and reports how often the advisor gets the level right, shows a tip it should show, stays quiet when it should, and advises Ultracode correctly.

All cases are synthetic. They contain no real conversations, names, paths or secrets.

## Case format

One JSON object per line, in `cases/<slice>.jsonl`:

```json
{
  "id": "debug-014",
  "kind": "prompt",
  "history": [
    { "role": "user", "text": "the login test fails on CI but passes locally" },
    { "role": "assistant", "text": "I reproduced it; it looks like a timing issue. Want me to dig into the root cause?" }
  ],
  "prompt": "yes go ahead",
  "current": "high",
  "ultracodeOn": false,
  "best": "xhigh",
  "acceptable": ["xhigh", "max"],
  "tip": "up",
  "ultracode": "keep",
  "tags": ["short-followup", "debugging"],
  "why": "A short reply that accepts an offer of tricky root-cause work."
}
```

| Field | Kinds | Meaning |
| --- | --- | --- |
| `id` | all | Unique, prefixed with the slice name |
| `kind` | all | `prompt` (a new user message), `midTask` (tool calls inside one turn) or `turnEnd` (Claude's final answer) |
| `history` | prompt | Earlier messages in the session, oldest first. Use it when the context changes what the new prompt means |
| `prompt` | prompt | The new user message |
| `turnPrompt` | midTask, turnEnd | The user message that started this turn (optional, but include it when it matters) |
| `trajectory` | midTask | The tool calls of this turn, in order: `{ "tool": "Edit", "failed": false }`. Tools: `Read`, `Grep`, `Glob`, `Edit`, `Write`, `Bash`, `WebFetch`, `WebSearch`, `Task` |
| `answer` | turnEnd | Claude's final answer for the turn |
| `current` | all | The effort level in use: `low`, `medium`, `high`, `xhigh` or `max` |
| `ultracodeOn` | all | Whether Ultracode (multi-agent workflows on every task) is on for the session |
| `best` | all | The best level for what comes next: the new prompt's task, the rest of this turn's work (midTask), or the likely next step (turnEnd) |
| `acceptable` | all | Every level that would be fine. Always includes `best` |
| `tip` | all | Should a good advisor show an effort tip right now? `up`, `down` or `none` |
| `ultracode` | all | What to advise about Ultracode: `on` (suggest turning it on), `off` (suggest turning it off) or `keep` (say nothing) |
| `tags` | all | Free labels for grouping results |
| `why` | all | One sentence explaining the labels |

## Labeling rubric

**Levels**

| Level | Fits |
| --- | --- |
| `low` | Trivial lookups and one-line answers |
| `medium` | Explanations, small edits, renames, simple questions |
| `high` | The everyday default: building, fixing, tests, installs, configuration, acceptance checks |
| `xhigh` | Tricky debugging (intermittent, unexplained, still failing after fixes) and reviewing a big change |
| `max` | Specs, architecture or design decisions, hard research that compares many options |

Judge the task, not the wording. Context counts:

- A short reply such as "yes, do it" or "next" takes the level of the work it accepts.
- A plan that is approved moves the next step to implementation (`high`).
- A bug that is still failing after two attempts is no longer everyday work.

Size and type:

- Size wins over type. A one-line edit whose exact change is given (a typo, a version bump, a string or value change) is `low`. A small edit that needs a search or a little judgment, a single small test or a one-line config tweak is `medium`. Building, fixing and testing in general is `high`.
- `acceptable` usually covers `best` and one level above it. Add the level below too when the work is light either way.
- A refactor or migration counts as hard only with a visible sign: failed runs, an explicit "behaviour must stay identical" constraint, concurrency, money or security semantics, or design choices in the edits. A routine refactor is `high`.
- Turn end with nothing left to do: `best` is the finished task's level and `tip` is `none`.

**When a tip is worth showing (`tip`)**

- Show `up` when the current level is below the acceptable range for substantial work.
- Show `down` when the current level is above the acceptable range, and the work ahead is long or sustained enough for the saving to matter. Three or more light requests in a row count; a streak is judged by its tasks, not only the last prompt. So does a long run of routine edits while on max or xhigh, and work with two or more actions, a list, or several files or endpoints. One small request does not.
- Use `none` in four cases:
  - The current level is already acceptable.
  - The work is a one-off quick exchange that ends before a switch could help.
  - The signal is genuinely unclear.
  - A lower level would be cheaper, but the bigger task still needs the current level. For example, a few edits in the middle of a hard refactor.

**Ultracode (`ultracode`)**

Ultracode runs multi-agent workflows on every task and uses much more.

- Suggest `on` when it is off, for broad work that splits into many independent parts: a whole-codebase audit or review, a migration across many files, or an exhaustive search or research sweep.
- Suggest `off` when it is on and the work is small or everyday, especially for several small tasks in a row.
- An open-ended survey or sweep (every library, every service, all the places) is `on`. A deep comparison of a few named options is `keep`: it is hard, but not many independent parts.
- Otherwise use `keep`. When a prompt contains the keyword "ultracode", the user already chose; use `keep`. An explicit choice earlier in the session ("leave ultracode off") also counts, unless the new work is plainly broad.
- Ultracode advice belongs to prompts and turn ends. Use `keep` for `midTask` cases: a switch mid-turn only applies from the next message, and the turn-end advice covers what comes next.

## Running it

```bash
node scripts/eval.mjs
```

```bash
node scripts/eval.mjs --failures 40 --kind prompt --tag short-followup
```

`--validate` checks the case files only. `--json <file>` also writes the full report. `--dir <folder>` scores another folder of cases.

## The case sets

| Folder | Written | Used for |
| --- | --- | --- |
| `cases/` | first, by seven writers sharing this rubric | tuning: the advisor was improved against these |
| `heldout/` | after that tuning, by five writers who never saw the code and two red-teamers who did | the first honest test, then a second round of tuning |
| `fresh/` | after both rounds, by writers who never saw the code | the final test; never tuned against |
