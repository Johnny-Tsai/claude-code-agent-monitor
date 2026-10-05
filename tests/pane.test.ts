import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { SYMBOLS } from '../hooks/view'
import { CHAT_A, CHAT_B, CJK, MIN, T0, band, fromChannel, ok, pane, renderText, start, tag, toggle, world } from './kit'
import type { World } from './kit'

/** The test runner prints console output; the hooks environment's typings do not declare it. */
declare const console: { log: (text: string) => void }

const event = (type: string, id: string, at: string, payload: Record<string, unknown> = {}): string =>
  JSON.stringify({ id: 'x', seq: 1, event_type: type, timestamp: at, payload: { dispatch_id: id, ...payload } })

const EVENTS = [
  event('DispatchStarted', '11111111-a', '2026-10-05T03:30:00Z', { runtime_id: 'alpha-cli', task_id: 'T-1 refactor parser' }),
  event('DispatchHeartbeat', '11111111-a', '2026-10-05T04:17:30Z', { runtime: 'Alpha' }),
  event('DispatchStarted', '44444444-d', '2026-10-05T02:35:00Z', { runtime_id: 'betaruntime-cli' }),
  event('DispatchHeartbeat', '44444444-d', '2026-10-05T02:40:00Z', { runtime: 'BetaRuntime' }),
  event('DispatchStarted', '22222222-b', '2026-10-05T02:00:00Z', { runtime_id: 'betaruntime-cli', task_id: 'T-2' }),
  event('DispatchCompleted', '22222222-b', '2026-10-05T02:05:00Z', { status: 'Success' }),
  event('DispatchStarted', '33333333-c', '2026-10-05T01:00:00Z', { runtime_id: 'alpha-image' }),
  event('DispatchFailed', '33333333-c', '2026-10-05T01:02:00Z'),
].join('\n')

const DISPATCH = {
  options: {
    dispatchCommand: 'events query -t DispatchStarted --since {since24h} --format "jsonl"',
    runtimeNames: 'alpha-cli=Alpha,betaruntime-cli=BetaRuntime',
    channelNames: `${CHAT_A}=general,${CHAT_B}=ops`,
    timeZone: 'Asia/Singapore',
  },
}

const lines = async ($: Engine, columns: number): Promise<string[]> => {
  const ui = await $.ui.mount(pane(columns))
  const out = renderText(await ui.drawn(), columns)
  await ui.unmount()
  return out
}

/** A busy session: two waiting channels, a long tool call, 72% context, two subagents. */
const busy = async ($: Engine, w: World): Promise<{ call: Promise<unknown> }> => {
  await start($)
  await $.prompt.submit({ text: tag(CHAT_A, '1'), origin: fromChannel(), wait: false })
  await w.clock.advance(6 * MIN)
  await $.prompt.submit({ text: `${tag(CHAT_B, '2')}\n${tag(CHAT_B, '3')}`, origin: fromChannel(), wait: false })
  await $.tool.call({ tool: 'Agent', description: 'review the diff', prompt: 'p' })
  await $.tool.call({ tool: 'Agent', description: 'scan the logs', prompt: 'p' })
  const call = $.tool.call({ tool: 'Bash', command: 'make', description: 'build' })
  await w.clock.advance(12 * MIN)
  await $.session.measure({ context: { window: 1, tokens: 1, percent: 72 }, rateLimits: [], changed: ['context'] })
  return { call }
}

const busyWorld = (on: Parameters<typeof world>[0]) => {
  const w = world(on, () => ok(EVENTS), [{ id: 'bg1', description: 'scan the logs', type: 'general-purpose', status: 'running' }])
  on('tool.call', async ($, e) => {
    if (e.tool === 'Bash') await w.clock.sleep(60 * MIN)
    if (e.tool === 'Agent' && e.description === 'scan the logs') {
      return { result: { status: 'async_launched', agentId: 'bg1', description: 'scan the logs', prompt: 'p', outputFile: '/tmp/o' } }
    }
    return { result: 'ok' }
  })
  return w
}

/** Every non-ASCII character in `text` that the symbol whitelist does not hold. */
const offList = (text: string): string[] => [...new Set([...text].filter(ch => ch.charCodeAt(0) > 0x7e && !SYMBOLS.includes(ch)))]

const bandText = async ($: Engine, columns: number): Promise<string> => {
  const ui = await $.ui.mount(band(columns))
  const out = renderText(await ui.drawn(), columns).join('')
  await ui.unmount()
  return out
}

/** One running dispatch, two stalled for over an hour, six ended (one failed, one cancelled). */
const at = (minutesBeforeT0: number): string => new Date(T0 - minutesBeforeT0 * MIN).toISOString()
const SAMPLE_EVENTS = [
  event('DispatchStarted', 'a1b2c3d4-1', at(14), { runtime_id: 'alpha-cli', task_id: 'T-108 parser' }),
  event('DispatchHeartbeat', 'a1b2c3d4-1', at(0.5)),
  event('DispatchStarted', '21f07d90-2', at(580), { runtime_id: 'betaruntime-cli' }),
  event('DispatchStarted', 'fcd9e7a4-3', at(578), { runtime_id: 'betaruntime-cli' }),
  ...[
    ['DispatchCompleted', 'alpha-cli', 'T-104', 20],
    ['DispatchCompleted', 'betaruntime-cli', 'T-104', 35],
    ['DispatchFailed', 'alpha-cli', 'T-105', 50],
    ['DispatchCompleted', 'alpha-cli', 'T-105', 65],
    ['DispatchCancelled', 'betaruntime-cli', 'T-106', 80],
    ['DispatchCompleted', 'alpha-cli', 'T-106', 95],
  ].flatMap(([type, runtime, task, ago], i) => [
    event('DispatchStarted', `e${i}e${i}e${i}e${i}-x`, at(Number(ago) + 6), { runtime_id: runtime, task_id: task }),
    event(String(type), `e${i}e${i}e${i}e${i}-x`, at(Number(ago))),
  ]),
].join('\n')

test('/monitor toggles the pane, never opens it by itself; by default runs no command, shows the fixed cards and no DISPATCHES', async ($, on) => {
  const w = world(on)
  on('tool.call', () => ({ result: 'ok' }))
  await start($)
  await w.clock.advance(5 * MIN)
  expect(w.opens).toEqual([])
  expect((await toggle($)).text).toBe('Agent monitor opened.')
  await w.clock.advance(3 * MIN)
  const text = (await lines($, 48)).join('\n')
  expect(text).toContain('AGENT MONITOR')
  expect(text).toContain('inbox 0 · now 0 · agents 0 · no reply yet')
  expect(text).toMatch(/│ - INBOX\s+│\n│ no messages waiting/)
  expect(text).toMatch(/│ - RUNNING\s+│\n│ idle/)
  expect(text).toMatch(/│ \+ SESSION\s+│\n│ up 8m · woke never · compacted 0/)
  expect(text).not.toContain('DISPATCHES')
  expect(text).toContain('updated 04:08 · refresh 60s')
  expect(offList(text)).toEqual([])
  console.log(`\n----- pane 48, empty session -----\n${text}`)
  expect(w.runs).toEqual([])
  expect((await toggle($)).text).toBe('Agent monitor closed.')
  expect(w.open.size).toBe(0)
})

test('with dispatchCommand: since filled in, quotes split; running first, stalled over an hour folded, recent capped at 3', { options: { ...DISPATCH.options } }, async ($, on) => {
  const w = world(on, () => ok(SAMPLE_EVENTS))
  await start($)
  await toggle($)
  expect(w.runs[0]).toEqual(['events', 'query', '-t', 'DispatchStarted', '--since', '2026-10-04T04:00:00Z', '--format', 'jsonl'])
  const text = (await lines($, 48)).join('\n')
  expect(text).toMatch(/DISPATCHES\s+1 running · 2 stalled/)
  const marks = text.split('\n').map(l => l.match(/^│ ([●◌✓✗–]) (\S+)/)?.slice(1).join(' ')).filter(Boolean)
  expect(marks).toEqual(['● Alpha', '◌ 2', '✓ Alpha', '✓ BetaRuntime', '✗ Alpha'])
  expect(text).toContain('◌ 2 stalled since 02:20')
})

test('a stalled dispatch heard from within the hour keeps its own row', DISPATCH, async ($, on) => {
  world(on, () =>
    ok([event('DispatchStarted', '44444444-d', at(30), { runtime_id: 'betaruntime-cli' }), event('DispatchHeartbeat', '44444444-d', at(10))].join('\n')),
  )
  await start($)
  await toggle($)
  const text = (await lines($, 60)).join('\n')
  expect(text).toMatch(/◌ BetaRuntime 44444444 11:30 30m\s+no end event/)
  expect(text).toMatch(/0 running · 1 stalled/)
})

test('a failing dispatch command shows a one-line reason and throws nothing', DISPATCH, async ($, on) => {
  world(on, () => ({ exitCode: 2, stdout: '', stderr: 'error: bad flag\nusage', isStdoutTruncated: false, isStderrTruncated: false }))
  await start($)
  expect((await toggle($)).text).toBe('Agent monitor opened.')
  expect((await lines($, 60)).join('\n')).toContain('could not read dispatches: exit code 2: error: bad flag')
})

test('pane open: the band keeps only what is past a threshold, with the same figures and marks as the pane', DISPATCH, async ($, on) => {
  const w = busyWorld(on)
  const { call } = await busy($, w)
  const closed = await bandText($, 200)
  expect(closed).toBe(' ● INBOX 3  discord #general 18m +1ch  │  ● NOW  Bash "build" 12m +1  │  ● restart soon  │  no reply yet')
  await toggle($)
  const open = await bandText($, 200)
  expect(open).toBe(' ● INBOX 3  discord #general 18m +1ch  │  ● NOW  Bash "build" 12m +1  │  ● restart soon')
  const paneText = (await lines($, 60)).join('\n')
  expect(paneText).toContain('inbox 3 · now 2 · agents 1 · no reply yet')
  expect(paneText).toMatch(/│ restart soon\s+│/)
  expect(paneText).toMatch(/● discord #general\s+18m/)
  expect(paneText).toMatch(/● discord #ops x2\s+12m/)
  expect(paneText).toMatch(/● Bash "build"\s+12m/)
  expect(paneText).not.toContain('CONTEXT')
  expect(paneText).not.toContain('%')
  expect(paneText).toMatch(/● agent scan the logs\s+12m/)
  expect(paneText).not.toContain('review the diff')
  expect(paneText).not.toContain('SUBAGENTS')
  const ui = await $.ui.mount(band(200))
  expect((await ui.findAll({ type: 'Text', text: '●' })).map(t => t.props['color'])).toEqual(['yellow', 'yellow', 'yellow'])
  await ui.unmount()
  await w.clock.advance(60 * MIN)
  await call
})

test('pane open and nothing past a threshold: the band draws nothing of its own', async ($, on) => {
  const w = world(on)
  let engineDrew = 0
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    engineDrew += 1
    const { Text } = $.ui.resolve(e)
    return Text({ children: 'engine' })
  })
  await start($)
  await $.prompt.submit({ text: tag(CHAT_A, '1'), origin: fromChannel(), wait: false })
  await toggle($)
  expect(await bandText($, 120)).toBe('engine')
  expect(engineDrew).toBe(1)
  await w.clock.advance(6 * MIN)
  expect(await bandText($, 120)).toContain('● INBOX 1')
  await toggle($)
  expect(await bandText($, 120)).toContain('no reply yet')
})

test('samples: every card title whole at 48 and 80 columns, no line overflows, only whitelisted symbols', DISPATCH, async ($, on) => {
  const w = busyWorld(on)
  const { call } = await busy($, w)
  await toggle($)
  for (const columns of [48, 80]) {
    const out = await lines($, columns)
    for (const title of ['AGENT MONITOR', 'INBOX', 'RUNNING', 'DISPATCHES', 'SESSION']) expect(out.some(l => l.includes(title))).toBe(true)
    for (const l of out) expect([...l].length).toBeLessThanOrEqual(columns)
    expect(CJK.test(out.join('\n'))).toBe(false)
    expect(offList(out.join('\n'))).toEqual([])
  }
  await w.clock.advance(60 * MIN)
  await call
})

test('print the samples the review asks for', DISPATCH, async ($, on) => {
  const w = world(on, () => ok(SAMPLE_EVENTS))
  on('tool.call', () => ({ result: 'ok' }))
  await start($)
  const all: string[] = []
  await toggle($)
  const busyPane = await lines($, 48)
  all.push(...busyPane)
  console.log(`\n----- pane 48, 1 running + 2 stalled over an hour + 6 ended -----\n${busyPane.join('\n')}`)
  await toggle($)
  await $.prompt.submit({ text: tag(CHAT_A, '1'), origin: fromChannel(), wait: false })
  await w.clock.advance(6 * MIN)
  await $.session.measure({ context: { window: 1, tokens: 1, percent: 74 }, rateLimits: [], changed: ['context'] })
  const closedBand = await bandText($, 100)
  await toggle($)
  const openBand = await bandText($, 100)
  all.push(closedBand, openBand)
  console.log(`\n----- band, pane closed -----\n${closedBand}\n----- band, pane open -----\n${openBand}`)
  expect(offList(all.join('\n'))).toEqual([])
})
