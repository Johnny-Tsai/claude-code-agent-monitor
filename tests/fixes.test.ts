import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { MIN, T0, ok, pane, renderText, start, toggle, world } from './kit'

const OPTIONS = {
  options: {
    dispatchCommand: 'agentctl events --type dispatch --since {since24h} --format jsonl',
    dispatchCommandPattern: 'agentctl run',
    runtimeNames: 'alpha-cli=Alpha,betaruntime-cli=BetaRuntime',
    timeZone: 'Asia/Singapore',
  },
}

const iso = (ms: number): string => new Date(ms).toISOString().replace('Z', '000Z')

/** Event rows as a fuller event store might print them: extra envelope and payload fields the mod must ignore. */
const started = (id: string, at: number, runtimeId: string, runtime: string, task: string | null): string =>
  JSON.stringify({
    id: 'evt',
    seq: 1001,
    version: 1,
    event_type: 'DispatchStarted',
    timestamp: iso(at),
    source: { actor: 'cli', component: 'runtime' },
    payload: {
      background: false,
      cancellable: false,
      dispatch_id: id,
      options: { mode: 'default', retries: 0, labels: ['example'] },
      pid: 4321,
      prompt_len: 1200,
      provider: 'vendor-a',
      runtime,
      runtime_id: runtimeId,
      runtime_mode: 'Cli',
      start_time: at * 1000,
      task_id: task,
      timeout_secs: 3600,
      extra: null,
    },
    hash: 'h',
  })
const heartbeat = (id: string, at: number, seq: number, runtime: string): string =>
  JSON.stringify({ id: 'evt', seq: 1, event_type: 'DispatchHeartbeat', timestamp: iso(at), source: { actor: 'cli', component: 'runtime' }, payload: { dispatch_id: id, heartbeat_seq: seq, runtime } })
const completed = (id: string, at: number): string =>
  JSON.stringify({ id: 'evt', seq: 1, event_type: 'DispatchCompleted', timestamp: iso(at), source: { actor: 'cli', component: 'runtime' }, payload: { dispatch_id: id, duration_ms: 1, exit_code: 0, failure: null, provider: 'vendor-b', runtime: 'BetaRuntime', runtime_id: 'betaruntime-cli', runtime_mode: 'Cli', status: 'Success', tokens_used: null, truncated: false } })

const F50 = 'f50a4b0b-0e5a-4f32-b251-50ee8a4c96fa'
const S340 = '340eca0b-1111-2222-3333-444444444444'
/** 340eca0b ended at T0 - 3 min; f50a4b0b starts at T0 + 1 min and beats every 30 s, no end event. */
const before = [started(S340, T0 - 8 * MIN, 'betaruntime-cli', 'BetaRuntime', 'T-104'), completed(S340, T0 - 3 * MIN)]
const withF50 = (until: number): string[] => {
  const rows = [...before, started(F50, T0 + MIN, 'alpha-cli', 'Alpha', 'T-104')]
  for (let t = T0 + MIN + 30_000, seq = 1; t <= until; t += 30_000, seq++) rows.push(heartbeat(F50, t, seq, 'Alpha'))
  return rows
}

const paneText = async ($: Engine): Promise<string> => {
  const ui = await $.ui.mount(pane(48, 200))
  const out = renderText(await ui.drawn(), 48).join('\n')
  await ui.unmount()
  return out
}

const dispatchCard = async ($: Engine): Promise<string> => {
  const ui = await $.ui.mount(pane(48, 200))
  const out = renderText(await ui.drawn(), 48)
  await ui.unmount()
  const from = out.findIndex(l => l.includes('DISPATCHES'))
  const to = out.findIndex((l, i) => i > from && l.startsWith('╰'))
  return [out[from - 1], ...out.slice(from, to + 1)].join('\n')
}

test('a dispatch with a start and heartbeats but no end event, in the real output shape, is running', OPTIONS, async ($, on) => {
  const w = world(on, () => ok(withF50(T0 + 3 * MIN).join('\n')))
  await start($)
  await w.clock.set(T0 + 3 * MIN + 10_000)
  await toggle($)
  const card = await dispatchCard($)
  expect(card).toMatch(/1 running/)
  expect(card).toMatch(/● Alpha\s+f50a4b0b 12:01 2m\s+T-104/)
  expect(card).toMatch(/✓ BetaRuntime 340eca0b/)
})

test('a dispatch that starts after the pane read shows up at the next 60 s refresh, and 5 s after a dispatch command starts', OPTIONS, async ($, on) => {
  let rows = before
  const w = world(on, () => ok(rows.join('\n')))
  on('tool.call', async () => {
    await w.clock.sleep(30 * MIN)
    return { result: 'ok' }
  })
  await start($)
  await toggle($)
  expect(await dispatchCard($)).toMatch(/0 running/)
  // Timer path: the dispatch starts outside this session.
  rows = withF50(T0 + 2 * MIN)
  await w.clock.advance(2 * MIN)
  expect(await dispatchCard($)).toMatch(/● Alpha\s+f50a4b0b/)
  // Launch path: a dispatch command in this session triggers a read 5 s later, before the next timer.
  rows = [...withF50(T0 + 2 * MIN + 30_000), started('99999999-x', T0 + 2 * MIN + 2_000, 'betaruntime-cli', 'BetaRuntime', 'T-109')]
  const runsBefore = w.runs.length
  const call = $.tool.call({ tool: 'Bash', command: 'agentctl run --runtime betaruntime "$(cat q.md)"', description: 'dispatch' })
  await w.clock.advance(6_000)
  expect(w.runs.length).toBe(runsBefore + 1)
  expect(await dispatchCard($)).toMatch(/2 running/)
  await w.clock.advance(30 * MIN)
  await call
})

test('a refresh that never settles does not block later ones, and stale data is flagged in the footer', OPTIONS, async ($, on) => {
  let mode: 'ok' | 'hang' = 'ok'
  const w = world(on, async () => {
    if (mode === 'hang') await new Promise(() => undefined)
    return ok(before.join('\n'))
  })
  await start($)
  await toggle($)
  mode = 'hang'
  await w.clock.advance(MIN)
  mode = 'ok'
  await w.clock.advance(MIN)
  const reads = w.runs.length
  expect(reads).toBe(3)
  let text = await paneText($)
  expect(text).toContain('updated 12:02 · refresh 60s')
  expect(text).not.toContain('stale')
  mode = 'hang'
  await w.clock.advance(4 * MIN)
  text = await paneText($)
  expect(text).toContain('updated 12:02 (stale, 4m old) · refresh 60s')
})

test('SESSION up time comes from the session itself and survives a reload; wakes and compactions too', { options: { wakePattern: 'wake seq=', timeZone: 'Asia/Singapore' } }, async ($, on) => {
  const w = world(on)
  w.sessionStartedAt = T0 - 80 * MIN
  on('session.compact', () => ({ messages: [{ role: 'user' as const, text: 's', toolUses: [] }] }))
  await start($)
  await $.prompt.submit({ text: '[wake seq=3] run the plan', origin: { kind: 'unclassified' }, wait: false })
  await $.session.compact({ trigger: 'auto', messages: [{ role: 'user', text: 's', toolUses: [] }] })
  await w.clock.advance(10 * MIN)
  await start($) // a hot reload fires session.start again
  const text = renderText(await (await $.ui.mount(pane(60, 200))).drawn(), 60).join('\n')
  expect(text).toContain('up 1h30m · woke 12:00 · compacted 1')
  expect(w.store.get(`session:${T0 - 80 * MIN}`)).toMatchObject({ compactCount: 1, wakeText: '[wake seq=3] run the plan' })
})

test('a reload that comes back with empty state restores wakes and compactions from the store', async ($, on) => {
  const w = world(on)
  w.sessionStartedAt = T0 - 20 * MIN
  w.store.set(`session:${T0 - 20 * MIN}`, { compactCount: 2, compactAt: T0 - 5 * MIN, wakeAt: T0 - 10 * MIN, wakeText: 'wake' })
  w.store.set('session:123', { compactCount: 9 })
  await start($)
  const text = renderText(await (await $.ui.mount(pane(60, 200))).drawn(), 60).join('\n')
  expect(text).toContain('up 20m · woke 03:50 · compacted 2')
  expect(w.store.has('session:123')).toBe(false)
})
