import { expect, test } from 'claude-code/testing'

import { CHAT_A, CHAT_B, CJK, MIN, band, fromChannel, renderText, start, tag, world } from './kit'

const text = async (ui: { drawn: () => Promise<unknown> }): Promise<string> => renderText(await ui.drawn(), 400).join('\n')

test('a channel message waits until a reply to the same chat; other chats and reactions do not clear it', async ($, on) => {
  const w = world(on)
  on('tool.call', () => ({ result: 'sent' }))
  await start($)
  const ui = await $.ui.mount(band())
  expect(await text(ui)).toContain('· INBOX 0')

  await $.prompt.submit({ text: tag(CHAT_A, '1'), origin: fromChannel(), wait: false })
  await w.clock.advance(2 * MIN)
  await ui.redraw()
  expect(await text(ui)).toContain('● INBOX 1  discord #1112 2m')

  await $.tool.call({ tool: 'mcp__plugin_discord_discord__reply', chat_id: CHAT_B, text: 'elsewhere' })
  await $.tool.call({ tool: 'mcp__plugin_discord_discord__react', chat_id: CHAT_A, message_id: '1', emoji: 'x' })
  await ui.redraw()
  expect(await text(ui)).toContain('INBOX 1')
  expect(await text(ui)).toContain('replied just now')

  await $.tool.call({ tool: 'mcp__plugin_discord_discord__reply', chat_id: CHAT_A, text: 'done' })
  await ui.redraw()
  expect(await text(ui)).toContain('· INBOX 0')
  expect(w.logs).toEqual([])
})

test('any channel server waits and is cleared by its own __reply tool; a voice server without chat ids too', async ($, on) => {
  world(on)
  on('tool.call', () => ({ result: 'ok' }))
  await start($)
  await $.prompt.submit({ text: tag('C42', 'm1', 'telegram'), origin: fromChannel('telegram'), wait: false })
  await $.prompt.submit({ text: 'turn on the lights', origin: fromChannel('plugin:voice:voice'), wait: false })
  const ui = await $.ui.mount(band())
  expect(await text(ui)).toContain('INBOX 2')
  expect(await text(ui)).toContain('+1ch')
  await $.tool.call({ tool: 'mcp__plugin_discord_discord__reply', chat_id: 'C42', text: 'wrong server' })
  await ui.redraw()
  expect(await text(ui)).toContain('INBOX 2')
  // Not a server connected on this machine, so its name is outside the generated MCP typings.
  await $.tool.call({ tool: 'mcp__telegram__reply', chat_id: 'C42', text: 'hi' } as unknown as Parameters<typeof $.tool.call>[0])
  await ui.redraw()
  expect(await text(ui)).toContain('INBOX 1  voice')
  await $.tool.call({ tool: 'mcp__plugin_voice_voice__voice_reply', text: 'ok' })
  await ui.redraw()
  expect(await text(ui)).toContain('INBOX 0')
})

test('channelNames names a chat; the same message seen twice counts once', { options: { channelNames: `${CHAT_A}=general, 999=ops` } }, async ($, on) => {
  world(on)
  await start($)
  await $.prompt.submit({ text: tag(CHAT_A, '9'), origin: fromChannel(), wait: false })
  await $.prompt.submit({ text: tag(CHAT_A, '9'), origin: fromChannel(), wait: false })
  const ui = await $.ui.mount(band())
  expect(await text(ui)).toContain('INBOX 1  discord #general')
})

test('waiting alert: one toast per message at the default 5 minutes, in the warning color', async ($, on) => {
  const w = world(on)
  await start($)
  await $.prompt.submit({ text: tag(CHAT_A, '7'), origin: fromChannel(), wait: false })
  await w.clock.advance(4 * MIN)
  expect(w.toasts).toEqual([])
  await w.clock.advance(MIN + 30_000)
  await w.clock.advance(10 * MIN)
  expect(w.toasts).toEqual(['Inbox: a message has waited 5m without a reply (discord #1112)'])
  const ui = await $.ui.mount(band())
  expect((await ui.find({ type: 'Text', text: '●' }))?.props['color']).toBe('yellow')
})

const TUNED = {
  options: {
    longActionMinutes: 2,
    dispatchCommandPattern: 'mytool run',
    runtimeNames: 'alpha-cli=Alpha',
    contextWarnPercent: 50,
    contextCriticalPercent: 60,
  },
}

test('the long-action threshold, the dispatch pattern and the context thresholds follow the options', TUNED, async ($, on) => {
  const w = world(on)
  on('tool.call', async () => {
    await w.clock.sleep(3 * MIN)
    return { result: 'ok' }
  })
  await start($)
  const ui = await $.ui.mount(band())
  expect(await text(ui)).toContain('· NOW idle')
  const call = $.tool.call({ tool: 'Bash', command: 'mytool run --runtime alpha-cli job', description: 'send' })
  await w.clock.settle()
  await ui.redraw()
  expect(await text(ui)).toContain('● NOW  dispatch -> Alpha <1m')
  await w.clock.advance(2 * MIN)
  await ui.redraw()
  expect((await ui.find({ type: 'Text', text: '2m' }))?.props['color']).toBe('yellow')
  await w.clock.advance(MIN)
  await call

  const measure = (percent: number) =>
    $.session.measure({ context: { window: 200_000, tokens: percent * 2000, percent }, rateLimits: [], changed: ['context'] })
  await measure(40)
  await ui.redraw()
  expect(await text(ui)).not.toContain('restart')
  expect(await text(ui)).not.toContain('%')
  await measure(55)
  await measure(58)
  expect(w.toasts).toEqual(['Context usage passed 50% - consider restarting the session soon'])
  await ui.redraw()
  expect(await text(ui)).toContain('● restart soon')
  expect((await ui.find({ type: 'Text', text: 'restart soon' }))?.props['color']).toBe('yellow')
  await measure(65)
  await ui.redraw()
  expect((await ui.find({ type: 'Text', text: 'restart now' }))?.props['color']).toBe('red')
  await measure(30)
  await measure(51)
  expect(w.toasts.length).toBe(2)
})

test('defaults: Bash shows its description and contexts warn at 70%', async ($, on) => {
  const w = world(on)
  on('tool.call', async () => {
    await w.clock.sleep(MIN)
    return { result: 'ok' }
  })
  await start($)
  const call = $.tool.call({ tool: 'Bash', command: 'mytool run --runtime alpha-cli job', description: 'build' })
  await w.clock.settle()
  await $.session.measure({ context: { window: 1, tokens: 1, percent: 69 }, rateLimits: [], changed: ['context'] })
  const ui = await $.ui.mount(band())
  expect(await text(ui)).toContain('● NOW  Bash "build" <1m')
  expect(w.toasts).toEqual([])
  await $.session.measure({ context: { window: 1, tokens: 1, percent: 72 }, rateLimits: [], changed: ['context'] })
  expect(w.toasts.length).toBe(1)
  await w.clock.advance(MIN)
  await call
})

test('narrow terminals drop segments from the right: last reply, then the restart warning, then NOW', async ($, on) => {
  world(on)
  await start($)
  await $.session.measure({ context: { window: 1, tokens: 1, percent: 72 }, rateLimits: [], changed: ['context'] })
  const widths: [number, string[]][] = [
    [160, ['INBOX', 'NOW', 'restart', 'no reply']],
    [55, ['INBOX', 'NOW', 'restart']],
    [40, ['INBOX', 'NOW']],
    [20, ['INBOX']],
  ]
  for (const [columns, parts] of widths) {
    const ui = await $.ui.mount(band(columns))
    const line = await text(ui)
    await ui.unmount()
    for (const part of ['INBOX', 'NOW', 'restart', 'no reply']) expect(line.includes(part)).toBe(parts.includes(part))
    expect(line.length).toBeLessThanOrEqual(columns)
  }
})

test('hooks pass results through unchanged', async ($, on) => {
  world(on)
  on('tool.call', ($, e) =>
    e.tool === 'Bash' ? { result: { stdout: 'x', stderr: '', interrupted: false }, isError: true as const } : { result: 'r' },
  )
  await start($)
  expect(await $.tool.call({ tool: 'mcp__plugin_discord_discord__reply', chat_id: CHAT_A, text: 't' })).toMatchObject({ result: 'r' })
  expect((await $.tool.call({ tool: 'Bash', command: 'false', description: 'fails' })).isError).toBe(true)
})

test('no CJK characters anywhere on the band or in toasts', async ($, on) => {
  const w = world(on)
  await start($)
  await $.prompt.submit({ text: tag(CHAT_A, '1'), origin: fromChannel(), wait: false })
  await w.clock.advance(6 * MIN)
  await $.session.measure({ context: { window: 1, tokens: 1, percent: 90 }, rateLimits: [], changed: ['context'] })
  const all = [await text(await $.ui.mount(band())), ...w.toasts].join('\n')
  expect(all.length).toBeGreaterThan(20)
  expect(CJK.test(all)).toBe(false)
})
