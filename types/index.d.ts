/** One channel message waiting for a reply. */
export type Pending = {
  key: string
  /** The channel server's name, as the delivery names it (e.g. plugin:discord:discord). */
  server: string
  /** The chat inside that server; '' when the message carries none. */
  chatId: string
  at: number
  isAlerted: boolean
}

/** One tool call in flight. */
export type Action = { id: string; tool: string; label: string; startedAt: number }

/** The last context measurement, and whether this crossing of the warning line was announced. */
export type ContextMark = { percent: number | null; isAlerted: boolean }

export type DispatchState = 'running' | 'stalled' | 'done' | 'failed' | 'cancelled' | 'rejected'

/** One external dispatch, paired from its events. */
export type DispatchRow = {
  runtime: string
  id: string
  startedAt: number | null
  endedAt: number | null
  /** The last start or heartbeat event. */
  lastSeenAt: number | null
  state: DispatchState
  summary: string
}

export type DispatchView = { rows: DispatchRow[]; error: string | null; fetchedAt: number | null }

/** One subagent of this session. */
export type AgentRun = {
  id: string
  description: string
  startedAt: number
  endedAt: number | null
  isBackground: boolean
  /** A background agent's id (from an async_launched result), matched against $.agent.list(). */
  agentId: string | null
  status: string | null
}

export type CustomMark = 'running' | 'stalled' | 'done' | 'failed' | 'idle' | 'waiting' | 'warn' | 'none'

/** One custom card's last read: the command's JSON, or why it could not be read. */
export type CustomView = {
  id: string
  title: string
  summary: string
  items: { mark: CustomMark; text: string; right: string }[]
  empty: string
  error: string | null
  fetchedAt: number | null
}

/** What the SESSION card shows. */
export type SessionInfo = {
  startedAt: number | null
  wakeAt: number | null
  wakeText: string
  compactCount: number
  compactAt: number | null
}

declare module 'claude-code' {
  interface PluginState {
    'agent-monitor': {
      pending: Pending[]
      seen: string[]
      lastReplyAt: number | null
      actions: Action[]
      tick: number
      context: ContextMark
      dispatch: DispatchView
      agents: AgentRun[]
      custom: CustomView[]
      session: SessionInfo
      /** Card id -> expanded; mirrored to $.store so it survives sessions. */
      expanded: Record<string, boolean>
      /** Card ids hidden with /monitor hide; mirrored to $.store. */
      hidden: string[]
      /** Card id -> most items listed when expanded (/monitor rows); mirrored to $.store. */
      rows: Record<string, number>
    }
  }
}
