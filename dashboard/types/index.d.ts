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

/** A color the small model gives a row or an item. */
export type Tone = 'normal' | 'good' | 'warn' | 'bad' | 'muted'

/** A node's state, drawn as its border and symbol. */
export type NodeState = 'done' | 'now' | 'todo' | 'failed' | 'wait'

/** A step that hangs under a stage: a failure, a retry, a wait, a side task. */
export type GraphBranch = { label: string; state: NodeState; note: string; back: boolean }

/** One stage of the work's main path, with what hangs under it. */
export type GraphNode = { label: string; state: NodeState; note: string; branches: GraphBranch[] }

/** `from` is the log entry a value was seen in, 0 for none: the pane shows how long ago. */
export type SummaryBlock =
  | { kind: 'graph'; title: string; nodes: GraphNode[] }
  | { kind: 'table'; title: string; columns: string[]; rows: { cells: string[]; tone: Tone; from: number }[] }
  | { kind: 'bars'; title: string; items: { label: string; value: number; max: number; note: string; tone: Tone; from: number }[] }
  | { kind: 'metrics'; title: string; items: { label: string; value: string; tone: Tone; from: number }[] }
  | { kind: 'list'; title: string; items: { text: string; tone: Tone }[] }

/** What the small model wrote, from the log. */
export type Summary = {
  title: string
  now: string
  waiting: string
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
      now: number
      pane: PaneSize | null
    }
  }
}
