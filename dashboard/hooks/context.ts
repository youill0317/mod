import type { LogEntry, Notes, PaneSize, PlanItem, RunningItem, Summary, WaitingItem } from '../types'
import { mask, truncate } from './text'
import { parseView } from './view'

// What the dashboard model reads, gathered without the main Claude doing
// anything: the conversation itself, the subagents' conversations, Claude's
// own plan, the working copy, what the person asked the dashboard to look at,
// and the model's own notes from before. Pure functions; register.tsx reads
// the session and calls them.

/** A message of the conversation as `$.session.messages()` gives it, the parts read here. */
export type Message = {
  role: 'user' | 'assistant'
  text: string
  toolUses?: readonly { tool: string; input: Record<string, unknown>; text?: string; isError?: true }[]
}

// How much of the conversation one call reads: all of it, cut in the middle,
// the first time (the notes start from it), and what is new after that.
export const FIRST_BUDGET = 60_000
export const NEXT_BUDGET = 16_000
export const AGENT_BUDGET = 3_000
const NOTES_MAX = 2_000

/**
 * The conversation as lines the model reads: what the person wrote, what
 * Claude said, and each tool call with how it ended. Harness markup is taken
 * out and secrets hidden; within `budget` characters, the start and the end
 * are kept and the middle says how much it left out.
 */
export function condense(messages: readonly Message[], budget: number, offset = 0): string {
  const blocks = messages.map((message, i) => messageText(message, offset + i)).filter(block => block !== '')
  return fitText(blocks, budget)
}

function messageText(message: Message, index: number): string {
  const lines: string[] = []
  const text = plain(message.text)
  if (message.role === 'user') {
    if (text !== '') lines.push(`[${index}] 사용자: ${cut(text, 1_500)}`)
  } else {
    if (text !== '') lines.push(`[${index}] Claude: ${cut(text, 1_200)}`)
    for (const use of message.toolUses ?? []) {
      const result = use.text === undefined ? '(실행 중)' : `${use.isError === true ? '실패: ' : ''}${cut(plain(use.text), 200)}`
      lines.push(`  ↳ ${use.tool} ${cut(inputText(use.tool, use.input), 160)} → ${result}`)
    }
  }
  return mask(lines.join('\n'))
}

// A tool's input as one short line: what it was asked to do, not its whole payload.
function inputText(tool: string, input: Record<string, unknown>): string {
  const pick = (key: string) => (typeof input[key] === 'string' ? (input[key] as string) : '')
  if (tool === 'Bash') return [pick('description'), pick('command')].filter(Boolean).join(' · ')
  if (tool === 'TodoWrite' && Array.isArray(input.todos)) return `할 일 ${input.todos.length}개`
  for (const key of ['file_path', 'notebook_path', 'description', 'subject', 'query', 'url', 'pattern', 'prompt']) {
    const value = pick(key)
    if (value !== '') return value
  }
  return ''
}

// System reminders and other harness markup are not what anyone said.
function plain(text: string): string {
  return text
    .replace(/<(system-reminder|command-[a-z-]+|local-command-[a-z-]+)>[\s\S]*?<\/\1>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/** Blocks joined within `budget`: the first quarter and the rest from the end, the middle counted. */
export function fitText(blocks: readonly string[], budget: number): string {
  const whole = blocks.join('\n')
  if (whole.length <= budget) return whole
  const head: string[] = []
  let used = 0
  for (const block of blocks) {
    if (used + block.length + 1 > budget / 4) break
    head.push(block)
    used += block.length + 1
  }
  const tail: string[] = []
  for (let i = blocks.length - 1; i >= head.length; i--) {
    const block = blocks[i]!
    if (used + block.length + 1 > budget - 40) break
    tail.unshift(block)
    used += block.length + 1
  }
  const skipped = blocks.length - head.length - tail.length
  // One block longer than the whole budget: its end is what matters.
  if (head.length === 0 && tail.length === 0) return `…${blocks[blocks.length - 1]!.slice(-(budget - 1))}`
  return [...head, `… (중간 ${skipped}개 생략) …`, ...tail].join('\n')
}

// ── Claude's plan, read off its todo and task tools ─────────────────────────

const STATUSES = ['pending', 'in_progress', 'completed'] as const

/**
 * The plan after one of Claude's own planning calls: TodoWrite writes the
 * whole list, TaskCreate adds a step, TaskUpdate changes or deletes one.
 * Anything else leaves it as it was.
 */
export function nextPlan(plan: readonly PlanItem[], tool: string, input: Record<string, unknown>, result: unknown): PlanItem[] {
  const statusOf = (value: unknown) => STATUSES.find(one => one === value)
  if (tool === 'TodoWrite' && Array.isArray(input.todos)) {
    return input.todos
      .map(o => (typeof o === 'object' && o !== null ? (o as Record<string, unknown>) : {}))
      .map((todo, i) => ({ id: `todo-${i}`, text: typeof todo.content === 'string' ? todo.content : '', status: statusOf(todo.status) ?? 'pending' }))
      .filter(item => item.text !== '')
      .slice(0, 40)
  }
  if (tool === 'TaskCreate') {
    const task = (result as { task?: { id?: unknown } } | undefined)?.task
    const id = typeof task?.id === 'string' ? task.id : typeof task?.id === 'number' ? String(task.id) : `task-${plan.length + 1}`
    const text = typeof input.subject === 'string' ? input.subject : ''
    return text === '' ? [...plan] : [...plan.filter(item => item.id !== id), { id, text, status: 'pending' as const }].slice(-40)
  }
  if (tool === 'TaskUpdate' && (typeof input.taskId === 'string' || typeof input.taskId === 'number')) {
    const id = String(input.taskId)
    if (input.status === 'deleted') return plan.filter(item => item.id !== id)
    return plan.map(item =>
      item.id === id
        ? { ...item, text: typeof input.subject === 'string' && input.subject !== '' ? input.subject : item.text, status: statusOf(input.status) ?? item.status }
        : item,
    )
  }
  return [...plan]
}

/** The plan as one log line: how far along, and the step now. */
export function planLine(plan: readonly PlanItem[]): string {
  const done = plan.filter(item => item.status === 'completed').length
  const now = plan.find(item => item.status === 'in_progress')
  return `계획 갱신: ${done}/${plan.length} 완료${now === undefined ? '' : `, 지금: ${now.text}`}`
}

// ── The model's prompt ──────────────────────────────────────────────────────

export type Gathered = {
  size: PaneSize | null
  /** What the person asked the dashboard to look at. */
  hint: string
  notes: Notes | null
  /** Notes an earlier session of this project left, only until this one has its own. */
  earlier: string
  plan: readonly PlanItem[]
  runs: readonly RunningItem[]
  waits: readonly WaitingItem[]
  /** Each running subagent's conversation, condensed. */
  agents: readonly { label: string; text: string }[]
  /** git and background logs, already read. */
  workspace: string
  /** The project's README or CLAUDE.md head, the first time only. */
  project: string
  log: readonly LogEntry[]
  /** The conversation the notes have not taken in yet, condensed. */
  conversation: string
  /** Whether the conversation was compacted since the notes last read it. */
  compacted: boolean
  previous: Summary | null
  at: number
}

/** What the dashboard model reads, section by section; an empty one is left out. */
export function promptFor(g: Gathered, ageText: (ms: number) => string): string {
  const covered = g.previous?.covers ?? 0
  const section = (title: string, body: string) => (body.trim() === '' ? '' : `## ${title}\n${body.trim()}`)
  return [
    g.size === null ? '' : `## 창\n가로 ${g.size.columns}칸, 세로 ${g.size.rows}줄. 위쪽 몇 줄은 mod가 쓴다.`,
    section('사용자가 대시보드에 바라는 것 (가장 우선)', mask(g.hint)),
    section('지금까지의 노트 (네가 지난번에 쓴 것)', g.notes?.text ?? ''),
    g.notes === null ? section('이 프로젝트의 지난 세션 노트 (참고만, 지금 작업과 다를 수 있다)', g.earlier) : '',
    section('프로젝트 소개', g.project),
    section(
      'Claude의 계획 (Claude가 직접 쓴 할 일 목록)',
      g.plan.map(item => `${item.status === 'completed' ? '[완료]' : item.status === 'in_progress' ? '[진행]' : '[대기]'} ${mask(item.text)}`).join('\n'),
    ),
    section(
      '지금 돌아가는 것 (mod가 위에 따로 보여 준다)',
      g.runs.map(item => `${item.kind === 'agent' ? '서브 에이전트' : item.background ? '백그라운드 셸' : '셸'} ${mask(item.label)} (${ageText(g.at - item.startedAt)}째)`).join('\n'),
    ),
    section('사용자를 기다리는 것 (mod가 위에 따로 보여 준다)', g.waits.map(item => mask(item.label)).join('\n')),
    section('서브 에이전트의 대화', g.agents.map(agent => `### ${mask(agent.label)}\n${agent.text}`).join('\n')),
    section('작업 폴더', g.workspace),
    section(
      '기록 (시간 표시에 쓰는 번호, 오래된 것부터)',
      g.log.map(entry => `#${entry.id} ${ageText(g.at - entry.at)} 전${entry.id > covered ? ' (새)' : ''} ${entry.text}`).join('\n'),
    ),
    section(
      g.notes === null ? '대화 (처음부터, 길면 중간 생략)' : '노트 이후의 새 대화',
      `${g.compacted ? '(대화가 압축되었다: 첫 메시지가 그 요약이다)\n' : ''}${g.conversation}`,
    ),
    g.previous === null || g.previous.view.length === 0 ? '' : section('지난번 화면', JSON.stringify(g.previous.view)),
  ]
    .filter(line => line !== '')
    .join('\n\n')
}

/** The model's answer as notes and a summary, or undefined when it is not one. */
export function parseAnswer(text: string): { notes: string; summary: Omit<Summary, 'covers' | 'fit'> } | undefined {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return undefined
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
  } catch {
    return undefined
  }
  const line = (value: unknown, max: number) => (typeof value === 'string' ? truncate(value.replace(/\s+/g, ' ').trim(), max) : '')
  const notes = typeof raw.notes === 'string' ? raw.notes.trim().slice(0, NOTES_MAX) : ''
  return { notes, summary: { now: line(raw.now, 60), ask: line(raw.ask, 80), view: parseView(raw.view) } }
}
