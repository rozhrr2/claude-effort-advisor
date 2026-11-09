import { expect, test } from 'claude-code/testing'

// Nothing sits beneath the plugin in a test: each `on` here stands for the engine.

const BAND = {
  plugin: 'effort-advisor',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: true,
    maxRows: 10,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

type Engine = { toasts: string[]; commands: string[]; rows: any[]; api: any[]; store: Record<string, unknown> }

function engine(on: any, answer = 'Done.', setup: Partial<Engine> = {}): Engine {
  const world: Engine = { toasts: [], commands: [], rows: [], api: [], store: {}, ...setup }
  on('ui.toast', (_: any, e: any) => {
    world.toasts.push(e.text)
    return { value: undefined }
  })
  on('turn.start', (_: any, e: any) => ({ turnId: e.turnId }))
  on('turn.step', async function* (_: any, e: any) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [] }
  })
  on('turn.complete', () => ({ text: answer }))
  on('tool.call', (_: any, e: any) =>
    e.tool === 'Bash' ? { result: {}, text: 'Exit code 1', isError: true } : { result: {}, text: 'ok' },
  )
  on('session.messages', (_: any, e: any) => ({ value: e?.as === 'api' ? world.api : world.rows }))
  on('command.register', () => ({ value: { command: 'effort-advisor' } }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('store.get', (_: any, e: any) => ({ value: world.store[e.key] }))
  on('store.set', (_: any, e: any) => {
    world.store[e.key] = JSON.parse(JSON.stringify(e.value))
    return { value: undefined }
  })
  on('store.delete', (_: any, e: any) => {
    delete world.store[e.key]
    return { value: undefined }
  })
  on('command.run', (_: any, e: any) => {
    world.commands.push(`/${e.command} ${e.args}`.trim())
    if (e.command === 'effort' && /^ultracode/.test(e.args)) return { text: `Ultracode ${e.args.split(' ')[1] ?? 'on'} (this session only).` }
    if (e.command === 'effort') return { text: `Set effort level to ${e.args} (this session only).` }
    return { text: '' }
  })
  // The engine's own drawing, for when the plugin passes the band on.
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  return world
}

const complete = (turnId: string, answer: string) => ({ turnId, reason: 'answer', answer, durationMs: 1000, isAborted: false }) as const

async function step($: any, turnId: string, effort: string, index = 0, model = 'claude-opus-5-5') {
  for await (const _chunk of $.turn.step({ turnId, index, model, effort, messageCount: 1 })) {
    // drain the stream
  }
  // The tip is written without holding up the model request; let it settle.
  await new Promise(resolve => setTimeout(resolve, 30))
}

async function band($: any) {
  return $.ui.mount({ ...BAND, surface: 'desktop' })
}

test('a debugging prompt at high shows an xhigh tip with a Switch button', async ($, on) => {
  const world = engine(on)
  await $.turn.start({ text: 'debug why the tests are flaky on Windows only', turnId: 't1' })
  await step($, 't1', 'high')
  expect(world.toasts.length).toBe(1)
  expect(world.toasts[0]).toMatch(/^Effort tip: xhigh suits this \(tricky debugging\); you're on high\./)
  expect(world.toasts[0]).toMatch(/effort menu next to the model picker/)
  // The desktop app's effort menu calls xhigh "Extra", so the band there does too.
  for (const [surface, name] of [['terminal', /xhigh/], ['desktop', /Extra \(xhigh\)/]] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /Effort tip: / }))?.text).toMatch(new RegExp(`^Effort tip: ${name.source} suits this \\(tricky debugging\\); you're on high`))
    expect((await ui.find({ type: 'Button', text: /Switch to / }))?.text).toMatch(new RegExp(`Switch to ${name.source}$`))
    expect(await ui.find({ type: 'Button', text: /Got it/ })).toBeDefined()
    await ui.unmount()
  }
})

test('in the desktop app the toast calls xhigh Extra (xhigh) too', async ($, on) => {
  const world = engine(on)
  on('session.surfaces', () => ({ value: ['desktop'] }))
  await $.turn.start({ text: 'debug why the tests are flaky on Windows only', turnId: 't1' })
  await step($, 't1', 'high')
  expect(world.toasts[0]).toMatch(/^Effort tip: Extra \(xhigh\) suits this \(tricky debugging\); you're on high\. To use it for this task, pick Extra \(xhigh\) in the effort menu/)
})

test('pressing Switch runs /effort for the session and confirms it', async ($, on) => {
  const world = engine(on)
  await $.turn.start({ text: 'debug why the tests are flaky on Windows only', turnId: 't1' })
  await step($, 't1', 'high')
  const ui = await band($)
  await ui.press({ key: 'effort-advisor-switch' })
  expect(world.commands).toContain('/effort xhigh')
  expect((await ui.find({ type: 'Text', text: /Switched to Extra \(xhigh\)/ }))?.text).toMatch(/for this session/)
  expect(await ui.find({ type: 'Button', text: /Switch to/ })).toBeUndefined()
  expect(await ui.find({ type: 'Button', text: /OK/ })).toBeDefined()
  await ui.unmount()
  const learned = world.store['learning-v1'] as any
  expect(learned.keys['prompt:debug:up'].accepted).toBe(1)
})

test('a short follow-up is judged by the conversation it continues', async ($, on) => {
  const world = engine(on, 'Done.', {
    rows: [
      { role: 'user', text: 'the login test fails on CI but passes locally' },
      { role: 'assistant', text: 'I reproduced it; it looks like a timing issue. Want me to dig into the root cause?' },
      { role: 'user', text: 'yes go ahead' },
    ],
  })
  await $.turn.start({ text: 'yes go ahead', turnId: 't1' })
  await step($, 't1', 'high')
  expect(world.toasts[0]).toMatch(/^Effort tip: xhigh suits this \(you accepted: tricky debugging\)/)
})

test('Ultracode on for a small task: the tip offers Turn off Ultracode, and pressing it runs the command', async ($, on) => {
  const world = engine(on, 'Done.', {
    api: [{ role: 'user', content: [{ type: 'text', text: '<system-reminder>\nUltracode is on: optimize for the most exhaustive answer.\n</system-reminder>' }] }],
  })
  await $.turn.start({ text: 'rename the helper to formatDate', turnId: 't1' })
  await step($, 't1', 'high')
  const ui = await band($)
  expect((await ui.find({ type: 'Text', text: /Ultracode tip/ }))?.text).toMatch(/Ultracode is on, but this is a small edit/)
  await ui.press({ key: 'effort-advisor-ultracode' })
  expect(world.commands).toContain('/effort ultracode off')
  expect((await ui.find({ type: 'Text', text: /Ultracode is off for this session/ }))).toBeDefined()
  await ui.unmount()
})

test('a whole-codebase audit with Ultracode off offers Turn on Ultracode', async ($, on) => {
  engine(on)
  await $.turn.start({ text: 'audit the entire codebase for unsafe sql queries', turnId: 't1' })
  await step($, 't1', 'xhigh')
  const ui = await band($)
  expect((await ui.find({ type: 'Text', text: /Ultracode tip/ }))?.text).toMatch(/broad sweep/)
  expect(await ui.find({ type: 'Button', text: /Turn on Ultracode/ })).toBeDefined()
  await ui.unmount()
})

test('a run of small requests over several turns suggests a lower level', async ($, on) => {
  const world = engine(on)
  await $.turn.start({ text: 'change the primary button color to the brand blue', turnId: 't1' })
  await step($, 't1', 'xhigh')
  await $.turn.start({ text: 'make the header sticky', turnId: 't2' })
  await step($, 't2', 'xhigh')
  // One or two small requests are not a pattern yet.
  expect(world.toasts).toEqual([])
  await $.turn.start({ text: 'bump the footer link font size a bit', turnId: 't3' })
  await step($, 't3', 'xhigh')
  expect(world.toasts.length).toBe(1)
  expect(world.toasts[0]).toMatch(/your recent requests are lighter, so medium is enough \(you're on xhigh\)/)
  const ui = await band($)
  expect(await ui.find({ type: 'Button', text: /Switch to medium/ })).toBeDefined()
  await ui.unmount()
})

test('at turn end a broad next step with Ultracode off offers Turn on Ultracode', async ($, on) => {
  const plan = "Here's the migration plan: 212 call sites across 9 packages, in 5 phases. Approve it and I'll start."
  engine(on, plan)
  await $.turn.start({ text: 'plan the move to the new api client', turnId: 't1' })
  await step($, 't1', 'high')
  await $.turn.complete(complete('t1', plan))
  const ui = await band($)
  expect((await ui.find({ type: 'Text', text: /Ultracode tip/ }))?.text).toMatch(/many independent parts/)
  expect(await ui.find({ type: 'Button', text: /Turn on Ultracode/ })).toBeDefined()
  await ui.unmount()
})

test('no tip names a level the model does not offer', async ($, on) => {
  const world = engine(on)
  // Sonnet 4.6's effort menu has no xhigh, so the debugging tip has nothing to point at.
  await $.turn.start({ text: 'debug why the tests are flaky on Windows only', turnId: 't1' })
  await step($, 't1', 'high', 0, 'claude-sonnet-4-6')
  expect(world.toasts).toEqual([])
})

test('a matching level, a confirmation without context and a subagent turn stay quiet', async ($, on) => {
  const world = engine(on)
  await $.turn.start({ text: 'add a flag to the install script and write tests', turnId: 't1' })
  await step($, 't1', 'high')
  await $.turn.start({ text: 'yes, go ahead', turnId: 't2' })
  await step($, 't2', 'high')
  await $.turn.start({ text: 'debug why the tests are flaky', turnId: 't3', agentId: 'a1' })
  for await (const _chunk of $.turn.step({ turnId: 't3', index: 0, model: 'm', effort: 'low', messageCount: 1, agentId: 'a1' })) {
    // drain
  }
  expect(world.toasts).toEqual([])
  const ui = await band($)
  expect(await ui.find({ type: 'Text', text: /Effort tip/ })).toBeUndefined()
  await ui.unmount()
})

test('three failed tool runs mid-turn suggest xhigh', async ($, on) => {
  const world = engine(on)
  await $.turn.start({ text: 'make the export work again', turnId: 't1' })
  await step($, 't1', 'high')
  for (let i = 0; i < 3; i += 1) await $.tool.call({ tool: 'Bash', command: 'npm test' })
  expect(world.toasts.length).toBe(1)
  expect(world.toasts[0]).toMatch(/this has turned into tricky debugging, so xhigh may help \(you're on high\)/)
})

test('edits inside a hard refactor at xhigh stay quiet', async ($, on) => {
  const world = engine(on)
  await $.turn.start({ text: 'redesign the storage architecture and weigh the trade-offs of each option', turnId: 't1' })
  await step($, 't1', 'max')
  for (let i = 0; i < 20; i += 1) await $.tool.call({ tool: 'Edit', file_path: '/a.ts', old_string: 'a', new_string: 'b' })
  expect(world.toasts.filter(t => /straightforward edits/.test(t))).toEqual([])
})

test('at turn end a ready plan at max shows a next-step tip with a Switch button', async ($, on) => {
  const world = engine(on, 'The plan is ready. Want me to implement it?')
  await $.turn.start({ text: 'thanks', turnId: 't1' })
  await step($, 't1', 'max')
  const result = await $.turn.complete(complete('t1', 'The plan is ready. Want me to implement it?'))
  expect(result.text).toBe('The plan is ready. Want me to implement it?')
  const ui = await band($)
  expect((await ui.find({ type: 'Text', text: /next step/ }))?.text).toMatch(/^Effort tip for the next step \(implementation\): high should be enough \(you're on max\)\.\s*$/)
  expect(await ui.find({ type: 'Button', text: /Switch to high/ })).toBeDefined()
  await ui.unmount()
  expect(world.toasts).toEqual([])
})

test('settings rows can turn off the toast and the turn-end tip', { options: { show_toast: false, turn_end_tips: false } }, async ($, on) => {
  const world = engine(on, 'The plan is ready. Want me to implement it?')
  await $.turn.start({ text: 'debug why the tests are flaky on Windows only', turnId: 't1' })
  await step($, 't1', 'high')
  expect(world.toasts).toEqual([])
  const ui = await band($)
  expect(await ui.find({ type: 'Text', text: /Effort tip: Extra \(xhigh\)/ })).toBeDefined()
  await ui.press({ key: 'effort-advisor-dismiss' })
  await ui.unmount()
  await $.turn.complete(complete('t1', 'The plan is ready. Want me to implement it?'))
  const after = await band($)
  expect(await after.find({ type: 'Text', text: /next step/ })).toBeUndefined()
  await after.unmount()
})

test('a higher minimum confidence keeps a borderline tip quiet', { options: { min_confidence: 0.9 } }, async ($, on) => {
  const world = engine(on)
  // "why does … fail" alone scores 0.65: shown at the default 0.6, quiet at 0.9.
  await $.turn.start({ text: 'why does the hook crash when the transcript is empty?', turnId: 't1' })
  await step($, 't1', 'high')
  expect(world.toasts).toEqual([])
})

test('Got it is remembered: dismissed tips raise the bar for that kind of tip', async ($, on) => {
  const world = engine(on)
  await $.turn.start({ text: 'debug why the tests are flaky on Windows only', turnId: 't1' })
  await step($, 't1', 'high')
  const ui = await band($)
  await ui.press({ key: 'effort-advisor-dismiss' })
  expect(await ui.find({ type: 'Text', text: /Effort tip/ })).toBeUndefined()
  await ui.unmount()
  const learned = world.store['learning-v1'] as any
  expect(learned.keys['prompt:debug:up'].dismissed).toBe(1)
})

test('/effort-advisor reports what it learned and can reset it', async ($, on) => {
  const world = engine(on, 'Done.', { store: { 'learning-v1': { v: 1, keys: { 'prompt:debug:up': { accepted: 0, dismissed: 3, ignored: 0, manual: 0 } } } } })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const status = await $.command.run({ command: 'effort-advisor', args: 'status' })
  expect(status.text).toMatch(/prompt · debug · up: followed 0, dismissed 3/)
  const reset = await $.command.run({ command: 'effort-advisor', args: 'reset' })
  expect(reset.text).toMatch(/learning reset/)
  expect(world.store['learning-v1']).toBeUndefined()
})

test('the band clears when the suggested level is picked in the menu', async ($, on) => {
  engine(on)
  await $.turn.start({ text: 'design the architecture and write a spec with trade-offs', turnId: 't1' })
  await step($, 't1', 'high')
  const ui = await band($)
  expect((await ui.find({ type: 'Text', text: /Effort tip: max/ }))?.text).toMatch(/max suits this/)
  await step($, 't1', 'max', 1)
  expect((await ui.find({ type: 'Text', text: /Now on max/ }))).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /Switch to/ })).toBeUndefined()
  await ui.unmount()
})
