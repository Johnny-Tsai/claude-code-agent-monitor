import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { ok, pane, renderText, start, toggle, world } from './kit'

const WORKERS = JSON.stringify({
  summary: '2 workers',
  items: [
    { mark: 'running', text: 'alpha', right: '1 run' },
    { mark: 'none', text: '- T-1 refactor parser', right: '3m' },
    { mark: 'waiting', text: 'beta', right: '1 wait' },
    { mark: 'none', text: '- T-2 decide the column name', right: '8m' },
    { mark: 'bogus', text: 'gamma', right: '' },
  ],
  empty: 'nothing running',
})

const CARDS = { options: { customCards: 'WORKERS=python3 /x/workers.py', timeZone: 'Asia/Singapore' } }

const lines = async ($: Engine, columns: number): Promise<string[]> => {
  const ui = await $.ui.mount(pane(columns))
  const out = renderText(await ui.drawn(), columns)
  await ui.unmount()
  return out
}

test('a custom item marked none draws no symbol, so it reads as a sub-row of the item above; an unknown mark still draws idle', CARDS, async ($, on) => {
  world(on, () => ok(WORKERS))
  await start($)
  await toggle($)
  const text = (await lines($, 60)).join('\n')
  expect(text).toMatch(/│ ● alpha\s+1 run │/)
  expect(text).toMatch(/│   - T-1 refactor parser\s+3m │/)
  expect(text).toMatch(/│ · beta\s+1 wait │/)
  expect(text).toMatch(/│   - T-2 decide the column name\s+8m │/)
  expect(text).toMatch(/│ · gamma\s+│/)
  // The mark column stays one cell wide: every row's text starts at the same column.
  const starts = ['alpha', '- T-1', 'beta', '- T-2'].map(s => text.split('\n').find(l => l.includes(s))?.indexOf(s))
  expect(starts).toEqual([4, 4, 4, 4])
})

test('none counts as a plain item: it is neither urgent nor waiting for the badge and the band', CARDS, async ($, on) => {
  world(on, () => ok(JSON.stringify({ summary: '1 item', items: [{ mark: 'none', text: 'just a line', right: '' }], empty: '' })))
  await start($)
  await toggle($)
  const text = (await lines($, 60)).join('\n')
  expect(text).toMatch(/- WORKERS\s+1 │/)
  expect(text).not.toContain('failed')
})
