/** One thing that happened in the session, as the dashboard keeps it. */
export type LogEntry = {
  id: number
  at: number
  kind:
    | 'prompt'
    | 'signal'
    | 'shell'
    | 'shell-done'
    | 'shell-failed'
    | 'background-done'
    | 'agent'
    | 'agent-done'
    | 'agent-failed'
    | 'edit'
    | 'tool'
    | 'permission'
    | 'question'
    | 'answer'
  text: string
}

/** A shell or a subagent that is running now. */
export type RunningItem = {
  id: string
  kind: 'shell' | 'agent'
  label: string
  startedAt: number
  background: boolean
  /** The background task's id, to end it when its notification arrives. */
  taskId: string | null
  /** A subagent's latest step. */
  last: string
}

/** Something that waits on the person. */
export type WaitingItem = {
  id: string
  kind: 'permission' | 'question'
  label: string
  since: number
}

/** A bar's color, as the small model gives it. */
export type Tone = 'normal' | 'good' | 'warn' | 'bad'

/** A node's state, drawn as its border and symbol. */
export type NodeState = 'done' | 'now' | 'todo' | 'failed' | 'wait'

/** A step that hangs under a stage: a failure, a retry, a wait, a side task. */
export type GraphBranch = { label: string; state: NodeState; note: string; back: boolean }

/** One stage of the work's main path, with what hangs under it; `from` is the log entry it began at. */
export type GraphNode = { label: string; state: NodeState; note: string; branches: GraphBranch[]; from: number }

/** A diagram below the top lines; `from` is the log entry a stage began or a value was seen at, 0 for none. */
export type SummaryBlock =
  | { kind: 'graph'; nodes: GraphNode[] }
  | { kind: 'bars'; items: { label: string; value: number; max: number; tone: Tone; from: number }[] }
  /** The graph's stages on one time axis, measured from the log entries they began at. */
  | { kind: 'time'; items: { label: string; state: NodeState; from: number }[] }

/** What the small model drew from the log. */
export type Summary = {
  /** The work now, the first line at the top. */
  now: string
  /** Most important first: what does not fit the pane is cut from the end. */
  blocks: SummaryBlock[]
  /** The last log id this summary covers. */
  covers: number
  at: number
  /** The pane size class it was laid out for (fitOf); another one lays it out again. */
  fit: string
}

/** The pane's body as last drawn: cells across, rows down. */
export type PaneSize = { columns: number; rows: number }

declare module 'claude-code' {
  interface PluginState {
    dashboard: {
      log: LogEntry[]
      running: RunningItem[]
      waiting: WaitingItem[]
      summary: Summary | null
      phase: string
      /** What Claude said the person must decide, until they write. */
      ask: string
      now: number
      pane: PaneSize | null
    }
  }
}
