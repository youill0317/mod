import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, ToolCallResult } from 'claude-code'

import type { LogEntry, RunningItem, Summary, WaitingItem } from '../types'

const PANE = 'dashboard'
const SIGNAL = 'signal'
const SIGNAL_ID = 'mcp__dashboard__signal'

const log = atom({ plugin: 'dashboard', key: 'log' } as const, [])
const running = atom({ plugin: 'dashboard', key: 'running' } as const, [])
const waiting = atom({ plugin: 'dashboard', key: 'waiting' } as const, [])
const summary = atom({ plugin: 'dashboard', key: 'summary' } as const, null)
const phase = atom({ plugin: 'dashboard', key: 'phase' } as const, '')
const lastSeen = atom({ plugin: 'dashboard', key: 'lastSeen' } as const, 0)
const now = atom({ plugin: 'dashboard', key: 'now' } as const, 0)

const MAX_LOG = 300
const LOG_FOR_MODEL = 80
// The model is woken soon after a change that matters, later after routine ones.
const SOON_MS = 2_000
const LATER_MS = 20_000
const TICK_MS = 10_000

// Log kinds that wake the model soon: the work changed phase or waits on the person.
const URGENT: ReadonlySet<LogEntry['kind']> = new Set(['signal', 'answer', 'permission', 'question', 'agent-done', 'agent-failed', 'shell-failed', 'background-done'])

const SIGNAL_DESCRIPTION = [
  "Marks a change in the work's phase on the person's progress dashboard.",
  'Call it when a new phase starts, a major phase ends, the work is blocked, or a decision from the person is needed.',
  "One short line in the person's language. Do not call it for routine steps.",
].join(' ')

const SYSTEM = [
  '너는 Claude Code 작업의 진행 대시보드를 쓴다. 사용자가 자리를 비웠다 돌아와도 작업 맥락을 바로 파악하고, 자리에 있을 때도 전체 과정을 통제할 수 있게 돕는 것이 목적이다.',
  '결과물, 계획, 파일 내용은 쓰지 않는다. 작업이 어떻게 흘러왔고 지금 어디에 있는지만 쓴다.',
  'JSON 하나만 출력한다. 형식:',
  '{"title": "작업 이름, 15자 이내",',
  ' "now": "지금 하는 일 한 문장, 40자 이내",',
  ' "steps": [{"from": 기록 번호, "text": "30자 이내"}],  최신순, 최대 8개. 사소한 기록은 묶고 의미 있는 단계 전환만 남긴다. from은 그 단계를 보여 주는 기록의 번호.',
  ' "checks": [{"label": "...", "value": "...", "from": 기록 번호}],  기록의 출력에서 확인된 바깥 상태(학습 epoch, 손실값, 원격 세션 상태 등), 최대 4개, 없으면 [].',
  ' "blocked": ["막힌 것, 실패, 재시도 중인 것"],  없으면 [].',
  ' "next": "다음에 할 일로 보이는 것, 30자 이내, 모르면 빈 문자열",',
  ' "waiting": "Claude가 사용자의 답이나 결정을 기다리면 그 내용 30자 이내, 아니면 빈 문자열"}',
  '쉬운 한국어로 쓴다. 명령어나 경로는 꼭 필요할 때만 짧게 쓴다.',
].join('\n')

// Module state: it starts over on a reload.
let preferred = 'haiku'
let fallback: string | undefined
let timer: { cancel: () => void } | undefined
let timerAt = Number.POSITIVE_INFINITY
let busy = false
let again = false
// Calls in flight on the main loop, to tell which one a permission dialog is for.
const pending = new Map<string, { tool: string; key: string }>()

export const register: Register = (on, options) => {
  preferred = typeof options.model === 'string' && options.model !== '' ? options.model : 'haiku'

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'dashboard',
      description: '작업 과정 대시보드를 옆에 엽니다',
      argumentHint: '[refresh | close]',
    })
    await $.tool.register({
      name: SIGNAL,
      description: SIGNAL_DESCRIPTION,
      inputSchema: {
        type: 'object',
        required: ['phase'],
        properties: {
          phase: { type: 'string', description: 'The phase now, one short line.' },
          note: { type: 'string', description: 'Optional: what is blocked or what the person must decide.' },
        },
      },
      isDeferred: false,
    })
    // A reload loses the calls the old module was holding: they are no longer tracked.
    await update($, running, list => list.filter(item => item.kind === 'agent' || item.background))
    await update($, waiting, () => [])
    $.clock.every(TICK_MS, () => tick($))
    return next(e)
  })

  on('command.run', { command: 'dashboard' }, async ($, e) => {
    const ask = e.args.trim()
    if (ask === 'close') {
      await $.ui.close({ id: PANE })
      return { text: '대시보드를 닫았습니다.' }
    }
    await $.ui.open({ id: PANE, title: '작업 과정' })
    await update($, now, () => Date.now())
    $.clock.after(0, () => wake($, ask === 'refresh'))
    return { text: ask === 'refresh' ? '대시보드를 다시 정리합니다.' : '작업 과정 대시보드를 열었습니다.' }
  })

  // The signal is the dashboard's own bookkeeping: it never needs the person's yes.
  on('tool.check', { tool: SIGNAL_ID }, () => ({ decision: 'allow' }))

  on('tool.call', { tool: SIGNAL_ID }, async ($, e) => {
    const input = e as unknown as { phase?: unknown; note?: unknown }
    const said = typeof input.phase === 'string' ? input.phase.trim() : ''
    const note = typeof input.note === 'string' ? input.note.trim() : ''
    if (said !== '') await update($, phase, () => said)
    await record($, 'signal', note === '' ? said : `${said} (${note})`)
    return { result: '대시보드에 기록했습니다.' }
  })

  on('tool.call', async ($, e, next) => {
    if (e.tool.startsWith('mcp__dashboard__')) return next(e)

    const input = inputOf(e)
    const id = e.tool_use_id

    // A subagent's call: only its latest step is kept, on its row.
    if (e.agentId !== undefined) {
      const agentId = e.agentId
      const step = stepOf(e.tool, input)
      await update($, running, list => list.map(item => (item.id === agentId ? { ...item, last: step } : item)))
      return next(e)
    }

    pending.set(id, { tool: e.tool, key: stableKey(input) })
    try {
      if (e.tool === 'Bash') {
        const startedAt = await startShell($, id, input)
        const ran = await next(e)
        await endShell($, id, input, ran, startedAt)
        return ran
      }

      if (e.tool === 'AskUserQuestion') {
        const label = questionOf(input)
        const item: WaitingItem = { id, kind: 'question', label, since: Date.now() }
        await update($, waiting, list => [...list, item])
        await record($, 'question', `사용자에게 질문: ${label}`)
        return await next(e)
      }

      const ran = await next(e)
      const done = ran.deny === undefined && ran.isError !== true
      if (done && ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(e.tool)) await record($, 'edit', `파일 수정: ${baseName(input.file_path ?? input.notebook_path)}`)
      else if (done && (e.tool === 'WebSearch' || e.tool === 'WebFetch' || e.tool.startsWith('mcp__'))) await record($, 'tool', stepOf(e.tool, input))
      return ran
    } finally {
      pending.delete(id)
      await update($, waiting, list => list.filter(item => item.id !== id))
    }
  })

  // The dialog asks about one of the calls in flight: it now waits on the person.
  on('classic.PermissionRequest', async ($, e, next) => {
    const key = stableKey(e.tool_input)
    const same = [...pending.entries()].filter(([, call]) => call.tool === e.tool_name)
    const match = same.find(([, call]) => call.key === key) ?? (same.length === 1 ? same[0] : undefined)
    if (match !== undefined) {
      const [id] = match
      const label = stepOf(e.tool_name, (e.tool_input ?? {}) as Record<string, unknown>)
      const item: WaitingItem = { id, kind: 'permission', label, since: Date.now() }
      await update($, waiting, list => [...list.filter(one => one.id !== id), item])
      await record($, 'permission', `권한 요청: ${label}`)
    }
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    const agentId = started.agentId
    if (agentId !== undefined && e.workflow === undefined) {
      const row: RunningItem = { id: agentId, kind: 'agent', label: `${e.subagentType}: ${e.description}`, startedAt: Date.now(), background: e.background, taskId: null, last: '' }
      await update($, running, list => [...list.filter(item => item.id !== agentId), row])
      await record($, 'agent', `서브 에이전트 시작 (${e.subagentType}): ${e.description}`)
    }
    return started
  })

  on('turn.complete', async ($, e, next) => {
    const ended = await next(e)
    if (e.agentId !== undefined) {
      const agentId = e.agentId
      const row = (await read($, running)).find(item => item.id === agentId)
      if (row !== undefined) {
        await update($, running, list => list.filter(item => item.id !== agentId))
        const ok = e.reason === 'answer'
        await record($, ok ? 'agent-done' : 'agent-failed', `서브 에이전트 ${ok ? '끝남' : '멈춤'}: ${row.label}`)
      }
      return ended
    }
    // The main turn ended: nothing of it runs in the foreground any more.
    await update($, running, list => list.filter(item => item.kind === 'agent' || item.background))
    await record($, 'answer', `Claude의 답: ${excerpt(e.answer, 240)}`)
    return ended
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'composer') {
      await update($, lastSeen, () => Date.now())
      // The person is here: a dialog they answered is no longer waiting.
      await update($, waiting, list => list.filter(item => item.kind !== 'permission'))
      await record($, 'prompt', `사용자 요청: ${excerpt(e.text, 200)}`)
    } else if (e.origin.kind === 'task-notification') {
      const text = e.text
      const ended = (await read($, running)).filter(item => item.taskId !== null && text.includes(item.taskId))
      if (ended.length > 0) {
        await update($, running, list => list.filter(item => !ended.some(one => one.id === item.id)))
        for (const item of ended) await record($, 'background-done', `백그라운드 끝남: ${item.label}`)
      }
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const columns = Math.max(24, e.props.bodyColumns)
    const entries = await read($, log)
    const runs = await read($, running)
    const waits = await read($, waiting)
    const written = await read($, summary)
    const said = await read($, phase)
    const seen = await read($, lastSeen)
    const at = Math.max(await read($, now), Date.now())

    const byId = new Map(entries.map(entry => [entry.id, entry]))
    const missed = seen === 0 ? 0 : entries.filter(entry => entry.at > seen && entry.kind !== 'prompt').length
    const unwritten = entries.filter(entry => entry.id > (written?.covers ?? 0)).length
    const title = written?.title || '작업 과정'
    const head = missed > 0 ? `보신 뒤 +${missed}` : ''

    const steps =
      written !== null && written.steps.length > 0
        ? written.steps.map(step => ({ at: byId.get(step.from)?.at ?? written.at, text: step.text }))
        : entries
            .filter(entry => entry.kind !== 'prompt')
            .slice(-6)
            .reverse()
            .map(entry => ({ at: entry.at, text: entry.text }))
    const waitNote = written?.waiting ?? ''

    const heading = (text: string) => (
      <Text bold color="claude">
        {truncate(text, columns)}
      </Text>
    )

    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Text bold>{truncate(title, Math.max(8, columns - width(head) - 2))}</Text>
          <Text dimColor>{head === '' ? '' : `  ${head}`}</Text>
        </Box>
        <Text>{truncate(`지금  ${written?.now || said || '아직 기록이 없습니다'}`, columns)}</Text>

        <Box flexDirection="column" marginTop={1}>
          {heading('▸ 나를 기다리는 것')}
          {waits.length === 0 && waitNote === '' && <Text dimColor>  없음</Text>}
          {waits.map(item => (
            <Text color="warning">{truncate(`  ${item.kind === 'question' ? '질문' : '권한 요청'}: ${item.label}  ${ageText(at - item.since)}째`, columns)}</Text>
          ))}
          {waitNote !== '' && <Text color="warning">{truncate(`  ${waitNote}`, columns)}</Text>}
        </Box>

        <Box flexDirection="column" marginTop={1}>
          {heading('▸ 돌아가는 것')}
          {runs.length === 0 && <Text dimColor>  없음</Text>}
          {runs.map(item => {
            const kind = item.kind === 'agent' ? '서브 에이전트' : item.background ? '백그라운드 셸' : '셸'
            const age = `  ${ageText(at - item.startedAt)}`
            return (
              <Box flexDirection="column">
                <Box flexDirection="row">
                  <Text color="suggestion">{truncate(`  ● ${kind}  ${item.label}`, Math.max(8, columns - width(age)))}</Text>
                  <Text dimColor>{age}</Text>
                </Box>
                {item.last !== '' && <Text dimColor>{truncate(`      ${item.last}`, columns)}</Text>}
              </Box>
            )
          })}
        </Box>

        <Box flexDirection="column" marginTop={1}>
          {heading(missed > 0 ? '▸ 지나온 단계  ★ 자리 비운 사이' : '▸ 지나온 단계')}
          {steps.length === 0 && <Text dimColor>  없음</Text>}
          {steps.map(step => {
            const mark = seen !== 0 && step.at > seen ? '★' : ' '
            return <Text>{truncate(`  ${mark} ${pad(ageText(at - step.at) + ' 전', 9)} ${step.text}`, columns)}</Text>
          })}
        </Box>

        {written !== null && written.checks.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            {heading('▸ 확인한 상태')}
            {written.checks.map(check => (
              <Text>{truncate(`  ${check.label}  ${check.value}  (확인 ${ageText(at - (byId.get(check.from)?.at ?? written.at))} 전)`, columns)}</Text>
            ))}
          </Box>
        )}

        <Box flexDirection="column" marginTop={1}>
          {heading('▸ 막힌 것')}
          {(written?.blocked ?? []).length === 0 ? <Text dimColor>  없음</Text> : (written?.blocked ?? []).map(text => <Text color="error">{truncate(`  ${text}`, columns)}</Text>)}
        </Box>

        <Box flexDirection="column" marginTop={1}>
          {heading('▸ 다음')}
          <Text dimColor={!written?.next}>{truncate(`  ${written?.next || '아직 모름'}`, columns)}</Text>
        </Box>

        <Box marginTop={1}>
          <Text dimColor>
            {truncate(
              written === null ? '아직 정리 전입니다' : `${ageText(at - written.at)} 전 정리${unwritten > 0 ? ` · 새 기록 ${unwritten}개 정리 대기` : ''}`,
              columns,
            )}
          </Text>
        </Box>
      </Box>
    )
  })
}

// ── Recording and waking the model ──────────────────────────────────────────

async function record($: EngineInterface, kind: LogEntry['kind'], text: string) {
  const at = Date.now()
  await update($, log, list => [...list, { id: (list[list.length - 1]?.id ?? 0) + 1, at, kind, text: excerpt(text, 300) }].slice(-MAX_LOG))
  if (URGENT.has(kind)) await schedule($, SOON_MS)
  else if (await paneShown($)) await schedule($, LATER_MS)
}

async function schedule($: EngineInterface, ms: number) {
  const due = Date.now() + ms
  if (timer !== undefined && timerAt <= due) return
  timer?.cancel()
  timerAt = due
  timer = $.clock.after(ms, () => {
    timer = undefined
    timerAt = Number.POSITIVE_INFINITY
    return summarize($)
  })
}

async function wake($: EngineInterface, force: boolean) {
  if (force) await update($, summary, old => (old === null ? old : { ...old, covers: 0 }))
  await summarize($)
}

async function paneShown($: EngineInterface): Promise<boolean> {
  try {
    return (await $.ui.panes()).some(pane => pane.id === PANE && pane.isShown)
  } catch {
    // Where no surface lists panes, nothing is shown: the log still keeps going.
    return false
  }
}

async function tick($: EngineInterface) {
  const busyNow = (await read($, running)).length > 0 || (await read($, waiting)).length > 0
  if (busyNow && (await paneShown($))) await update($, now, () => Date.now())
}

async function summarize($: EngineInterface) {
  if (busy) {
    again = true
    return
  }
  busy = true
  try {
    const entries = await read($, log)
    const previous = await read($, summary)
    const newest = entries[entries.length - 1]?.id ?? 0
    if (newest === 0 || (previous !== null && previous.covers >= newest)) return

    const prompt = promptFor(entries.slice(-LOG_FOR_MODEL), previous, await read($, running), await read($, waiting), await read($, phase), Date.now())
    const text = await complete($, prompt)
    if (text === undefined) return
    const written = parseSummary(text, new Set(entries.map(entry => entry.id)))
    if (written === undefined) return
    await update($, summary, () => ({ ...written, covers: newest, at: Date.now() }))
  } finally {
    busy = false
    if (again) {
      again = false
      await schedule($, SOON_MS)
    }
  }
}

async function complete($: EngineInterface, prompt: string): Promise<string | undefined> {
  const ask = (model: string) => $.model.complete({ model, system: SYSTEM, prompt, maxTokens: 900, effort: 'low', timeoutMs: 30_000 })
  let answer
  try {
    answer = await ask(fallback ?? preferred)
  } catch {
    // The organization may not allow the preferred model: use the session's.
    if (fallback !== undefined) return undefined
    fallback = await $.session.model()
    answer = await ask(fallback)
  }
  return answer.isAnswered ? answer.text : undefined
}

async function startShell($: EngineInterface, id: string, input: Record<string, unknown>): Promise<number> {
  const label = shellLabel(input)
  const background = input.run_in_background === true
  const startedAt = Date.now()
  const item: RunningItem = { id, kind: 'shell', label, startedAt, background, taskId: null, last: '' }
  await update($, running, list => [...list, item])
  await record($, 'shell', `${background ? '백그라운드 셸 시작' : '셸 실행'}: ${label}`)
  return startedAt
}

async function endShell($: EngineInterface, id: string, input: Record<string, unknown>, ran: ToolCallResult, startedAt: number) {
  const label = shellLabel(input)
  const failed = ran.deny !== undefined || ran.isError === true
  const result = (ran.result ?? {}) as { stdout?: unknown; stderr?: unknown; backgroundTaskId?: unknown }

  if (input.run_in_background === true && !failed) {
    const taskId = typeof result.backgroundTaskId === 'string' ? result.backgroundTaskId : null
    await update($, running, list => list.map(item => (item.id === id ? { ...item, taskId } : item)))
    return
  }
  await update($, running, list => list.filter(item => item.id !== id))
  const output = outputOf(result.stdout, result.stderr)
  const took = ageText(Date.now() - startedAt)
  await record($, failed ? 'shell-failed' : 'shell-done', `${failed ? '셸 실패' : '셸 끝남'} (${took}): ${label}${output === '' ? '' : ` → ${output}`}`)
}

// ── Pure helpers ────────────────────────────────────────────────────────────

/** What the small model reads: the log, what runs and waits, and what it wrote last. */
export function promptFor(
  entries: readonly LogEntry[],
  previous: Summary | null,
  runs: readonly RunningItem[],
  waits: readonly WaitingItem[],
  said: string,
  at: number,
): string {
  const covered = previous?.covers ?? 0
  const lines = entries.map(entry => `#${entry.id} ${ageText(at - entry.at)} 전${entry.id > covered ? ' (새)' : ''} ${entry.text}`)
  return [
    said === '' ? '' : `Claude가 알린 지금 단계: ${said}`,
    `돌아가는 것: ${runs.length === 0 ? '없음' : runs.map(item => `${item.kind === 'agent' ? '서브 에이전트' : '셸'} ${item.label} (${ageText(at - item.startedAt)}째)`).join('; ')}`,
    `사용자를 기다리는 것: ${waits.length === 0 ? '없음' : waits.map(item => item.label).join('; ')}`,
    previous === null ? '' : `지난번에 쓴 대시보드: ${JSON.stringify({ title: previous.title, now: previous.now, steps: previous.steps, checks: previous.checks, blocked: previous.blocked, next: previous.next, waiting: previous.waiting })}`,
    '기록 (오래된 것부터):',
    ...lines,
  ]
    .filter(line => line !== '')
    .join('\n')
}

/** The model's JSON as a summary, or undefined when it is not one. */
export function parseSummary(text: string, ids: ReadonlySet<number>): Omit<Summary, 'covers' | 'at'> | undefined {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return undefined
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
  } catch {
    return undefined
  }
  const str = (value: unknown, max: number) => (typeof value === 'string' ? truncate(value.trim(), max) : '')
  const list = (value: unknown) => (Array.isArray(value) ? value : [])
  const ref = (value: unknown) => (typeof value === 'number' && ids.has(value) ? value : 0)
  return {
    title: str(raw.title, 30),
    now: str(raw.now, 80),
    steps: list(raw.steps)
      .map(step => (typeof step === 'object' && step !== null ? (step as Record<string, unknown>) : {}))
      .map(step => ({ from: ref(step.from), text: str(step.text, 60) }))
      .filter(step => step.text !== '')
      .slice(0, 8),
    checks: list(raw.checks)
      .map(check => (typeof check === 'object' && check !== null ? (check as Record<string, unknown>) : {}))
      .map(check => ({ label: str(check.label, 20), value: str(check.value, 30), from: ref(check.from) }))
      .filter(check => check.label !== '' && check.value !== '')
      .slice(0, 4),
    blocked: list(raw.blocked)
      .map(item => str(item, 60))
      .filter(item => item !== '')
      .slice(0, 4),
    next: str(raw.next, 60),
    waiting: str(raw.waiting, 60),
  }
}

function inputOf(e: object): Record<string, unknown> {
  const { tool: _tool, tool_use_id: _id, agentId: _agent, requestMeta: _meta, ...rest } = e as Record<string, unknown>
  return rest
}

function shellLabel(input: Record<string, unknown>): string {
  const description = typeof input.description === 'string' ? input.description.trim() : ''
  if (description !== '') return excerpt(description, 80)
  return excerpt(mask(typeof input.command === 'string' ? input.command : ''), 80)
}

function questionOf(input: Record<string, unknown>): string {
  const first = Array.isArray(input.questions) ? (input.questions[0] as Record<string, unknown> | undefined) : undefined
  return excerpt(typeof first?.question === 'string' ? first.question : '질문', 80)
}

export function stepOf(tool: string, input: Record<string, unknown>): string {
  if (tool === 'Bash') return `셸: ${shellLabel(input)}`
  if (typeof input.file_path === 'string') return `${tool}: ${baseName(input.file_path)}`
  if (typeof input.query === 'string') return `${tool}: ${excerpt(input.query, 60)}`
  if (typeof input.url === 'string') return `${tool}: ${excerpt(input.url, 60)}`
  if (typeof input.pattern === 'string') return `${tool}: ${excerpt(input.pattern, 60)}`
  if (typeof input.description === 'string') return `${tool}: ${excerpt(input.description, 60)}`
  return tool
}

function baseName(path: unknown): string {
  return typeof path === 'string' ? path.split('/').pop() ?? path : ''
}

function outputOf(stdout: unknown, stderr: unknown): string {
  const text = [stdout, stderr].filter((part): part is string => typeof part === 'string' && part.trim() !== '').join('\n')
  if (text === '') return ''
  return mask(text.trim().slice(-240)).replace(/\s+/g, ' ').trim()
}

/** JSON with sorted keys, so two spellings of one input compare equal. */
export function stableKey(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .filter(key => (value as Record<string, unknown>)[key] !== undefined)
      .map(key => `${JSON.stringify(key)}:${stableKey((value as Record<string, unknown>)[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

// Hides what looks like a secret before text leaves for the model.
export function mask(text: string): string {
  return text
    .replace(/(\b[A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|AUTH)[A-Za-z0-9_]*\s*=\s*)("[^"]*"|'[^']*'|\S+)/gi, '$1***')
    .replace(/(--?(?:token|password|passwd|secret|api-?key|auth)(?:=|\s+))("[^"]*"|'[^']*'|\S+)/gi, '$1***')
    .replace(/(Bearer\s+)\S+/gi, '$1***')
    .replace(/\b(?:sk|ghp|gho|ghs|github_pat|xox[abprs]|AKIA)[-_A-Za-z0-9]{8,}/g, '***')
    .replace(/\b[A-Za-z0-9_]{32,}\b/g, '***')
}

function excerpt(text: string, max: number): string {
  return truncate(text.replace(/\s+/g, ' ').trim(), max)
}

export function ageText(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}초`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}분`
  return `${Math.floor(minutes / 60)}시간 ${minutes % 60}분`
}

// Terminal columns: Hangul, CJK and full-width forms take two.
export function width(text: string): number {
  let columns = 0
  for (const char of text) columns += isWide(char.codePointAt(0) ?? 0) ? 2 : 1
  return columns
}

export function truncate(text: string, max: number): string {
  if (width(text) <= max) return text
  if (max < 2) return ''
  let out = ''
  let used = 0
  for (const char of text) {
    const w = isWide(char.codePointAt(0) ?? 0) ? 2 : 1
    if (used + w > max - 1) break
    out += char
    used += w
  }
  return `${out}…`
}

function pad(text: string, size: number): string {
  return text + ' '.repeat(Math.max(0, size - width(text)))
}

function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  )
}
