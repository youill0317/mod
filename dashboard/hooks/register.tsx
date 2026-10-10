import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRow, Dashboard, Item, Json, Pick, Source, Tone } from '../types'

const PANE = 'dashboard'
const TOOL = 'show'
const TOOL_ID = 'mcp__dashboard__show'

const spec = atom({ plugin: 'dashboard', key: 'spec' } as const, null)
const approved = atom({ plugin: 'dashboard', key: 'approved' } as const, false)
const values = atom({ plugin: 'dashboard', key: 'values' } as const, {})
const errors = atom({ plugin: 'dashboard', key: 'errors' } as const, {})
const history = atom({ plugin: 'dashboard', key: 'history' } as const, {})
const updatedAt = atom({ plugin: 'dashboard', key: 'updatedAt' } as const, null)
const now = atom({ plugin: 'dashboard', key: 'now' } as const, 0)
const agents = atom({ plugin: 'dashboard', key: 'agents' } as const, [])

const TICK_MS = 5_000
const MIN_REFRESH_SECONDS = 5
const DEFAULT_REFRESH_SECONDS = 15
const MAX_SOURCE_CHARS = 20_000
const MAX_HISTORY = 120
const MAX_AGENTS = 20
const MAX_TABLE_ROWS = 20

const SOURCE_SCHEMA = {
  type: 'object',
  description: 'Exactly one of command, file or url.',
  properties: {
    command: { type: 'array', items: { type: 'string' }, description: 'argv run without a shell; stdout is read. The person approves commands once.' },
    file: { type: 'string', description: 'Text file path, relative to the working directory or absolute.' },
    url: { type: 'string', description: 'URL fetched with GET.' },
  },
}

const PICK_SCHEMA = {
  type: 'object',
  required: ['source'],
  properties: {
    source: { type: 'string', description: 'Id of an entry in sources.' },
    path: { type: 'string', description: 'Path into the JSON value, e.g. runs.0.loss.' },
    regex: { type: 'string', description: 'Regex over the text; group 1 or the whole match. For sparkline every match is a point.' },
  },
}

const INPUT_SCHEMA = {
  type: 'object',
  required: ['title', 'sections'],
  properties: {
    title: { type: 'string' },
    refreshSeconds: { type: 'number', description: `How often sources are read again; at least ${MIN_REFRESH_SECONDS}, default ${DEFAULT_REFRESH_SECONDS}.` },
    sources: { type: 'object', additionalProperties: SOURCE_SCHEMA, description: 'Live values by id.' },
    sections: {
      type: 'array',
      items: {
        type: 'object',
        required: ['items'],
        properties: {
          title: { type: 'string' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              required: ['kind'],
              description:
                'kind text {text|from, tone}; stat {label, value|from, unit, tone}; progress {label, current|from (number, "a/b" or {current,total}), total|totalFrom}; sparkline {label, values|from (number appended each refresh, or number list)}; status {label, state|from, detail}; table {columns, rows|from (rows, objects keyed by column, or text lines)}; agents {} (live subagents of this session). tone: normal good warn bad muted accent.',
              properties: {
                kind: { type: 'string', enum: ['text', 'stat', 'progress', 'sparkline', 'status', 'table', 'agents'] },
                label: { type: 'string' },
                text: { type: 'string' },
                value: { type: ['string', 'number'] },
                unit: { type: 'string' },
                tone: { type: 'string', enum: ['normal', 'good', 'warn', 'bad', 'muted', 'accent'] },
                current: { type: 'number' },
                total: { type: 'number' },
                values: { type: 'array', items: { type: 'number' } },
                state: { type: 'string' },
                detail: { type: 'string' },
                columns: { type: 'array', items: { type: 'string' } },
                rows: { type: 'array', items: { type: 'array', items: { type: ['string', 'number'] } } },
                from: PICK_SCHEMA,
                totalFrom: PICK_SCHEMA,
              },
            },
          },
        },
      },
    },
  },
}

const TOOL_DESCRIPTION = [
  'Shows a live dashboard in a pane beside the conversation, replacing any dashboard shown before.',
  'Design it for what the person is working on now: sections of items, kept short for a pane about 40 to 60 columns wide.',
  'Values that change go in sources (a command, a file or a URL) read again every refreshSeconds, and items point at them with from.',
  'Values you already know can be given directly. Call it again with a new design to change the dashboard.',
].join(' ')

const designPrompt = (ask: string) =>
  [
    '사용자가 /dashboard 를 실행했습니다. 지금까지의 작업 맥락을 바탕으로, 사용자가 지금 한눈에 보고 싶어 할 실시간 대시보드를 설계해서 띄워 주세요.',
    ask === '' ? '' : `사용자의 요청: ${ask}`,
    `${TOOL_ID} 도구를 쓰세요. 목록에 없으면 ToolSearch에서 "select:${TOOL_ID}"로 불러옵니다.`,
    '계속 바뀌는 값은 sources에 읽는 방법(명령, 파일, URL)을 넣고 from으로 연결하세요. 이미 아는 값은 직접 넣어도 됩니다.',
    '서브 에이전트를 쓰는 작업이면 agents 항목을 넣으세요. 창 폭은 40~60열 정도이니 간결하게 짜세요.',
    '띄운 뒤에는 무엇을 보여 주는지 한두 문장으로만 알려 주세요.',
  ]
    .filter(line => line !== '')
    .join('\n')

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'dashboard',
      description: 'Claude가 지금 작업에 맞춘 실시간 대시보드를 옆에 띄웁니다',
      argumentHint: '[요청 | refresh | close]',
    })
    await $.tool.register({ name: TOOL, description: TOOL_DESCRIPTION, inputSchema: INPUT_SCHEMA, isDeferred: true })
    $.clock.every(TICK_MS, () => tick($))
    return next(e)
  })

  on('command.run', { command: 'dashboard' }, async ($, e) => {
    const ask = e.args.trim()
    const current = await read($, spec)

    if (ask === 'close') {
      await $.ui.close({ id: PANE })
      return { text: '대시보드를 닫았습니다.' }
    }
    if (ask === 'refresh') {
      if (current === null) return { text: '아직 대시보드가 없습니다. /dashboard 로 만들어 주세요.' }
      await refresh($, current)
      return { text: '대시보드를 새로 읽었습니다.' }
    }
    if (ask === '' && current !== null) {
      await $.ui.open({ id: PANE, title: current.title })
      return { text: `대시보드를 열었습니다: ${current.title}` }
    }

    // A command cannot start a turn while it runs: the prompt goes right after it.
    const text = designPrompt(ask)
    $.clock.after(0, () => submitDesign($, text))
    return { text: '지금 작업에 맞는 대시보드를 Claude가 설계합니다.' }
  })

  on('tool.call', { tool: TOOL_ID }, async ($, e) => {
    const design = toDashboard(e)
    if (typeof design === 'string') return { result: `대시보드를 띄우지 못했습니다: ${design}` }

    const commands = Object.values(design.sources ?? {}).filter(source => source.command !== undefined)
    const allowed = commands.length === 0 ? true : await askToRun($, design)

    await update($, spec, () => design)
    await update($, approved, () => allowed)
    await update($, values, () => ({}))
    await update($, errors, () => ({}))
    await update($, history, () => ({}))
    await refresh($, design)

    const opened = await $.ui.open({ id: PANE, title: design.title })
    const failed = Object.keys(await read($, errors))

    return {
      result: [
        `대시보드 "${design.title}"를 띄웠습니다.`,
        opened.isPlaced ? '' : '터미널 폭이 좁아 아직 화면에 배치되지 않았습니다. 사용자가 /dashboard 로 열 수 있습니다.',
        commands.length === 0 ? '' : allowed ? '명령 실행이 허용됐습니다.' : '사용자가 명령 실행을 허용하지 않아 명령으로 읽는 값은 비어 있습니다.',
        failed.length === 0 ? '' : `읽지 못한 소스: ${failed.join(', ')}`,
      ]
        .filter(line => line !== '')
        .join('\n'),
    }
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    const id = started.agentId
    if (id !== undefined) {
      const row: AgentRow = {
        id,
        type: e.subagentType,
        description: e.description,
        startedAt: (await $.clock.now()),
        endedAt: null,
        tools: 0,
        last: '',
        status: 'running',
      }
      await update($, agents, list => [...list.filter(one => one.id !== id), row].slice(-MAX_AGENTS))
    }
    return started
  })

  on('tool.call', async ($, e, next) => {
    const id = e.agentId
    if (id !== undefined) {
      const last = activityOf(e)
      await update($, agents, list => list.map(one => (one.id === id ? { ...one, tools: one.tools + 1, last } : one)))
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const ended = await next(e)
    const id = e.agentId
    if (id !== undefined) {
      const status = e.reason === 'answer' ? 'done' : 'failed'
      const at = (await $.clock.now())
      await update($, agents, list => list.map(one => (one.id === id ? { ...one, status, endedAt: at } : one)))
    }
    return ended
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const design = await read($, spec)
    const columns = Math.max(20, e.props.bodyColumns)

    if (design === null) {
      return (
        <Box flexDirection="column">
          <Text dimColor>아직 대시보드가 없습니다. /dashboard 를 입력하면 Claude가 지금 작업에 맞춰 만듭니다.</Text>
        </Box>
      )
    }

    const read$ = {
      values: await read($, values),
      errors: await read($, errors),
      history: await read($, history),
      approved: await read($, approved),
      agents: await read($, agents),
      now: Math.max(await read($, now), (await $.clock.now())),
      updatedAt: await read($, updatedAt),
    }
    const every = refreshSecondsOf(design)
    const ago = read$.updatedAt === null ? '아직 안 읽음' : `${ageText(read$.now - read$.updatedAt)} 전 갱신`
    const hasSources = Object.keys(design.sources ?? {}).length > 0

    return (
      <Box flexDirection="column">
        {hasSources && <Text dimColor>{truncate(`${ago} · ${every}초마다`, columns)}</Text>}
        {design.sections.map((section, s) => (
          <Box flexDirection="column" marginTop={1}>
            {section.title !== undefined && section.title !== '' && (
              <Text bold color="claude">
                {truncate(section.title, columns)}
              </Text>
            )}
            {section.items.map((item, i) => drawItem(Box, Text, item, `${s}.${i}`, columns, read$))}
          </Box>
        ))}
        {Object.entries(read$.errors).map(([id, message]) => (
          <Text color="error">{truncate(`! ${id}: ${message}`, columns)}</Text>
        ))}
      </Box>
    )
  })
}

async function submitDesign($: EngineInterface, text: string) {
  await $.prompt.submit({ text })
}

// ── Reading ─────────────────────────────────────────────────────────────────

async function tick($: EngineInterface) {
  const design = await read($, spec)
  if (design === null) return
  const shown = (await $.ui.panes()).some(pane => pane.id === PANE && pane.isShown)
  if (!shown) return
  const at = (await $.clock.now())
  await update($, now, () => at)
  const last = await read($, updatedAt)
  if (last === null || at - last >= refreshSecondsOf(design) * 1000 - 500) await refresh($, design)
}

async function refresh($: EngineInterface, design: Dashboard) {
  const allowed = await read($, approved)
  const entries = Object.entries(design.sources ?? {})
  const readings = await Promise.all(
    entries.map(async ([id, source]) => {
      try {
        return { id, value: await readSource($, source, allowed) }
      } catch (error) {
        return { id, error: errorText(error) }
      }
    }),
  )

  const fresh: Record<string, Json> = {}
  const failed: Record<string, string> = {}
  for (const reading of readings) {
    if ('error' in reading && reading.error !== undefined) failed[reading.id] = reading.error
    else if ('value' in reading && reading.value !== undefined) fresh[reading.id] = reading.value
  }

  await update($, values, old => ({ ...old, ...fresh }))
  await update($, errors, () => failed)

  // Sparklines that read one number gain a point on every refresh.
  const points: Record<string, number> = {}
  design.sections.forEach((section, s) =>
    section.items.forEach((item, i) => {
      if (item.kind !== 'sparkline' || item.from === undefined || item.from.regex !== undefined) return
      const value = pickValue(fresh, item.from)
      const number = toNumber(value)
      if (number !== undefined && !Array.isArray(value)) points[`${s}.${i}`] = number
    }),
  )
  if (Object.keys(points).length > 0) {
    await update($, history, old => {
      const out: Record<string, number[]> = { ...old }
      for (const [key, number] of Object.entries(points)) out[key] = [...(out[key] ?? []), number].slice(-MAX_HISTORY)
      return out
    })
  }

  const at = (await $.clock.now())
  await update($, updatedAt, () => at)
  await update($, now, () => at)
}

async function readSource($: EngineInterface, source: Source, allowed: boolean): Promise<Json> {
  let text: string
  if (source.command !== undefined) {
    if (!allowed) throw new Error('명령 실행이 허용되지 않음')
    const ran = await $.process.run(source.command, { timeoutMs: 20_000 })
    if (ran.exitCode !== 0 && ran.stdout.trim() === '') throw new Error(firstLine(ran.stderr) || `종료 코드 ${ran.exitCode}`)
    text = ran.stdout
  } else if (source.file !== undefined) {
    const file = await $.fs.read(source.file)
    text = typeof file === 'string' ? file : ''
  } else if (source.url !== undefined) {
    const response = await $.http.fetch(source.url)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    text = response.text
  } else {
    throw new Error('command, file, url 중 하나가 필요함')
  }
  return parseText(text.slice(0, MAX_SOURCE_CHARS))
}

async function askToRun($: EngineInterface, design: Dashboard): Promise<boolean> {
  const lines = Object.entries(design.sources ?? {})
    .filter(([, source]) => source.command !== undefined)
    .map(([id, source]) => `${id}: ${(source.command ?? []).join(' ')}`)
  const question = `대시보드가 다음 명령을 ${refreshSecondsOf(design)}초마다 실행합니다. 허용할까요?\n${lines.join('\n')}`
  try {
    const answer = await $.ui.ask(question, { header: 'Dashboard', options: ['허용', '명령 없이 띄우기'] })
    return answer === '허용'
  } catch {
    return false
  }
}

// ── Drawing ─────────────────────────────────────────────────────────────────

type Reads = {
  values: Record<string, Json>
  errors: Record<string, string>
  history: Record<string, number[]>
  approved: boolean
  agents: AgentRow[]
  now: number
  updatedAt: number | null
}

// An element of the surface's table, drawn through the JSX factory.
type Draw = Parameters<typeof h>[0]
type Node = ReturnType<typeof h>

function drawItem(BoxEl: unknown, TextEl: unknown, item: Item, key: string, columns: number, r: Reads): Node {
  const Box = BoxEl as Draw
  const Text = TextEl as Draw
  const line = (text: string, props: Record<string, unknown> = {}) => h(Text, props, truncate(text, columns))

  switch (item.kind) {
    case 'text': {
      const text = item.from !== undefined ? textOf(pickValue(r.values, item.from)) : item.text ?? ''
      return h(Text, { ...toneProps(item.tone), wrap: 'wrap' }, text === '' ? '—' : text)
    }
    case 'stat': {
      const raw = item.from !== undefined ? pickValue(r.values, item.from) : item.value
      const value = raw === undefined || raw === null ? '—' : `${textOf(raw)}${item.unit ?? ''}`
      const label = `${item.label}  `
      return h(Box, 
        { flexDirection: 'row' },
        h(Text, { dimColor: true }, label),
        h(Text, { bold: true, ...toneProps(item.tone) }, truncate(value, Math.max(4, columns - width(label)))),
      )
    }
    case 'progress': {
      const [current, total] = progressOf(item, r.values)
      const label = `${item.label}  `
      if (current === undefined) return h(Box, { flexDirection: 'row' }, h(Text, { dimColor: true }, label), h(Text, { dimColor: true }, '—'))
      const ratio = total !== undefined && total > 0 ? Math.min(1, Math.max(0, current / total)) : undefined
      const tail = total !== undefined ? ` ${trimNumber(current)}/${trimNumber(total)}${ratio !== undefined ? ` ${Math.round(ratio * 100)}%` : ''}` : ` ${trimNumber(current)}`
      const barWidth = Math.max(4, Math.min(30, columns - width(label) - width(tail)))
      const filled = ratio === undefined ? 0 : Math.round(ratio * barWidth)
      return h(Box, 
        { flexDirection: 'row' },
        h(Text, { dimColor: true }, label),
        h(Text, { color: 'success' }, '█'.repeat(filled)),
        h(Text, { color: 'subtle' }, '░'.repeat(barWidth - filled)),
        h(Text, {}, tail),
      )
    }
    case 'sparkline': {
      const points = sparkPoints(item, key, r)
      const label = `${item.label}  `
      if (points.length === 0) return h(Box, { flexDirection: 'row' }, h(Text, { dimColor: true }, label), h(Text, { dimColor: true }, '—'))
      const lastText = ` ${trimNumber(points[points.length - 1]!)}`
      const room = Math.max(4, columns - width(label) - width(lastText))
      return h(Box, 
        { flexDirection: 'row' },
        h(Text, { dimColor: true }, label),
        h(Text, { color: 'suggestion' }, sparkline(points.slice(-room))),
        h(Text, { bold: true }, lastText),
      )
    }
    case 'status': {
      const state = item.from !== undefined ? textOf(pickValue(r.values, item.from)) : item.state ?? ''
      const look = statusLook(state)
      const head = `${look.glyph} ${item.label}`
      const rest = state === '' ? '' : `  ${state}`
      return h(Box, 
        { flexDirection: 'column' },
        h(Box, { flexDirection: 'row' }, h(Text, { color: look.color, bold: true }, truncate(head, columns)), h(Text, { color: look.color }, truncate(rest, Math.max(0, columns - width(head))))),
        item.detail !== undefined && item.detail !== '' ? line(`  ${item.detail}`, { dimColor: true }) : null,
      )
    }
    case 'table': {
      const rows = tableRows(item, r.values).slice(0, MAX_TABLE_ROWS)
      return drawTable(Box, Text, item.columns, rows, columns)
    }
    case 'agents':
      return drawAgents(Box, Text, r.agents, r.now, columns)
    default:
      return null
  }
}

function drawTable(Box: Draw, Text: Draw, head: string[], rows: string[][], columns: number): Node {
  if (head.length === 0) return null
  const gap = 2
  const widths = head.map((title, c) => Math.max(width(title), ...rows.map(row => width(row[c] ?? ''))))
  // Narrow the widest columns until the table fits the pane.
  while (widths.reduce((a, b) => a + b, 0) + gap * (widths.length - 1) > columns) {
    const widest = widths.indexOf(Math.max(...widths))
    if (widths[widest]! <= 3) break
    widths[widest] = widths[widest]! - 1
  }
  const row = (cells: string[]) => cells.map((cell, c) => pad(truncate(cell, widths[c]!), widths[c]!)).join(' '.repeat(gap)).trimEnd()
  return h(Box, 
    { flexDirection: 'column' },
    h(Text, { dimColor: true }, row(head)),
    ...(rows.length === 0 ? [h(Text, { dimColor: true }, '—')] : rows.map(cells => h(Text, {}, row(cells)))),
  )
}

function drawAgents(Box: Draw, Text: Draw, list: AgentRow[], at: number, columns: number): Node {
  if (list.length === 0) return h(Text, { dimColor: true }, '서브 에이전트 없음')
  const ordered = [...list].sort((a, b) => Number(a.status !== 'running') - Number(b.status !== 'running') || b.startedAt - a.startedAt).slice(0, 8)
  return h(Box, 
    { flexDirection: 'column' },
    ...ordered.map(agent => {
      const look = statusLook(agent.status)
      const elapsed = ageText((agent.endedAt ?? at) - agent.startedAt)
      const head = `${look.glyph} ${agent.type}`
      const meta = `  ${elapsed} · 도구 ${agent.tools}회`
      const what = agent.status === 'running' && agent.last !== '' ? agent.last : agent.description
      return h(Box, 
        { flexDirection: 'column' },
        h(Box, { flexDirection: 'row' }, h(Text, { color: look.color, bold: true }, truncate(head, columns)), h(Text, { dimColor: true }, truncate(meta, Math.max(0, columns - width(head))))),
        h(Text, { dimColor: true }, truncate(`  ${what}`, columns)),
      )
    }),
  )
}

// ── Pure helpers ────────────────────────────────────────────────────────────

/** The tool's input as a dashboard, or why it is not one. */
export function toDashboard(input: unknown): Dashboard | string {
  if (typeof input !== 'object' || input === null) return '입력이 객체가 아님'
  const raw = input as Record<string, unknown>
  if (typeof raw.title !== 'string' || raw.title.trim() === '') return 'title이 필요함'
  if (!Array.isArray(raw.sections) || raw.sections.length === 0) return 'sections가 하나 이상 필요함'
  const sources: Record<string, Source> = {}
  if (typeof raw.sources === 'object' && raw.sources !== null) {
    for (const [id, value] of Object.entries(raw.sources as Record<string, unknown>)) {
      if (typeof value !== 'object' || value === null) continue
      const source = value as Record<string, unknown>
      if (Array.isArray(source.command) && source.command.length > 0 && source.command.every(part => typeof part === 'string')) sources[id] = { command: source.command as string[] }
      else if (typeof source.file === 'string') sources[id] = { file: source.file }
      else if (typeof source.url === 'string') sources[id] = { url: source.url }
    }
  }
  const sections = (raw.sections as unknown[])
    .filter((section): section is Record<string, unknown> => typeof section === 'object' && section !== null)
    .map(section => ({
      ...(typeof section.title === 'string' ? { title: section.title } : {}),
      items: (Array.isArray(section.items) ? section.items : []).filter(isItem),
    }))
  const refreshSeconds = typeof raw.refreshSeconds === 'number' ? raw.refreshSeconds : undefined
  return JSON.parse(JSON.stringify({ title: raw.title.trim(), refreshSeconds, sources, sections })) as Dashboard
}

function isItem(value: unknown): value is Item {
  if (typeof value !== 'object' || value === null) return false
  const kind = (value as Record<string, unknown>).kind
  return ['text', 'stat', 'progress', 'sparkline', 'status', 'table', 'agents'].includes(String(kind))
}

export function refreshSecondsOf(design: Dashboard): number {
  const asked = design.refreshSeconds ?? DEFAULT_REFRESH_SECONDS
  return Math.max(MIN_REFRESH_SECONDS, Math.round(Number.isFinite(asked) ? asked : DEFAULT_REFRESH_SECONDS))
}

export function parseText(text: string): Json {
  const trimmed = text.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed) as Json
    } catch {
      // Not JSON after all: keep the text.
    }
  }
  return trimmed
}

/** What a pick points at in the readings. */
export function pickValue(readings: Record<string, Json>, pick: Pick): Json | undefined {
  let value: Json | undefined = readings[pick.source]
  if (value === undefined) return undefined
  if (pick.path !== undefined && pick.path !== '') {
    for (const part of pick.path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(one => one !== '')) {
      if (value === null || typeof value !== 'object') return undefined
      value = Array.isArray(value) ? value[Number(part)] : (value as Record<string, Json>)[part]
      if (value === undefined) return undefined
    }
  }
  if (pick.regex !== undefined && pick.regex !== '') {
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    let pattern: RegExp
    try {
      pattern = new RegExp(pick.regex)
    } catch {
      return undefined
    }
    const match = pattern.exec(text)
    if (match === null) return undefined
    return match[1] ?? match[0]
  }
  return value
}

function sparkPoints(item: Extract<Item, { kind: 'sparkline' }>, key: string, r: Reads): number[] {
  if (item.from === undefined) return (item.values ?? []).filter(Number.isFinite)
  if (item.from.regex !== undefined && item.from.regex !== '') {
    const source = r.values[item.from.source]
    if (source === undefined) return []
    const text = typeof source === 'string' ? source : JSON.stringify(source)
    let pattern: RegExp
    try {
      pattern = new RegExp(item.from.regex, 'g')
    } catch {
      return []
    }
    return [...text.matchAll(pattern)].map(match => Number(match[1] ?? match[0])).filter(Number.isFinite)
  }
  const value = pickValue(r.values, item.from)
  if (Array.isArray(value)) return value.map(one => toNumber(one)).filter((one): one is number => one !== undefined)
  return r.history[key] ?? []
}

export function progressOf(item: Extract<Item, { kind: 'progress' }>, readings: Record<string, Json>): [number | undefined, number | undefined] {
  let current = item.current
  let total = item.total
  if (item.from !== undefined) {
    const value = pickValue(readings, item.from)
    if (typeof value === 'string' && /^\s*[\d.]+\s*\/\s*[\d.]+\s*$/.test(value)) {
      const [a, b] = value.split('/').map(part => Number(part.trim()))
      current = a
      total = b
    } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      current = toNumber(value.current) ?? current
      total = toNumber(value.total) ?? total
    } else {
      current = toNumber(value) ?? undefined
    }
  }
  if (item.totalFrom !== undefined) total = toNumber(pickValue(readings, item.totalFrom)) ?? total
  return [current, total]
}

export function tableRows(item: Extract<Item, { kind: 'table' }>, readings: Record<string, Json>): string[][] {
  if (item.from === undefined) return (item.rows ?? []).map(row => row.map(cell => String(cell)))
  const value = pickValue(readings, item.from)
  if (Array.isArray(value)) {
    return value.map(row => {
      if (Array.isArray(row)) return row.map(cell => textOf(cell))
      if (row !== null && typeof row === 'object') return item.columns.map(column => textOf((row as Record<string, Json>)[column] ?? ''))
      return [textOf(row)]
    })
  }
  if (typeof value === 'string') {
    return value
      .split('\n')
      .map(lineText => lineText.trim())
      .filter(lineText => lineText !== '')
      .map(lineText => lineText.split(/\t|\s{2,}/))
  }
  return []
}

function activityOf(e: Record<string, unknown>): string {
  const tool = String(e.tool ?? '')
  if (typeof e.description === 'string' && e.description !== '') return `${tool}: ${e.description}`
  if (typeof e.file_path === 'string') return `${tool}: ${e.file_path.split('/').pop()}`
  if (typeof e.pattern === 'string') return `${tool}: ${e.pattern}`
  return tool
}

export function statusLook(state: string): { glyph: string; color: string } {
  const s = state.toLowerCase()
  if (/fail|error|dead|crash|killed|stopped|실패|오류|종료됨|죽/.test(s)) return { glyph: '✗', color: 'error' }
  if (/done|success|complete|finished|ok|passed|완료|성공|끝/.test(s)) return { glyph: '✓', color: 'success' }
  if (/wait|pending|queued|idle|paused|대기|준비/.test(s)) return { glyph: '◌', color: 'warning' }
  if (/run|active|busy|train|progress|working|실행|학습|진행/.test(s)) return { glyph: '●', color: 'suggestion' }
  return { glyph: '○', color: 'subtle' }
}

function toneProps(tone: Tone | undefined): Record<string, unknown> {
  switch (tone) {
    case 'good':
      return { color: 'success' }
    case 'warn':
      return { color: 'warning' }
    case 'bad':
      return { color: 'error' }
    case 'muted':
      return { dimColor: true }
    case 'accent':
      return { color: 'suggestion' }
    default:
      return {}
  }
}

export function sparkline(points: number[]): string {
  const bars = '▁▂▃▄▅▆▇█'
  const low = Math.min(...points)
  const high = Math.max(...points)
  if (high === low) return bars[3]!.repeat(points.length)
  return points.map(point => bars[Math.round(((point - low) / (high - low)) * (bars.length - 1))]).join('')
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const number = Number(value.trim().replace(/,/g, ''))
    return Number.isFinite(number) ? number : undefined
  }
  return undefined
}

function textOf(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'number') return trimNumber(value)
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}

function trimNumber(value: number): string {
  if (Number.isInteger(value)) return String(value)
  return Math.abs(value) >= 100 ? value.toFixed(1) : String(Number(value.toPrecision(4)))
}

export function ageText(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}초`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}분`
  return `${Math.floor(minutes / 60)}시간 ${minutes % 60}분`
}

function firstLine(text: string): string {
  return text.split('\n').map(one => one.trim()).find(one => one !== '') ?? ''
}

function errorText(error: unknown): string {
  return truncate(firstLine(error instanceof Error ? error.message : String(error)), 80)
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
