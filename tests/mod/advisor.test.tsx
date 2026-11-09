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

function engine(on: any, toasts: string[], answer = 'Done.') {
  on('ui.toast', (_: any, e: any) => {
    toasts.push(e.text)
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
  // The engine's own drawing, for when the plugin passes the band on.
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
}

const complete = (turnId: string, answer: string) => ({ turnId, reason: 'answer', answer, durationMs: 1000, isAborted: false }) as const

async function step($: any, turnId: string, effort: string, index = 0, model = 'claude-opus-5-5') {
  for await (const _chunk of $.turn.step({ turnId, index, model, effort, messageCount: 1 })) {
    // drain the stream
  }
  // The tip is written without holding up the model request; let it settle.
  await new Promise(resolve => setTimeout(resolve, 20))
}

test('a debugging prompt at high shows an xhigh tip in a toast and the band', async ($, on) => {
  const toasts: string[] = []
  engine(on, toasts)
  await $.turn.start({ text: 'debug why the tests are flaky on Windows only', turnId: 't1' })
  await step($, 't1', 'high')
  expect(toasts.length).toBe(1)
  expect(toasts[0]).toMatch(/^Effort tip: xhigh suits this \(tricky debugging\); you're on high\./)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    const row = await ui.find({ type: 'Text', text: /Effort tip: xhigh/ })
    expect(row?.text).toMatch(/effort menu next to the model picker/)
    await ui.unmount()
  }
})

test('no tip names a level the model does not offer', async ($, on) => {
  const toasts: string[] = []
  engine(on, toasts)
  // Sonnet 4.6's effort menu has no xhigh, so the debugging tip has nothing to point at.
  await $.turn.start({ text: 'debug why the tests are flaky on Windows only', turnId: 't1' })
  await step($, 't1', 'high', 0, 'claude-sonnet-4-6')
  expect(toasts).toEqual([])
})

test('a matching level, a confirmation and a subagent turn stay quiet', async ($, on) => {
  const toasts: string[] = []
  engine(on, toasts)
  await $.turn.start({ text: 'add a flag to the install script and write tests', turnId: 't1' })
  await step($, 't1', 'high')
  await $.turn.start({ text: 'yes, go ahead', turnId: 't2' })
  await step($, 't2', 'high')
  await $.turn.start({ text: 'debug why the tests are flaky', turnId: 't3', agentId: 'a1' })
  for await (const _chunk of $.turn.step({ turnId: 't3', index: 0, model: 'm', effort: 'low', messageCount: 1, agentId: 'a1' })) {
    // drain
  }
  expect(toasts).toEqual([])
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Effort tip/ })).toBeUndefined()
  await ui.unmount()
})

test('three failed tool runs mid-turn suggest xhigh with the keep-going hint', async ($, on) => {
  const toasts: string[] = []
  engine(on, toasts)
  await $.turn.start({ text: 'make the export work again', turnId: 't1' })
  await step($, 't1', 'high')
  for (let i = 0; i < 3; i += 1) await $.tool.call({ tool: 'Bash', command: 'npm test' })
  expect(toasts.length).toBe(1)
  expect(toasts[0]).toMatch(/this has turned into tricky debugging, so xhigh may help \(you're on high\)/)
  expect(toasts[0]).toMatch(/then send "keep going"/)
})

test('at turn end a ready plan at max puts a next-step tip beneath the answer', async ($, on) => {
  const toasts: string[] = []
  engine(on, toasts, 'The plan is ready. Want me to implement it?')
  await $.turn.start({ text: 'thanks', turnId: 't1' })
  await step($, 't1', 'max')
  const result = await $.turn.complete(complete('t1', 'The plan is ready. Want me to implement it?'))
  expect(result.text).toMatch(/^Effort tip for the next step \(implementation\): high should be enough \(you're on max\)\./)
  expect(toasts).toEqual([])
  // A plain summary at turn end leaves the answer alone.
  await $.turn.start({ text: 'ok', turnId: 't2' })
  await step($, 't2', 'max')
  const plain = await $.turn.complete(complete('t2', 'Summary of the changes above.'))
  expect(plain.text).toBe('The plan is ready. Want me to implement it?')
})

test('settings rows can turn off the toast and the turn-end tip', { options: { show_toast: false, turn_end_tips: false } }, async ($, on) => {
  const toasts: string[] = []
  engine(on, toasts, 'The plan is ready. Want me to implement it?')
  await $.turn.start({ text: 'debug why the tests are flaky on Windows only', turnId: 't1' })
  await step($, 't1', 'high')
  expect(toasts).toEqual([])
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Effort tip: xhigh/ })).toBeDefined()
  await ui.unmount()
  const result = await $.turn.complete(complete('t1', 'The plan is ready. Want me to implement it?'))
  expect(result.text).toBe('The plan is ready. Want me to implement it?')
})

test('a higher minimum confidence keeps a borderline tip quiet', { options: { min_confidence: 0.9 } }, async ($, on) => {
  const toasts: string[] = []
  engine(on, toasts)
  // "why does … fail" alone scores 0.65: shown at the default 0.6, quiet at 0.9.
  await $.turn.start({ text: 'why does the hook crash when the transcript is empty?', turnId: 't1' })
  await step($, 't1', 'high')
  expect(toasts).toEqual([])
})

test('the band clears when the suggested level is picked or Got it is pressed', async ($, on) => {
  const toasts: string[] = []
  engine(on, toasts)
  await $.turn.start({ text: 'design the architecture and write a spec with trade-offs', turnId: 't1' })
  await step($, 't1', 'high')
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /Effort tip: max/ }))?.text).toMatch(/max suits this/)
  await step($, 't1', 'max', 1)
  expect(await ui.find({ type: 'Text', text: /Effort tip/ })).toBeUndefined()
  await ui.unmount()

  await $.turn.start({ text: 'the build is still failing after your fix, find the root cause', turnId: 't2' })
  await step($, 't2', 'medium')
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await band.find({ type: 'Text', text: /Effort tip: xhigh/ })).toBeDefined()
  await band.press({ key: 'effort-advisor-dismiss' })
  expect(await band.find({ type: 'Text', text: /Effort tip/ })).toBeUndefined()
  await band.unmount()
})
