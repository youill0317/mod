import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, ToolCallResult } from 'claude-code'

import type { LogEntry, Notes, PaneSize, RunningItem, Tone, WaitingItem } from '../types'
import { AGENT_BUDGET, condense, FIRST_BUDGET, LEAST_FIRST_BUDGET, NEXT_BUDGET, nextPlan, parseAnswer, planLine, promptFor } from './context'
import type { Message } from './context'
import { register as memo, withSubagent } from './memo'
import { backoffMs, isUnavailable, mask, truncate, width } from './text'
import { fitView, stamper } from './view'
import type { Seg } from './view'

const PANE = 'dashboard'

const log = atom({ plugin: 'dashboard', key: 'log' } as const, [])
const running = atom({ plugin: 'dashboard', key: 'running' } as const, [])
const waiting = atom({ plugin: 'dashboard', key: 'waiting' } as const, [])
const summary = atom({ plugin: 'dashboard', key: 'summary' } as const, null)
const notes = atom({ plugin: 'dashboard', key: 'notes' } as const, null)
const plan = atom({ plugin: 'dashboard', key: 'plan' } as const, [])
const hint = atom({ plugin: 'dashboard', key: 'hint' } as const, '')
const ask = atom({ plugin: 'dashboard', key: 'ask' } as const, '')
const now = atom({ plugin: 'dashboard', key: 'now' } as const, 0)
const pane = atom({ plugin: 'dashboard', key: 'pane' } as const, null)
const status = atom({ plugin: 'dashboard', key: 'status' } as const, { kind: 'idle', reason: '', since: 0 })
// The memo's values (memo.ts), for the events hooked here for both views.
const shells = atom({ plugin: 'dashboard', key: 'shells' } as const, [])
const subagents = atom({ plugin: 'dashboard', key: 'subagents' } as const, [])
const interactive = atom({ plugin: 'dashboard', key: 'interactive' } as const, true)

// The symbols that lead the lines at the top: the work now, what waits on the person, what runs.
const CURRENT = '●'
const WAITING = '◆'
const SHELL = '▶'
const AGENT = '◎'
const BACKGROUND = '↻'

const MAX_LOG = 300
const LOG_FOR_MODEL = 80
// The model is woken soon after a change that matters, later after routine ones.
const SOON_MS = 2_000
const LATER_MS = 20_000
const TICK_MS = 10_000
const OPEN_MS = 300
// Notes an earlier session left are offered for a week.
const EARLIER_MS = 7 * 24 * 3_600_000

// Log kinds that wake the model soon: the work changed phase or waits on the person.
const URGENT: ReadonlySet<LogEntry['kind']> = new Set(['said', 'plan', 'answer', 'permission', 'permission-done', 'question', 'question-done', 'agent-done', 'agent-failed', 'shell-failed', 'background-done'])

const PLANNING = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate'])

// The dashboard's model works alone: the main Claude tells it nothing. It reads
// the session and designs the view from materials, with no diagram kinds.
const SYSTEM = [
  '너는 Claude Code 세션 옆에 붙은 작업 대시보드를 혼자 맡는다. 메인 Claude는 작업에만 집중하고 너에게 아무것도 알려 주지 않는다.',
  '대화, Claude의 계획, 서브 에이전트, 작업 폴더, 기록을 직접 읽고, 사용자가 이 작업의 흐름과 지금 위치, 중요한 값을 한눈에 보고 통제할 수 있는 화면을 설계한다.',
  '도식의 종류는 정해져 있지 않다. 아래 재료를 조합해 이 작업을 가장 잘 보여 주는 모양을 직접 고른다. 단계 흐름, 체크리스트, 수치 표, 추세, 비교, 가설 목록, 파일 지도 등 무엇이든 좋다. 작업이 바뀌면 모양도 바꾼다.',
  '재료 (JSON):',
  '- "문자열" 또는 {"t":"text","v":"","tone":"normal","bold":false}  글. \\n으로 줄을 나눈다.',
  '- {"t":"row","gap":1,"c":[...]}  옆으로 늘어놓기. 넘치면 다음 줄로 넘어간다.',
  '- {"t":"col","gap":0,"c":[...]}  위아래로 쌓기.',
  '- {"t":"box","style":"round|bold|dashed|double","tone":"normal","title":"","c":[...]}  테두리 상자.',
  '- {"t":"arrow","dir":"right|left|down|up","label":"","tone":"normal"}  화살표.',
  '- {"t":"bar","value":3,"max":10,"w":20,"tone":"normal"}  진행 막대. 숫자는 옆에 글로 따로 쓴다.',
  '- {"t":"spark","values":[0.9,0.7,0.5],"tone":"normal"}  추세 한 줄.',
  '- {"t":"table","head":["",""],"rows":[["",""]],"tone":"normal"}  표.',
  '- {"t":"rule"}  구분선.',
  'tone은 normal, dim, accent, good, warn, bad. 지금 하는 곳에만 accent나 bold를 써서 눈이 갈 곳을 하나로 둔다. 끝난 것은 dim으로 조용히.',
  '기호를 써도 좋다: ✓ 끝남, ● 지금, ○ 남음, ✗ 실패, ◆ 기다림, ↺ 다시 함.',
  '시간은 직접 계산하지 말고 글 안에 표시를 넣으면 mod가 기록 시각으로 채운다: {ago:12} 기록 12가 몇 분 전인지, {for:12} 기록 12부터 지금까지, {for:12-15} 12부터 15까지 걸린 시간.',
  '규칙:',
  '- 실행 중인 셸, 서브 에이전트, 사용자를 기다리는 권한 요청과 질문은 mod가 위에 따로 보여 주니 화면에 다시 넣지 않는다.',
  '- 값을 지어내지 않는다. 수치는 대화, 셸 결과, 로그에 나온 것만 쓰고 언제 본 값인지 {ago:N}을 붙인다.',
  '- 창 크기에 맞춘다. view는 중요한 것부터 늘어놓고, 창에 넘치는 뒤쪽 블록은 잘린다. 글은 짧은 한국어 구절로 쓴다.',
  '- 사용자가 대시보드에 바라는 것이 있으면 그것을 가장 먼저 따른다.',
  '- 화면과 노트는 지금 상태를 보여 준다. 끝났거나, 사용자가 거절하거나 취소했거나, 하지 않기로 한 것은 남은 일과 기다림에서 지운다. 거절된 것은 노트의 정한 것에 "하지 않기로 함"으로만 남긴다.',
  '- 기록의 권한 요청과 질문은 뒤에 따라오는 "사용자가 허용함/거절함/답함" 기록으로 끝난 것이다. 지금 기다리는 것은 mod가 위에 보여 준다.',
  '- ask는 Claude의 가장 최근 답이 사용자에게 결정을 물었고 사용자가 아직 답하지 않았을 때만 쓴다. 그 밖에는 빈 문자열.',
  '- 작업이 크게 바뀌지 않았으면 지난번 화면의 모양은 유지하되 내용은 지금 상태로 고친다. 지난 화면이나 노트에 있어도 지금 근거가 없으면 뺀다.',
  '- notes에는 앞의 대화 없이도 다음 번에 이 작업을 이해하는 데 필요한 것을 적는다: 목표와 사용자가 원하는 것, 정한 것, 끝난 일, 남은 일, 막힌 것, 지켜볼 값과 최신 값(기록 번호와 함께). 지난 노트를 고쳐 쓰고 2000자를 넘기지 않는다.',
  'JSON 하나만 출력한다:',
  '{"notes":"...","now":"지금 하는 일, 20자 이내","ask":"사용자가 결정해야 할 것, 없으면 빈 문자열","view":[블록, ...]}',
].join('\n')

// Module state: it starts over on a reload.
let preferred = 'haiku'
let fallback: string | undefined
// Failed calls in a row, and until when the model is left alone after them.
let failures = 0
let pausedUntil = 0
let timer: { cancel: () => void } | undefined
let timerAt = Number.POSITIVE_INFINITY
let busy = false
let again = false
// Whether the main conversation was compacted since the notes last read it.
let compacted = false
// Whether the next summary is drawn even with nothing new (`/dashboard refresh`, a new hint).
let forced = false
// How much of the conversation the first read takes: halved after each first read that fails.
let firstBudget = FIRST_BUDGET
// The pane size the render hook last reported, so a redraw at the same size reports nothing.
let seen = ''
// Calls in flight, by loop (null for the main one), to tell which one a permission dialog is for.
const pending = new Map<string, { tool: string; key: string; agentId: string | null }>()

// One mod, two views of the work: the memo beside the spinner (memo.ts), and
// this /dashboard pane. An event both follow is hooked once, here: a mod has one
// hook per event without a matcher, and `$` never crosses an import.
export const register: Register = (on, options) => {
  preferred = typeof options.model === 'string' && options.model !== '' ? options.model : 'haiku'
  memo(on, options)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'dashboard',
      description: '작업 현황 대시보드를 옆에 엽니다',
      argumentHint: '[보고 싶은 것 | refresh | reset | close]',
    })
    // A reload loses the calls the old module was holding: they are no longer tracked.
    await update($, running, list => list.filter(item => item.kind === 'agent' || item.background))
    await update($, waiting, () => [])
    await update($, shells, () => [])
    // A call the old module was making is gone with it.
    await update($, status, old => (old.kind === 'reading' ? { kind: 'idle' as const, reason: '', since: 0 } : old))
    await update($, interactive, () => e.isInteractive)
    $.clock.every(TICK_MS, () => tick($))
    return next(e)
  })

  on('command.run', { command: 'dashboard' }, async ($, e) => {
    const asked = e.args.trim()
    if (asked === 'close') {
      await $.ui.close({ id: PANE })
      return { text: '대시보드를 닫았습니다.' }
    }
    // Anything else the person writes is what the dashboard should look at.
    if (asked === 'reset') {
      // A fresh start: no hint, and notes written again from the conversation, this project's stored ones gone too.
      await update($, hint, () => '')
      await update($, notes, () => null)
      firstBudget = FIRST_BUDGET
      try {
        await $.store.delete(`notes:${await projectRoot($)}`)
      } catch {
        // Nothing stored to forget.
      }
    } else if (asked !== '' && asked !== 'refresh') await update($, hint, () => asked.slice(0, 300))
    await $.ui.open({ id: PANE, title: '작업 현황' })
    const at = await $.clock.now()
    await update($, now, () => at)
    // A moment for the pane's first draw to note its size, so the summary is laid out for it.
    $.clock.after(OPEN_MS, () => wake($, asked !== ''))
    if (asked === 'reset') return { text: '대시보드를 처음부터 다시 그립니다: 바라는 것과 노트를 지우고 대화를 다시 읽습니다.' }
    if (asked === 'refresh') return { text: '대시보드를 다시 그립니다.' }
    if (asked !== '') return { text: `대시보드가 이것을 중심으로 보여 줍니다: ${asked}` }
    return { text: '작업 현황 대시보드를 열었습니다.' }
  })

  on('tool.call', async ($, e, next) => {
    const input = inputOf(e)
    const id = e.tool_use_id

    // A subagent's call: only its latest step is kept, on its row.
    if (e.agentId !== undefined) {
      const agentId = e.agentId
      const step = stepOf(e.tool, input)
      await update($, running, list => list.map(item => (item.id === agentId ? { ...item, last: step } : item)))
      pending.set(id, { tool: e.tool, key: stableKey(input), agentId })
      let ran: ToolCallResult | undefined
      try {
        ran = await next(e)
        return ran
      } finally {
        pending.delete(id)
        await settle($, id, ran)
      }
    }

    pending.set(id, { tool: e.tool, key: stableKey(input), agentId: null })
    let ran: ToolCallResult | undefined
    try {
      if (e.tool === 'Bash') {
        const startedAt = await startShell($, id, input)
        ran = await next(e)
        await endShell($, id, input, ran, startedAt)
        return ran
      }

      if (e.tool === 'AskUserQuestion') {
        const label = questionOf(input)
        const item: WaitingItem = { id, kind: 'question', label, since: await $.clock.now() }
        await update($, waiting, list => [...list, item])
        await record($, 'question', `사용자에게 질문: ${label}`)
        ran = await next(e)
        return ran
      }

      ran = await next(e)
      const done = ran.deny === undefined && ran.isError !== true
      // Claude's own plan, read off its planning tools: the dashboard's best outline of the work.
      if (done && PLANNING.has(e.tool)) {
        const before = await read($, plan)
        const after = nextPlan(before, e.tool, input, ran.result)
        if (JSON.stringify(after) !== JSON.stringify(before)) {
          await update($, plan, () => after)
          await record($, 'plan', planLine(after))
        }
      } else if (done && ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(e.tool)) await record($, 'edit', `파일 수정: ${baseName(input.file_path ?? input.notebook_path)}`)
      else if (done && (e.tool === 'WebSearch' || e.tool === 'WebFetch' || e.tool.startsWith('mcp__'))) await record($, 'tool', stepOf(e.tool, input))
      return ran
    } finally {
      pending.delete(id)
      await settle($, id, ran)
    }
  })

  // What Claude says between its steps ("이제 테스트를 고치겠습니다") is the clearest
  // sign of a new phase. Read off the stream as it passes, never changed; a turn's
  // last words are its answer, which turn.complete records.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    try {
      const said = result.answer.trim()
      if (e.agentId === undefined && said !== '' && result.toolUses.length > 0) {
        $.clock.after(0, () => record($, 'said', `Claude: ${excerpt(said, 200)}`))
      }
    } catch {
      // Nothing to note: the step stands as it came.
    }
    return result
  })

  // A compacted conversation starts over from its summary: the notes read it again from there.
  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && e.trigger !== 'precompute' && result.messages !== undefined) compacted = true
    return result
  })

  // The dialog asks about one of the calls in flight on its loop: it now waits on the person.
  on('classic.PermissionRequest', async ($, e, next) => {
    const key = stableKey(e.tool_input)
    const loop = e.agent_id ?? null
    const same = [...pending.entries()].filter(([, call]) => call.agentId === loop && call.tool === e.tool_name)
    const match = same.find(([, call]) => call.key === key) ?? (same.length === 1 ? same[0] : undefined)
    if (match !== undefined) {
      const [id] = match
      const input = (e.tool_input ?? {}) as Record<string, unknown>
      const label = e.tool_name === 'Bash' ? shellLabel(input) : stepOf(e.tool_name, input)
      const item: WaitingItem = { id, kind: 'permission', label, since: await $.clock.now() }
      await update($, waiting, list => [...list.filter(one => one.id !== id), item])
      await record($, 'permission', `권한 요청: ${label}`)
    }
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    const agentId = started.agentId
    if (agentId === undefined) return started
    // The memo tells a subagent's spinner by its id.
    await update($, subagents, list => withSubagent(list, agentId))
    if (e.workflow === undefined) {
      // A subagent's row is the role it was given.
      const role = e.description.trim() === '' ? e.subagentType : e.description.trim()
      const row: RunningItem = { id: agentId, kind: 'agent', label: role, startedAt: await $.clock.now(), background: e.background, taskId: null, last: '' }
      await update($, running, list => [...list.filter(item => item.id !== agentId), row])
      await record($, 'agent', `서브 에이전트 시작 (${e.subagentType}): ${e.description}`)
    }
    return started
  })

  on('turn.complete', async ($, e, next) => {
    const ended = await next(e)
    // A turn that ended runs no foreground shell any more, whatever was missed.
    const loop = e.agentId ?? null
    await update($, shells, list => list.filter(one => one.agentId !== loop))
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
    // The main turn ended: nothing of it runs in the foreground or waits on the person any more.
    await update($, running, list => list.filter(item => item.kind === 'agent' || item.background))
    await update($, waiting, list => list.filter(item => pending.get(item.id)?.agentId != null))
    if (e.isAborted) {
      // Esc before any answer or step takes the prompt back out of the conversation, and no
      // event says so: a turn that ended that way takes its prompt off the dashboard too.
      const last = (await read($, log)).at(-1)
      if (e.answer.trim() === '' && last?.kind === 'prompt') await withdraw($, last.id)
      else await record($, 'answer', `사용자가 중단함${e.answer.trim() === '' ? '' : `: ${excerpt(e.answer, 240)}`}`)
      return ended
    }
    await record($, 'answer', `Claude의 답: ${excerpt(e.answer, 240)}`)
    return ended
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'composer') {
      // The person is here: a dialog they answered and a decision they were asked for no longer wait.
      await update($, waiting, list => list.filter(item => item.kind !== 'permission'))
      await update($, ask, () => '')
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
    // A render never writes state: the size is noted just after, for the next summary.
    const rows = e.props.scroll.bodyRows
    if (`${columns}x${rows}` !== seen) {
      seen = `${columns}x${rows}`
      $.clock.after(0, () => noteSize($, { columns, rows }))
    }
    const entries = await read($, log)
    const runs = await read($, running)
    const waits = await read($, waiting)
    const written = await read($, summary)
    const asked = await read($, ask)
    const at = Math.max(await read($, now), await $.clock.now())
    const byId = new Map(entries.map(entry => [entry.id, entry]))

    // The top: one line each, led by its symbol, with how long it has taken on the right.
    const current = written?.now ?? ''
    const top = [
      ...(current === '' ? [] : [{ symbol: CURRENT, color: 'suggestion', text: current, age: '', last: '' }]),
      ...(asked === '' ? [] : [{ symbol: WAITING, color: 'warning', text: asked, age: '', last: '' }]),
      ...waits.map(item => ({
        symbol: WAITING,
        color: 'warning',
        text: `${item.label} · ${item.kind === 'question' ? '질문' : '권한 요청'}`,
        age: `  ${ageText(at - item.since)}`,
        last: '',
      })),
      // A call waiting on the person's permission is not running yet: it shows once, as waiting.
      ...runs.filter(item => !waits.some(wait => wait.id === item.id)).map(item => ({
        symbol: item.kind === 'agent' ? AGENT : item.background ? BACKGROUND : SHELL,
        color: undefined,
        text: item.label,
        age: `  ${ageText(at - item.startedAt)}`,
        last: item.last,
      })),
    ]
    const topRows = top.length + top.filter(item => item.last !== '').length

    // Where the model stands, while nothing else says it: reading before its first view, or failed.
    const state = await read($, status)
    const note =
      state.kind === 'failed'
        ? { text: `모델 응답을 받지 못함 (${state.reason}) · 곧 다시 시도`, color: 'warning' }
        : state.kind === 'reading' && (written?.view.length ?? 0) === 0
          ? { text: `대시보드 모델이 세션을 읽는 중… ${ageText(at - state.since)}째`, color: undefined }
          : undefined
    const above = topRows + (note === undefined ? 0 : 1 + (topRows > 0 ? 1 : 0))

    // Below it, the model's view: as many of its blocks as the pane holds, the most important first.
    const room = rows - above - (above > 0 ? 1 : 0)
    const blocks = fitView(written?.view ?? [], columns, room, stamper(byId, at, ageText))

    return (
      <Box flexDirection="column">
        {top.map(item => (
          <Box flexDirection="column">
            <Box flexDirection="row">
              <Text color={item.color} bold={item.symbol === CURRENT}>{truncate(`${item.symbol} ${item.text}`, Math.max(8, columns - width(item.age)))}</Text>
              {item.age !== '' && <Text dimColor>{item.age}</Text>}
            </Box>
            {item.last !== '' && <Text dimColor>{truncate(`  └ ${item.last}`, columns)}</Text>}
          </Box>
        ))}
        {note !== undefined && (
          <Box marginTop={top.length === 0 ? 0 : 1}>
            <Text color={note.color} dimColor={note.color === undefined}>{truncate(note.text, columns)}</Text>
          </Box>
        )}
        {blocks.map((lines, i) => (
          <Box flexDirection="column" marginTop={i === 0 && top.length === 0 && note === undefined ? 0 : 1}>
            {lines.map(line => drawLine(Box, Text, line))}
          </Box>
        ))}
      </Box>
    )
  })
}

// ── Drawing the view ────────────────────────────────────────────────────────

// An element of the surface's table, drawn through the JSX factory.
type Draw = Parameters<typeof h>[0]
type Node = ReturnType<typeof h>

const TONE_COLOR: Record<Tone, string | undefined> = { normal: undefined, dim: undefined, accent: 'suggestion', good: 'success', warn: 'warning', bad: 'error' }

/** One laid-out line: its runs of one style each, side by side. */
function drawLine(BoxEl: unknown, TextEl: unknown, line: readonly Seg[]): Node {
  const Box = BoxEl as Draw
  const Text = TextEl as Draw
  if (line.length === 0) return h(Text, {}, ' ')
  const runs: Seg[] = []
  for (const seg of line) {
    const last = runs[runs.length - 1]
    if (last !== undefined && last.tone === seg.tone && last.bold === seg.bold) runs[runs.length - 1] = { ...last, text: last.text + seg.text }
    else runs.push(seg)
  }
  return h(Box, { flexDirection: 'row' }, ...runs.map(seg => h(Text, { color: TONE_COLOR[seg.tone], dimColor: seg.tone === 'dim', bold: seg.bold }, seg.text)))
}

// ── Recording and waking the model ──────────────────────────────────────────

/**
 * A call that waited on the person has ended: it waits no more, and the log
 * says how it ended, so the model never reads a request as still open.
 */
async function settle($: EngineInterface, id: string, ran: ToolCallResult | undefined) {
  const was = (await read($, waiting)).find(item => item.id === id)
  await update($, waiting, list => list.filter(item => item.id !== id))
  if (was === undefined) return
  if (was.kind === 'permission') await record($, 'permission-done', `${permissionOutcome(ran)}: ${was.label}`)
  else await record($, 'question-done', `${answerOf(ran)} (질문: ${was.label})`)
}

async function record($: EngineInterface, kind: LogEntry['kind'], text: string) {
  const at = await $.clock.now()
  await update($, log, list => [...list, { id: (list[list.length - 1]?.id ?? 0) + 1, at, kind, text: excerpt(mask(text), 300) }].slice(-MAX_LOG))
  // A pane nobody sees costs no model call: opening it reads all that happened meanwhile.
  if (await paneShown($)) await schedule($, URGENT.has(kind) ? SOON_MS : LATER_MS)
}

// A prompt taken back stays in the log as withdrawn, so no id is used twice, but the model
// no longer reads it; a summary that already covered it is drawn again.
async function withdraw($: EngineInterface, id: number) {
  await update($, log, list => list.map(entry => (entry.id === id ? { ...entry, kind: 'withdrawn' as const } : entry)))
  await update($, summary, old => (old === null || old.covers < id ? old : { ...old, covers: 0 }))
  if (await paneShown($)) await schedule($, SOON_MS)
}

async function schedule($: EngineInterface, ms: number) {
  const at = await $.clock.now()
  // After failed calls the model is left alone a while, whatever woke it.
  const due = Math.max(at + ms, pausedUntil)
  if (timer !== undefined && timerAt <= due) return
  timer?.cancel()
  timerAt = due
  timer = $.clock.after(due - at, () => {
    timer = undefined
    timerAt = Number.POSITIVE_INFINITY
    return summarize($)
  })
}

async function wake($: EngineInterface, force: boolean) {
  if (force) forced = true
  await summarize($)
}

async function noteSize($: EngineInterface, size: PaneSize) {
  await update($, pane, () => size)
  // A summary laid out for another size class is laid out again for this one.
  const written = await read($, summary)
  if (written !== null && written.fit !== fitOf(size)) await schedule($, SOON_MS)
}

async function paneShown($: EngineInterface): Promise<boolean> {
  try {
    return (await $.ui.panes()).some(one => one.id === PANE && one.isShown)
  } catch {
    // Where no surface lists panes, nothing is shown: the log still keeps going.
    return false
  }
}

async function tick($: EngineInterface) {
  const busyNow = (await read($, running)).length > 0 || (await read($, waiting)).length > 0 || (await read($, status)).kind === 'reading'
  if (busyNow && (await paneShown($))) {
    const at = await $.clock.now()
    await update($, now, () => at)
  }
}

async function summarize($: EngineInterface) {
  if (busy) {
    again = true
    return
  }
  busy = true
  try {
    const entries = (await read($, log)).filter(entry => entry.kind !== 'withdrawn')
    const previous = await read($, summary)
    const newest = entries[entries.length - 1]?.id ?? 0
    const size = await read($, pane)
    const fit = fitOf(size)
    const messages = await conversation($)
    const known = await read($, notes)
    const from = compacted ? 0 : resumeAt(messages, known)
    // Nothing to draw from: no conversation and no log (the only prompt was taken back).
    if (newest === 0 && messages.length === 0) {
      if (previous !== null) await update($, summary, () => null)
      return
    }
    if (!forced && previous !== null && previous.covers >= newest && previous.fit === fit && from >= messages.length) return

    const runs = await read($, running)
    const at = await $.clock.now()
    const root = await projectRoot($)
    const prompt = promptFor(
      {
        size,
        hint: await read($, hint),
        notes: known,
        earlier: known === null ? await earlierNotes($, root, at) : '',
        plan: await read($, plan),
        runs,
        waits: await read($, waiting),
        agents: await agentTalk($, runs),
        workspace: await workspace($, runs),
        project: known === null ? await projectIntro($) : '',
        log: entries.slice(-LOG_FOR_MODEL),
        // The first time, the whole conversation (cut in the middle): the notes start from it.
        conversation: condense(messages.slice(from), known === null ? firstBudget : NEXT_BUDGET, from),
        compacted,
        previous,
        at,
      },
      ageText,
    )
    await update($, status, () => ({ kind: 'reading' as const, reason: '', since: at }))
    const reply = await complete($, prompt)
    const answer = 'text' in reply ? parseAnswer(reply.text) : undefined
    if (answer === undefined) {
      // Never silent: the pane says the call failed and why, and the model is left alone a while.
      failures += 1
      const failedAt = await $.clock.now()
      pausedUntil = failedAt + backoffMs(failures)
      // A first read too big to answer is tried again smaller.
      if (known === null) firstBudget = Math.max(LEAST_FIRST_BUDGET, Math.floor(firstBudget / 2))
      await update($, status, () => ({ kind: 'failed' as const, reason: 'failed' in reply ? reply.failed : '응답을 읽지 못함', since: failedAt }))
      return
    }
    failures = 0
    await update($, status, () => ({ kind: 'idle' as const, reason: '', since: 0 }))

    compacted = false
    forced = false
    const last = messages[messages.length - 1]
    const kept: Notes = { text: answer.notes !== '' ? answer.notes : (known?.text ?? ''), upTo: messages.length, key: last === undefined ? '' : keyOf(last) }
    await update($, notes, () => kept)
    await update($, summary, () => ({ ...answer.summary, covers: newest, fit }))
    // What to decide stands only if the person has not written since what it was read from.
    const wrote = (await read($, log)).some(entry => entry.kind === 'prompt' && entry.id > newest)
    if (!wrote) await update($, ask, () => answer.summary.ask)
    if (kept.text !== '') {
      try {
        await $.store.set(`notes:${root}`, { text: kept.text, at })
      } catch {
        // The next session starts without them.
      }
    }
  } finally {
    busy = false
    if (again) {
      again = false
      await schedule($, SOON_MS)
    }
  }
}

// ── Reading the session for the model ───────────────────────────────────────

async function conversation($: EngineInterface): Promise<Message[]> {
  try {
    return (await $.session.messages()) as unknown as Message[]
  } catch {
    return []
  }
}

/** A message's fingerprint, to find the last one the notes took in. */
export function keyOf(message: Message): string {
  return `${message.role}:${message.text.slice(0, 120)}:${(message.toolUses ?? []).map(use => use.tool).join(',')}`
}

/**
 * Where the notes left off in the conversation: just past the last message
 * they took in, found by its fingerprint when older messages have scrolled
 * out. Not found, the conversation was rewritten: it is read again from the start.
 */
export function resumeAt(messages: readonly Message[], known: Notes | null): number {
  if (known === null || known.upTo === 0) return 0
  const at = known.upTo - 1
  if (at < messages.length && keyOf(messages[at]!) === known.key) return known.upTo
  for (let i = messages.length - 1; i >= 0; i--) if (keyOf(messages[i]!) === known.key) return i + 1
  return 0
}

// What each running subagent has said and done lately, from its own conversation.
async function agentTalk($: EngineInterface, runs: readonly RunningItem[]): Promise<{ label: string; text: string }[]> {
  const out: { label: string; text: string }[] = []
  for (const item of runs.filter(one => one.kind === 'agent').slice(0, 3)) {
    try {
      const found = await $.session.messages({ agentId: item.id })
      if (!Array.isArray(found)) continue
      const messages = found as unknown as Message[]
      const text = condense(messages.slice(-8), AGENT_BUDGET, Math.max(0, messages.length - 8))
      if (text !== '') out.push({ label: item.label, text })
    } catch {
      // Its conversation is not readable: its row at the top still shows.
    }
  }
  return out
}

// The working copy as git sees it, and the tail of each background shell's output.
async function workspace($: EngineInterface, runs: readonly RunningItem[]): Promise<string> {
  const git = async (args: string[]) => {
    try {
      const ran = await $.process.run(['git', ...args], { timeoutMs: 5_000 })
      return ran.exitCode === 0 ? ran.stdout.trim() : ''
    } catch {
      return ''
    }
  }
  const parts: string[] = []
  const status = await git(['status', '--short', '--branch'])
  if (status !== '') {
    parts.push(`git status:\n${status.split('\n').slice(0, 25).join('\n')}`)
    const diff = await git(['diff', '--stat', 'HEAD'])
    if (diff !== '') parts.push(`바뀐 양:\n${diff.split('\n').slice(-12).join('\n')}`)
    const commits = await git(['log', '--oneline', '-5'])
    if (commits !== '') parts.push(`최근 커밋:\n${commits}`)
  }
  for (const item of runs.filter(one => one.background && one.output !== undefined).slice(0, 3)) {
    try {
      const text = await $.fs.read(item.output!)
      const tail = (typeof text === 'string' ? text : '').trim().slice(-1_500)
      if (tail !== '') parts.push(`백그라운드 출력 끝부분 (${item.label}):\n${tail}`)
    } catch {
      // Not readable: the shell's row still shows.
    }
  }
  return mask(parts.join('\n\n'))
}

// What the project is, from its own instructions or README: read once, when the notes start.
async function projectIntro($: EngineInterface): Promise<string> {
  for (const name of ['CLAUDE.md', 'README.md']) {
    try {
      const text = await $.fs.read(name)
      if (typeof text === 'string' && text.trim() !== '') return mask(text.trim().slice(0, 1_500))
    } catch {
      // Not there: the next one.
    }
  }
  return ''
}

async function projectRoot($: EngineInterface): Promise<string> {
  try {
    return await $.session.root()
  } catch {
    return 'default'
  }
}

// The notes an earlier session of this project left, while they are recent.
async function earlierNotes($: EngineInterface, root: string, at: number): Promise<string> {
  try {
    const stored = (await $.store.get(`notes:${root}`)) as { text?: unknown; at?: unknown } | undefined
    if (typeof stored?.text !== 'string' || typeof stored.at !== 'number' || at - stored.at > EARLIER_MS) return ''
    return stored.text
  } catch {
    return ''
  }
}

// High effort thinks at length before it answers: the cap leaves room for the
// thinking and the whole JSON after it, so the answer is never cut mid-way.
const MAX_TOKENS = 32_000
const TIMEOUT_MS = 240_000

/** The model's text, or why there is none, in words for the pane. */
async function complete($: EngineInterface, prompt: string): Promise<{ text: string } | { failed: string }> {
  const asking = (model: string) => $.model.complete({ model, system: [{ text: SYSTEM, cache: true }], prompt, maxTokens: MAX_TOKENS, effort: 'high', timeoutMs: TIMEOUT_MS })
  let answer
  try {
    try {
      answer = await asking(fallback ?? preferred)
    } catch {
      // The organization may not allow the preferred model: use the session's.
      if (fallback !== undefined) return { failed: '모델 호출이 거부됨' }
      fallback = await $.session.model()
      answer = await asking(fallback)
    }
    // A model this account cannot use answers an error rather than refusing: use the session's too.
    if (!answer.isAnswered && answer.reason === 'api-error' && fallback === undefined && isUnavailable(answer.error, answer.status)) {
      fallback = await $.session.model()
      answer = await asking(fallback)
    }
  } catch {
    return { failed: '모델 호출이 거부됨' }
  }
  if (answer.isAnswered) return { text: answer.text }
  if (answer.reason === 'api-error') return { failed: `API 오류 ${answer.status ?? ''} ${answer.error}`.replace(/\s+/g, ' ').trim() }
  if (answer.reason === 'aborted') return { failed: '시간 초과' }
  return { failed: '빈 응답' }
}

async function startShell($: EngineInterface, id: string, input: Record<string, unknown>): Promise<number> {
  const label = shellLabel(input)
  const background = input.run_in_background === true
  const startedAt = await $.clock.now()
  const item: RunningItem = { id, kind: 'shell', label, startedAt, background, taskId: null, last: '' }
  await update($, running, list => [...list, item])
  await record($, 'shell', `${background ? '백그라운드 셸 시작' : '셸 실행'}: ${label}`)
  return startedAt
}

async function endShell($: EngineInterface, id: string, input: Record<string, unknown>, ran: ToolCallResult, startedAt: number) {
  const label = shellLabel(input)
  const failed = ran.deny !== undefined || ran.isError === true
  const result = (ran.result ?? {}) as { stdout?: unknown; stderr?: unknown; backgroundTaskId?: unknown; rawOutputPath?: unknown; persistedOutputPath?: unknown }
  const taskId = typeof result.backgroundTaskId === 'string' ? result.backgroundTaskId : null

  // A foreground shell the person moved to the background (Ctrl+B), or one past its timeout, runs on too.
  if ((input.run_in_background === true || taskId !== null) && !failed) {
    const output = typeof result.rawOutputPath === 'string' ? result.rawOutputPath : typeof result.persistedOutputPath === 'string' ? result.persistedOutputPath : undefined
    await update($, running, list => list.map(item => (item.id === id ? { ...item, background: true, taskId, ...(output === undefined ? {} : { output }) } : item)))
    if (input.run_in_background !== true) await record($, 'shell', `셸이 백그라운드로 넘어감: ${label}`)
    return
  }
  await update($, running, list => list.filter(item => item.id !== id))
  const output = outputOf(result.stdout, result.stderr)
  const took = ageText((await $.clock.now()) - startedAt)
  await record($, failed ? 'shell-failed' : 'shell-done', `${failed ? '셸 실패' : '셸 끝남'} (${took}): ${label}${output === '' ? '' : ` → ${output}`}`)
}

// ── Pure helpers ────────────────────────────────────────────────────────────

/**
 * The size class a summary is laid out for: a band of columns and of rows.
 * A resize within it keeps the summary; one across it lays it out again.
 */
export function fitOf(size: PaneSize | null): string {
  if (size === null) return ''
  const band = [20, 40].filter(edge => size.rows >= edge).length
  return `${Math.min(8, Math.floor(size.columns / 20))}/${band}`
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

/** How a permission request ended, from the call's result. */
export function permissionOutcome(ran: ToolCallResult | undefined): string {
  if (ran === undefined) return '권한 요청이 중단됨'
  if (ran.deny !== undefined) return '사용자가 거절함'
  if (ran.isError === true && /reject|denied|doesn't want|don't want|not allowed|거절|거부/i.test(ran.text ?? '')) return '사용자가 거절함'
  return '사용자가 허용함'
}

/** What the person answered a question with, from the call's result. */
export function answerOf(ran: ToolCallResult | undefined): string {
  if (ran === undefined || ran.deny !== undefined || ran.isError === true) return '사용자가 질문에 답하지 않음'
  const answers = (ran.result as { answers?: unknown } | undefined)?.answers
  const said = typeof answers === 'object' && answers !== null ? Object.values(answers as Record<string, unknown>).filter(value => typeof value === 'string' && value !== '') : []
  return said.length === 0 ? '사용자가 질문에 답함' : `사용자 답: ${excerpt(said.join(' / '), 120)}`
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
  return mask(text.trim()).slice(-240).replace(/\s+/g, ' ').trim()
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

function excerpt(text: string, max: number): string {
  return truncate(text.replace(/\s+/g, ' ').trim(), max)
}

export function ageText(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}초`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}분`
  return minutes % 60 === 0 ? `${minutes / 60}시간` : `${Math.floor(minutes / 60)}시간 ${minutes % 60}분`
}
