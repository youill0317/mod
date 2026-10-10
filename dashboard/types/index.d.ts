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

/** What the small model wrote, from the log. */
export type Summary = {
  title: string
  now: string
  steps: { from: number; text: string }[]
  checks: { label: string; value: string; from: number }[]
  blocked: string[]
  next: string
  waiting: string
  /** The last log id this summary covers. */
  covers: number
  at: number
}

declare module 'claude-code' {
  interface PluginState {
    dashboard: {
      log: LogEntry[]
      running: RunningItem[]
      waiting: WaitingItem[]
      summary: Summary | null
      phase: string
      lastSeen: number
      now: number
    }
  }
}
