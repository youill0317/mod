/** One foreground shell command that is running now. */
export type RunningShell = {
  /** The tool call's id. */
  id: string
  /** The subagent that runs it; null for the main Claude. */
  agentId: string | null
  /** What is shown: Claude's own description first, then the Korean memo. */
  memo: string
}

declare module 'claude-code' {
  interface PluginState {
    'shell-memo': {
      running: RunningShell[]
      subagents: string[]
    }
  }
}
