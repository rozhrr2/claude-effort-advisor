# Effort Advisor: research summary

Written 2026-11-09 against Claude Code 2.1.317 (Windows desktop app 4.23118, Windows 10).

## The choice

One shared classifier (`lib/core.mjs`) with two thin Claude Code adapters:

1. **A mod** (`hooks/register.tsx`). It runs inside Claude Code and shows tips as a band above the prompt, a short toast, and a line beneath the answer.
2. **A command hook** (`command-hook/effort_advisor.mjs`). It is a fallback for setups without mods, and shows tips through the hook `systemMessage` field.

Nothing existing fit every constraint: offline, under 100 ms, suggest-only, Windows-friendly, and never storing prompt text. So the ideas worth keeping were ported (see Credits) and the rest written fresh.

## What Claude Code exposes

| Question | Finding |
| --- | --- |
| Is the current effort readable? | Yes, with gaps. Tool events and Stop get `effort.level` in the hook input and `CLAUDE_EFFORT` in the environment. UserPromptSubmit gets neither reliably. Transcript assistant rows carry `effort`. In a mod, every `turn.step` carries `e.effort`. |
| Can anything change effort? | Not from a hook: hooks have no output field for it. The desktop app's session tool also refuses to re-price the calling session. A mod's `turn.step` could rewrite effort per request, but that would apply a level instead of suggesting one, so it is not used. |
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

- **Suggest, never apply.** No setting is written. The user switches in the effort menu next to the model picker.
- **Low noise:**
  - It speaks only when the advice differs from the live level and confidence is at least 0.6 (0.7 at turn end).
  - A tip to lower effort needs a two-level gap. A one-step drop is suggested only from max (at 0.75 confidence), after a long run of routine edits, or after several light requests in a row.
  - A single quick question never triggers a lower-effort tip: three in a row are needed.
  - The same tip is shown at most once per turn, and waits 3 prompts before it can return. The wait doubles each time it's ignored (cap 24).
  - It never names a level the current model's menu lacks.
  - Confirmations, slash commands and `ultrathink` prompts stay silent.
- **Privacy.** Text is classified in memory only. State keeps levels, counters and a hashed session key. The optional decision log keeps labels only.
- **Fail-open.**
  - The command hook always exits 0, and prints nothing on any error.
  - Claude Code skips a mod hook that fails. The mod's prompt, tool, turn and drawing hooks also hand back the engine's own result.
  - There are no network calls and no blocking decisions.
  - Stop never asks the agent to continue: Stop context would make the agent keep working, so turn-end tips use `systemMessage` or the mod.

## Credits

The heuristics adapt ideas, not code or model weights, from the projects listed above. Most of them are MIT-licensed routers, plus RouteLLM (Apache-2.0) and NVIDIA's classifier (NVIDIA Open Model License). No code was copied.
