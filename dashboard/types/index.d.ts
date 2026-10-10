/** Any value the state can hold. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

/** How an item looks: its color on screen. */
export type Tone = 'normal' | 'good' | 'warn' | 'bad' | 'muted' | 'accent'

/** Where a live value is read from, again on every refresh: exactly one of the three. */
export type Source = {
  /** A command run without a shell, its standard output read. Needs the person's approval. */
  command?: string[]
  /** A text file, relative to the working directory or absolute. */
  file?: string
  /** A URL fetched with GET. */
  url?: string
}

/** Which part of a source an item shows. */
export type Pick = {
  /** The source's id in `sources`. */
  source: string
  /** A path into the source's JSON, like `runs.0.loss` or `runs[0].loss`. */
  path?: string
  /** A regular expression over the source's text: its first group, or the whole match. */
  regex?: string
}

export type Item =
  | { kind: 'text'; text?: string; from?: Pick; tone?: Tone }
  | { kind: 'stat'; label: string; value?: string | number; from?: Pick; unit?: string; tone?: Tone }
  | { kind: 'progress'; label: string; current?: number; total?: number; from?: Pick; totalFrom?: Pick }
  | { kind: 'sparkline'; label: string; values?: number[]; from?: Pick }
  | { kind: 'status'; label: string; state?: string; detail?: string; from?: Pick }
  | { kind: 'table'; columns: string[]; rows?: (string | number)[][]; from?: Pick }
  | { kind: 'agents' }

export type Section = { title?: string; items: Item[] }

/** The dashboard Claude designs. */
export type Dashboard = {
  title: string
  refreshSeconds?: number
  sources?: Record<string, Source>
  sections: Section[]
}

/** One subagent as the dashboard tracks it. */
export type AgentRow = {
  id: string
  type: string
  description: string
  startedAt: number
  endedAt: number | null
  tools: number
  last: string
  status: 'running' | 'done' | 'failed'
}

declare module 'claude-code' {
  interface PluginState {
    dashboard: {
      spec: Dashboard | null
      /** Whether the person allowed the spec's commands to run. */
      approved: boolean
      /** Each source's last reading, parsed as JSON when it is JSON. */
      values: Record<string, Json>
      /** Each source's last error, by id. */
      errors: Record<string, string>
      /** Sparkline readings kept across refreshes, by item key. */
      history: Record<string, number[]>
      updatedAt: number | null
      now: number
      agents: AgentRow[]
    }
  }
}
