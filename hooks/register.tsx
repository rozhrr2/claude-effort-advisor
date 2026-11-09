// Effort Advisor as a Claude Code mod: suggest-only, display-only, in-process.
// Tips go to a band above the prompt, a short toast, or a line beneath the answer.
// None of them reaches Claude or the transcript, and nothing changes a setting.

import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { EffortAdvisorHistory, EffortAdvisorTip } from '../types'
import overrides from '../config.mjs'
import {
  DEFAULT_CONFIG,
  classifyNextStep,
  classifyPrompt,
  decide,
  formatUserMessage,
  mergeConfig,
  midTaskRecommendation,
  newTurn,
  normalizeLevel,
  updateTurn,
} from '../lib/core.mjs'

const WINDOW_SIZE = 6
const EDIT_TOOLS = /^(?:Edit|Write|MultiEdit|NotebookEdit)$/
const EMPTY_HISTORY: EffortAdvisorHistory = {
  promptCount: 0,
  window: [],
  lastSuggestion: null,
  pending: null,
  ignored: { up: 0, down: 0 },
  lastEffort: null,
}

const tipAtom = atom({ plugin: 'effort-advisor', key: 'tip' } as const, null as EffortAdvisorTip | null)
const historyAtom = atom({ plugin: 'effort-advisor', key: 'history' } as const, EMPTY_HISTORY)

type Event = 'prompt' | 'midTask' | 'stop'

// Per-turn values held by the module; a hot reload starts them over (one turn without tips).
type Context = {
  config: any
  turnId: string | null
  turnHasPrompt: boolean
  promptRec: any
  turn: any
  effort: string | null
  model: string | null
  firstStepDone: boolean
}

function remember(history: EffortAdvisorHistory, event: Event, decision: any): EffortAdvisorHistory {
  return {
    ...history,
    lastSuggestion: { from: decision.from, to: decision.to, promptCount: history.promptCount, event },
    pending: { to: decision.to, direction: decision.direction, promptCount: history.promptCount },
  }
}

async function readHistory($: any): Promise<EffortAdvisorHistory> {
  return { ...EMPTY_HISTORY, ...(await read($, historyAtom)) }
}

async function showTip($: any, ctx: Context, event: Event, decision: any, rec: any): Promise<string> {
  const text = formatUserMessage({
    event,
    from: decision.from,
    to: decision.to,
    rec,
    sustained: decision.sustained,
    ultracode: ctx.config.ultracodeHints,
  })
  ctx.turn = { ...ctx.turn, suggestedTo: decision.to }
  const onBand = ctx.config.display.band && !(event === 'stop' && ctx.config.display.beneathAnswer)
  if (onBand) {
    const tip: EffortAdvisorTip = { text, from: decision.from, to: decision.to, event, turnId: ctx.turnId }
    await update($, tipAtom, () => tip)
  }
  if (ctx.config.display.toast && event !== 'stop') $.ui.toast(text, { timeoutMs: 8000 })
  return text
}

// The first model request of a turn carries the effort that turn really runs at.
async function onFirstStep($: any, ctx: Context, level: string): Promise<void> {
  let history = await readHistory($)
  if (ctx.turnHasPrompt) history = { ...history, promptCount: history.promptCount + 1 }
  const pending = history.pending
  if (pending) {
    if (level === pending.to) {
      history = { ...history, pending: null, ignored: { ...history.ignored, [pending.direction]: 0 } }
    } else if (ctx.turnHasPrompt && history.promptCount > pending.promptCount) {
      const ignored = Math.min(5, (history.ignored[pending.direction] ?? 0) + 1)
      history = { ...history, pending: null, ignored: { ...history.ignored, [pending.direction]: ignored } }
    }
  }
  if (ctx.promptRec?.level) {
    history = { ...history, window: [...history.window, ctx.promptRec.level].slice(-WINDOW_SIZE) }
  }
  history = { ...history, lastEffort: level }
  if (ctx.config.events.prompt && ctx.turnHasPrompt && ctx.promptRec) {
    const rec = ctx.config.ultracodeHints ? ctx.promptRec : { ...ctx.promptRec, ultracodeHint: false }
    const decision = decide({ event: 'prompt', current: level, rec, state: { ...history, turn: ctx.turn }, config: ctx.config, model: ctx.model })
    if (decision.speak) {
      history = remember(history, 'prompt', decision)
      await showTip($, ctx, 'prompt', decision, rec)
    }
  }
  await update($, historyAtom, () => history)
}

// A switch made mid-turn (pick a level, then send "keep going") clears the matching tip.
async function onEffortChanged($: any, level: string): Promise<void> {
  const tip = await read($, tipAtom)
  if (tip && tip.to === level) await update($, tipAtom, () => null)
}

async function onToolResult($: any, ctx: Context, tool: string, ran: any): Promise<void> {
  const answered = ran?.deny === undefined
  const failed = answered && ran?.isError === true
  const edited = answered && !failed && EDIT_TOOLS.test(tool)
  ctx.turn = updateTurn(ctx.turn, { calls: 1, edits: edited ? 1 : 0, failures: failed ? 1 : 0 })
  const rec = midTaskRecommendation(ctx.turn, ctx.effort, ctx.config)
  if (!rec.level) return
  const history = await readHistory($)
  const decision = decide({ event: 'midTask', current: ctx.effort, rec, state: { ...history, turn: ctx.turn }, config: ctx.config, model: ctx.model })
  if (!decision.speak) return
  await update($, historyAtom, () => remember(history, 'midTask', decision))
  await showTip($, ctx, 'midTask', decision, rec)
}

async function tipForNextStep($: any, ctx: Context, answer: string): Promise<string | null> {
  const rec = classifyNextStep(answer, ctx.turn ?? {})
  if (!rec.level) return null
  const history = await readHistory($)
  const decision = decide({ event: 'stop', current: ctx.effort, rec, state: { ...history, turn: ctx.turn }, config: ctx.config, model: ctx.model })
  if (!decision.speak) return null
  await update($, historyAtom, () => remember(history, 'stop', decision))
  return showTip($, ctx, 'stop', decision, rec)
}

async function clearStaleTip($: any, turnId: string): Promise<void> {
  await update($, tipAtom, tip => (tip && tip.turnId !== turnId ? null : tip))
}

async function dismissTip($: any): Promise<void> {
  await update($, tipAtom, () => null)
}

async function drawBand($: any, e: any, next: any) {
  const tip = await read($, tipAtom)
  if (!tip) return next(e)
  const { Box, Button, Text } = $.ui.resolve(e)
  return (
    <Box>
      <Text dimColor>{tip.text} </Text>
      <Button key="effort-advisor-dismiss" label="Got it" onPress={() => dismissTip($)} />
    </Box>
  )
}

// The plugin's settings rows (manifest userConfig), mapped onto config keys.
function fromOptions(options: any) {
  const o = options ?? {}
  const pick = (value: unknown, type: string) => (typeof value === type ? value : undefined)
  const strip = (object: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined))
  return {
    ...strip({ minConfidence: pick(o.min_confidence, 'number'), ultracodeHints: pick(o.ultracode_hints, 'boolean') }),
    display: strip({ toast: pick(o.show_toast, 'boolean') }),
    events: strip({ midTask: pick(o.mid_task_tips, 'boolean'), stop: pick(o.turn_end_tips, 'boolean') }),
  }
}

export const register: Register = (on, options) => {
  // Settings rows first, then config.mjs, so an edit in a local clone wins.
  const config = mergeConfig(mergeConfig(DEFAULT_CONFIG, fromOptions(options)), overrides)
  if (!config.enabled) return
  const ctx: Context = {
    config,
    turnId: null,
    turnHasPrompt: false,
    promptRec: null,
    turn: null,
    effort: null,
    model: null,
    firstStepDone: false,
  }

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      ctx.turnId = e.turnId
      ctx.turnHasPrompt = typeof e.text === 'string' && e.text.trim().length > 0
      // Classified in memory only; the text is not stored.
      ctx.promptRec = ctx.turnHasPrompt ? classifyPrompt(e.text) : null
      ctx.turn = newTurn(e.turnId)
      ctx.firstStepDone = false
      await clearStaleTip($, e.turnId)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      if (typeof e.model === 'string') ctx.model = e.model
      const level = normalizeLevel(e.effort)
      if (level) {
        const changed = ctx.effort !== null && level !== ctx.effort
        ctx.effort = level
        if (!ctx.firstStepDone) {
          ctx.firstStepDone = true
          void onFirstStep($, ctx, level).catch(() => undefined)
        } else if (changed) {
          void onEffortChanged($, level).catch(() => undefined)
        }
      }
    }
    return yield* next(e)
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId === undefined && ctx.turn && ctx.effort && config.events.midTask) {
      await onToolResult($, ctx, String(e.tool), ran).catch(() => undefined)
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined || e.reason !== 'answer' || !config.events.stop || !ctx.effort) return result
    const text = await tipForNextStep($, ctx, e.answer || result.text).catch(() => null)
    // A text other than the answer is drawn beneath it; the transcript keeps the answer.
    return text && config.display.beneathAnswer ? { ...result, text } : result
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!config.display.band || e.props.hasSurvey) return next(e)
    return drawBand($, e, next)
  }).catch(($, e, next) => next(e))
}
