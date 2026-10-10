import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, ToolCallResult } from 'claude-code'

import type { GraphNode, LogEntry, NodeState, PaneSize, RunningItem, Summary, SummaryBlock, Tone, WaitingItem } from '../types'

const PANE = 'dashboard'
const SIGNAL = 'signal'
const SIGNAL_ID = 'mcp__dashboard__signal'

const log = atom({ plugin: 'dashboard', key: 'log' } as const, [])
const running = atom({ plugin: 'dashboard', key: 'running' } as const, [])
const waiting = atom({ plugin: 'dashboard', key: 'waiting' } as const, [])
const summary = atom({ plugin: 'dashboard', key: 'summary' } as const, null)
const phase = atom({ plugin: 'dashboard', key: 'phase' } as const, '')
const now = atom({ plugin: 'dashboard', key: 'now' } as const, 0)
const pane = atom({ plugin: 'dashboard', key: 'pane' } as const, null)

// The symbols that lead what waits on the person and what runs.
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

// Log kinds that wake the model soon: the work changed phase or waits on the person.
const URGENT: ReadonlySet<LogEntry['kind']> = new Set(['signal', 'answer', 'permission', 'question', 'agent-done', 'agent-failed', 'shell-failed', 'background-done'])

const SIGNAL_DESCRIPTION = [
  "Marks a change in the work's phase on the person's progress dashboard.",
  'Call it when a new phase starts, a major phase ends, the work is blocked, or a decision from the person is needed.',
  "One short line in the person's language. Do not call it for routine steps.",
].join(' ')

const SYSTEM = [
  '너는 Claude Code 작업의 진행 대시보드를 설계한다. 사용자가 전체 작업 과정을 한눈에 파악하고 통제할 수 있게 돕는 것이 목적이다.',
  '결과물, 계획, 파일 내용은 쓰지 않는다. 작업이 어떻게 흘러왔고 지금 어디에 있는지만 보여 준다.',
  '실행 중인 것과 사용자를 기다리는 것은 화면 맨 위에 따로 나오므로 블록으로 만들지 않는다.',
  '글이 아니라 도식으로 보여 준다. 가장 중요한 것은 graph 도식이고, 표와 막대와 숫자 상자는 비교할 대상이나 수치가 있을 때만 쓴다. 문장은 쓰지 않는다.',
  'JSON 하나만 출력한다. 형식:',
  '{"title": "작업 이름, 15자 이내", "now": "지금 하는 일, 30자 이내", "waiting": "Claude가 답을 마치고 사용자의 결정을 기다리면 25자 이내. 사용자를 기다리는 것 목록에 이미 있으면 빈 문자열", "blocks": [블록...]}',
  '블록 종류:',
  '- {"kind": "graph", "title": "", "nodes": [{"label": "단계", "state": "done|now|todo|failed|wait", "note": "", "branches": [{"label": "", "state": "...", "note": "", "back": false}]}]}',
  '  작업의 주된 흐름을 상자와 화살표로 그린다. nodes는 일어난 순서대로 3~8개, 지난 단계와 지금 단계와 다음 단계. now 뒤에는 todo만 둔다. 항상 첫 블록으로 둔다.',
  '  branches는 그 단계에서 갈라진 일이다: 실패(failed), 사용자 대기(wait), 따로 돈 서브 에이전트나 작업(done/now). 실패를 고치고 다시 해서 넘어갔으면 back을 true로. 단계마다 최대 2개.',
  '  label은 한 단어 명사, 한글 4자 이내(예: 준비, 변환, 빌드, 배포, 학습). note는 그 단계의 핵심 수치나 대상, 8자 이내(예: 12쪽, 38/64, epoch 2), 없으면 빈 문자열.',
  '- {"kind": "table", "title": "", "columns": ["열"], "rows": [{"cells": ["값"], "tone": "...", "from": 기록 번호}]}  여러 대상(세션, 실험, 파일)을 비교할 때만. 열 4개 이하, 행 6개 이하, 칸은 12자 이내.',
  '- {"kind": "bars", "title": "", "items": [{"label": "", "value": 숫자, "max": 숫자, "note": "", "tone": "...", "from": 기록 번호}]}  진행률(epoch, 처리 개수 등)이 있을 때만. note에 value/max를 되풀이하지 않는다.',
  '- {"kind": "metrics", "title": "", "items": [{"label": "", "value": "8자 이내", "tone": "...", "from": 기록 번호}]}  꼭 봐야 할 숫자 2~4개가 있을 때만.',
  '- {"kind": "list", "title": "", "items": [{"text": "20자 이내", "tone": "..."}]}  도식으로 나타낼 수 없는 것만, 최대 2줄. 거의 쓰지 않는다.',
  '블록 제목은 기본으로 빈 문자열이다. 블록만 보고 무엇인지 알 수 없을 때만 한 단어 명사로 붙인다(예: 세션, 실험, 점수).',
  '열 이름, 막대 이름, 숫자 이름도 한 단어 명사로 쓴다. "막힌 것", "확인할 것", "~한 ~"처럼 서술어가 붙은 말은 절대 쓰지 않는다. 보면 아는 말("지금", "현황")은 쓰지 않는다.',
  '창 크기와 그 창에 맞는 한도가 주어지면 넘기지 않는다. 상자가 모자라면 지난 단계들을 한 상자로 묶고(예: 준비, 변환, 빌드 → 빌드), 지금 단계와 다음 단계는 남긴다. 넓은 창이면 단계를 나눠 더 펼친다.',
  '다른 블록이 차지하는 줄: table은 행 수+2줄, bars는 항목마다 1줄, metrics는 4줄, 블록 사이 1줄. 줄이 모자라면 덜 중요한 블록부터 빼고 표의 행과 막대 항목을 줄인다. 남으면 억지로 채우지 않는다.',
  '블록은 최대 4개. 내용 없는 블록은 만들지 않는다. 지난번 대시보드가 있으면 작업이 크게 바뀌지 않는 한 블록 종류와 순서를 유지한다.',
  'from은 그 값을 확인한 기록의 번호다. 바깥 상태(학습 epoch, 세션 상태 등)에는 꼭 넣고, 아니면 0으로 둔다.',
  'tone은 normal, good(끝남), warn(주의), bad(실패), muted(덜 중요) 중 하나.',
].join('\n')

// Module state: it starts over on a reload.
let preferred = 'haiku'
let fallback: string | undefined
let timer: { cancel: () => void } | undefined
let timerAt = Number.POSITIVE_INFINITY
let busy = false
let again = false
// The pane size the render hook last reported, so a redraw at the same size reports nothing.
let seen = ''
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
    // A session with no tools (`--tools ""`) refuses the signal; the dashboard works without it.
    try {
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
    } catch {
      // No signal tool in this session.
    }
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
    const at = await $.clock.now()
    await update($, now, () => at)
    // A moment for the pane's first draw to note its size, so the summary is laid out for it.
    $.clock.after(OPEN_MS, () => wake($, ask === 'refresh'))
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
        const item: WaitingItem = { id, kind: 'question', label, since: await $.clock.now() }
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
    if (agentId !== undefined && e.workflow === undefined) {
      const row: RunningItem = { id: agentId, kind: 'agent', label: `${e.subagentType}: ${e.description}`, startedAt: await $.clock.now(), background: e.background, taskId: null, last: '' }
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
    const said = await read($, phase)
    const at = Math.max(await read($, now), await $.clock.now())

    const byId = new Map(entries.map(entry => [entry.id, entry]))
    const unwritten = entries.filter(entry => entry.id > (written?.covers ?? 0)).length
    const title = written?.title || '작업 과정'

    // Before the first summary, the latest log entries stand in as a table.
    const recent = entries.filter(entry => entry.kind !== 'prompt').slice(-5).reverse()
    const blocks: SummaryBlock[] =
      written !== null && written.blocks.length > 0
        ? written.blocks
        : recent.length === 0
          ? []
          : [{ kind: 'table', title: '', columns: ['기록'], rows: recent.map(entry => ({ cells: [entry.text], tone: 'normal' as const, from: entry.id })) }]
    // What the mod already lists as waiting is not repeated from the model's note.
    const waitNote = waits.length > 0 ? '' : written?.waiting ?? ''

    // What waits on the person and what runs, each line led by its symbol.
    const live = [
      ...waits.map(item => ({
        symbol: WAITING,
        color: 'warning',
        text: `${item.label} · ${item.kind === 'question' ? '질문' : '권한 요청'}`,
        age: `  ${ageText(at - item.since)}`,
        last: '',
      })),
      ...(waitNote === '' ? [] : [{ symbol: WAITING, color: 'warning', text: waitNote, age: '', last: '' }]),
      // A call waiting on the person's permission is not running yet: it shows once, as waiting.
      ...runs.filter(item => !waits.some(wait => wait.id === item.id)).map(item => ({
        symbol: item.kind === 'agent' ? AGENT : item.background ? BACKGROUND : SHELL,
        color: 'suggestion',
        text: item.label,
        age: `  ${ageText(at - item.startedAt)}`,
        last: item.last,
      })),
    ]
    const footer = [written === null ? '아직 정리 전' : `${ageText(at - written.at)} 전 정리`, ...(unwritten > 0 ? [`새 기록 ${unwritten}개 정리 대기`] : [])].join(' · ')

    return (
      <Box flexDirection="column">
        <Text bold>{truncate(title, columns)}</Text>
        {(written?.now || said) !== '' && <Text>{truncate(written?.now || said, columns)}</Text>}

        {live.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            {live.map(item => (
              <Box flexDirection="column">
                <Box flexDirection="row">
                  <Text color={item.color}>{truncate(`${item.symbol} ${item.text}`, Math.max(8, columns - width(item.age)))}</Text>
                  <Text dimColor>{item.age}</Text>
                </Box>
                {item.last !== '' && <Text dimColor>{truncate(`    ${item.last}`, columns)}</Text>}
              </Box>
            ))}
          </Box>
        )}

        {blocks.map(block => (
          <Box flexDirection="column" marginTop={1}>
            {block.title !== '' && <Text dimColor bold>{truncate(block.title, columns)}</Text>}
            {drawBlock(Box, Text, block, columns, byId, at)}
          </Box>
        ))}

        <Box marginTop={1}>
          <Text dimColor>{truncate(footer, columns)}</Text>
        </Box>
      </Box>
    )
  })
}

// ── Drawing the blocks ──────────────────────────────────────────────────────

// An element of the surface's table, drawn through the JSX factory.
type Draw = Parameters<typeof h>[0]
type Node = ReturnType<typeof h>

const TONE_COLOR: Record<Tone, string | undefined> = { normal: undefined, good: 'success', warn: 'warning', bad: 'error', muted: undefined }

function drawBlock(BoxEl: unknown, TextEl: unknown, block: SummaryBlock, columns: number, byId: Map<number, LogEntry>, at: number): Node {
  const Box = BoxEl as Draw
  const Text = TextEl as Draw
  const ago = (from: number) => {
    const entry = byId.get(from)
    return entry === undefined ? '' : `${ageText(at - entry.at)} 전`
  }
  switch (block.kind) {
    case 'graph':
      return drawGraph(Box, Text, block.nodes, columns)
    case 'table':
      return drawTable(Box, Text, block.columns, block.rows.map(row => ({ ...row, age: ago(row.from) })), columns)
    case 'bars':
      return drawBars(Box, Text, block.items.map(item => ({ ...item, age: ago(item.from) })), columns)
    case 'metrics':
      return drawMetrics(Box, Text, block.items.map(item => ({ ...item, age: ago(item.from) })), columns)
    case 'list':
      return h(Box, { flexDirection: 'column' }, ...block.items.map(item => h(Text, { color: TONE_COLOR[item.tone], dimColor: item.tone === 'muted' }, truncate(`• ${item.text}`, columns))))
  }
}

// How each state is drawn: the box's border and color, and the symbol before the label.
const NODE_LOOK: Record<NodeState, { symbol: string; border: string; color: string | undefined; dim: boolean; bold: boolean }> = {
  done: { symbol: '✓', border: 'round', color: 'success', dim: false, bold: false },
  now: { symbol: '●', border: 'bold', color: 'suggestion', dim: false, bold: true },
  todo: { symbol: '○', border: 'dashed', color: 'subtle', dim: true, bold: false },
  failed: { symbol: '✗', border: 'round', color: 'error', dim: false, bold: false },
  wait: { symbol: '◆', border: 'round', color: 'warning', dim: false, bold: false },
}

/** Columns a node box takes: its widest line, the padding and the border. */
export function nodeWidth(node: { label: string; note: string; back?: boolean }): number {
  return Math.max(width(`✓ ${node.label}`), width(`${node.back === true ? '↺ ' : ''}${node.note}`)) + 4
}

/**
 * The main path as boxes joined by arrows, as many to a row as the pane holds,
 * and under a box what branched off it: a failure, a retry, a wait.
 *
 *   ╭────────╮   ╭────────╮   ┏━━━━━━━━┓
 *   │✓ 빌드  │─▶ │✓ 링크  │─▶ ┃● 최적화┃
 *   │12쪽    │   ╰────────╯   ┃38/64   ┃
 *   ╰────────╯                ┗━━━━━━━━┛
 *       │
 *       ▼
 *   ╭────────╮
 *   │✗ 경로  │
 *   │↺ 3개   │
 *   ╰────────╯
 */
function drawGraph(Box: Draw, Text: Draw, nodes: readonly GraphNode[], columns: number): Node {
  const ARROW = '─▶ '
  const box = (item: { label: string; state: NodeState; note: string }, back = false) => {
    const look = NODE_LOOK[item.state]
    const inner = nodeWidth({ ...item, back }) - 4
    return h(
      Box,
      { flexDirection: 'column', borderStyle: look.border, borderColor: look.color, paddingX: 1, width: inner + 4 },
      h(Text, { color: look.color === 'subtle' ? undefined : look.color, dimColor: look.dim, bold: look.bold }, truncate(`${look.symbol} ${item.label}`, inner)),
      item.note !== '' || back ? h(Text, { dimColor: true }, truncate(`${back ? '↺ ' : ''}${item.note}`, inner)) : null,
    )
  }
  // A column is a box with what branched under it; its arrow hangs on the box and
  // stretches across any width a wider branch adds, so it always meets the next box.
  const columnWidth = (node: GraphNode, last: boolean) =>
    Math.max(nodeWidth(node) + (last ? 0 : 3), ...node.branches.map(branch => nodeWidth(branch) + (last ? 0 : 1)))
  const column = (node: GraphNode, last: boolean) => {
    const arrow = last ? '' : `${'─'.repeat(Math.max(1, columnWidth(node, false) - nodeWidth(node) - 2))}▶ `
    const middle = ' '.repeat(Math.floor(nodeWidth(node) / 2) - 1)
    return h(
      Box,
      { flexDirection: 'column', width: columnWidth(node, last) },
      h(Box, { flexDirection: 'row' }, box(node), arrow === '' ? null : h(Box, { marginTop: 1 }, h(Text, { dimColor: true }, arrow))),
      ...node.branches.map(branch =>
        h(
          Box,
          { flexDirection: 'column' },
          h(Text, { color: NODE_LOOK[branch.state].color, dimColor: branch.state === 'todo' }, `${middle}│`),
          h(Text, { color: NODE_LOOK[branch.state].color, dimColor: branch.state === 'todo' }, `${middle}▼`),
          box(branch, branch.back),
        ),
      ),
    )
  }
  // Rows of columns that fit the pane; the next row continues the path.
  const rows: GraphNode[][] = [[]]
  let used = 0
  nodes.forEach((node, i) => {
    const need = columnWidth(node, i === nodes.length - 1)
    if (used > 0 && used + need > columns - 2) {
      rows.push([])
      used = 0
    }
    rows[rows.length - 1]!.push(node)
    used += need
  })
  return h(
    Box,
    { flexDirection: 'column' },
    ...rows.map((row, r) =>
      h(
        Box,
        { flexDirection: 'row', marginTop: r === 0 ? 0 : 1 },
        r === 0 ? null : h(Box, { marginTop: 1 }, h(Text, { dimColor: true }, '↳ ')),
        ...row.map(node => column(node, node === nodes[nodes.length - 1])),
      ),
    ),
  )
}

function drawTable(Box: Draw, Text: Draw, head: readonly string[], rows: readonly { cells: readonly string[]; tone: Tone; age: string }[], columns: number): Node {
  const withAge = rows.some(row => row.age !== '')
  const titles = withAge ? [...head, '확인'] : [...head]
  const cells = rows.map(row => {
    const filled = head.map((_, c) => row.cells[c] ?? '')
    return withAge ? [...filled, row.age] : filled
  })
  const gap = 2
  const widths = titles.map((title, c) => Math.max(width(title), ...cells.map(row => width(row[c] ?? ''))))
  // Narrow the widest column until the table fits the pane.
  while (widths.reduce((a, b) => a + b, 0) + gap * (widths.length - 1) > columns) {
    const widest = widths.indexOf(Math.max(...widths))
    if (widths[widest]! <= 4) break
    widths[widest] = widths[widest]! - 1
  }
  const line = (row: readonly string[]) => row.map((cell, c) => pad(truncate(cell, widths[c]!), widths[c]!)).join(' '.repeat(gap)).trimEnd()
  const total = Math.min(columns, widths.reduce((a, b) => a + b, 0) + gap * (widths.length - 1))
  return h(
    Box,
    { flexDirection: 'column' },
    h(Text, { dimColor: true }, line(titles)),
    h(Text, { dimColor: true }, '─'.repeat(total)),
    ...cells.map((row, r) => h(Text, { color: TONE_COLOR[rows[r]!.tone], dimColor: rows[r]!.tone === 'muted' }, line(row))),
  )
}

// epoch  ██████░░░░░░  2/10  t384_lr1e4
function drawBars(Box: Draw, Text: Draw, items: readonly { label: string; value: number; max: number; note: string; tone: Tone; age: string }[], columns: number): Node {
  const labelWidth = Math.min(14, Math.max(...items.map(item => width(item.label))))
  const tails = items.map(item => ` ${trimNumber(item.value)}/${trimNumber(item.max)}${item.note === '' ? '' : `  ${item.note}`}${item.age === '' ? '' : `  ${item.age}`}`)
  const tailWidth = Math.max(...tails.map(width))
  const barWidth = Math.max(6, Math.min(24, columns - labelWidth - 2 - tailWidth))
  return h(
    Box,
    { flexDirection: 'column' },
    ...items.map((item, i) => {
      const filled = Math.round(Math.min(1, Math.max(0, item.value / item.max)) * barWidth)
      const color = item.tone === 'normal' ? 'suggestion' : TONE_COLOR[item.tone] ?? 'subtle'
      return h(
        Box,
        { flexDirection: 'row' },
        h(Text, { dimColor: true }, `${pad(truncate(item.label, labelWidth), labelWidth)}  `),
        h(Text, { color }, '█'.repeat(filled)),
        h(Text, { dimColor: true }, '░'.repeat(barWidth - filled)),
        h(Text, {}, truncate(tails[i]!, Math.max(0, columns - labelWidth - 2 - barWidth))),
      )
    }),
  )
}

// Boxed key numbers, each as wide as its content, as many to a row as the pane holds.
// When every number was seen at once, that time shows once under the boxes.
function drawMetrics(Box: Draw, Text: Draw, items: readonly { label: string; value: string; tone: Tone; age: string }[], columns: number): Node {
  const shared = items.every(item => item.age === items[0]!.age) ? items[0]!.age : undefined
  const captions = items.map(item => (shared !== undefined || item.age === '' ? item.label : `${item.label} · ${item.age}`))
  const content = Math.max(...items.map((item, i) => Math.max(width(item.value), width(captions[i]!))))
  const tileWidth = Math.min(columns, Math.max(8, content + 4))
  const perRow = Math.max(1, Math.min(items.length, Math.floor((columns + 1) / (tileWidth + 1))))
  const rows: number[][] = []
  for (let i = 0; i < items.length; i += perRow) rows.push(items.slice(i, i + perRow).map((_, j) => i + j))
  return h(
    Box,
    { flexDirection: 'column' },
    ...rows.map(row =>
      h(
        Box,
        { flexDirection: 'row', gap: 1 },
        ...row.map(i =>
          h(
            Box,
            { flexDirection: 'column', borderStyle: 'round', borderColor: 'subtle', width: tileWidth, paddingX: 1 },
            h(Text, { bold: true, color: TONE_COLOR[items[i]!.tone] }, truncate(items[i]!.value, tileWidth - 4)),
            h(Text, { dimColor: true }, truncate(captions[i]!, tileWidth - 4)),
          ),
        ),
      ),
    ),
    shared === undefined || shared === '' ? null : h(Text, { dimColor: true }, shared),
  )
}

function trimNumber(value: number): string {
  if (Number.isInteger(value)) return String(value)
  return String(Number(value.toPrecision(3)))
}

// ── Recording and waking the model ──────────────────────────────────────────

async function record($: EngineInterface, kind: LogEntry['kind'], text: string) {
  const at = await $.clock.now()
  await update($, log, list => [...list, { id: (list[list.length - 1]?.id ?? 0) + 1, at, kind, text: excerpt(text, 300) }].slice(-MAX_LOG))
  if (URGENT.has(kind)) await schedule($, SOON_MS)
  else if (await paneShown($)) await schedule($, LATER_MS)
}

async function schedule($: EngineInterface, ms: number) {
  const due = (await $.clock.now()) + ms
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

async function noteSize($: EngineInterface, size: PaneSize) {
  await update($, pane, () => size)
  // A summary laid out for another size class is laid out again for this one.
  const written = await read($, summary)
  if (written !== null && written.fit !== fitOf(size)) await schedule($, SOON_MS)
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
    const entries = await read($, log)
    const previous = await read($, summary)
    const newest = entries[entries.length - 1]?.id ?? 0
    const size = await read($, pane)
    const fit = fitOf(size)
    if (newest === 0 || (previous !== null && previous.covers >= newest && previous.fit === fit)) return

    const prompt = promptFor(entries.slice(-LOG_FOR_MODEL), previous, await read($, running), await read($, waiting), await read($, phase), await $.clock.now(), size)
    const text = await complete($, prompt)
    if (text === undefined) return
    const written = parseSummary(text, new Set(entries.map(entry => entry.id)))
    if (written === undefined) return
    const at = await $.clock.now()
    await update($, summary, () => ({ ...written, covers: newest, at, fit }))
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
  const startedAt = await $.clock.now()
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
  const took = ageText((await $.clock.now()) - startedAt)
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
  size: PaneSize | null = null,
): string {
  const covered = previous?.covers ?? 0
  const lines = entries.map(entry => `#${entry.id} ${ageText(at - entry.at)} 전${entry.id > covered ? ' (새)' : ''} ${entry.text}`)
  return [
    size === null ? '' : roomFor(size, runs, waits),
    size !== null && previous !== null && previous.fit !== fitOf(size) ? '창 크기가 지난번과 다르다: 새 크기에 맞게 다시 짠다.' : '',
    said === '' ? '' : `Claude가 알린 지금 단계: ${said}`,
    `돌아가는 것: ${runs.length === 0 ? '없음' : runs.map(item => `${item.kind === 'agent' ? '서브 에이전트' : '셸'} ${item.label} (${ageText(at - item.startedAt)}째)`).join('; ')}`,
    `사용자를 기다리는 것: ${waits.length === 0 ? '없음' : waits.map(item => item.label).join('; ')}`,
    previous === null ? '' : `지난번에 쓴 대시보드: ${JSON.stringify({ title: previous.title, now: previous.now, waiting: previous.waiting, blocks: previous.blocks })}`,
    '기록 (오래된 것부터):',
    ...lines,
  ]
    .filter(line => line !== '')
    .join('\n')
}

// A node box with a label of a few letters and its arrow: what one column of the graph takes.
const NODE_COLUMNS = 15

/** How many node boxes fit across the pane, about. */
export function nodesAcross(columns: number): number {
  return Math.max(1, Math.floor((columns - 2) / NODE_COLUMNS))
}

/**
 * What fits in a pane with `rows` for the blocks: the graph's boxes (a row of
 * them, two when one row holds fewer than three or the pane is tall), its
 * branches, and the rows left for the other blocks.
 */
export function layoutFor(columns: number, rows: number): { across: number; nodes: number; branches: number; rest: number } {
  const across = nodesAcross(columns)
  const lines = across < 3 || rows >= 30 ? 2 : 1
  const nodes = Math.min(8, across * lines)
  // A row of boxes takes 4 rows and 1 between; a branch under a box takes 6.
  let left = rows - (4 * lines + (lines - 1))
  const branches = left >= 12 ? 2 : left >= 6 ? 1 : 0
  left -= 6 * branches
  // The row between the graph and the next block.
  return { across, nodes, branches, rest: Math.max(0, left - 1) }
}

/**
 * The size class a summary is laid out for: what fits in the pane, with the rows
 * left for other blocks in bands. A resize within it keeps the summary.
 */
export function fitOf(size: PaneSize | null): string {
  if (size === null) return ''
  const room = layoutFor(size.columns, size.rows - 5)
  // Past two dozen rows, more room changes nothing the model would choose.
  const band = [2, 6, 12, 24].filter(edge => room.rest >= edge).length
  return `${room.nodes}/${room.branches}/${band}`
}

/** The pane's room told to the model, as limits it can keep without counting cells. */
export function roomFor(size: PaneSize, runs: readonly RunningItem[], waits: readonly WaitingItem[]): string {
  // Around the blocks: the title, the current line, the row above the first block,
  // the footer and the row above it, and the live lines with the row above them.
  const shown = runs.filter(item => !waits.some(wait => wait.id === item.id))
  const live = waits.length + shown.length + shown.filter(item => item.last !== '').length
  const rows = Math.max(4, size.rows - 5 - (live > 0 ? live + 1 : 0))
  const room = layoutFor(size.columns, rows)
  return [
    `창: 가로 ${size.columns}칸, 세로 ${size.rows}줄.`,
    `graph는 상자 ${room.nodes}개까지(한 줄에 ${room.across}개씩), 갈래는 ${room.branches === 0 ? '넣지 않는다' : `모두 합쳐 ${room.branches}개까지`}.`,
    room.rest < 2 ? 'graph 말고 다른 블록은 넣지 않는다.' : `graph 말고 다른 블록은 모두 합쳐 ${room.rest}줄 안에 넣는다.`,
  ].join(' ')
}

/** The model's JSON as a summary, or undefined when it is not one. */
export function parseSummary(text: string, ids: ReadonlySet<number>): Omit<Summary, 'covers' | 'at' | 'fit'> | undefined {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return undefined
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
  } catch {
    return undefined
  }
  const blocks = list(raw.blocks)
    .map(obj)
    .map(block => parseBlock(block, ids))
    .filter((block): block is SummaryBlock => block !== undefined)
    .slice(0, 5)
  return { title: str(raw.title, 30), now: str(raw.now, 60), waiting: str(raw.waiting, 50), blocks }
}

function parseBlock(block: Record<string, unknown>, ids: ReadonlySet<number>): SummaryBlock | undefined {
  // A block title is one word: whatever follows the first space is dropped.
  const title = str(block.title, 16).split(/\s+/)[0] ?? ''
  const from = (value: unknown) => (typeof value === 'number' && ids.has(value) ? value : 0)
  switch (block.kind) {
    case 'graph':
    case 'flow': {
      const nodes = list(block.kind === 'flow' ? block.steps : block.nodes)
        .map(obj)
        .map(node => ({
          label: str(node.label, 10),
          state: stateOf(node.state),
          note: str(node.note, 12),
          branches: list(node.branches)
            .map(obj)
            .map(branch => ({ label: str(branch.label, 10), state: stateOf(branch.state), note: str(branch.note, 12), back: branch.back === true }))
            .filter(branch => branch.label !== '')
            .slice(0, 2),
        }))
        .filter(node => node.label !== '')
        .slice(0, 8)
      return nodes.length === 0 ? undefined : { kind: 'graph', title, nodes: inOrder(nodes) }
    }
    case 'table': {
      const columns = list(block.columns).map(column => str(column, 12)).filter(column => column !== '').slice(0, 5)
      const rows = list(block.rows)
        .map(row => (Array.isArray(row) ? { cells: row } : obj(row)))
        .map(row => ({ cells: list(row.cells).map(cell => str(typeof cell === 'number' ? String(cell) : cell, 20)).slice(0, columns.length), tone: toneOf(row.tone), from: from(row.from) }))
        .filter(row => row.cells.some(cell => cell !== ''))
        .slice(0, 8)
      return columns.length === 0 || rows.length === 0 ? undefined : { kind: 'table', title, columns, rows }
    }
    case 'bars': {
      const items = list(block.items)
        .map(obj)
        .map(item => ({ label: str(item.label, 14), value: num(item.value), max: num(item.max), note: str(item.note, 14), tone: toneOf(item.tone), from: from(item.from) }))
        .filter(item => item.label !== '' && item.max > 0)
        .map(item => ({ ...item, note: repeatsValue(item.note, item.value, item.max) ? '' : item.note }))
        .slice(0, 6)
      return items.length === 0 ? undefined : { kind: 'bars', title, items }
    }
    case 'metrics': {
      const items = list(block.items)
        .map(obj)
        .map(item => ({ label: str(item.label, 12), value: str(typeof item.value === 'number' ? String(item.value) : item.value, 12), tone: toneOf(item.tone), from: from(item.from) }))
        .filter(item => item.label !== '' && item.value !== '')
        .slice(0, 4)
      return items.length === 0 ? undefined : { kind: 'metrics', title, items }
    }
    case 'list': {
      const items = list(block.items)
        .map(item => (typeof item === 'string' ? { text: item } : obj(item)))
        .map(item => ({ text: str(item.text, 60), tone: toneOf(item.tone) }))
        .filter(item => item.text !== '')
        .slice(0, 3)
      return items.length === 0 ? undefined : { kind: 'list', title, items }
    }
    default:
      return undefined
  }
}

/** A flow reads left to right: a step finished after the current one belongs before it. */
export function inOrder<S extends { state: NodeState }>(steps: readonly S[]): S[] {
  const now = steps.findIndex(step => step.state === 'now')
  if (now === -1) return [...steps]
  const before = steps.slice(0, now)
  const after = steps.slice(now + 1)
  const finished = after.filter(step => step.state === 'done' || step.state === 'failed')
  return [...before, ...finished, steps[now]!, ...after.filter(step => !finished.includes(step))]
}

/** Whether a bar's note only says again what its value shows (`38/64장` beside 38/64). */
export function repeatsValue(note: string, value: number, max: number): boolean {
  return note.replace(/\s+/g, '').includes(`${value}/${max}`)
}

const TONES = ['normal', 'good', 'warn', 'bad', 'muted'] as const
const STATES = ['done', 'now', 'todo', 'failed', 'wait'] as const
const stateOf = (value: unknown): NodeState => STATES.find(state => state === value) ?? 'todo'
const toneOf = (value: unknown): Tone => TONES.find(tone => tone === value) ?? 'normal'
const str = (value: unknown, max: number) => (typeof value === 'string' ? truncate(value.trim(), max) : '')
const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : Number(value) || 0)
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const obj = (value: unknown) => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {})

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
