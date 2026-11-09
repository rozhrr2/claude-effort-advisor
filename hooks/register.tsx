// Effort Advisor as a Claude Code mod. It suggests, and it switches only when you press
// a button: "Switch to <level>" runs /effort <level>, and "Turn on/off Ultracode" runs
// /effort ultracode on|off, both for this session only, exactly as if you typed them.
// Tips are display-only (a band above the prompt, a toast); Claude never sees them.
// It keeps labels and counters only, never prompt or message text.

import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { EffortAdvisorHistory, EffortAdvisorTip } from '../types'
import overrides from '../config.mjs'
import {
  DEFAULT_CONFIG,
  adviseUltracode,
  classifyNextStep,
  classifyPrompt,
  decide,
  decideUltracode,
  describeLearning,
  emptyLearning,
  formatUltracodeMessage,
  formatUserMessage,
  learnKey,
  mergeConfig,
  midTaskRecommendation,
  newTurn,
  normalizeLevel,
  recordOutcome,
  updateTurn,
  windowEntry,
} from '../lib/core.mjs'

const WINDOW_SIZE = 6
const EDIT_TOOLS = /^(?:Edit|Write|MultiEdit|NotebookEdit)$/
const STORE_KEY = 'learning-v1'
const MAX_MESSAGE_CHARS = 4000
// Claude Code's own reminder when Ultracode is switched for the session.
const ULTRACODE_REMINDER = /<system-reminder>\s*Ultracode is (on|off)\b/gi
const EMPTY_HISTORY: EffortAdvisorHistory = {
  promptCount: 0,
  window: [],
  lastSuggestion: null,
  pending: null,
  lastUltracode: null,
  ignored: { up: 0, down: 0, ultracode: 0 },
  lastEffort: null,
  ultracodeOn: null,
  expectedEffort: null,
  apiScanned: 0,
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
  // What this prompt adds to the session window: a level or "unknown", never text.
  windowEntry: string | null
  ultracodeAdvice: { ifOn: any; ifOff: any } | null
  turn: any
  effort: string | null
  model: string | null
  firstStepDone: boolean
  learning: any
}

// The plugin's settings rows (manifest userConfig), mapped onto config keys.
function fromOptions(options: any) {
  const o = options ?? {}
  const pick = (value: unknown, type: string) => (typeof value === type ? value : undefined)
  const strip = (object: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined))
  return {
    ...strip({
      minConfidence: pick(o.min_confidence, 'number'),
      ultracodeHints: pick(o.ultracode_hints, 'boolean'),
      learning: pick(o.learn_from_choices, 'boolean'),
    }),
    display: strip({ toast: pick(o.show_toast, 'boolean') }),
    events: strip({ midTask: pick(o.mid_task_tips, 'boolean'), stop: pick(o.turn_end_tips, 'boolean') }),
  }
}

async function readHistory($: any): Promise<EffortAdvisorHistory> {
  const stored = await read($, historyAtom)
  return { ...EMPTY_HISTORY, ...stored, ignored: { ...EMPTY_HISTORY.ignored, ...(stored?.ignored ?? {}) } }
}

// Saving what it learned must never get in the way of a tip or a button.
async function saveLearning($: any, ctx: Context): Promise<void> {
  if (!ctx.config.learning) return
  try {
    await $.store.set(STORE_KEY, ctx.learning)
  } catch {
    // The counts stay in memory for this session.
  }
}

// The conversation before this prompt, as { role, text } with long texts cut short.
async function recentHistory($: any, currentText: string, limit: number) {
  try {
    const rows = await $.session.messages()
    const messages = rows
      .map((row: any) => ({ role: row?.role === 'assistant' ? 'assistant' : 'user', text: String(row?.text ?? '').slice(0, MAX_MESSAGE_CHARS) }))
      .filter((message: any) => message.text.trim() && !/^<(?:command-|local-command)/.test(message.text.trim()))
    const last = messages.at(-1)
    if (last && last.role === 'user' && last.text.trim() === currentText.trim().slice(0, MAX_MESSAGE_CHARS).trim()) messages.pop()
    return messages.slice(-limit)
  } catch {
    return []
  }
}

// Ultracode's state from Claude Code's reminders in the requests sent since the last look.
async function scanUltracode($: any, history: EffortAdvisorHistory): Promise<EffortAdvisorHistory> {
  try {
    const api = await $.session.messages({ as: 'api' })
    const start = api.length < history.apiScanned ? 0 : history.apiScanned
    let state = history.ultracodeOn
    for (const message of api.slice(start)) {
      const content = message?.content
      const texts = typeof content === 'string' ? [content] : Array.isArray(content) ? content.map((block: any) => (typeof block?.text === 'string' ? block.text : '')) : []
      for (const text of texts) {
        if (!/ultracode/i.test(text)) continue
        for (const match of text.matchAll(ULTRACODE_REMINDER)) state = match[1].toLowerCase() === 'on'
      }
    }
    return { ...history, ultracodeOn: state, apiScanned: api.length }
  } catch {
    return history
  }
}

async function showTip($: any, ctx: Context, event: Event, effort: any, rec: any, ultracode: any): Promise<string> {
  const band = ctx.config.display.band && !(event === 'stop' && ctx.config.display.beneathAnswer)
  const pieces = (buttons: boolean) => [
    effort ? formatUserMessage({ event, from: effort.from, to: effort.to, rec, sustained: effort.sustained, buttons }) : '',
    ultracode ? formatUltracodeMessage({ to: ultracode.decision.to, advice: ultracode.advice, buttons }) : '',
  ].filter(Boolean).join(' ')
  if (effort) ctx.turn = { ...ctx.turn, suggestedTo: effort.to }
  if (band) {
    const tip: EffortAdvisorTip = {
      text: pieces(true),
      turnId: ctx.turnId,
      event,
      status: 'shown',
      effort: effort ? { from: effort.from, to: effort.to, key: effort.key } : null,
      ultracode: ultracode ? { to: ultracode.decision.to, key: ultracode.decision.key } : null,
    }
    await update($, tipAtom, () => tip)
  }
  const full = pieces(false)
  if (ctx.config.display.toast && event !== 'stop') $.ui.toast(full, { timeoutMs: 8000 })
  return full
}

function rememberEffort(history: EffortAdvisorHistory, event: Event, decision: any): EffortAdvisorHistory {
  return {
    ...history,
    lastSuggestion: { from: decision.from, to: decision.to, promptCount: history.promptCount, event },
    pending: { to: decision.to, direction: decision.direction, promptCount: history.promptCount, key: decision.key },
  }
}

// Did you follow the last tip yourself, ignore it, or change the level on your own?
function resolveOutcomes(ctx: Context, history: EffortAdvisorHistory, level: string): EffortAdvisorHistory {
  let next = history
  const changedByYou = history.lastEffort !== null && level !== history.lastEffort && level !== history.expectedEffort
  const pending = history.pending
  if (pending) {
    if (level === pending.to) {
      ctx.learning = recordOutcome(ctx.learning, pending.key, 'manual')
      next = { ...next, pending: null, ignored: { ...next.ignored, [pending.direction]: 0 } }
    } else if (ctx.turnHasPrompt && next.promptCount > pending.promptCount) {
      ctx.learning = recordOutcome(ctx.learning, pending.key, 'ignored')
      next = { ...next, pending: null, ignored: { ...next.ignored, [pending.direction]: Math.min(5, (next.ignored[pending.direction] ?? 0) + 1) } }
    }
  } else if (changedByYou && ctx.promptRec?.category) {
    // A switch you made just before this prompt says what this kind of work needs.
    const direction = ['low', 'medium', 'high', 'xhigh', 'max'].indexOf(level) > ['low', 'medium', 'high', 'xhigh', 'max'].indexOf(history.lastEffort as string) ? 'up' : 'down'
    ctx.learning = recordOutcome(ctx.learning, learnKey('prompt', ctx.promptRec, direction), 'manual')
  }
  if (level === next.expectedEffort) next = { ...next, expectedEffort: null }
  return next
}

// The first model request of a turn carries the effort that turn really runs at.
async function onFirstStep($: any, ctx: Context, level: string): Promise<void> {
  let history = await readHistory($)
  const advice = ctx.ultracodeAdvice
  const ultracodeMatters = Boolean(advice) && (advice!.ifOff?.advice === 'on' || advice!.ifOn?.advice === 'off')
  if (ultracodeMatters) history = await scanUltracode($, history)
  history = resolveOutcomes(ctx, history, level)
  if (ctx.turnHasPrompt) history = { ...history, promptCount: history.promptCount + 1 }
  if (ctx.windowEntry) history = { ...history, window: [...history.window, ctx.windowEntry].slice(-WINDOW_SIZE) }
  history = { ...history, lastEffort: level }

  let effort: any = null
  if (ctx.config.events.prompt && ctx.turnHasPrompt && ctx.promptRec) {
    const decision = decide({ event: 'prompt', current: level, rec: ctx.promptRec, state: { ...history, turn: ctx.turn }, config: ctx.config, model: ctx.model, learning: ctx.learning })
    if (decision.speak) effort = decision
  }
  let ultracode: any = null
  if (ultracodeMatters && ctx.turnHasPrompt) {
    // Never suggest turning it off without knowing it is on.
    const chosen = history.ultracodeOn === true ? advice!.ifOn : advice!.ifOff
    if (chosen && chosen.advice !== 'keep') {
      const decision = decideUltracode({ advice: chosen, state: history, config: ctx.config, learning: ctx.learning })
      if (decision.speak) ultracode = { decision, advice: chosen }
    }
  }
  if (effort) history = rememberEffort(history, 'prompt', effort)
  if (ultracode) history = { ...history, lastUltracode: { to: ultracode.decision.to, promptCount: history.promptCount, key: ultracode.decision.key } }
  await update($, historyAtom, () => history)
  if (effort || ultracode) await showTip($, ctx, 'prompt', effort, ctx.promptRec, ultracode)
  await saveLearning($, ctx)
}

// A level change mid-turn: a tip that asked for it is done.
async function onEffortChanged($: any, level: string): Promise<void> {
  const tip = await read($, tipAtom)
  if (tip?.effort && tip.effort.to === level && tip.status === 'shown') {
    await update($, tipAtom, (current) => (current ? { ...current, effort: null, status: current.ultracode ? 'shown' : 'done', text: `Now on ${level}.` } : current))
  }
}

async function onToolResult($: any, ctx: Context, tool: string, ran: any): Promise<void> {
  const answered = ran?.deny === undefined
  const failed = answered && ran?.isError === true
  const edited = answered && !failed && EDIT_TOOLS.test(tool)
  ctx.turn = updateTurn(ctx.turn, { calls: 1, edits: edited ? 1 : 0, failures: failed ? 1 : 0 })
  const rec = midTaskRecommendation(ctx.turn, ctx.effort, ctx.config, { turnRec: ctx.promptRec })
  if (!rec.level) return
  const history = await readHistory($)
  const decision = decide({ event: 'midTask', current: ctx.effort, rec, state: { ...history, turn: ctx.turn }, config: ctx.config, model: ctx.model, learning: ctx.learning })
  if (!decision.speak) return
  await update($, historyAtom, () => rememberEffort(history, 'midTask', decision))
  await showTip($, ctx, 'midTask', decision, rec, null)
}

async function tipForNextStep($: any, ctx: Context, answer: string): Promise<string | null> {
  const rec = classifyNextStep(answer, ctx.turn ?? {}, { turnRec: ctx.promptRec })
  let history = await readHistory($)
  let effort: any = null
  if (rec.level) {
    const decision = decide({ event: 'stop', current: ctx.effort, rec, state: { ...history, turn: ctx.turn }, config: ctx.config, model: ctx.model, learning: ctx.learning })
    if (decision.speak) effort = decision
  }
  // Ultracode for what comes next: on for a broad next step, off for a small one.
  let ultracode: any = null
  if (ctx.config.ultracodeHints) {
    const messages = await recentHistory($, '', ctx.config.contextMessages)
    const ifOff = adviseUltracode({ kind: 'turnEnd', answer, history: messages, ultracodeOn: false, rec: ctx.promptRec })
    const ifOn = adviseUltracode({ kind: 'turnEnd', answer, history: messages, ultracodeOn: true, rec: ctx.promptRec })
    if (ifOff.advice === 'on' || ifOn.advice === 'off') {
      history = await scanUltracode($, history)
      // Never suggest turning it off without knowing it is on.
      const chosen = history.ultracodeOn === true ? ifOn : ifOff
      if (chosen.advice !== 'keep') {
        const decision = decideUltracode({ advice: chosen, state: history, config: ctx.config, learning: ctx.learning })
        if (decision.speak) ultracode = { decision, advice: chosen }
      }
    }
  }
  if (!effort && !ultracode) {
    await update($, historyAtom, () => history)
    return null
  }
  if (effort) history = rememberEffort(history, 'stop', effort)
  if (ultracode) history = { ...history, lastUltracode: { to: ultracode.decision.to, promptCount: history.promptCount, key: ultracode.decision.key } }
  await update($, historyAtom, () => history)
  return showTip($, ctx, 'stop', effort, rec, ultracode)
}

async function clearStaleTip($: any, turnId: string): Promise<void> {
  await update($, tipAtom, (tip) => (tip && tip.turnId !== turnId ? null : tip))
}

// ---------------------------------------------------------------- buttons

async function pressSwitch($: any, ctx: Context): Promise<void> {
  const tip = await read($, tipAtom)
  if (!tip?.effort) return
  const { to, key } = tip.effort
  await update($, tipAtom, (current) => (current ? { ...current, status: 'busy', text: `Switching to ${to}…` } : current))
  let outcome = ''
  let ok = false
  try {
    const result = await $.command.run({ command: 'effort', args: to })
    ok = !result?.deny && typeof result?.text === 'string' && /effort level to/i.test(result.text)
    outcome = String(result?.deny ?? result?.text ?? '').slice(0, 160)
  } catch (error: any) {
    outcome = String(error?.message ?? error).slice(0, 160)
  }
  if (ok) {
    await update($, historyAtom, (history) => ({ ...EMPTY_HISTORY, ...history, expectedEffort: to, pending: null }))
    ctx.learning = recordOutcome(ctx.learning, key, 'accepted')
    await saveLearning($, ctx)
  }
  await update($, tipAtom, (current) => (current
    ? {
        ...current,
        effort: ok ? null : current.effort,
        status: ok ? (current.ultracode ? 'shown' : 'done') : 'failed',
        text: ok
          ? `Switched to ${to} for this session. It applies from your next message (send "keep going" to use it now).`
          : `Couldn't switch to ${to}${outcome ? `: ${outcome}` : ''}. Pick it in the effort menu instead.`,
      }
    : current))
}

async function pressUltracode($: any, ctx: Context): Promise<void> {
  const tip = await read($, tipAtom)
  if (!tip?.ultracode) return
  const { to, key } = tip.ultracode
  await update($, tipAtom, (current) => (current ? { ...current, status: 'busy', text: `Turning Ultracode ${to}…` } : current))
  let ok = false
  let outcome = ''
  try {
    const result = await $.command.run({ command: 'effort', args: `ultracode ${to}` })
    ok = !result?.deny && typeof result?.text === 'string' && /ultracode (?:on|off)/i.test(result.text)
    outcome = String(result?.deny ?? result?.text ?? '').slice(0, 160)
  } catch (error: any) {
    outcome = String(error?.message ?? error).slice(0, 160)
  }
  if (ok) {
    await update($, historyAtom, (history) => ({ ...EMPTY_HISTORY, ...history, ultracodeOn: to === 'on' }))
    ctx.learning = recordOutcome(ctx.learning, key, 'accepted')
    await saveLearning($, ctx)
  }
  await update($, tipAtom, (current) => (current
    ? {
        ...current,
        ultracode: ok ? null : current.ultracode,
        status: ok ? (current.effort ? 'shown' : 'done') : 'failed',
        text: ok
          ? `Ultracode is ${to} for this session. It applies from your next message.`
          : `Couldn't turn Ultracode ${to}${outcome ? `: ${outcome}` : ''}. Type "/effort ultracode ${to}" instead.`,
      }
    : current))
}

async function pressDismiss($: any, ctx: Context): Promise<void> {
  const tip = await read($, tipAtom)
  if (tip?.status === 'shown' || tip?.status === 'failed') {
    if (tip.effort) ctx.learning = recordOutcome(ctx.learning, tip.effort.key, 'dismissed')
    if (tip.ultracode) ctx.learning = recordOutcome(ctx.learning, tip.ultracode.key, 'dismissed')
    await update($, historyAtom, (history) => ({ ...EMPTY_HISTORY, ...history, pending: null }))
    await saveLearning($, ctx)
  }
  await update($, tipAtom, () => null)
}

async function drawBand($: any, e: any, next: any, ctx: Context) {
  const tip = await read($, tipAtom)
  if (!tip) return next(e)
  const { Box, Button, Text } = $.ui.resolve(e)
  const actionable = tip.status === 'shown' || tip.status === 'failed'
  return (
    <Box>
      <Text dimColor>{tip.text} </Text>
      {actionable && tip.effort ? <Button key="effort-advisor-switch" label={`Switch to ${tip.effort.to}`} onPress={() => pressSwitch($, ctx)} /> : null}
      {actionable && tip.ultracode ? <Button key="effort-advisor-ultracode" label={tip.ultracode.to === 'on' ? 'Turn on Ultracode' : 'Turn off Ultracode'} onPress={() => pressUltracode($, ctx)} /> : null}
      <Button key="effort-advisor-dismiss" label={tip.status === 'done' ? 'OK' : 'Got it'} onPress={() => pressDismiss($, ctx)} />
    </Box>
  )
}

// ---------------------------------------------------------------- session, commands

async function startSession($: any, ctx: Context): Promise<void> {
  if (ctx.config.learning) {
    try {
      const stored = await $.store.get(STORE_KEY)
      ctx.learning = stored && (stored as any).v === 1 ? stored : emptyLearning()
    } catch {
      ctx.learning = emptyLearning()
    }
  }
  await $.command.register({ name: 'effort-advisor', description: 'Effort Advisor: show what it has learned, or reset it', argumentHint: 'status | reset' })
}

async function answerCommand($: any, ctx: Context, args: string) {
  if (/^\s*reset\s*$/i.test(args)) {
    ctx.learning = emptyLearning()
    try {
      await $.store.delete(STORE_KEY)
    } catch {
      // Nothing was stored.
    }
    return { text: 'Effort Advisor: learning reset. Tips start again from the defaults.' }
  }
  const history = await readHistory($)
  const ultracode = history.ultracodeOn === null ? 'not seen yet' : history.ultracodeOn ? 'on' : 'off'
  return {
    text: [
      describeLearning(ctx.learning),
      `Learning is ${ctx.config.learning ? 'on' : 'off'}. Effort this session: ${history.lastEffort ?? 'not seen yet'}. Ultracode: ${ultracode}.`,
      'Run "/effort-advisor reset" to forget what it learned.',
    ].join('\n'),
  }
}

async function noteEffortCommand($: any, args: string): Promise<void> {
  const ultracode = /^\s*ultracode(?:\s+(on|off))?\s*$/i.exec(args)
  if (ultracode) await update($, historyAtom, (history) => ({ ...EMPTY_HISTORY, ...history, ultracodeOn: (ultracode[1] ?? 'on').toLowerCase() === 'on' }))
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
    windowEntry: null,
    ultracodeAdvice: null,
    turn: null,
    effort: null,
    model: null,
    firstStepDone: false,
    learning: emptyLearning(),
  }

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await startSession($, ctx).catch(() => undefined)
    return result
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'effort-advisor' }, ($, e) => answerCommand($, ctx, e.args))

  on('command.run', { command: 'effort' }, async ($, e, next) => {
    const result = await next(e)
    await noteEffortCommand($, e.args).catch(() => undefined)
    return result
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      ctx.turnId = e.turnId
      ctx.turnHasPrompt = typeof e.text === 'string' && e.text.trim().length > 0
      // Read in memory only; neither the prompt nor the conversation is stored.
      const history = ctx.turnHasPrompt ? await recentHistory($, e.text, config.contextMessages) : []
      // The levels of the session's earlier prompts, for runs of light work.
      const stored = ctx.turnHasPrompt ? await readHistory($).catch(() => EMPTY_HISTORY) : EMPTY_HISTORY
      ctx.promptRec = ctx.turnHasPrompt ? classifyPrompt(e.text, { history, window: stored.window }) : null
      ctx.windowEntry = ctx.turnHasPrompt ? windowEntry(ctx.promptRec, e.text) : null
      ctx.ultracodeAdvice = ctx.turnHasPrompt && config.ultracodeHints
        ? {
            ifOff: adviseUltracode({ kind: 'prompt', prompt: e.text, history, ultracodeOn: false, rec: ctx.promptRec }),
            ifOn: adviseUltracode({ kind: 'prompt', prompt: e.text, history, ultracodeOn: true, rec: ctx.promptRec }),
          }
        : null
      ctx.turn = { ...newTurn(e.turnId), promptRec: ctx.promptRec }
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
    return drawBand($, e, next, ctx)
  }).catch(($, e, next) => next(e))
}
