// agent-monitor: a band above the prompt and a /monitor pane, both drawn from one model.
// Every hook only observes: it passes its event on with next(e) unchanged and keeps its own
// errors to itself (a debug log line), so the session's tools and prompts never feel it.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { Action, AgentRun, ContextMark, CustomView, DispatchView, Pending, SessionInfo } from '../types'
import { parseConfig, resolveCards } from './config'
import type { Config } from './config'
import { dispatchArgv, oneLine, pairDispatches, parseJsonl } from './dispatch'
import {
  addPending,
  appendChannelText,
  channelLabel,
  clearByReply,
  contextTransition,
  dueAlerts,
  isTrackedInSubagent,
  labelFor,
  launchOf,
  mergeAgentStatus,
  parseChannelMessages,
  replyTarget,
} from './logic'
import type { ChannelMessage } from './logic'
import { buildModel } from './model'
import { emptyCustom, parseCustomOutput } from './custom'
import { cardInner, cardTitle, layoutPane, paneDoc } from './pane'
import { TOGGLE, bandLine, bandSegments, textProps } from './view'
import type { Line } from './view'

const PANE = 'agent-monitor'
const TICK_MS = 30_000
const PANE_REFRESH_MS = 60_000
const COMMAND_TIMEOUT_MS = 20_000

const pendingA = atom({ plugin: 'agent-monitor', key: 'pending' } as const, [] as Pending[])
const seenA = atom({ plugin: 'agent-monitor', key: 'seen' } as const, [] as string[])
const lastReplyA = atom({ plugin: 'agent-monitor', key: 'lastReplyAt' } as const, null as number | null)
const actionsA = atom({ plugin: 'agent-monitor', key: 'actions' } as const, [] as Action[])
const tickA = atom({ plugin: 'agent-monitor', key: 'tick' } as const, 0)
const contextA = atom({ plugin: 'agent-monitor', key: 'context' } as const, { percent: null, isAlerted: false } as ContextMark)
const dispatchA = atom({ plugin: 'agent-monitor', key: 'dispatch' } as const, { rows: [], error: null, fetchedAt: null } as DispatchView)
const agentsA = atom({ plugin: 'agent-monitor', key: 'agents' } as const, [] as AgentRun[])
const customA = atom({ plugin: 'agent-monitor', key: 'custom' } as const, [] as CustomView[])
const sessionA = atom({ plugin: 'agent-monitor', key: 'session' } as const, {
  startedAt: null,
  wakeAt: null,
  wakeText: '',
  compactCount: 0,
  compactAt: null,
} as SessionInfo)
const expandedA = atom({ plugin: 'agent-monitor', key: 'expanded' } as const, {} as Record<string, boolean>)
const STORE_EXPANDED = 'expanded'
const STORE_HIDDEN = 'hidden'
const STORE_ROWS = 'rows'
const hiddenA = atom({ plugin: 'agent-monitor', key: 'hidden' } as const, [] as string[])
const rowsA = atom({ plugin: 'agent-monitor', key: 'rows' } as const, {} as Record<string, number>)
const CUSTOM_TIMEOUT_MS = 10_000
/** How long after a dispatch command starts before its DispatchStarted event is read. */
const DISPATCH_SETTLE_MS = 5_000
const storeSessionKey = (startedAt: number): string => `session:${startedAt}`

type $ = EngineInterface

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

const logError = ($: $, where: string, err: unknown): void => {
  try {
    $.ui.log(`agent-monitor ${where}: ${oneLine(errText(err))}`, { to: 'debug' })
  } catch {
    // Not even the debug log: give up quietly.
  }
}

// ---------- the inbox ----------

const recordMessages = async ($: $, messages: readonly ChannelMessage[]): Promise<void> => {
  if (messages.length === 0) return
  const now = await $.clock.now()
  let added: Pending[] = []
  await update($, seenA, seen => {
    const ledger = addPending({ pending: [], seen }, messages, now)
    added = ledger.pending
    return ledger.seen
  })
  if (added.length > 0) await update($, pendingA, list => [...list, ...added])
}

const onTick = async ($: $, cfg: Config): Promise<void> => {
  try {
    const now = await $.clock.now()
    await update($, tickA, () => now)
    let due: Pending[] = []
    await update($, pendingA, list => {
      const result = dueAlerts(list, now, cfg.waitingAlertMs)
      due = result.due
      return result.pending
    })
    const minutes = Math.round(cfg.waitingAlertMs / 60_000)
    for (const p of due) {
      $.ui.toast(`Inbox: a message has waited ${minutes}m without a reply (${channelLabel(cfg, p.server, p.chatId)})`, {
        timeoutMs: 10_000,
      })
    }
  } catch (err) {
    logError($, 'tick', err)
  }
}

// ---------- dispatches and subagents (pane refresh) ----------

/**
 * When the running refresh started. A refresh whose `$` call never settles (its timer dispatch
 * abandoned) must not block every later one, so a flag older than REFRESH_STALE_MS is ignored.
 */
let refreshingSince: number | null = null
const REFRESH_STALE_MS = 45_000

const readDispatches = async ($: $, cfg: Config, now: number): Promise<DispatchView> => {
  try {
    const ran = await $.process.run(dispatchArgv(cfg, now), { timeoutMs: COMMAND_TIMEOUT_MS })
    if (ran.exitCode !== 0) {
      return { rows: [], error: `exit code ${ran.exitCode}: ${oneLine(ran.stderr || ran.stdout)}`, fetchedAt: now }
    }
    if (ran.isStdoutTruncated) return { rows: [], error: 'output too large, cut off', fetchedAt: now }
    const parsed = parseJsonl(ran.stdout)
    if (parsed.error !== null) return { rows: [], error: parsed.error, fetchedAt: now }
    return { rows: pairDispatches(cfg, parsed.events, now), error: null, fetchedAt: now }
  } catch (err) {
    return { rows: [], error: oneLine(errText(err)), fetchedAt: now }
  }
}

const readCustom = async (
  $: $,
  card: Config['customCards'][number],
  now: number,
): Promise<CustomView> => {
  const base = { ...emptyCustom(card), fetchedAt: now }
  try {
    const ran = await $.process.run(card.argv, { timeoutMs: CUSTOM_TIMEOUT_MS })
    if (ran.exitCode !== 0) return { ...base, error: `exit code ${ran.exitCode}: ${oneLine(ran.stderr || ran.stdout)}` }
    const parsed = parseCustomOutput(ran.stdout)
    return typeof parsed === 'string' ? { ...base, error: parsed } : { ...base, ...parsed }
  } catch (err) {
    return { ...base, error: oneLine(errText(err)) }
  }
}

/** Expands or collapses cards (`all` for every one), kept in $.state and $.store. */
/** Every card id this configuration draws, in pane order. */
const cardIds = (cfg: Config): string[] => [
  'inbox',
  'running',
  ...(cfg.dispatchArgv.length > 0 ? ['dispatches'] : []),
  ...cfg.customCards.map(c => c.id),
  'session',
]

const setExpanded = async ($: $, cfg: Config, which: string, isExpanded: boolean): Promise<string[]> => {
  const match = resolveCards(cardIds(cfg), which)
  if ('error' in match) return []
  const target = match.ids
  let next: Record<string, boolean> = {}
  await update($, expandedA, map => {
    next = { ...map, ...Object.fromEntries(target.map(id => [id, isExpanded])) }
    return next
  })
  await $.store.set(STORE_EXPANDED, next)
  return target
}

/** /monitor hide|show|rows: the answer line for the person. */
const arrangeCards = async ($: $, cfg: Config, verb: string, which: string, value: string | undefined): Promise<string> => {
  const match = resolveCards(cardIds(cfg), which)
  if ('error' in match) return match.error
  const target = match.ids
  if (verb === 'hide' || verb === 'show') {
    if (verb === 'hide' && which === 'all') return 'Hide cards one at a time; the header card always stays.'
    let next: string[] = []
    await update($, hiddenA, list => {
      next = verb === 'hide' ? [...new Set([...list, ...target])] : list.filter(id => !target.includes(id))
      return next
    })
    await $.store.set(STORE_HIDDEN, next)
    return `${verb === 'hide' ? 'Hidden' : 'Shown'}: ${target.join(', ')}.`
  }
  const n = Number(value)
  if (value !== 'default' && !(Number.isInteger(n) && n >= 1 && n <= 30)) return 'Rows takes a whole number from 1 to 30, or default.'
  let next: Record<string, number> = {}
  await update($, rowsA, map => {
    next = Object.fromEntries(Object.entries({ ...map, ...Object.fromEntries(target.map(id => [id, n])) }).filter(([id]) => !(value === 'default' && target.includes(id))))
    return next
  })
  await $.store.set(STORE_ROWS, next)
  return value === 'default' ? `Rows back to default: ${target.join(', ')}.` : `Rows set to ${n}: ${target.join(', ')}.`
}

const refreshPane = async ($: $, cfg: Config): Promise<void> => {
  const now = await $.clock.now()
  if (refreshingSince !== null && now - refreshingSince < REFRESH_STALE_MS) return
  refreshingSince = now
  try {
    await update($, tickA, () => now)
    if (cfg.dispatchArgv.length > 0) {
      const view = await readDispatches($, cfg, now)
      await update($, dispatchA, () => view)
    }
    for (const card of cfg.customCards) {
      const view = await readCustom($, card, now)
      await update($, customA, list => list.map(one => (one.id === card.id ? view : one)))
    }
    try {
      const infos = await $.agent.list()
      await update($, agentsA, runs => mergeAgentStatus(runs, infos))
    } catch (err) {
      logError($, 'agent.list', err)
    }
  } catch (err) {
    logError($, 'refresh', err)
  } finally {
    if (refreshingSince === now) refreshingSince = null
  }
}

const isPaneOpen = async ($: $): Promise<boolean> => (await $.ui.panes()).some(pane => pane.id === PANE)

const onPaneTimer = async ($: $, cfg: Config): Promise<void> => {
  try {
    if (await isPaneOpen($)) await refreshPane($, cfg)
  } catch (err) {
    logError($, 'pane timer', err)
  }
}

// ---------- the session card ----------

/**
 * The session's start comes from the engine ($.session.usage().startedAt: its launch, or its first
 * launch when resumed), so a hot reload never resets it; wake and compaction figures are kept in
 * $.store under that start too, and restored when the module's state comes back empty.
 */
const restoreSession = async ($: $): Promise<void> => {
  const { startedAt } = await $.session.usage()
  const saved = (await $.store.get(storeSessionKey(startedAt))) as Partial<SessionInfo> | undefined
  await update($, sessionA, info => {
    const isSameSession = info.startedAt === startedAt
    const kept = isSameSession ? info : { ...info, wakeAt: null, wakeText: '', compactCount: 0, compactAt: null }
    return { ...kept, ...(isSameSession ? {} : (saved ?? {})), startedAt }
  })
  for (const key of await $.store.keys()) {
    if (key.startsWith('session:') && key !== storeSessionKey(startedAt)) await $.store.delete(key)
  }
}

const saveSession = async ($: $, change: (info: SessionInfo) => SessionInfo): Promise<void> => {
  let next: SessionInfo | null = null
  await update($, sessionA, info => {
    next = change(info)
    return next
  })
  const done = next as SessionInfo | null
  if (done !== null && done.startedAt !== null) await $.store.set(storeSessionKey(done.startedAt), done)
}

// ---------- tool calls ----------

type Tracked = { action: Action | null; agentRun: AgentRun | null; startedAt: number }

const beginCall = async (
  $: $,
  cfg: Config,
  tool: string,
  input: Record<string, unknown>,
  loop: string | undefined,
  id: string | undefined,
): Promise<Tracked> => {
  const startedAt = await $.clock.now()
  const label = labelFor(cfg, tool, input)
  const callId = id ?? `${tool}-${startedAt}-${Math.random().toString(36).slice(2)}`
  let action: Action | null = null
  if (loop === undefined || isTrackedInSubagent(label)) {
    const one: Action = { id: callId, tool, label, startedAt }
    action = one
    await update($, actionsA, list => [...list, one].slice(-50))
  }
  let agentRun: AgentRun | null = null
  if ((tool === 'Agent' || tool === 'Task') && loop === undefined) {
    const description = typeof input['description'] === 'string' ? input['description'] : 'task'
    const run: AgentRun = { id: callId, description, startedAt, endedAt: null, isBackground: false, agentId: null, status: null }
    agentRun = run
    await update($, agentsA, list => [...list, run].slice(-30))
  }
  return { action, agentRun, startedAt }
}

const endCall = async ($: $, tracked: Tracked, hasFailed: boolean, result: unknown): Promise<void> => {
  const { action, agentRun } = tracked
  if (action !== null) await update($, actionsA, list => list.filter(one => one.id !== action.id))
  if (agentRun === null) return
  const endedAt = await $.clock.now()
  const launch = launchOf(result)
  await update($, agentsA, list =>
    list.map(one =>
      one.id !== agentRun.id
        ? one
        : {
            ...one,
            endedAt,
            isBackground: launch.isBackground,
            agentId: launch.agentId,
            status: hasFailed ? 'failed' : launch.isBackground ? launch.status : 'completed',
          },
    ),
  )
}

const noteReply = async ($: $, cfg: Config, tool: string, input: Record<string, unknown>, startedAt: number) => {
  const target = replyTarget(cfg, tool, input)
  if (target === null) return
  await update($, pendingA, list => clearByReply(list, target, startedAt))
  const now = await $.clock.now()
  await update($, lastReplyA, () => now)
}

const readModel = async ($: $, cfg: Config) => {
  await read($, tickA)
  const now = await $.clock.now()
  const input = {
    pending: await read($, pendingA),
    lastReplyAt: await read($, lastReplyA),
    actions: await read($, actionsA),
    context: await read($, contextA),
    agents: await read($, agentsA),
    dispatch: await read($, dispatchA),
    custom: await read($, customA),
    session: await read($, sessionA),
  }
  return buildModel(input, now, cfg)
}

// ---------- hooks ----------

export const register: Register = (on, options) => {
  const cfg = parseConfig(options)

  on('session.start', async ($, e, next) => {
    try {
      const now = await $.clock.now()
      await update($, actionsA, () => [])
      await update($, tickA, () => now)
      await restoreSession($)
      await update($, customA, list => cfg.customCards.map(card => list.find(one => one.id === card.id) ?? emptyCustom(card)))
      const savedHidden = await $.store.get(STORE_HIDDEN)
      if (Array.isArray(savedHidden)) await update($, hiddenA, () => savedHidden.filter((x): x is string => typeof x === 'string'))
      const savedRows = await $.store.get(STORE_ROWS)
      if (typeof savedRows === 'object' && savedRows !== null) await update($, rowsA, () => savedRows as Record<string, number>)
      const saved = await $.store.get(STORE_EXPANDED)
      if (typeof saved === 'object' && saved !== null) await update($, expandedA, () => saved as Record<string, boolean>)
    } catch (err) {
      logError($, 'session.start', err)
    }
    try {
      await $.command.register({
        name: 'monitor',
        description: 'Toggle the agent monitor pane; expand or collapse its cards',
        argumentHint: `[expand|collapse <card|all> · hide <card> · show <card|all> · rows <card> <1-30|default>] cards: ${cardIds(cfg).join(', ')}`,
      })
    } catch (err) {
      logError($, 'command.register', err)
    }
    try {
      $.clock.every(TICK_MS, () => void onTick($, cfg))
      $.clock.every(PANE_REFRESH_MS, () => void onPaneTimer($, cfg))
      if (cfg.openOnStart && !(await isPaneOpen($))) {
        await $.ui.open({ id: PANE, title: 'Agent monitor' })
        void refreshPane($, cfg)
      }
    } catch (err) {
      logError($, 'timers', err)
    }
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    try {
      if (e.origin.kind === 'channel') await recordMessages($, parseChannelMessages(e.text, e.origin.server))
      const isWake = cfg.wakePattern !== null ? cfg.wakePattern.test(e.text) : e.origin.kind === 'scheduled-trigger'
      if (isWake) {
        const now = await $.clock.now()
        const wakeText = e.text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
        await saveSession($, info => ({ ...info, wakeAt: now, wakeText }))
      }
    } catch (err) {
      logError($, 'prompt.submit', err)
    }
    return next(e)
  })

  // Channel messages delivered into a running turn arrive here; ones prompt.submit saw too are deduplicated.
  on('session.append', async ($, e, next) => {
    try {
      const found = appendChannelText(e)
      if (found !== null) await recordMessages($, parseChannelMessages(found.text, found.server))
    } catch (err) {
      logError($, 'session.append', err)
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const input = e as unknown as Record<string, unknown>
    let tracked: Tracked = { action: null, agentRun: null, startedAt: 0 }
    try {
      tracked = await beginCall($, cfg, tool, input, e.agentId, e.tool_use_id)
      if (tracked.action?.label.startsWith('dispatch')) $.clock.after(DISPATCH_SETTLE_MS, () => void onPaneTimer($, cfg))
    } catch (err) {
      logError($, 'tool.call begin', err)
    }
    let ran: Awaited<ReturnType<typeof next>> | undefined
    let hasThrown = true
    try {
      ran = await next(e)
      hasThrown = false
    } finally {
      try {
        await endCall($, tracked, hasThrown || ran?.isError === true || ran?.deny !== undefined, ran?.result)
      } catch (err) {
        logError($, 'tool.call end', err)
      }
    }
    try {
      if (tracked.action?.label.startsWith('dispatch') && (await isPaneOpen($))) void refreshPane($, cfg)
      if (ran.deny === undefined && ran.isError !== true && tracked.startedAt > 0) {
        await noteReply($, cfg, tool, input, tracked.startedAt)
      }
    } catch (err) {
      logError($, 'tool.call reply', err)
    }
    return ran
  })

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    try {
      if (e.agentId === undefined && e.trigger !== 'precompute' && result.skip === undefined) {
        const now = await $.clock.now()
        await saveSession($, info => ({ ...info, compactCount: info.compactCount + 1, compactAt: now }))
      }
    } catch (err) {
      logError($, 'session.compact', err)
    }
    return result
  })

  on('session.measure', async ($, e, next) => {
    try {
      const percent = typeof e.context.percent === 'number' ? e.context.percent : null
      let shouldAlert = false
      await update($, contextA, prev => {
        const t = contextTransition(prev, percent, cfg.contextWarn)
        shouldAlert = t.shouldAlert
        return t.mark
      })
      if (shouldAlert) {
        $.ui.toast(`Context usage passed ${cfg.contextWarn}% - consider restarting the session soon`, { timeoutMs: 10_000 })
      }
    } catch (err) {
      logError($, 'session.measure', err)
    }
    return next(e)
  })

  on('command.run', { command: 'monitor' }, async ($, e) => {
    try {
      // The card name may hold spaces; for rows the number is the last word.
      const [verb = '', ...rest] = e.args.trim().split(/\s+/)
      const value = verb === 'rows' && rest.length > 1 ? rest.pop() : undefined
      const which = rest.join(' ') || 'all'
      if (verb === 'hide' || verb === 'show' || verb === 'rows') return { text: await arrangeCards($, cfg, verb, which, value) }
      if (verb === 'expand' || verb === 'collapse') {
        const match = resolveCards(cardIds(cfg), which)
        if ('error' in match) return { text: match.error }
        const ids = await setExpanded($, cfg, which, verb === 'expand')
        return { text: `${verb === 'expand' ? 'Expanded' : 'Collapsed'}: ${ids.join(', ')}.` }
      }
      if (await isPaneOpen($)) {
        await $.ui.close({ id: PANE })
        return { text: 'Agent monitor closed.' }
      }
      const opened = await $.ui.open({ id: PANE, title: 'Agent monitor' })
      await refreshPane($, cfg)
      return { text: opened.isPlaced ? 'Agent monitor opened.' : `Agent monitor opened, not shown yet: ${oneLine(opened.reason)}` }
    } catch (err) {
      logError($, 'monitor', err)
      return { text: `Agent monitor could not toggle: ${oneLine(errText(err))}` }
    }
  })

  // The band depends on whether the pane is open: redraw it when the pane closes, however it closes.
  on('ui.close', async ($, e, next) => {
    const closed = await next(e)
    try {
      if (e.id === PANE) await update($, tickA, () => Date.now())
    } catch (err) {
      logError($, 'ui.close', err)
    }
    return closed
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    try {
      const model = await readModel($, cfg)
      const segments = bandSegments(model, await isPaneOpen($))
      if (segments.length === 0) return next(e)
      const line = bandLine(segments, e.props.bodyColumns)
      const { Box, Text } = $.ui.resolve(e)
      return (
        <Box flexDirection="row">
          {line.map(run => (
            <Text {...textProps(run)}>{run.text}</Text>
          ))}
        </Box>
      )
    } catch (err) {
      logError($, 'render band', err)
      return next(e)
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    try {
      const model = await readModel($, cfg)
      const expanded = await read($, expandedA)
      const doc = paneDoc(model, e.props.bodyColumns, cfg.timeZone, {
        customMaxItems: cfg.customCardMaxItems,
        rows: await read($, rowsA),
        hidden: await read($, hiddenA),
      })
      const rows = e.props.scroll.bodyRows > 0 ? e.props.scroll.bodyRows : cfg.paneMaxRows
      const layout = layoutPane(doc, id => expanded[id] ?? !cfg.collapsedCards.has(id), rows)
      const inner = cardInner(e.props.bodyColumns)
      const row = (line: Line) => (
        <Box flexDirection="row">
          {line.map(run => (
            <Text wrap="truncate" {...textProps(run)}>
              {run.text}
            </Text>
          ))}
        </Box>
      )
      const card = (key: string, body: RenderChildren) => (
        <Box key={key} flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
          {body}
        </Box>
      )
      return (
        <Box flexDirection="column">
          {card('head', layout.head.map(row))}
          {layout.cards.map(({ card: one, isOpen, body }) => {
            const title = (
              <Box flexDirection="row">
                <Button
                  key={`toggle-${one.id}`}
                  plain
                  label={isOpen ? TOGGLE.expanded : TOGGLE.collapsed}
                  onPress={() => void setExpanded($, cfg, one.id, !isOpen)}
                />
                {row(cardTitle(one, inner))}
              </Box>
            )
            return card(one.id, [title, ...body.map(row)])
          })}
          {layout.showFooter && <Box flexDirection="column" paddingX={1}>{doc.footer.map(row)}</Box>}
        </Box>
      )
    } catch (err) {
      logError($, 'render pane', err)
      return (
        <Box>
          <Text color="yellow">Agent monitor could not draw: {oneLine(errText(err))}</Text>
        </Box>
      )
    }
  })
}
