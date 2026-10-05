import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { SYMBOLS } from '../hooks/view'
import { CHAT_A, T0, fromChannel, ok, pane, renderText, start, tag, toggle, world } from './kit'

/** The test runner prints console output; the hooks environment's typings do not declare it. */
declare const console: { log: (text: string) => void }

const run = async ($: Engine, args: string): Promise<string | undefined> =>
  (await $.command.run({ command: 'monitor', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 80 } })).text

const draw = async ($: Engine, columns = 48, rows = 200): Promise<string[]> => {
  const ui = await $.ui.mount(pane(columns, rows))
  const out = renderText(await ui.drawn(), columns)
  await ui.unmount()
  return out
}

const WAITING_15 = JSON.stringify({
  summary: '15 waiting',
  items: Array.from({ length: 15 }, (_, i) => ({ mark: 'waiting', text: `T-${200 + i} decision item number ${i + 1}`, right: `${i}d` })),
  empty: 'nothing waiting',
})
const SCHEDULE = JSON.stringify({
  summary: 'next 00:37 hourly-sync-check · 1 failed',
  items: [
    ...Array.from({ length: 18 }, (_, i) => ({ mark: 'idle', text: `nightly-job-${i + 1}`, right: `${String(i % 10).padStart(2, '0')}:30` })),
    { mark: 'failed', text: 'disk-usage-check-daily', right: 'last 05:30' },
    { mark: 'idle', text: '4 frequent jobs (hourly or more)', right: '' },
  ],
  empty: 'no jobs',
})
const at = (m: number): string => new Date(T0 - m * 60_000).toISOString()
const EVENTS = [
  JSON.stringify({ event_type: 'DispatchStarted', timestamp: at(14), payload: { dispatch_id: 'a1b2c3d4-1', runtime_id: 'alpha-cli', task_id: 'T-108' } }),
  JSON.stringify({ event_type: 'DispatchHeartbeat', timestamp: at(0), payload: { dispatch_id: 'a1b2c3d4-1' } }),
  ...Array.from({ length: 6 }, (_, i) => [
    JSON.stringify({ event_type: 'DispatchStarted', timestamp: at(30 + i * 15), payload: { dispatch_id: `e${i}e${i}e${i}e${i}-x`, runtime_id: 'alpha-cli', task_id: `T-11${i}` } }),
    JSON.stringify({ event_type: i === 2 ? 'DispatchFailed' : 'DispatchCompleted', timestamp: at(24 + i * 15), payload: { dispatch_id: `e${i}e${i}e${i}e${i}-x` } }),
  ]).flat(),
].join('\n')

const OPTIONS = {
  options: {
    customCards: 'WAITING ON YOU=python3 /x/waiting.py;;SCHEDULE=python3 /x/schedule.py',
    collapsedCards: 'session',
    dispatchCommand: 'agentctl events --since {since24h} --format jsonl',
    runtimeNames: 'alpha-cli=Alpha',
    timeZone: 'Asia/Singapore',
  },
}

const answer = (argv: readonly string[]) =>
  ok(argv[0] === 'agentctl' ? EVENTS : argv.some(a => a.endsWith('waiting.py')) ? WAITING_15 : SCHEDULE)

test('hide and show cards; hidden ones are listed above the footer and remembered in the store', OPTIONS, async ($, on) => {
  const w = world(on, answer)
  await start($)
  await toggle($)
  expect(await run($, 'hide inbox')).toBe('Hidden: inbox.')
  expect(await run($, 'hide running')).toBe('Hidden: running.')
  expect(await run($, 'hide all')).toBe('Hide cards one at a time; the header card always stays.')
  expect(await run($, 'hide header')).toMatch(/^No card named "header"\. Did you mean \S+\? Cards: inbox, running, dispatches, waiting-on-you, schedule, session\.$/)
  let text = (await draw($)).join('\n')
  expect(text).not.toMatch(/[-+] INBOX/)
  expect(text).not.toMatch(/[-+] RUNNING/)
  expect(text).toContain('AGENT MONITOR')
  expect(text).toMatch(/hidden: inbox, running\n updated/)
  expect(w.store.get('hidden')).toEqual(['inbox', 'running'])
  expect(await run($, 'show all')).toBe('Shown: inbox, running, dispatches, waiting-on-you, schedule, session.')
  text = (await draw($)).join('\n')
  expect(text).toMatch(/- INBOX/)
  expect(text).not.toContain('hidden:')
})

test('hidden cards come back from the store at the next session start', OPTIONS, async ($, on) => {
  const w = world(on, answer)
  w.store.set('hidden', ['session'])
  w.store.set('rows', { 'waiting-on-you': 2 })
  await start($)
  await toggle($)
  const text = (await draw($)).join('\n')
  expect(text).not.toMatch(/[-+] SESSION/)
  expect(text).toContain('hidden: session')
  expect(text.match(/· T-2\d\d decision/g)?.length).toBe(2)
})

test('rows sets how many items an expanded card lists, default restores it, bad values are refused', OPTIONS, async ($, on) => {
  const w = world(on, answer)
  await start($)
  await toggle($)
  expect(await run($, 'rows waiting-on-you 8')).toBe('Rows set to 8: waiting-on-you.')
  expect(await run($, 'rows dispatches 1')).toBe('Rows set to 1: dispatches.')
  let text = (await draw($)).join('\n')
  expect(text.match(/· T-2\d\d decision/g)?.length).toBe(8)
  expect(text).toContain('+7 more')
  expect(text.match(/[✓✗] Alpha\s+e\de\d/g)?.length).toBe(1)
  expect(w.store.get('rows')).toEqual({ 'waiting-on-you': 8, dispatches: 1 })
  expect(await run($, 'rows waiting-on-you 31')).toBe('Rows takes a whole number from 1 to 30, or default.')
  expect(await run($, 'rows waiting-on-you default')).toBe('Rows back to default: waiting-on-you.')
  text = (await draw($)).join('\n')
  expect(text.match(/· T-2\d\d decision/g)?.length).toBe(5)
  expect(w.store.get('rows')).toEqual({ dispatches: 1 })
})

test('with a card set to 30 rows, 44 rows still show every visible card title', OPTIONS, async ($, on) => {
  world(on, answer)
  await start($)
  await toggle($)
  await run($, 'rows schedule 30')
  await run($, 'rows waiting-on-you 30')
  const out = await draw($, 48, 44)
  expect(out.length).toBeLessThanOrEqual(44)
  for (const t of ['AGENT MONITOR', 'INBOX', 'RUNNING', 'DISPATCHES', 'WAITING ON YOU', 'SCHEDULE', 'SESSION']) {
    expect(out.some(l => l.includes(t)), t).toBe(true)
  }
})

test('badges: gray counts, yellow for waiting items, a red failed count; no hollow circle anywhere', OPTIONS, async ($, on) => {
  world(on, answer)
  await start($)
  await $.prompt.submit({ text: tag(CHAT_A, '1'), origin: fromChannel(), wait: false })
  await toggle($)
  const ui = await $.ui.mount(pane(48, 200))
  const texts = await ui.findAll({ type: 'Text' })
  const colorOf = (re: RegExp, nth = 0) => texts.filter(t => re.test(t.text))[nth]?.props
  // The first "1" is the overview's inbox count (colored by state); the second is INBOX's badge.
  expect(colorOf(/^1$/, 1)).toMatchObject({ dimColor: true })
  expect(colorOf(/^15$/)).toMatchObject({ color: 'yellow' })
  expect(colorOf(/^20$/)).toMatchObject({ dimColor: true })
  expect(colorOf(/^1 failed$/)).toMatchObject({ color: 'red' })
  const all = renderText(await ui.drawn(), 48).join('\n')
  await ui.unmount()
  expect(all).toMatch(/SCHEDULE\s+20 · 1 failed │/)
  expect(all).not.toContain('○')
  expect(SYMBOLS.includes('○')).toBe(false)
})

test('the argument hint lists every subcommand and card', OPTIONS, async ($, on) => {
  const w = world(on, answer)
  await start($)
  const hint = w.hint
  for (const word of ['expand', 'collapse', 'hide', 'show', 'rows', '1-30|default', 'waiting-on-you', 'schedule', 'dispatches']) {
    expect(hint).toContain(word)
  }
})

test('sample: 48 columns, inbox and running hidden, WAITING ON YOU at 8 rows', OPTIONS, async ($, on) => {
  world(on, answer)
  await start($)
  await toggle($)
  await run($, 'hide inbox')
  await run($, 'hide running')
  await run($, 'rows waiting-on-you 8')
  const out = await draw($, 48, 44)
  expect(out.length).toBeLessThanOrEqual(44)
  console.log(`\n----- pane 48 x 44, inbox and running hidden, waiting rows 8 -----\n${out.join('\n')}`)
})

test('card names: any case, spaces as dashes, unique prefixes, candidates for ambiguous ones, a suggestion for typos', OPTIONS, async ($, on) => {
  const w = world(on, answer)
  await start($)
  expect(await run($, 'rows Waiting On You 8')).toBe('Rows set to 8: waiting-on-you.')
  expect(await run($, 'rows wait 6')).toBe('Rows set to 6: waiting-on-you.')
  expect(await run($, 'rows sch 4')).toBe('Rows set to 4: schedule.')
  expect(await run($, 'collapse SESSION')).toBe('Collapsed: session.')
  expect(await run($, 'hide s')).toBe('"s" matches schedule, session; type more of the name.')
  expect(await run($, 'rows wiatting on you 8')).toBe(
    'No card named "wiatting on you". Did you mean waiting-on-you? Cards: inbox, running, dispatches, waiting-on-you, schedule, session.',
  )
  expect(await run($, 'rows wiatting 8')).toBe(
    'No card named "wiatting". Did you mean waiting-on-you? Cards: inbox, running, dispatches, waiting-on-you, schedule, session.',
  )
  expect(await run($, 'expand dispach')).toMatch(/Did you mean dispatches\?/)
  expect(w.store.get('rows')).toEqual({ 'waiting-on-you': 6, schedule: 4 })
})
