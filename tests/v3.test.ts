import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { SYMBOLS } from '../hooks/view'
import { CHAT_A, MIN, T0, fromChannel, ok, pane, renderText, start, tag, toggle, world } from './kit'

/** The test runner prints console output; the hooks environment's typings do not declare it. */
declare const console: { log: (text: string) => void }

const WAITING = JSON.stringify({
  summary: '3 waiting',
  items: [
    { mark: 'waiting', text: 'approve the weekly release notes', right: '' },
    { mark: 'waiting', text: 'T-107 channel reply settings', right: '4d' },
    { mark: 'waiting', text: 'T-104 每日摘要報告', right: 'today' },
  ],
  empty: 'nothing waiting',
})
const SCHEDULE = JSON.stringify({
  summary: 'next 12:30 nightly-report-run · 1 failed',
  items: [
    { mark: 'idle', text: 'nightly-report-run', right: '12:30' },
    { mark: 'idle', text: 'db-backup', right: '18:00' },
    { mark: 'failed', text: 'disk-usage-check-daily', right: 'last 05:30' },
  ],
  empty: 'no jobs',
})

const CARDS = {
  options: {
    customCards: 'WAITING ON YOU=python3 /x/waiting.py;;SCHEDULE=python3 /x/schedule.py',
    collapsedCards: 'schedule,session',
    channelNames: `${CHAT_A}=general`,
    timeZone: 'Asia/Singapore',
  },
}

const SUMMARY = { role: 'user' as const, text: 'summary', toolUses: [] }

const answer = (argv: readonly string[]) => ok(argv.some(a => a.endsWith('waiting.py')) ? WAITING : SCHEDULE)

const lines = async ($: Engine, columns: number): Promise<string[]> => {
  const ui = await $.ui.mount(pane(columns))
  const out = renderText(await ui.drawn(), columns)
  await ui.unmount()
  return out
}

const offList = (text: string): string[] => [...new Set([...text].filter(ch => ch.charCodeAt(0) > 0x7e && !SYMBOLS.includes(ch)))]

test('custom cards: run without a shell with a 10 s timeout, sit before SESSION, show items or the summary when collapsed', CARDS, async ($, on) => {
  const w = world(on, answer)
  await start($)
  await toggle($)
  expect(w.runs).toEqual([
    ['python3', '/x/waiting.py'],
    ['python3', '/x/schedule.py'],
  ])
  expect(w.timeouts).toEqual([10_000, 10_000])
  const text = (await lines($, 60)).join('\n')
  const order = ['INBOX', 'RUNNING', 'WAITING ON YOU', 'SCHEDULE', 'SESSION'].map(t => text.indexOf(` ${t} `))
  expect(order.every((at, i) => at > 0 && (i === 0 || at > (order[i - 1] ?? 0)))).toBe(true)
  expect(text).toMatch(/- WAITING ON YOU\s+3 │/)
  expect(text).toMatch(/· T-107 channel reply settings\s+4d/)
  expect(text).toMatch(/\+ SCHEDULE\s+3 · 1 failed │\n│ next 12:30 nightly-report-run · 1 failed/)
  expect(text).not.toContain('db-backup')
})

test('a custom command that fails or prints something else shows could not read, and nothing throws', CARDS, async ($, on) => {
  world(on, argv => (argv.some(a => a.endsWith('waiting.py')) ? ok('not json') : 'spawn ENOENT'))
  await start($)
  expect((await toggle($)).text).toBe('Agent monitor opened.')
  const text = (await lines($, 60)).join('\n')
  expect(text).toContain('could not read: output is not JSON')
  expect(text).toContain('could not read: spawn ENOENT')
  for (const l of text.split('\n')) expect(l.length).toBeLessThanOrEqual(60)
})

test('expand and collapse: by command, by pressing the title toggle, remembered in the store', CARDS, async ($, on) => {
  const w = world(on, answer)
  await start($)
  await toggle($)
  expect((await $.command.run({ command: 'monitor', args: 'expand schedule', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 80 } })).text).toBe(
    'Expanded: schedule.',
  )
  let text = (await lines($, 60)).join('\n')
  expect(text).toMatch(/- SCHEDULE/)
  expect(text).toMatch(/✗ disk-usage-check-daily\s+last 05:30/)
  expect(w.store.get('expanded')).toEqual({ schedule: true })

  const ui = await $.ui.mount(pane(60))
  await ui.press({ key: 'toggle-inbox' })
  text = renderText(await ui.drawn(), 60).join('\n')
  expect(text).toMatch(/\+ INBOX/)
  await ui.unmount()

  const all = await $.command.run({ command: 'monitor', args: 'collapse all', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 80 } })
  expect(all.text).toBe('Collapsed: inbox, running, waiting-on-you, schedule, session.')
  expect(
    (await $.command.run({ command: 'monitor', args: 'expand nothing-here', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 80 } })).text,
  ).toMatch(/^No card named "nothing-here"\. Did you mean \S+\? Cards: inbox, running, waiting-on-you, schedule, session\.$/)
})

test('openOnStart opens the pane at session start; the default does not', { options: { openOnStart: true } }, async ($, on) => {
  const w = world(on)
  await start($)
  expect(w.opens).toEqual(['agent-monitor'])
})

test('SESSION: up time, the last wake (scheduled triggers or wakePattern) and compactions', { options: { wakePattern: 'wake seq=', timeZone: 'Asia/Singapore' } }, async ($, on) => {
  const w = world(on)
  on('session.compact', ($, e) => (e.trigger === 'precompute' ? { skip: 'not now' } : { messages: [SUMMARY] }))
  await start($)
  await w.clock.advance(72 * MIN)
  await $.prompt.submit({ text: '[wake seq=17] run the plan and do the next step it prints', origin: { kind: 'unclassified' }, wait: false })
  await $.prompt.submit({ text: 'a plain prompt', origin: { kind: 'composer' }, wait: false })
  await $.session.compact({ trigger: 'auto', messages: [SUMMARY] })
  await $.session.compact({ trigger: 'precompute', messages: [SUMMARY] })
  await $.command.run({ command: 'monitor', args: 'expand session', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 80 } })
  const text = (await lines($, 60)).join('\n')
  expect(text).toContain('started 12:00 (up 1h12m)')
  expect(text).toContain('last wake 13:12 [wake seq=17] run the plan and~')
  expect(text).toContain('compacted 1, last 13:12')
})

const ALL = {
  options: {
    ...CARDS.options,
    dispatchCommand: 'agentctl events --since {since24h} --format jsonl',
    runtimeNames: 'alpha-cli=Alpha,betaruntime-cli=BetaRuntime',
  },
}

test('samples at 48 and 60 columns: every card, SCHEDULE and SESSION collapsed, then SCHEDULE expanded', ALL, async ($, on) => {
  const events = [
    JSON.stringify({ event_type: 'DispatchStarted', timestamp: new Date(T0 - 14 * MIN).toISOString(), payload: { dispatch_id: 'a1b2c3d4-1', runtime_id: 'alpha-cli', task_id: 'T-108 parser' } }),
    JSON.stringify({ event_type: 'DispatchHeartbeat', timestamp: new Date(T0 + 7 * MIN).toISOString(), payload: { dispatch_id: 'a1b2c3d4-1' } }),
    JSON.stringify({ event_type: 'DispatchStarted', timestamp: new Date(T0 - 580 * MIN).toISOString(), payload: { dispatch_id: '21f07d90-2', runtime_id: 'betaruntime-cli' } }),
    JSON.stringify({ event_type: 'DispatchStarted', timestamp: new Date(T0 - 60 * MIN).toISOString(), payload: { dispatch_id: 'e0e0e0e0-3', runtime_id: 'alpha-cli', task_id: 'T-104' } }),
    JSON.stringify({ event_type: 'DispatchCompleted', timestamp: new Date(T0 - 52 * MIN).toISOString(), payload: { dispatch_id: 'e0e0e0e0-3' } }),
  ].join('\n')
  const w = world(on, argv => (argv[0] === 'agentctl' ? ok(events) : answer(argv)), [])
  on('tool.call', async ($, e) => {
    if (e.tool === 'Bash') await w.clock.sleep(60 * MIN)
    return { result: 'ok' }
  })
  await start($)
  await $.prompt.submit({ text: tag(CHAT_A, '1'), origin: fromChannel(), wait: false })
  const call = $.tool.call({ tool: 'Bash', command: 'make', description: 'build' })
  await w.clock.advance(8 * MIN)
  await $.session.measure({ context: { window: 1, tokens: 1, percent: 74 }, rateLimits: [], changed: ['context'] })
  await toggle($)
  const shots: string[] = []
  for (const columns of [48, 60]) {
    const out = await lines($, columns)
    for (const l of out) expect(l.length).toBeLessThanOrEqual(columns)
    shots.push(`----- pane ${columns}, SCHEDULE and SESSION collapsed -----\n${out.join('\n')}`)
  }
  await $.command.run({ command: 'monitor', args: 'expand schedule', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 80 } })
  shots.push(`----- pane 48, SCHEDULE expanded -----\n${(await lines($, 48)).join('\n')}`)
  const modText = shots.join('\n').replace(/每日摘要報告/g, '')
  expect(offList(modText)).toEqual([])
  console.log(`\n${shots.join('\n\n')}`)
  await w.clock.advance(60 * MIN)
  await call
})

const WAITING_15 = JSON.stringify({
  summary: '15 waiting',
  items: Array.from({ length: 15 }, (_, i) => ({ mark: 'waiting', text: `T-${200 + i} decision item number ${i + 1}`, right: `${i}d` })),
  empty: 'nothing waiting',
})
const SCHEDULE_18 = JSON.stringify({
  summary: 'next 00:37 hourly-sync-check · 1 failed',
  items: [
    ...Array.from({ length: 18 }, (_, i) => ({ mark: 'idle', text: `nightly-job-${i + 1}`, right: `${String(i % 10).padStart(2, '0')}:30` })),
    { mark: 'failed', text: 'disk-usage-check-daily', right: 'last 05:30' },
    { mark: 'idle', text: '4 frequent jobs (hourly or more)', right: '' },
  ],
  empty: 'no jobs',
})
const at = (minutesBeforeT0: number): string => new Date(T0 - minutesBeforeT0 * MIN).toISOString()
const SIX_RECENT = [
  JSON.stringify({ event_type: 'DispatchStarted', timestamp: at(14), payload: { dispatch_id: 'a1b2c3d4-1', runtime_id: 'alpha-cli', task_id: 'T-108' } }),
  JSON.stringify({ event_type: 'DispatchHeartbeat', timestamp: at(0), payload: { dispatch_id: 'a1b2c3d4-1' } }),
  JSON.stringify({ event_type: 'DispatchStarted', timestamp: at(580), payload: { dispatch_id: '21f07d90-2', runtime_id: 'betaruntime-cli' } }),
  ...Array.from({ length: 6 }, (_, i) => [
    JSON.stringify({ event_type: 'DispatchStarted', timestamp: at(30 + i * 15), payload: { dispatch_id: `e${i}e${i}e${i}e${i}-x`, runtime_id: 'alpha-cli', task_id: `T-11${i}` } }),
    JSON.stringify({ event_type: i === 2 ? 'DispatchFailed' : 'DispatchCompleted', timestamp: at(24 + i * 15), payload: { dispatch_id: `e${i}e${i}e${i}e${i}-x` } }),
  ]).flat(),
].join('\n')

const FULL = {
  options: {
    ...CARDS.options,
    collapsedCards: 'session',
    dispatchCommand: 'agentctl events --since {since24h} --format jsonl',
    runtimeNames: 'alpha-cli=Alpha,betaruntime-cli=BetaRuntime',
  },
}

const fullWorld = (on: Parameters<typeof world>[0]) =>
  world(on, argv => ok(argv[0] === 'agentctl' ? SIX_RECENT : argv.some(a => a.endsWith('waiting.py')) ? WAITING_15 : SCHEDULE_18))

const titles = ['AGENT MONITOR', '- INBOX', '- RUNNING', '- DISPATCHES', '- WAITING ON YOU', '- SCHEDULE', '+ SESSION']

test('expanded custom cards list customCardMaxItems items and fold the rest; recent dispatches stop at 3', FULL, async ($, on) => {
  fullWorld(on)
  await start($)
  await toggle($)
  const text = (await lines($, 48)).join('\n')
  expect(text.match(/· T-2\d\d decision/g)?.length).toBe(5)
  expect(text).toContain('+10 more')
  expect(text.match(/[✓✗] Alpha\s+e\de\d/g)?.length).toBe(3)
  // The failed job is past the fifth item, yet it is one of the five shown.
  expect(text).toMatch(/✗ disk-usage-check-daily\s+last 05:30/)
  expect(text.match(/· nightly-job-\d+/g)?.length).toBe(4)
  expect(text).toContain('+15 more')
})

test('44 rows: every card title stays visible, expanded detail is shortened first, the collapsed SESSION keeps its summary', FULL, async ($, on) => {
  fullWorld(on)
  await start($)
  await toggle($)
  for (const [rows, label] of [
    [44, 'reported by the surface'],
    [0, 'paneMaxRows default'],
  ] as const) {
    const ui = await $.ui.mount(pane(48, rows))
    const out = renderText(await ui.drawn(), 48)
    await ui.unmount()
    expect(out.length, label).toBeLessThanOrEqual(44)
    for (const t of titles) expect(out.some(l => l.includes(t)), `${label}: ${t}`).toBe(true)
    expect(out.join('\n')).toContain('up <1m · woke never · compacted 0')
    expect(out.join('\n')).toMatch(/\+\d+ more/)
  }
})

test('paneMaxRows sets the budget when the surface reports none', { options: { ...FULL.options, paneMaxRows: 30 } }, async ($, on) => {
  fullWorld(on)
  await start($)
  await toggle($)
  const ui = await $.ui.mount(pane(48, 0))
  const out = renderText(await ui.drawn(), 48)
  expect(out.length).toBeLessThanOrEqual(30)
  for (const t of titles) expect(out.some(l => l.includes(t))).toBe(true)
})

test('sample: 48 columns, 44 rows, 15 WAITING items, 6 recent dispatches, SCHEDULE expanded with 18 jobs', FULL, async ($, on) => {
  fullWorld(on)
  await start($)
  await toggle($)
  const tallUi = await $.ui.mount(pane(48, 200))
  const tall = renderText(await tallUi.drawn(), 48)
  await tallUi.unmount()
  const fitted = await lines44($)
  expect(fitted.length).toBeLessThanOrEqual(44)
  console.log(`\n----- pane 48 x 44 -----\n${fitted.join('\n')}\n----- (unbounded height would take ${tall.length} rows) -----`)
  expect(tall.length).toBeGreaterThan(44)
})

const lines44 = async ($: Engine): Promise<string[]> => {
  const ui = await $.ui.mount({ ...pane(48, 44), requestId: 'agent-monitor' })
  return renderText(await ui.drawn(), 48)
}
