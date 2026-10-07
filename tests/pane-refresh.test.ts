import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { ok, pane, renderText, start, toggle, world } from './kit'

const CARD = JSON.stringify({ summary: '1 job', items: [{ mark: 'idle', text: 'nightly-report-run', right: '12:30' }], empty: 'no jobs' })

const options = (paneRefreshSeconds: number) => ({
  options: { customCards: 'SCHEDULE=python3 /x/schedule.py', paneRefreshSeconds, timeZone: 'Asia/Singapore' },
})

const paneText = async ($: Engine): Promise<string> => {
  const ui = await $.ui.mount(pane(60))
  const out = renderText(await ui.drawn(), 60).join('\n')
  await ui.unmount()
  return out
}

test('paneRefreshSeconds sets how often the open pane re-reads its cards, and the footer says so', options(5), async ($, on) => {
  const w = world(on, () => ok(CARD))
  await start($)
  await toggle($)
  expect(w.runs.length).toBe(1)
  expect(await paneText($)).toContain('· refresh 5s')
  await w.clock.advance(5_000)
  expect(w.runs.length).toBe(2)
  await w.clock.advance(5_000)
  expect(w.runs.length).toBe(3)
})

test('paneRefreshSeconds below 3 is clamped to 3 rather than rejected', options(1), async ($, on) => {
  const w = world(on, () => ok(CARD))
  await start($)
  await toggle($)
  expect(await paneText($)).toContain('· refresh 3s')
  await w.clock.advance(2_000)
  expect(w.runs.length).toBe(1)
  await w.clock.advance(1_000)
  expect(w.runs.length).toBe(2)
})

test('without paneRefreshSeconds the pane keeps its 60 s refresh and footer', { options: { customCards: 'SCHEDULE=python3 /x/schedule.py', timeZone: 'Asia/Singapore' } }, async ($, on) => {
  const w = world(on, () => ok(CARD))
  await start($)
  await toggle($)
  expect(await paneText($)).toContain('· refresh 60s')
  await w.clock.advance(59_000)
  expect(w.runs.length).toBe(1)
  await w.clock.advance(1_000)
  expect(w.runs.length).toBe(2)
})
