# Effort Advisor: research summary

Written 2026-11-09 against Claude Code 2.1.317 (Windows desktop app 4.23118, Windows 10). Updated the same day for version 0.2: buttons that switch, Ultracode advice, conversation context, learning and a stress test.

## The choice

One shared classifier (`lib/core.mjs`) with two thin Claude Code adapters:

1. **A mod** (`hooks/register.tsx`). It runs inside Claude Code and shows tips as a band above the prompt, a short toast, and a line beneath the answer.
2. **A command hook** (`command-hook/effort_advisor.mjs`). It is a fallback for setups without mods, and shows tips through the hook `systemMessage` field.

Nothing existing fit every constraint: offline, under 100 ms, suggest-only, Windows-friendly, and never storing prompt text. So the ideas worth keeping were ported (see Credits) and the rest written fresh.

## What Claude Code exposes

| Question | Finding |
| --- | --- |
| Is the current effort readable? | Yes, with gaps. Tool events and Stop get `effort.level` in the hook input and `CLAUDE_EFFORT` in the environment. UserPromptSubmit gets neither reliably. Transcript assistant rows carry `effort`. In a mod, every `turn.step` carries `e.effort`. |
| Can anything change effort? | Not from a hook: hooks have no output field for it. A mod can run a slash command with `$.command.run`: `/effort xhigh` answers "Set effort level to xhigh (this session only)", the next `turn.step` carries `effort: "xhigh"`, and no settings file changes. The **Switch** button does exactly that, and only when pressed. A mod's `turn.step` could also rewrite effort per request, but that would apply a level without asking, so it is not used. |
| Can Ultracode be read or switched? | `/effort ultracode on` and `off` switch it for the session; there is no `/ultracode` command. `/effort status` reports it, but a command a mod runs appears in the transcript like a typed one, so the mod never polls it. Instead it reads Claude Code's own reminder ("Ultracode is on: …") in the session's API messages (`$.session.messages({ as: 'api' })`), and never suggests turning Ultracode off without having seen it on. |
| Can a mod read the conversation? | Yes: `$.session.messages()` returns rows with a role and text. The advisor reads the last 8 in memory to judge follow-ups and stores none of them. |
| Does every model offer every level? | No. In 2.1.317 the 4.6 models have no xhigh, and the 4.5 models have neither xhigh nor max. Models with no effort setting send no `effort` at all, so the advisor stays silent there. |
| User-visible channels | Hook `systemMessage`, delivered to SDK hosts as `system:informational`. Mods have `$.ui.toast` (delivered to SDK hosts as `system:ui_toast`), `$.ui.status`, an `AbovePrompt` band drawn on the terminal and desktop surfaces, and `turn.complete` text drawn beneath the answer. All are display-only. |
| When does a new level apply? | From the next message. Mid-turn, the user picks the level, then sends "keep going", and Claude picks it up once the current tool calls finish ([model config](https://code.claude.com/docs/en/model-config#when-a-new-effort-level-starts)). |
| Cost per event | Command hook: Node starts in about 70 ms on the test machine (Windows PowerShell 5.1: about 180 ms). Mod: in-process, no start-up. |

Sources:

- [hooks reference](https://code.claude.com/docs/en/hooks)
- [statusline](https://code.claude.com/docs/en/statusline)
- [model config](https://code.claude.com/docs/en/model-config)
- [plugin manifest](https://code.claude.com/docs/en/plugins/manifest-reference)
- the mod API declarations that ship with Claude Code's plugin-authoring skill

## Live findings

- **The desktop app starts the CLI with `--effort <level>` and changes the level live, without restarting it.** A UserPromptSubmit hook gets no `effort` field, and its `CLAUDE_EFFORT` is inherited, so it can be stale. One headless run at `high`, started from inside a `max` session, read `max` at prompt time; the next tool batch and Stop reported `high`. So the command hook trusts the transcript or its saved state at prompt time, and otherwise waits for the first tool batch.
- **Headless `stream-json` runs showed the tips arriving as SDK messages:** mod toasts as `system:ui_toast`, and hook notes as `system:informational` ("UserPromptSubmit says: …").
- **The mod reads the true level on every model request** (`turn.step` `e.effort`), so it needs no such workaround.
- **In the desktop app, pressing Switch moves the effort menu to the new level** (checked by hand in a new session on 2026-11-09: high, then Switch to xhigh, and the menu showed xhigh).
- **A throwaway probe mod, in an isolated config folder, checked the switch path before the buttons were built:** `$.command.run({ command: 'effort', args: 'xhigh' })` set the level for the session, the next request ran at xhigh, and the command's `command.run` hook saw `origin.kind: "plugin"`. `/effort ultracode on` answered "Ultracode on (this session only): dynamic workflows on every task. Effort stays high."

## Candidates looked at

| Candidate | Licence | Verdict |
| --- | --- | --- |
| [shaaz1000/claude-router](https://github.com/shaaz1000/claude-router) | MIT, Python | The best design reference: weighted regex tiers, pasted-content detection, counts-only logging. It runs on Python and uses a different level ladder, so the ideas were ported, not the code. |
| [Qcko/claude-code-effort-router](https://github.com/Qcko/claude-code-effort-router) | MIT, PowerShell | Reading effort from the transcript's last assistant row was reused as a fallback. PowerShell is too slow, and it logs prompt previews. |
| [tzachbon/claude-model-router-hook](https://github.com/tzachbon/claude-model-router-hook) | MIT, Python | Ideas reused: abstain when unsure, and leave a margin near class boundaries. |
| [totally-tim/effort-router](https://github.com/totally-tim/effort-router), [tommy5dollar/effort-router](https://github.com/tommy5dollar/effort-router), [Viktorooos/claude-prompt-router](https://github.com/Viktorooos/claude-prompt-router), [0dust/ClaudeRouter](https://github.com/0dust/ClaudeRouter) | MIT | They apply effort automatically, call a model (network, quota, and the prompt leaves the machine), or both. Reused only the ideas of skipping confirmations and plain replies, and of lowering effort mid-task only on strong evidence. |
| [ccstatusline](https://github.com/sirmalloc/ccstatusline), [claude-powerline](https://github.com/Owloops/claude-powerline) | MIT | Status line display only, and many setups already have a status line. |
| [musistudio/claude-code-router](https://github.com/musistudio/claude-code-router) | MIT | A model proxy, not a hook. |
| [RouteLLM](https://github.com/lm-sys/RouteLLM), [NVIDIA prompt-task-and-complexity-classifier](https://huggingface.co/nvidia/prompt-task-and-complexity-classifier), [semantic-router](https://github.com/aurelio-labs/semantic-router) | Apache-2.0, NVIDIA Open Model, MIT | They need embeddings or a GPU model, which is too slow to load per prompt. Ideas reused: abstain thresholds, and task types weighted by reasoning depth and constraint count. |

On 2026-11-09, none of the 317 plugins in [anthropics/claude-plugins-official](https://github.com/anthropics/claude-plugins-official) was an effort router, and [awesome-claude-code](https://github.com/hesreallyhim/awesome-claude-code) listed none either. The feature request for built-in automatic effort, ["Auto-adjust reasoning effort based on prompt complexity"](https://github.com/anthropics/claude-code/issues/34874), was closed as not planned.

## Design decisions

- **Suggest; switch only on a press.** No setting is written. The **Switch** and **Ultracode** buttons run `/effort` for the session, exactly as if typed; nothing changes without a press.
- **Judge the conversation, not one message** (v0.2, after v0.1 was found "too short sighted"):
  - A follow-up takes the level of what it continues: an accepted offer, a chosen option (building it), "now the tests", "go deeper".
  - Claude's fix claims followed by "still failing" are counted across the conversation. Two that did not hold make tricky debugging, whatever the next message says, until the user reports it solved. After one, only a bug that is tricky by nature moves up.
  - The session window holds each prompt's level (or "unknown" for a short prompt with no signal). Three light entries in a row, at least two of them known, are a run of light work.
  - At turn end the whole answer counts: options plus a question point to a design decision, a plan or recommendation to building, an open bug to debugging. Sentences that only report what was done are ignored for Ultracode.
  - Claude's own latest message can say a design is being weighed when the user's words do not.
- **Ultracode:** on for work that splits into many independent parts (breadth signals such as "every endpoint", "~140 files", "across 9 packages", exhaustive searches), off for small or everyday work while it is on. One coherent change, a narrowed scope ("just that one") and acknowledgements never count. A prompt that names Ultracode, now or earlier in the session, is left alone.
- **Learning:** counts per kind of tip (moment, kind of work, direction). A tip followed with **Switch** lowers the bar for that kind by 0.05, a level picked by hand by 0.04; a dismissed tip raises it by 0.04 and an ignored one by 0.015, within −0.15 to +0.3. No text is kept.
- **Low noise:**
  - It speaks only when the advice differs from the live level and confidence is at least 0.6 (0.7 at turn end). One step up needs 0.1 more; a jump of two levels or more needs 0.1 less, unless the reading rests on one weak or contested keyword.
  - A tip to lower effort needs real work ahead or a run of lighter requests: one small request never triggers it. One step down is suggested from max for ordinary work (0.75), from xhigh for long work (0.8), after a long run of routine edits, after several light requests, and when building starts after a design discussion. Never one step down from max for hard debugging, reviews or design.
  - The same tip is shown at most once per turn, and waits 3 prompts before it can return. The wait doubles each time it's ignored (cap 24).
  - It never names a level the current model's menu lacks.
  - Confirmations, slash commands and `ultrathink` prompts stay silent.
- **Privacy.** Text is classified in memory only. State keeps levels, counters and a hashed session key. The optional decision log keeps labels only.
- **Fail-open.**
  - The command hook always exits 0, and prints nothing on any error.
  - Claude Code skips a mod hook that fails. The mod's prompt, tool, turn and drawing hooks also hand back the engine's own result.
  - There are no network calls and no blocking decisions.
  - Stop never asks the agent to continue: Stop context would make the agent keep working, so turn-end tips use `systemMessage` or the mod.

## Stress test (v0.2)

Early feedback on v0.1 was that it was "too short sighted". To measure and fix that, the advisor was scored on labelled situations: a prompt (often with the conversation before it), a run of tool calls, or Claude's final answer, each with the current level and a label saying what a careful expert would want. `scripts/eval.mjs` replays each case through the real classifier and policy.

**Three case sets, written at different times:**

| Set | Written by | Cases | Role |
| --- | --- | --- | --- |
| `tests/eval/cases/` | seven writers sharing one rubric | 405 | tuning |
| `tests/eval/heldout/` | five writers blind to the code, plus two red-teamers who read it | 200 | first honest test, then a second tuning round |
| `tests/eval/fresh/` | five writers blind to the code, after all tuning | 150 | final test, never tuned against |

**Label checks:**
- An independent audit of 69 tuning cases agreed with 90% of the tip labels. Its findings became the rubric clarifications in `tests/eval/README.md`.
- Blind checkers sampled 50 held-out and 50 final cases and disputed none.
- Of the 50 red-team cases they disputed one, and only as debatable.

**Results:**

| Set | v0.1 | v0.2 |
| --- | --- | --- |
| Tuning | 50.6% | 91.1% |
| Held-out, first look | 48.5% | 51.5% |
| Held-out, after the second round | 48.5% | 82.5% |
| Final test | 48.0% | 69.3% |

On the final test, v0.2 shows a needed tip in 55% of cases (v0.1: 19%) with about the same false-alarm rate (9.3% against 8.1%), and gets Ultracode right in 91% (v0.1: 80%). Each event takes about 0.2 ms; the worst case measured, 12 messages of 4,000 characters, took 20 ms.

**What the first honest test taught:**
- The first round reached 93% on the tuning set but only 51.5% on fresh cases: it had learned wording. The second round fixed mechanisms instead:
  - file names and paths no longer count as task words, and common misspellings are normalised;
  - a negation ends at "and" or "but";
  - a message with two tasks is judged by its harder part;
  - fix-attempt counting needs a bug;
  - a run of short exchanges counts as light work, except inside a hard discussion;
  - turn-end answers are read for partial progress, small choices, side notes and findings;
  - Ultracode needs real breadth.
- That generalised better (51.5% to 69.3% on cases written afterwards), but a gap of about 20 points between seen and unseen cases remains. That is the ceiling of word lists: unseen cases use language the lists don't know.
- About one unseen message in three still gets no reading at all. The natural next step is a second opinion from a small model for exactly those messages, opt-in, since it costs some usage and sends the message to the model.

## Credits

The heuristics adapt ideas, not code or model weights, from the projects listed above. Most of them are MIT-licensed routers, plus RouteLLM (Apache-2.0) and NVIDIA's classifier (NVIDIA Open Model License). No code was copied.
