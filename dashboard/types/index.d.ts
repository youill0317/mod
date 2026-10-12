/** One foreground shell command that is running now, for the memo beside the spinner. */
export type RunningShell = {
  /** The tool call's id. */
  id: string
  /** The subagent that runs it; null for the main Claude. */
  agentId: string | null
  /** What is shown: Claude's own description first, then the Korean memo. */
  memo: string
}

/** One thing that happened in the session, as the dashboard keeps it: what the model cites for time. */
export type LogEntry = {
  id: number
  at: number
  kind:
    | 'prompt'
    | 'said'
    | 'plan'
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
    /** A prompt taken back with Esc before any answer: kept for its id, never shown to the model. */
    | 'withdrawn'
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
  /** Where a background shell writes, when the engine said: its tail is read for the model. */
  output?: string
}

/** Something that waits on the person. */
export type WaitingItem = {
  id: string
  kind: 'permission' | 'question'
  label: string
  since: number
}

/** One step of Claude's own plan (its todo list or tasks), as it last wrote it. */
export type PlanItem = {
  id: string
  text: string
  status: 'pending' | 'in_progress' | 'completed'
}

/** A color the model gives a piece of the view. */
export type Tone = 'normal' | 'dim' | 'accent' | 'good' | 'warn' | 'bad'

/**
 * The materials the model builds the view from: no diagram kinds, only pieces
 * it composes. Widths, wrapping and fitting the pane are the mod's.
 */
export type ViewNode =
  | { t: 'text'; v: string; tone: Tone; bold: boolean }
  | { t: 'row'; gap: number; c: ViewNode[] }
  | { t: 'col'; gap: number; c: ViewNode[] }
  | { t: 'box'; style: 'round' | 'bold' | 'dashed' | 'double'; tone: Tone; title: string; c: ViewNode[] }
  | { t: 'arrow'; dir: 'right' | 'left' | 'down' | 'up'; tone: Tone; label: string }
  | { t: 'bar'; value: number; max: number; tone: Tone; w: number }
  | { t: 'spark'; values: number[]; tone: Tone }
  | { t: 'table'; head: string[]; rows: string[][]; tone: Tone }
  | { t: 'rule'; tone: Tone }

/** What the dashboard model drew from the session. */
export type Summary = {
  /** The work now, the first line at the top. */
  now: string
  /** What the person must decide, as the model read it; '' for nothing. */
  ask: string
  /** Most important first: what does not fit the pane is cut from the end. */
  view: ViewNode[]
  /** The last log id this summary covers. */
  covers: number
  /** The pane size class it was laid out for (fitOf); another one lays it out again. */
  fit: string
}

/** The dashboard model's own notes on the work, so it needs no more than what is new. */
export type Notes = {
  text: string
  /** How many messages of the main conversation the notes have taken in. */
  upTo: number
  /** The last message taken in, to find it again once older ones scroll out or the conversation is compacted. */
  key: string
}

/** Where the dashboard's model stands: idle, reading the session now, or its last call failed and why. */
export type ModelStatus = { kind: 'idle' | 'reading' | 'failed'; reason: string; since: number }

/** The pane's body as last drawn: cells across, rows down. */
export type PaneSize = { columns: number; rows: number }

declare module 'claude-code' {
  interface PluginState {
    dashboard: {
      log: LogEntry[]
      running: RunningItem[]
      waiting: WaitingItem[]
      summary: Summary | null
      notes: Notes | null
      plan: PlanItem[]
      /** What the person asked the dashboard to look at (`/dashboard <words>`). */
      hint: string
      /** What the person must decide, until they write. */
      ask: string
      now: number
      pane: PaneSize | null
      /** Where the dashboard's model stands, shown while nothing else would say it. */
      status: ModelStatus
      /** The memo beside the spinner: the foreground shells running now. */
      shells: RunningShell[]
      /** Ids of the subagents seen, so a spinner's requestId tells its loop. */
      subagents: string[]
      /** Whether a person is at the prompt: a `-p` run or the SDK draws no spinner, so gets no memo. */
      interactive: boolean
    }
  }
}
