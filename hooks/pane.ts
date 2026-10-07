// The /monitor pane: a header card and one round card per section, each with a collapsed
// summary and expanded detail. Built from the same Model and symbol table as the band.
import type { CustomMark } from '../types'
import { clockTime, cut, displayWidth, duration, truncateWidth } from './logic'
import type { Model } from './model'
import { count, fitLine, levelMark, levelTone, replyText, restartRun, spread, statusMark } from './view'
import type { Line, Run, Tone } from './view'

/** `maxLines`: most detail lines shown when expanded; the rest fold into one `+N more` line. */
export type Card = { id: string; title: string; badge: Line; summary: Line; lines: Line[]; maxLines?: number }
/** `footer`: the hidden-cards line (when some are hidden) and the updated line. */
export type PaneDoc = { head: Line[]; cards: Card[]; footer: Line[] }

/** What the person set with /monitor: hidden cards and per-card item limits. */
export type PaneOptions = {
  customMaxItems: number
  rows: Readonly<Record<string, number>>
  hidden: readonly string[]
  /** The pane's refresh period, for the footer; 60 s when absent. */
  refreshMs?: number
}

/** The badge: a gray count, and a red `· N failed` when the card holds failed items. */
export const badgeOf = (n: number, failed: number, tone: Tone = 'muted'): Line =>
  n === 0 && failed === 0
    ? []
    : [
        { text: String(n), tone: n === 0 ? 'muted' : tone, bold: tone !== 'muted' },
        ...(failed > 0 ? [SEP, { text: `${failed} failed`, tone: 'critical' as Tone, bold: true }] : []),
      ]

/** Cells inside a card: the pane body less the round border (2) and padding (2). */
export const cardInner = (bodyColumns: number): number => Math.max(16, bodyColumns - 4)

const muted = (text: string): Line => [{ text, tone: 'muted' }]

const DISPATCH_COLS = { runtime: 11, id: 8, start: 5, age: 5 } as const
const RECENT_DEFAULT = 3
/** Stalled dispatches silent longer than this fold into one line. */
const STALE_FOLD_MS = 60 * 60_000

/** Fits the 5-cell AGE column: 1h43m, then whole hours (10h), then days (2d). */
export const ageText = (ms: number): string => {
  const m = Math.floor(Math.max(0, ms) / 60_000)
  if (m < 600) return duration(ms)
  return m < 24 * 60 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / (24 * 60))}d`
}

const padTo = (s: string, n: number): string => {
  const t = truncateWidth(s, n)
  return t + ' '.repeat(Math.max(0, n - displayWidth(t)))
}

const SEP: Run = { text: ' · ', tone: 'muted' }

/** A custom item's mark: the status table, plus waiting (gray middle dot, like idle) and warn (yellow dot). */
export const customMark = (mark: CustomMark): Run =>
  mark === 'waiting' ? { text: '·', tone: 'muted' } : mark === 'warn' ? { text: '●', tone: 'warn' } : statusMark(mark)

/** The header card: title and clock, the overview, and the restart warning when there is one. */
const headLines = (m: Model, inner: number, timeZone: string): Line[] => {
  const runningAgents = m.subagents.filter(s => s.status === 'running').length
  const overview: Line = [
    { text: 'inbox ', tone: 'plain' },
    count(m.inbox.total, levelTone(m.inbox.level)),
    SEP,
    { text: 'now ', tone: 'plain' },
    count(m.actions.length, m.actions.some(a => a.level !== 'normal') ? 'warn' : 'ok'),
    SEP,
    { text: 'agents ', tone: 'plain' },
    count(runningAgents, 'ok'),
    SEP,
    { text: replyText(m.lastReplyAgoMs), tone: 'muted' },
  ]
  const restart = restartRun(m)
  return [
    spread([{ text: 'AGENT MONITOR', tone: 'accent', bold: true }], [{ text: clockTime(m.now, timeZone), tone: 'muted' }], inner),
    fitLine(overview, inner),
    ...(restart === null ? [] : [[restart]]),
  ]
}

const timed = (mark: Run, label: string, right: Run, inner: number): Line =>
  spread([mark, { text: ` ${label}`, tone: 'plain' }], [right], inner)

const inboxCard = (m: Model, inner: number): Card => {
  const [oldest] = m.inbox.groups
  return {
    id: 'inbox',
    title: 'INBOX',
    badge: badgeOf(m.inbox.total, 0),
    summary:
      oldest === undefined
        ? muted('no messages waiting')
        : fitLine(
            [
              { text: `${m.inbox.total} waiting, oldest ${oldest.label} `, tone: 'plain' },
              { text: duration(oldest.waitedMs), tone: oldest.level === 'normal' ? 'plain' : levelTone(oldest.level) },
            ],
            inner,
          ),
    lines:
      oldest === undefined
        ? [muted('no messages waiting')]
        : m.inbox.groups.map(g =>
            timed(
              levelMark(g.level, false),
              `${g.label}${g.count > 1 ? ` x${g.count}` : ''}`,
              { text: duration(g.waitedMs), tone: g.level === 'normal' ? 'plain' : levelTone(g.level) },
              inner,
            ),
          ),
  }
}

const runningCard = (m: Model, inner: number): Card => {
  const [first] = m.actions
  return {
    id: 'running',
    title: 'RUNNING',
    badge: badgeOf(m.actions.length, 0),
    summary:
      first === undefined
        ? muted('idle')
        : fitLine(
            [
              { text: `${m.actions.length} running, longest ${first.label} `, tone: 'plain' },
              { text: duration(first.elapsedMs), tone: first.level === 'normal' ? 'plain' : levelTone(first.level) },
            ],
            inner,
          ),
    lines:
      first === undefined
        ? [muted('idle')]
        : m.actions.map(a =>
            timed(levelMark(a.level, false), a.label, { text: duration(a.elapsedMs), tone: a.level === 'normal' ? 'plain' : levelTone(a.level) }, inner),
          ),
  }
}

const dispatchCard = (m: Model, inner: number, timeZone: string, recent: number): Card => {
  const d = m.dispatches
  const c = DISPATCH_COLS
  const taskWidth = Math.max(0, inner - 2 - c.runtime - c.id - c.start - c.age - 4)
  const running = d.rows.filter(r => r.status === 'running')
  const stalled = d.rows.filter(r => r.status === 'stalled')
  const fresh = stalled.filter(r => r.lastSeenAt !== null && m.now - r.lastSeenAt <= STALE_FOLD_MS)
  const stale = stalled.filter(r => !fresh.includes(r))
  const ended = d.rows.filter(r => r.status !== 'running' && r.status !== 'stalled').slice(0, recent)
  const row = (r: (typeof d.rows)[number]): Line => {
    const isOpen = r.status === 'running' || r.status === 'stalled'
    const tone: Tone = isOpen ? 'plain' : 'muted'
    return fitLine(
      [
        statusMark(r.status),
        { text: ` ${padTo(r.runtime, c.runtime)} ${padTo(r.id, c.id)} ${padTo(clockTime(r.startedAt, timeZone), c.start)} `, tone },
        { text: padTo(ageText(r.ageMs), c.age), tone: r.status === 'stalled' ? 'warn' : tone },
        { text: ` ${truncateWidth(r.summary || (r.status === 'stalled' ? 'no end event' : ''), taskWidth)}`.trimEnd(), tone: 'muted' },
      ],
      inner,
    )
  }
  const lines: Line[] = []
  let summary: Line
  if (d.error !== null) {
    lines.push(fitLine([{ text: `could not read dispatches: ${d.error}`, tone: 'critical' }], inner))
    summary = lines[0] ?? []
  } else if (d.fetchedAt === null) {
    lines.push(muted('loading...'))
    summary = muted('loading...')
  } else {
    if (d.rows.length === 0) lines.push(muted('none in the last 24h'))
    if (running.length + fresh.length > 0) {
      lines.push(muted(`  ${padTo('RUNTIME', c.runtime)} ${padTo('ID', c.id)} ${padTo('START', c.start)} ${padTo('AGE', c.age)} TASK`))
    }
    lines.push(...running.map(row), ...fresh.map(row))
    if (stale.length > 0) {
      const since = Math.min(...stale.map(r => r.startedAt ?? r.lastSeenAt ?? m.now))
      lines.push([statusMark('stalled'), { text: ` ${stale.length} stalled since ${clockTime(since, timeZone)}`, tone: 'muted' }])
    }
    if (ended.length > 0) {
      lines.push(muted(`─── recent ${'─'.repeat(Math.max(0, inner - 11))}`))
      lines.push(...ended.map(row))
    }
    const okCount = ended.filter(r => r.status === 'done').length
    const badCount = ended.filter(r => r.status === 'failed' || r.status === 'rejected').length
    summary =
      ended.length === 0
        ? muted('nothing ended in the last 24h')
        : [
            { text: 'recent ', tone: 'muted' },
            { text: `✓ ${okCount}`, tone: 'muted' },
            ...(badCount > 0 ? [{ text: '  ', tone: 'plain' as Tone }, { text: `✗ ${badCount}`, tone: 'critical' as Tone }] : []),
          ]
  }
  const badge: Line = [
    { text: `${running.length} running`, tone: running.length === 0 ? 'muted' : 'ok', bold: running.length > 0 },
    ...(stalled.length > 0 ? [SEP, { text: `${stalled.length} stalled`, tone: 'warn' as Tone, bold: true }] : []),
  ]
  return { id: 'dispatches', title: 'DISPATCHES', badge, summary, lines }
}

const URGENT: readonly CustomMark[] = ['failed', 'warn', 'stalled']

/**
 * Orders items so the ones a capped card shows come first: failed, warn and stalled items always
 * make the cut (up to `cap`), the rest of the cut goes to the first other items; each group keeps
 * the command's own order.
 */
export const visibleFirst = <T extends { mark: CustomMark }>(items: readonly T[], cap: number): T[] => {
  if (items.length <= cap) return [...items]
  const urgent = items.filter(i => URGENT.includes(i.mark)).slice(0, cap)
  const rest = items.filter(i => !urgent.includes(i))
  const chosen = new Set<T>([...urgent, ...rest.slice(0, cap - urgent.length)])
  return [...items.filter(i => chosen.has(i)), ...items.filter(i => !chosen.has(i))]
}

const customCard = (m: Model, view: Model['custom'][number], inner: number, maxItems: number): Card => {
  const loading = view.fetchedAt === null
  const failed = view.items.filter(i => i.mark === 'failed').length
  const waiting = view.items.some(i => i.mark === 'waiting')
  const lines: Line[] =
    view.error !== null
      ? [fitLine([{ text: `could not read: ${view.error}`, tone: 'critical' }], inner)]
      : loading
        ? [muted('loading...')]
        : view.items.length === 0
          ? [fitLine(muted(view.empty), inner)]
          : visibleFirst(view.items, maxItems).map(i =>
              timed(customMark(i.mark), i.text, { text: i.right, tone: i.mark === 'failed' ? 'critical' : 'muted' }, inner),
            )
  return {
    id: view.id,
    title: view.title,
    badge: badgeOf(view.items.length, failed, waiting ? 'warn' : 'muted'),
    summary: view.error !== null || loading || view.summary === '' ? (lines[0] ?? []) : fitLine([{ text: view.summary, tone: 'plain' }], inner),
    lines,
    maxLines: maxItems,
  }
}

const sessionCard = (m: Model, inner: number, timeZone: string): Card => {
  const s = m.session
  const up = s.startedAt === null ? '--' : duration(m.now - s.startedAt)
  const woke = s.wakeAt === null ? 'never' : clockTime(s.wakeAt, timeZone)
  return {
    id: 'session',
    title: 'SESSION',
    badge: [],
    summary: fitLine([{ text: `up ${up} · woke ${woke} · compacted ${s.compactCount}`, tone: 'plain' }], inner),
    lines: [
      fitLine([{ text: 'started ', tone: 'muted' }, { text: `${clockTime(s.startedAt, timeZone)} (up ${up})`, tone: 'plain' }], inner),
      fitLine(
        s.wakeAt === null
          ? muted('no wake yet')
          : [{ text: 'last wake ', tone: 'muted' }, { text: `${woke} ${cut(s.wakeText, 30)}`, tone: 'plain' }],
        inner,
      ),
      fitLine(
        [
          { text: 'compacted ', tone: 'muted' },
          { text: `${s.compactCount}${s.compactAt === null ? '' : `, last ${clockTime(s.compactAt, timeZone)}`}`, tone: 'plain' },
        ],
        inner,
      ),
    ],
  }
}

/** Data older than this is called stale: two refreshes missed. */
const STALE_DATA_MS = 150_000

/** When the cards' data was last read (not when the pane was drawn), flagged once it is stale. */
const footer = (m: Model, timeZone: string, refreshMs = 60_000): Line => {
  const reads = [m.dispatches.isEnabled ? m.dispatches.fetchedAt : null, ...m.custom.map(c => c.fetchedAt)].filter(
    (t): t is number => t !== null,
  )
  const at = reads.length > 0 ? Math.max(...reads) : null
  const isStale = at !== null && m.now - at > STALE_DATA_MS
  return [
    { text: `updated ${at === null ? clockTime(m.now, timeZone) : clockTime(at, timeZone)}`, tone: isStale ? 'warn' : 'muted' },
    ...(isStale ? [{ text: ` (stale, ${duration(m.now - at)} old)`, tone: 'warn' as Tone }] : []),
    { text: ` · refresh ${Math.round(refreshMs / 1000)}s`, tone: 'muted' },
  ]
}

/** Every visible card, in order: INBOX, RUNNING, DISPATCHES (when configured), the custom cards, SESSION. */
export const paneDoc = (m: Model, bodyColumns: number, timeZone: string, opts: PaneOptions): PaneDoc => {
  const inner = cardInner(bodyColumns)
  const width = Math.max(20, bodyColumns)
  const limit = (card: Card): Card => (opts.rows[card.id] === undefined ? card : { ...card, maxLines: opts.rows[card.id] })
  const all = [
    limit(inboxCard(m, inner)),
    limit(runningCard(m, inner)),
    ...(m.dispatches.isEnabled ? [dispatchCard(m, inner, timeZone, opts.rows['dispatches'] ?? RECENT_DEFAULT)] : []),
    ...m.custom.map(view => limit(customCard(m, view, inner, opts.customMaxItems))),
    limit(sessionCard(m, inner, timeZone)),
  ]
  const hidden = all.filter(card => opts.hidden.includes(card.id)).map(card => card.id)
  return {
    head: headLines(m, inner, timeZone),
    cards: all.filter(card => !hidden.includes(card.id)),
    footer: [
      ...(hidden.length > 0 ? [fitLine(muted(`hidden: ${hidden.join(', ')}`), width)] : []),
      fitLine(footer(m, timeZone, opts.refreshMs), width),
    ],
  }
}

/** A card's title row after its toggle: the title on the left, its badge on the right. */
export const cardTitle = (card: Card, inner: number): Line =>
  spread([{ text: ` ${card.title}`, tone: 'accent', bold: true }], card.badge, inner - 1)

// ---------- fitting the pane's height ----------

export type Placed = { card: Card; isOpen: boolean; body: Line[] }
export type Layout = { head: Line[]; cards: Placed[]; showFooter: boolean }

const moreLine = (hidden: number): Line => muted(`+${hidden} more`)

/** The first `keep` rows of `lines`, the last of them a `+N more` line when some are hidden. */
const shown = (lines: readonly Line[], keep: number): Line[] =>
  keep >= lines.length ? [...lines] : [...lines.slice(0, Math.max(0, keep - 1)), moreLine(lines.length - Math.max(0, keep - 1))]

/** Rows a round card takes: its border (2), its title row and its body. */
const CARD_FRAME = 3

/**
 * Lays the cards into `maxRows`: collapsed cards keep their one summary row; expanded ones show up
 * to their maxLines, then the longest is shortened a row at a time (down to one `+N more` row) until
 * everything fits, so every card's title row stays on screen. The footer goes last of all.
 */
export const layoutPane = (doc: PaneDoc, isOpen: (id: string) => boolean, maxRows: number): Layout => {
  const open = doc.cards.map(card => isOpen(card.id))
  const keep = doc.cards.map((card, i) =>
    !open[i] ? 1 : card.maxLines !== undefined && card.lines.length > card.maxLines ? card.maxLines + 1 : card.lines.length,
  )
  let showFooter = true
  const total = (): number =>
    2 + doc.head.length + keep.reduce((sum, k) => sum + CARD_FRAME + Math.max(1, k), 0) + (showFooter ? doc.footer.length : 0)
  while (total() > maxRows) {
    let longest = -1
    keep.forEach((k, i) => {
      if (open[i] && k > 1 && (longest === -1 || k > (keep[longest] ?? 0))) longest = i
    })
    if (longest === -1) {
      if (!showFooter) break
      showFooter = false
      continue
    }
    keep[longest] = (keep[longest] ?? 1) - 1
  }
  return {
    head: doc.head,
    cards: doc.cards.map((card, i) => ({
      card,
      isOpen: open[i] === true,
      body: open[i] ? shown(card.lines, keep[i] ?? 1) : [card.summary],
    })),
    showFooter,
  }
}
