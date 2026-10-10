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
const ask = atom({ plugin: 'dashboard', key: 'ask' } as const, '')
const now = atom({ plugin: 'dashboard', key: 'now' } as const, 0)
const pane = atom({ plugin: 'dashboard', key: 'pane' } as const, null)

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

// Log kinds that wake the model soon: the work changed phase or waits on the person.
const URGENT: ReadonlySet<LogEntry['kind']> = new Set(['signal', 'answer', 'permission', 'question', 'agent-done', 'agent-failed', 'shell-failed', 'background-done'])

const SIGNAL_DESCRIPTION = [
  "Marks a change in the work's phase on the person's progress dashboard.",
  'Call it when a new phase starts, a major phase ends, the work is blocked, or a decision from the person is needed.',
  "One short line in the person's language. Do not call it for routine steps.",
].join(' ')

// What the small model decides: the work's stages and what is worth watching.
// Lengths, counts, order and fitting the pane are the mod's, not the model's.
const SYSTEM = [
  '너는 Claude Code 세션의 작업 현황을 도식으로 설계한다. 사용자가 작업의 흐름과 지금 위치를 한눈에 보고 통제하게 하는 것이 목적이다.',
  '작업 기록을 읽고 이 작업에 맞는 도식을 고른다. 문장은 쓰지 않는다. 실행 중인 셸, 서브 에이전트, 사용자 대기는 mod가 위에 따로 보여 주므로 도식에 넣지 않는다.',
  'JSON 하나만 출력한다: {"now": "지금 하는 일, 20자 이내", "blocks": [중요한 것부터]}',
  '- {"kind": "graph", "nodes": [{"label": "", "state": "done|now|todo|failed|wait", "note": "", "from": 기록 번호, "branches": [{"label": "", "state": "", "note": "", "back": false}]}]}',
  '  작업의 단계 흐름. 거의 항상 첫 블록. label은 한 단어 명사 2~4자, note는 핵심 수치나 대상 8자 이내(없으면 빈 문자열), from은 그 단계가 시작된 기록 번호.',
  '  실패, 대기, 재시도, 곁다리 작업은 본 흐름에 두지 않고 그 단계의 branches로 둔다. 실패를 고쳐 넘어갔으면 back을 true로. 늘 붙어 다니는 단계는 하나로 묶는다.',
  '- {"kind": "bars", "items": [{"label": "", "value": 숫자, "max": 숫자, "tone": "normal|good|warn|bad", "from": 기록 번호}]}  끝이 정해진 진행률이 있을 때(epoch, 처리 개수, 점수). label은 6자 이내. from은 그 값을 확인한 기록 번호.',
  '- {"kind": "time"}  단계마다 실제로 걸린 시간. 작업이 길어 어디서 시간이 갔는지 볼 만할 때.',
  '창이 좁으면 상자를 줄이고 블록을 적게, 넓으면 단계를 나눠 펼친다. 창에 넘치는 블록은 뒤에서부터 잘린다.',
  '지난번 도식이 있으면 작업이 크게 바뀌지 않는 한 구성을 유지한다.',
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
      description: '작업 현황 대시보드를 옆에 엽니다',
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
    const asked = e.args.trim()
    if (asked === 'close') {
      await $.ui.close({ id: PANE })
      return { text: '대시보드를 닫았습니다.' }
    }
    await $.ui.open({ id: PANE, title: '작업 현황' })
    const at = await $.clock.now()
    await update($, now, () => at)
    // A moment for the pane's first draw to note its size, so the summary is laid out for it.
    $.clock.after(OPEN_MS, () => wake($, asked === 'refresh'))
    return { text: asked === 'refresh' ? '대시보드를 다시 그립니다.' : '작업 현황 대시보드를 열었습니다.' }
  })

  // The signal is the dashboard's own bookkeeping: it never needs the person's yes.
  on('tool.check', { tool: SIGNAL_ID }, () => ({ decision: 'allow' }))

  on('tool.call', { tool: SIGNAL_ID }, async ($, e) => {
    const input = e as unknown as { phase?: unknown; note?: unknown }
    const said = typeof input.phase === 'string' ? input.phase.trim() : ''
    const note = typeof input.note === 'string' ? input.note.trim() : ''
    if (said !== '') await update($, phase, () => said)
    // What Claude says is blocked or the person must decide waits on them until they answer.
    if (note !== '') await update($, ask, () => excerpt(note, 80))
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
    const said = await read($, phase)
    const asked = await read($, ask)
    const at = Math.max(await read($, now), await $.clock.now())
    const byId = new Map(entries.map(entry => [entry.id, entry]))

    // The top: one line each, led by its symbol, with how long it has taken on the right.
    const current = written?.now || said
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

    // Below it, only diagrams: as many as the pane holds, the model's most important first.
    const room = rows - topRows - (topRows > 0 ? 1 : 0)
    const blocks = fitBlocks(
      // A summary an older version of the mod wrote may hold kinds it no longer draws.
      (written?.blocks ?? [])
        .filter(block => KINDS.has(block.kind))
        .map(block => (block.kind === 'graph' ? { ...block, nodes: fitGraph(clipNodes(block.nodes, columns), columns, room) } : block))
        .map(block => ({ block, rows: blockRows(block, columns, byId, at) })),
      room + (topRows > 0 ? 1 : 0),
    )

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
        {blocks.map((block, i) => (
          <Box flexDirection="column" marginTop={i === 0 && top.length === 0 ? 0 : 1}>
            {drawBlock(Box, Text, block, columns, byId, at)}
          </Box>
        ))}
      </Box>
    )
  })
}

// ── Drawing the diagrams ────────────────────────────────────────────────────

// An element of the surface's table, drawn through the JSX factory.
type Draw = Parameters<typeof h>[0]
type Node = ReturnType<typeof h>

const KINDS: ReadonlySet<string> = new Set(['graph', 'bars', 'time'])
const TONE_COLOR: Record<Tone, string> = { normal: 'suggestion', good: 'success', warn: 'warning', bad: 'error' }

function drawBlock(BoxEl: unknown, TextEl: unknown, block: SummaryBlock, columns: number, byId: Map<number, LogEntry>, at: number): Node {
  const Box = BoxEl as Draw
  const Text = TextEl as Draw
  switch (block.kind) {
    case 'graph':
      return drawGraph(Box, Text, block.nodes, columns)
    case 'bars':
      return drawBars(Box, Text, block.items.map(item => ({ ...item, age: agoOf(item.from, byId, at) })), columns)
    case 'time':
      return drawTime(Box, Text, spans(block.items, byId, at), columns)
  }
}

function agoOf(from: number, byId: ReadonlyMap<number, { at: number }>, at: number): string {
  const entry = byId.get(from)
  return entry === undefined ? '' : `${ageText(at - entry.at)} 전`
}

/** The rows a block takes when drawn `columns` wide. */
export function blockRows(block: SummaryBlock, columns: number, byId: ReadonlyMap<number, { at: number }>, at: number): number {
  switch (block.kind) {
    case 'graph':
      return graphHeight(block.nodes, columns)
    case 'bars':
      return block.items.length
    case 'time':
      return spans(block.items, byId, at).length
  }
}

/**
 * The blocks that fit in `room` rows, each with the row above it, in the
 * model's order of importance: past the first, one that would not fit is left
 * out, and so is everything after it.
 */
export function fitBlocks<B>(blocks: readonly { block: B; rows: number }[], room: number): B[] {
  const kept: B[] = []
  let used = 0
  for (const { block, rows } of blocks) {
    if (rows === 0) continue
    if (kept.length > 0 && used + 1 + rows > room) break
    kept.push(block)
    used += 1 + rows
  }
  return kept
}

/**
 * The graph made to fit `room` rows: first the side tasks that went fine are
 * left out, then every branch, then the oldest finished stages fold into one
 * box that counts them. What is current and what is left always stays.
 */
export function fitGraph(nodes: readonly GraphNode[], columns: number, room: number): GraphNode[] {
  if (graphHeight(nodes, columns) <= room) return [...nodes]
  const quiet = nodes.map(node => ({ ...node, branches: node.branches.filter(branch => branch.state !== 'done' && branch.state !== 'now') }))
  if (graphHeight(quiet, columns) <= room) return quiet
  const bare: GraphNode[] = nodes.map(node => ({ ...node, branches: [] }))
  const settled = bare.findIndex(node => node.state !== 'done' && node.state !== 'failed')
  const foldable = settled === -1 ? bare.length - 1 : settled
  let fitted = bare
  for (let folded = 2; folded <= foldable && graphHeight(fitted, columns) > room; folded++) {
    const fold: GraphNode = { label: '…', state: 'done', note: `${folded}단계`, branches: [], from: bare[0]!.from }
    fitted = [fold, ...bare.slice(folded)]
  }
  return fitted
}

// How each state is drawn: the box's border and color, and the symbol before the label.
const NODE_LOOK: Record<NodeState, { symbol: string; border: string; color: string | undefined; dim: boolean; bold: boolean }> = {
  // Done stages stay quiet: color is kept for where the eye should go.
  done: { symbol: '✓', border: 'round', color: 'subtle', dim: false, bold: false },
  now: { symbol: '●', border: 'bold', color: 'suggestion', dim: false, bold: true },
  todo: { symbol: '○', border: 'dashed', color: 'subtle', dim: true, bold: false },
  failed: { symbol: '✗', border: 'round', color: 'error', dim: false, bold: false },
  wait: { symbol: '◆', border: 'round', color: 'warning', dim: false, bold: false },
}

/**
 * Labels and notes cut only where the pane needs it: a box may be as wide as
 * leaves room for two side by side, so a narrow pane cuts and a wide one does not.
 */
export function clipNodes(nodes: readonly GraphNode[], columns: number): GraphNode[] {
  const inner = Math.max(8, Math.floor((columns - 2) / 2) - 7)
  const clip = <N extends { label: string; note: string; back?: boolean }>(node: N): N => ({
    ...node,
    label: truncate(node.label, inner - 2),
    note: truncate(node.note, inner - (node.back === true ? 2 : 0)),
  })
  return nodes.map(node => ({ ...clip(node), branches: node.branches.map(clip) }))
}

/** Columns a node box takes: its widest line, the padding and the border. */
export function nodeWidth(node: { label: string; note: string; back?: boolean }): number {
  return Math.max(width(`✓ ${node.label}`), width(`${node.back === true ? '↺ ' : ''}${node.note}`)) + 4
}

/** Rows a node box takes: its label, its note when it has one, and the border. */
function nodeHeight(node: { note: string; back?: boolean }): number {
  return node.note !== '' || node.back === true ? 4 : 3
}

// A column is a box with what branched under it; its arrow hangs on the box and
// stretches across any width a wider branch adds, so it always meets the next box.
function columnWidth(node: GraphNode, last: boolean): number {
  return Math.max(nodeWidth(node) + (last ? 0 : 3), ...node.branches.map(branch => nodeWidth(branch) + (last ? 0 : 1)))
}

function columnHeight(node: GraphNode): number {
  return nodeHeight(node) + node.branches.reduce((sum, branch) => sum + 2 + nodeHeight(branch), 0)
}

function rowsOf(nodes: readonly GraphNode[], columns: number): GraphNode[][] {
  return graphRows(nodes.map((node, i) => columnWidth(node, i === nodes.length - 1)), columns - 2).map(row => row.map(i => nodes[i]!))
}

function graphHeight(nodes: readonly GraphNode[], columns: number): number {
  const rows = rowsOf(nodes, columns)
  return rows.reduce((sum, row) => sum + Math.max(...row.map(columnHeight)), 0) + rows.length - 1
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
  const rows = rowsOf(nodes, columns)
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

/**
 * Which columns go on each row: as few rows as fit `room`, the columns spread
 * evenly over them, so no box is left alone on a last row.
 */
export function graphRows(widths: readonly number[], room: number): number[][] {
  const greedy: number[][] = [[]]
  let used = 0
  widths.forEach((need, i) => {
    if (used > 0 && used + need > room) {
      greedy.push([])
      used = 0
    }
    greedy[greedy.length - 1]!.push(i)
    used += need
  })
  const per = Math.ceil(widths.length / greedy.length)
  const even = greedy.map((_, r) => widths.map((_, i) => i).slice(r * per, (r + 1) * per)).filter(row => row.length > 0)
  // A column's arrow is part of its width: the last on a row hangs one, which still fits.
  const fits = even.length === greedy.length && even.every(row => row.reduce((sum, i) => sum + widths[i]!, 0) <= room)
  return fits ? even : greedy
}

/**
 * Each stage's start and length from the log entries the stages began at: a
 * stage lasts until the next one begins, the last until now. A start the model
 * cited out of order is held at the one before, and a stage whose entry is
 * gone from the log is left out.
 */
export function spans(items: readonly { label: string; state: NodeState; from: number }[], byId: ReadonlyMap<number, { at: number }>, at: number): { label: string; state: NodeState; start: number; end: number }[] {
  const started: { label: string; state: NodeState; start: number }[] = []
  for (const item of items) {
    const entry = byId.get(item.from)
    if (entry === undefined) continue
    started.push({ label: item.label, state: item.state, start: Math.max(entry.at, started[started.length - 1]?.start ?? entry.at) })
  }
  return started.map((item, i) => ({ ...item, end: Math.max(item.start, started[i + 1]?.start ?? at) }))
}

/**
 * The stages on one honest time axis, a row each: where the bar starts is when
 * the stage began, its length how long it took. The current stage is the one
 * in color.
 *
 *   준비  ██                      3분
 *   빌드    ████████             22분
 *   배포            ██████  14분째
 */
function drawTime(Box: Draw, Text: Draw, rows: readonly { label: string; state: NodeState; start: number; end: number }[], columns: number): Node {
  if (rows.length === 0) return null
  const first = rows[0]!.start
  const last = Math.max(...rows.map(row => row.end))
  const tails = rows.map(row => `${ageText(row.end - row.start)}${row.state === 'now' ? '째' : ''}`)
  const labelWidth = Math.min(16, Math.max(...rows.map(row => width(row.label))))
  const tailWidth = Math.max(...tails.map(width))
  const area = Math.max(8, Math.min(48, columns - labelWidth - 2 - 1 - tailWidth))
  const scale = (ms: number) => (last === first ? 0 : Math.round(((ms - first) / (last - first)) * area))
  return h(
    Box,
    { flexDirection: 'column' },
    ...rows.map((row, i) => {
      const from = Math.min(area - 1, scale(row.start))
      const length = Math.max(1, Math.min(area - from, scale(row.end) - from))
      const look = NODE_LOOK[row.state]
      return h(
        Box,
        { flexDirection: 'row' },
        h(Text, { dimColor: row.state !== 'now', bold: row.state === 'now' }, `${pad(truncate(row.label, labelWidth), labelWidth)}  `),
        h(Text, {}, ' '.repeat(from)),
        h(Text, { color: look.color === 'subtle' ? undefined : look.color, dimColor: row.state === 'done' }, '█'.repeat(length)),
        h(Text, { dimColor: row.state !== 'now' }, `${' '.repeat(area - from - length)} ${tails[i]!}`),
      )
    }),
  )
}

// epoch  ██████░░░░░░ 2/10  36분 전
function drawBars(Box: Draw, Text: Draw, items: readonly { label: string; value: number; max: number; tone: Tone; age: string }[], columns: number): Node {
  const labelWidth = Math.min(14, Math.max(...items.map(item => width(item.label))))
  const tails = items.map(item => ` ${valueText(item.value, item.max)}${item.age === '' ? '' : `  ${item.age}`}`)
  const tailWidth = Math.max(...tails.map(width))
  const barWidth = Math.max(6, Math.min(24, columns - labelWidth - 2 - tailWidth))
  return h(
    Box,
    { flexDirection: 'column' },
    ...items.map((item, i) => {
      const filled = Math.round(Math.min(1, Math.max(0, item.value / item.max)) * barWidth)
      return h(
        Box,
        { flexDirection: 'row' },
        h(Text, { dimColor: true }, `${pad(truncate(item.label, labelWidth), labelWidth)}  `),
        h(Text, { color: TONE_COLOR[item.tone] }, '█'.repeat(filled)),
        h(Text, { dimColor: true }, '░'.repeat(barWidth - filled)),
        h(Text, {}, truncate(tails[i]!, Math.max(0, columns - labelWidth - 2 - barWidth))),
      )
    }),
  )
}

/** A bar's value beside its end: `2/10`, or the value alone for a ratio out of 1 (an AUC, a share). */
export function valueText(value: number, max: number): string {
  return max === 1 ? trimNumber(value) : `${trimNumber(value)}/${trimNumber(max)}`
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
    return (await $.ui.panes()).some(one => one.id === PANE && one.isShown)
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
  const asking = (model: string) => $.model.complete({ model, system: SYSTEM, prompt, maxTokens: 900, effort: 'low', timeoutMs: 30_000 })
  let answer
  try {
    answer = await asking(fallback ?? preferred)
  } catch {
    // The organization may not allow the preferred model: use the session's.
    if (fallback !== undefined) return undefined
    fallback = await $.session.model()
    answer = await asking(fallback)
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

/** What the small model reads: the pane, the log, what runs and waits, and what it drew last. */
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
    size === null ? '' : `창: 가로 ${size.columns}칸, 세로 ${size.rows}줄. 단계 상자는 한 줄에 ${nodesAcross(size.columns)}개쯤 들어간다.`,
    size !== null && previous !== null && previous.fit !== fitOf(size) ? '창 크기가 지난번과 다르다: 새 크기에 맞게 다시 짠다.' : '',
    said === '' ? '' : `Claude가 알린 지금 단계: ${said}`,
    `돌아가는 것: ${runs.length === 0 ? '없음' : runs.map(item => `${item.kind === 'agent' ? '서브 에이전트' : '셸'} ${item.label} (${ageText(at - item.startedAt)}째)`).join('; ')}`,
    `사용자를 기다리는 것: ${waits.length === 0 ? '없음' : waits.map(item => item.label).join('; ')}`,
    previous === null ? '' : `지난번 도식: ${JSON.stringify({ now: previous.now, blocks: previous.blocks })}`,
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
 * The size class a summary is laid out for: the boxes across and a band of
 * rows. A resize within it keeps the summary; one across it lays it out again.
 */
export function fitOf(size: PaneSize | null): string {
  if (size === null) return ''
  const band = [20, 40].filter(edge => size.rows >= edge).length
  return `${Math.min(8, nodesAcross(size.columns))}/${band}`
}

/** The model's JSON as a summary, or undefined when it is not one. Counts and lengths are held here. */
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
  const from = (value: unknown) => (typeof value === 'number' && ids.has(value) ? value : 0)
  const blocks = list(raw.blocks).map(obj)
  const graph = blocks.find(block => block.kind === 'graph' || block.kind === 'flow')
  const nodes = graph === undefined ? [] : nodesOf(graph, from)
  const parsed = blocks
    .map((block): SummaryBlock | undefined => {
      switch (block.kind) {
        case 'graph':
        case 'flow':
          return block === graph && nodes.length > 0 ? { kind: 'graph', nodes } : undefined
        case 'bars': {
          const items = list(block.items)
            .map(obj)
            .map(item => ({ label: str(item.label, 14), value: num(item.value), max: num(item.max), tone: toneOf(item.tone), from: from(item.from) }))
            .filter(item => item.label !== '' && item.max > 0)
            .slice(0, 6)
          return items.length === 0 ? undefined : { kind: 'bars', items }
        }
        case 'time': {
          // The graph's stages that began somewhere in the log; the mod measures them.
          const items = nodes.filter(node => node.state !== 'todo' && node.from > 0).map(node => ({ label: node.label, state: node.state, from: node.from }))
          return items.length < 2 ? undefined : { kind: 'time', items }
        }
        default:
          return undefined
      }
    })
    .filter((block): block is SummaryBlock => block !== undefined)
    .slice(0, 4)
  return { now: str(raw.now, 60), blocks: parsed }
}

function nodesOf(graph: Record<string, unknown>, from: (value: unknown) => number): GraphNode[] {
  const nodes = list(graph.kind === 'flow' ? graph.steps : graph.nodes)
    .map(obj)
    .map(node => ({
      label: str(node.label, 24),
      state: stateOf(node.state),
      note: str(node.note, 32),
      from: from(node.from),
      branches: list(node.branches)
        .map(obj)
        .map(branch => ({ label: str(branch.label, 24), state: stateOf(branch.state), note: str(branch.note, 32), back: branch.back === true }))
        .filter(branch => branch.label !== '')
        .slice(0, 2),
    }))
    .filter(node => node.label !== '')
    .slice(0, 8)
  return inOrder(nodes)
}

/** A flow reads left to right: a step finished after the current one belongs before it. */
export function inOrder<S extends { state: NodeState }>(steps: readonly S[]): S[] {
  const current = steps.findIndex(step => step.state === 'now')
  if (current === -1) return [...steps]
  const before = steps.slice(0, current)
  const after = steps.slice(current + 1)
  const finished = after.filter(step => step.state === 'done' || step.state === 'failed')
  return [...before, ...finished, steps[current]!, ...after.filter(step => !finished.includes(step))]
}

const TONES = ['normal', 'good', 'warn', 'bad'] as const
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
  return minutes % 60 === 0 ? `${minutes / 60}시간` : `${Math.floor(minutes / 60)}시간 ${minutes % 60}분`
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
