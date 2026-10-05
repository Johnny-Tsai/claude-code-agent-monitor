// The band above the prompt, and the pieces both views share (see pane.ts for the pane).
// Neither computes a figure or a threshold: both read the Model, and both take their status
// symbols and colors from statusMark/levelMark below, so the two always agree.
import { cut, displayWidth, duration, truncateWidth } from './logic'
import type { Level, Model, Status } from './model'

/**
 * Every non-ASCII character either view may draw. Terminal fonts (PuTTY's included) have these;
 * anything else risks a box glyph. The round card borders are drawn by the surface, listed too.
 */
export const SYMBOLS = '●✓✗◌–·│─┊╭╮╰╯'

/** The card toggles: ASCII, so every font has them. */
export const TOGGLE = { expanded: '-', collapsed: '+' } as const

/** Color roles; textProps maps them to named terminal colors only. */
export type Tone = 'accent' | 'ok' | 'warn' | 'critical' | 'muted' | 'plain'
export type Run = { text: string; tone: Tone; bold?: boolean }
export type Line = Run[]

export const textProps = (run: Run): { color?: string; dimColor?: boolean; bold?: boolean } => {
  const bold = run.bold === true ? { bold: true } : {}
  switch (run.tone) {
    case 'accent':
      return { color: 'cyan', ...bold }
    case 'ok':
      return { color: 'green', ...bold }
    case 'warn':
      return { color: 'yellow', ...bold }
    case 'critical':
      return { color: 'red', ...bold }
    case 'muted':
      return { dimColor: true, ...bold }
    default:
      return bold
  }
}

// ---------- the one symbol and color table ----------

export const statusMark = (status: Status): Run => {
  switch (status) {
    case 'running':
      return { text: '●', tone: 'ok' }
    case 'stalled':
      return { text: '◌', tone: 'warn' }
    case 'done':
      return { text: '✓', tone: 'muted' }
    case 'failed':
    case 'rejected':
      return { text: '✗', tone: 'critical' }
    case 'cancelled':
      return { text: '–', tone: 'muted' }
    default:
      return { text: '·', tone: 'muted' }
  }
}

export const levelTone = (level: Level): Tone => (level === 'error' ? 'critical' : level === 'warning' ? 'warn' : 'ok')

/** A dot colored by severity; a gray middle dot when there is nothing to show. */
export const levelMark = (level: Level, isEmpty: boolean): Run =>
  isEmpty ? { text: '·', tone: 'muted' } : { text: '●', tone: levelTone(level) }

/** A count colored by state: gray at zero. */
export const count = (n: number, tone: Tone): Run => ({ text: String(n), tone: n === 0 ? 'muted' : tone, bold: n > 0 })

const lineWidth = (line: Line): number => line.reduce((w, r) => w + displayWidth(r.text), 0)

/** Cuts a line to `width` cells, the last run that does not fit ending in `~`. */
export const fitLine = (line: Line, width: number): Line => {
  const out: Line = []
  let left = width
  for (const run of line) {
    const w = displayWidth(run.text)
    if (w <= left) {
      out.push(run)
      left -= w
      continue
    }
    if (left > 0) out.push({ ...run, text: truncateWidth(run.text, left) })
    break
  }
  return out
}

/** `left` then `right` pushed to the far edge; the left side gives way when they do not both fit. */
export const spread = (left: Line, right: Line, width: number): Line => {
  const rw = lineWidth(right)
  const fittedLeft = fitLine(left, Math.max(0, width - rw - 1))
  const gap = Math.max(1, width - lineWidth(fittedLeft) - rw)
  return fitLine([...fittedLeft, { text: ' '.repeat(gap), tone: 'plain' }, ...right], width)
}

export const replyText = (ms: number | null): string =>
  ms === null ? 'no reply yet' : ms < 60_000 ? 'replied just now' : `replied ${duration(ms)} ago`

/** The restart warning shared by the band and the pane's overview; none under the warning line. */
export const restartRun = (m: Model): Run | null =>
  m.context === null || m.context.level === 'normal'
    ? null
    : { text: m.context.level === 'error' ? 'restart now' : 'restart soon', tone: levelTone(m.context.level), bold: true }

// ---------- the band ----------

export type Segment = { key: 'inbox' | 'now' | 'context' | 'reply'; runs: Line }

export const SEPARATOR: Run = { text: '  │  ', tone: 'muted' }

/**
 * The band's segments. With the pane closed: INBOX, NOW, the restart warning (only past the
 * warning line) and the last reply. With the pane open the pane says the rest, so the band keeps
 * only what is past a threshold; nothing past one means no band at all (an empty list).
 */
export const bandSegments = (m: Model, isPaneOpen: boolean): Segment[] => {
  const [oldest] = m.inbox.groups
  const inbox: Segment = {
    key: 'inbox',
    runs: [
      levelMark(m.inbox.level, m.inbox.total === 0),
      { text: ' INBOX ', tone: 'plain', bold: true },
      count(m.inbox.total, levelTone(m.inbox.level)),
      ...(oldest === undefined
        ? []
        : [
            { text: `  ${oldest.label} `, tone: 'plain' as Tone },
            { text: duration(oldest.waitedMs), tone: levelTone(oldest.level) },
            ...(m.inbox.groups.length > 1 ? [{ text: ` +${m.inbox.groups.length - 1}ch`, tone: 'muted' as Tone }] : []),
          ]),
    ],
  }
  const [first] = m.actions
  const now: Segment = {
    key: 'now',
    runs:
      first === undefined
        ? [statusMark('idle'), { text: ' NOW ', tone: 'plain', bold: true }, { text: 'idle', tone: 'muted' }]
        : [
            levelMark(first.level, false),
            { text: ' NOW  ', tone: 'plain', bold: true },
            { text: `${cut(first.label, 28)} `, tone: 'plain' },
            { text: duration(first.elapsedMs), tone: levelTone(first.level) },
            ...(m.actions.length > 1 ? [{ text: ` +${m.actions.length - 1}`, tone: 'muted' as Tone }] : []),
          ],
  }
  const restart = restartRun(m)
  const context: Segment | null =
    restart === null ? null : { key: 'context', runs: [{ text: '●', tone: restart.tone }, { text: ' ', tone: 'plain' }, restart] }
  if (isPaneOpen) {
    return [
      ...(m.inbox.level !== 'normal' ? [inbox] : []),
      ...(first !== undefined && first.level !== 'normal' ? [now] : []),
      ...(context === null ? [] : [context]),
    ]
  }
  return [inbox, now, ...(context === null ? [] : [context]), { key: 'reply', runs: [{ text: replyText(m.lastReplyAgoMs), tone: 'muted' }] }]
}

/** The band as one line within `width`: segments drop from the right (last reply, restart, NOW); the first always stays. */
export const bandLine = (segments: readonly Segment[], width: number): Line => {
  const kept = [...segments]
  const join = (list: readonly Segment[]): Line => [
    { text: ' ', tone: 'plain' },
    ...list.flatMap((s, i) => (i > 0 ? [SEPARATOR, ...s.runs] : s.runs)),
  ]
  while (kept.length > 1 && lineWidth(join(kept)) > width) kept.pop()
  return fitLine(join(kept), width)
}
