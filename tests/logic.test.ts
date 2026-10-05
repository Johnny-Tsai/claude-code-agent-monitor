import { describe, expect, test } from 'claude-code/testing'

import { DEFAULT_CONFIG, parseConfig, parsePairs, splitArgv } from '../hooks/config'
import { dispatchArgv, pairDispatches, parseJsonl } from '../hooks/dispatch'
import type { DispatchEvent } from '../hooks/dispatch'
import {
  addPending,
  appendChannelText,
  channelLabel,
  clearByReply,
  contextTransition,
  displayWidth,
  labelFor,
  parseChannelMessages,
  replyTarget,
} from '../hooks/logic'
import { ageText } from '../hooks/pane'
import { SYMBOLS, fitLine, spread, statusMark } from '../hooks/view'

describe('options', () => {
  test('defaults work out of the box', () => {
    const c = DEFAULT_CONFIG
    expect(c.channelNames.size).toBe(0)
    expect(c.dispatchArgv).toEqual([])
    expect(c.dispatchPattern).toBeNull()
    expect([c.waitingAlertMs, c.longActionMs, c.contextWarn, c.contextCritical]).toEqual([300_000, 600_000, 70, 85])
    expect(dispatchArgv(c, Date.now())).toEqual([])
  })
  test('pairs, argv and numbers parse; critical never falls under warn', () => {
    expect([...parsePairs('1=a, 2 = b;bad;=x\n3=c').entries()]).toEqual([['1', 'a'], ['2', 'b'], ['3', 'c']])
    expect(splitArgv(`tool -t "a b" --x='y z' {since24h}`)).toEqual(['tool', '-t', 'a b', '--x=y z', '{since24h}'])
    const c = parseConfig({ contextWarnPercent: 90, contextCriticalPercent: 80, dispatchCommandPattern: '(' })
    expect(c.contextCritical).toBe(90)
    expect(c.dispatchPattern?.test('a(b')).toBe(true)
    expect(dispatchArgv(parseConfig({ dispatchCommand: 'q --since {since24h}' }), Date.parse('2026-10-05T12:00:00.500Z'))).toEqual([
      'q',
      '--since',
      '2026-10-04T12:00:00Z',
    ])
  })
})

describe('channel messages', () => {
  test('tags of any server, several at once; no tag means one message of the delivering server', () => {
    const text = [
      '<channel source="plugin:discord:discord" chat_id="11" message_id="1">a</channel>',
      '<channel source="telegram" chat_id="22" message_id="2">b</channel>',
      '<channel source="plugin:voice:voice">c</channel>',
      '<channel source="..." chat_id="..." message_id="...">',
    ].join('\n')
    expect(parseChannelMessages(text, null).map(m => [m.server, m.chatId])).toEqual([
      ['plugin:discord:discord', '11'],
      ['telegram', '22'],
      ['plugin:voice:voice', ''],
    ])
    expect(parseChannelMessages('plain words', 'slack')).toEqual([{ server: 'slack', chatId: '', key: expect.stringMatching(/^slack\|\|h/) }])
    expect(parseChannelMessages('plain words', null)).toEqual([])
  })
  test('labels: named, last four digits, or just the server', () => {
    const c = parseConfig({ channelNames: '123456=general' })
    expect(channelLabel(c, 'plugin:discord:discord', '123456')).toBe('discord #general')
    expect(channelLabel(c, 'plugin:discord:discord', '987654')).toBe('discord #7654')
    expect(channelLabel(c, 'plugin:voice:voice', '')).toBe('voice')
  })
  test('replies match their own server; replyTools overrides the naming rule', () => {
    const c = DEFAULT_CONFIG
    expect(replyTarget(c, 'mcp__plugin_discord_discord__reply', { chat_id: '1' })).toEqual({ server: 'plugin_discord_discord', chatId: '1' })
    expect(replyTarget(c, 'mcp__plugin_voice_voice__voice_reply', {})).toEqual({ server: 'plugin_voice_voice', chatId: null })
    expect(replyTarget(c, 'mcp__plugin_discord_discord__react', { chat_id: '1' })).toBeNull()
    expect(replyTarget(c, 'Bash', {})).toBeNull()
    const custom = parseConfig({ replyTools: 'mcp__slack__post_message' })
    expect(replyTarget(custom, 'mcp__slack__post_message', { chat_id: 'C' })).toEqual({ server: 'slack', chatId: 'C' })
    expect(replyTarget(custom, 'mcp__slack__reply', {})).toBeNull()
    const ledger = addPending({ pending: [], seen: [] }, parseChannelMessages('<channel source="plugin:discord:discord" chat_id="1" message_id="9">', null), 100)
    expect(clearByReply(ledger.pending, { server: 'plugin_discord_discord', chatId: '1' }, 150)).toEqual([])
    expect(clearByReply(ledger.pending, { server: 'plugin_discord_discord', chatId: '1' }, 50).length).toBe(1)
  })
  test('append rows: main-loop deliveries and channel prompts are read, tool results and terminal input never', () => {
    const row = (over: Record<string, unknown>) => ({
      door: 'delivery',
      origin: { kind: 'unclassified' },
      message: { type: 'user', content: [{ type: 'text', text: '<channel source="x" chat_id="1" message_id="2">' }] },
      ...over,
    })
    expect(appendChannelText(row({}))?.server).toBeNull()
    expect(appendChannelText(row({ door: 'prompt', origin: { kind: 'channel', server: 'x' } }))?.server).toBe('x')
    expect(appendChannelText(row({ door: 'tool-result' }))).toBeNull()
    expect(appendChannelText(row({ agentId: 'a' }))).toBeNull()
    expect(appendChannelText(row({ origin: { kind: 'composer' } }))).toBeNull()
  })
})

describe('labels and context', () => {
  test('labels without and with a dispatch pattern', () => {
    expect(labelFor(DEFAULT_CONFIG, 'Bash', { command: 'x run --runtime alpha-cli', description: 'build' })).toBe('Bash "build"')
    const c = parseConfig({ dispatchCommandPattern: 'x run', runtimeNames: 'alpha-cli=Alpha' })
    expect(labelFor(c, 'Bash', { command: 'x run --runtime alpha-cli' })).toBe('dispatch -> Alpha')
    expect(labelFor(c, 'Bash', { command: 'x run --runtime=other' })).toBe('dispatch -> other')
    expect(labelFor(c, 'Agent', { description: 'review' })).toBe('agent review')
    expect(labelFor(c, 'mcp__s__fetch_messages', {})).toBe('fetch_messages')
  })
  test('the warning toast fires once per crossing', () => {
    let mark = { percent: null as number | null, isAlerted: false }
    const fired: boolean[] = []
    for (const p of [50, 72, 80, 60, 71]) {
      const t = contextTransition(mark, p, 70)
      mark = t.mark
      fired.push(t.shouldAlert)
    }
    expect(fired).toEqual([false, true, false, false, true])
  })
})

describe('dispatch events', () => {
  const ev = (type: string, id: string, at: string, payload: Record<string, unknown> = {}): DispatchEvent => ({
    type,
    at: Date.parse(at),
    payload: { dispatch_id: id, ...payload },
  })
  test('heartbeats keep a dispatch running; 3 minutes without one and no end event is stalled; ended ones are unaffected', () => {
    const now = Date.parse('2026-10-05T03:00:00Z')
    const rows = pairDispatches(
      parseConfig({ runtimeNames: 'alpha-cli=Alpha' }),
      [
        ev('DispatchStarted', 'eeeeeeee-1', '2026-10-05T01:00:00Z', { runtime_id: 'alpha-cli' }),
        ev('DispatchHeartbeat', 'eeeeeeee-1', '2026-10-05T02:59:30Z'),
        ev('DispatchStarted', 'ffffffff-2', '2026-10-05T02:30:00Z', { runtime_id: 'other-cli' }),
        ev('DispatchHeartbeat', 'ffffffff-2', '2026-10-05T02:56:00Z'),
        ev('DispatchStarted', '99999999-3', '2026-10-05T02:35:00Z'),
        ev('DispatchStarted', '88888888-4', '2026-10-05T01:00:00Z'),
        ev('DispatchCompleted', '88888888-4', '2026-10-05T01:11:00Z'),
        ev('DispatchStarted', '77777777-5', '2026-10-05T02:58:00Z'),
        ev('DispatchRejected', '66666666-6', '2026-10-05T02:00:00Z', { runtime: 'Thing' }),
      ],
      now,
    )
    expect(rows.map(r => [r.id, r.state, r.runtime])).toEqual([
      ['77777777', 'running', 'unknown'],
      ['eeeeeeee', 'running', 'Alpha'],
      ['99999999', 'stalled', 'unknown'],
      ['ffffffff', 'stalled', 'other-cli'],
      ['66666666', 'rejected', 'Thing'],
      ['88888888', 'done', 'unknown'],
    ])
  })
  test('a bad line fails the whole read', () => {
    expect(parseJsonl('{"event_type":"DispatchStarted","timestamp":"2026-10-05T00:00:00Z","payload":{"dispatch_id":"a"}}').error).toBeNull()
    expect(parseJsonl('nope').error).toBe('line 1 is not JSON')
  })
})

describe('layout', () => {
  test('spread pushes the right side to the edge and gives way on the left', () => {
    const line = spread([{ text: 'a long channel name here', tone: 'plain' }], [{ text: '12m', tone: 'warn' }], 20)
    expect(line.map(r => r.text).join('')).toBe('a long channel~  12m')
    expect(displayWidth(line.map(r => r.text).join(''))).toBe(20)
    expect(fitLine([{ text: 'abcdef', tone: 'plain' }], 4).map(r => r.text)).toEqual(['abc~'])
  })
  test('the AGE column never needs more than 5 cells', () => {
    expect([12, 103, 641, 3000].map(m => ageText(m * 60_000))).toEqual(['12m', '1h43m', '10h', '2d'])
  })
  test('the status table uses only whitelisted symbols', () => {
    expect([...SYMBOLS].some(ch => '▰▱↻…×○'.includes(ch))).toBe(false)
    expect(['running', 'stalled', 'done', 'failed', 'cancelled', 'rejected', 'idle'].map(s => statusMark(s as never).text).join('')).toBe('●◌✓✗–✗·')
  })
})
