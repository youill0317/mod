import type { Tone, ViewNode } from '../types'
import { truncate, width } from './text'

// The view is built from materials, not diagram kinds: the model composes text,
// rows, columns, boxes, arrows, bars, sparklines, tables and rules into whatever
// shows this work best. This file reads its tree and lays it out to lines of
// styled pieces, measuring Hangul as two columns, so nothing it writes breaks.

/** One run of text in one style. */
export type Seg = { text: string; tone: Tone; bold: boolean }
/** A laid-out piece: its lines, each `w` columns once padded. */
export type Laid = { w: number; lines: Seg[][] }

const TONES = ['normal', 'dim', 'accent', 'good', 'warn', 'bad'] as const
const STYLES = ['round', 'bold', 'dashed', 'double'] as const
const DIRS = ['right', 'left', 'down', 'up'] as const
const MAX_DEPTH = 8
const MAX_NODES = 300
const MAX_TEXT = 400

const BORDERS: Record<(typeof STYLES)[number], { tl: string; tr: string; bl: string; br: string; h: string; v: string }> = {
  round: { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' },
  bold: { tl: '┏', tr: '┓', bl: '┗', br: '┛', h: '━', v: '┃' },
  dashed: { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '┄', v: '┆' },
  double: { tl: '╔', tr: '╗', bl: '╚', br: '╝', h: '═', v: '║' },
}

const SPARK = '▁▂▃▄▅▆▇█'

// ── Reading the model's tree ────────────────────────────────────────────────

/** The model's view as materials the mod can draw; anything unknown or malformed is dropped. */
export function parseView(value: unknown): ViewNode[] {
  const budget = { left: MAX_NODES }
  return list(value)
    .map(one => parseNode(one, 0, budget))
    .filter((node): node is ViewNode => node !== undefined)
}

function parseNode(value: unknown, depth: number, budget: { left: number }): ViewNode | undefined {
  if (depth > MAX_DEPTH || budget.left <= 0) return undefined
  // A bare string is text.
  if (typeof value === 'string') {
    budget.left -= 1
    return { t: 'text', v: clean(value), tone: 'normal', bold: false }
  }
  const raw = obj(value)
  budget.left -= 1
  const tone = toneOf(raw.tone)
  const children = () =>
    (typeof raw.c === 'string' ? [raw.c] : list(raw.c))
      .map(one => parseNode(one, depth + 1, budget))
      .filter((node): node is ViewNode => node !== undefined)
  switch (raw.t) {
    case 'text':
      return { t: 'text', v: clean(str(raw.v)), tone, bold: raw.bold === true }
    case 'row':
    case 'col': {
      const c = children()
      return c.length === 0 ? undefined : { t: raw.t, gap: Math.max(0, Math.min(raw.t === 'row' ? 4 : 2, Math.round(num(raw.gap, raw.t === 'row' ? 1 : 0)))), c }
    }
    case 'box': {
      const c = children()
      return { t: 'box', style: STYLES.find(one => one === raw.style) ?? 'round', tone, title: clean(str(raw.title)).replace(/\n/g, ' '), c }
    }
    case 'arrow':
      return { t: 'arrow', dir: DIRS.find(one => one === raw.dir) ?? 'right', tone, label: clean(str(raw.label)).replace(/\n/g, ' ') }
    case 'bar': {
      const max = num(raw.max, 0)
      return max > 0 ? { t: 'bar', value: num(raw.value, 0), max, tone, w: Math.max(0, Math.min(60, Math.round(num(raw.w, 0)))) } : undefined
    }
    case 'spark': {
      const values = list(raw.values).map(one => num(one, Number.NaN)).filter(Number.isFinite).slice(-120)
      return values.length === 0 ? undefined : { t: 'spark', values, tone }
    }
    case 'table': {
      const head = list(raw.head).map(cell).slice(0, 8)
      const rows = list(raw.rows).map(row => list(row).map(cell).slice(0, 8)).filter(row => row.length > 0).slice(0, 30)
      return head.length === 0 && rows.length === 0 ? undefined : { t: 'table', head, rows, tone }
    }
    case 'rule':
      return { t: 'rule', tone }
    default:
      return undefined
  }
}

const cell = (value: unknown) => clean(typeof value === 'number' ? String(value) : str(value)).replace(/\n/g, ' ')
const clean = (text: string) => text.slice(0, MAX_TEXT).replace(/\t/g, ' ').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '')
const toneOf = (value: unknown): Tone => TONES.find(one => one === value) ?? 'normal'
const str = (value: unknown) => (typeof value === 'string' ? value : '')
const num = (value: unknown, fallback: number) => {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : fallback
}
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const obj = (value: unknown) => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {})

// ── Laying it out ───────────────────────────────────────────────────────────

/**
 * The tree laid out at most `max` columns wide. `stamp` fills the time marks a
 * text may hold ({ago:12}, {for:12}, {for:12-15}) from the log, so times stay
 * the mod's measure, never the model's guess.
 */
export function layout(node: ViewNode, max: number, stamp: (text: string) => string = text => text): Laid {
  const room = Math.max(1, max)
  switch (node.t) {
    case 'text': {
      const lines = stamp(node.v)
        .split('\n')
        .map(line => truncate(line, room))
      return fromLines(lines.map(line => [{ text: line, tone: node.tone, bold: node.bold }]))
    }
    case 'col': {
      const parts = node.c.map(child => layout(child, room, stamp))
      const lines: Seg[][] = []
      parts.forEach((part, i) => {
        if (i > 0) for (let g = 0; g < node.gap; g++) lines.push([])
        lines.push(...part.lines)
      })
      return { w: Math.max(0, ...parts.map(part => part.w)), lines }
    }
    case 'row':
      return layoutRow(node.c, node.gap, room, stamp)
    case 'box':
      return layoutBox(node, room, stamp)
    case 'arrow':
      return layoutArrow(node, room)
    case 'bar': {
      const w = Math.max(1, Math.min(room, node.w > 0 ? node.w : 20))
      const filled = Math.round(Math.min(1, Math.max(0, node.value / node.max)) * w)
      return { w, lines: [[{ text: '█'.repeat(filled), tone: node.tone === 'normal' ? 'accent' : node.tone, bold: false }, { text: '░'.repeat(w - filled), tone: 'dim', bold: false }]] }
    }
    case 'spark': {
      const values = node.values.slice(-room)
      const low = Math.min(...values)
      const high = Math.max(...values)
      const text = values.map(value => SPARK[high === low ? 3 : Math.round(((value - low) / (high - low)) * (SPARK.length - 1))]).join('')
      return { w: width(text), lines: [[{ text, tone: node.tone === 'normal' ? 'accent' : node.tone, bold: false }]] }
    }
    case 'table':
      return layoutTable(node, room, stamp)
    case 'rule':
      return { w: room, lines: [[{ text: '─'.repeat(room), tone: node.tone === 'normal' ? 'dim' : node.tone, bold: false }]] }
  }
}

function fromLines(lines: Seg[][]): Laid {
  return { w: Math.max(0, ...lines.map(lineWidth)), lines }
}

export function lineWidth(line: readonly Seg[]): number {
  return line.reduce((sum, seg) => sum + width(seg.text), 0)
}

function padLine(line: readonly Seg[], w: number): Seg[] {
  const gap = w - lineWidth(line)
  return gap > 0 ? [...line, { text: ' '.repeat(gap), tone: 'normal', bold: false }] : [...line]
}

/**
 * Pieces side by side, as many to a line as fit; the next wraps below. An
 * arrow beside a box sits on the box's first inner line, where the label is.
 */
function layoutRow(children: readonly ViewNode[], gap: number, room: number, stamp: (text: string) => string): Laid {
  const groups: { node: ViewNode; laid: Laid }[][] = [[]]
  let used = 0
  for (const child of children) {
    const natural = layout(child, room, stamp)
    const group = groups[groups.length - 1]!
    if (group.length > 0 && used + gap + natural.w > room) {
      groups.push([{ node: child, laid: natural }])
      used = natural.w
      continue
    }
    group.push({ node: child, laid: natural })
    used += (group.length > 1 ? gap : 0) + natural.w
  }
  const lines: Seg[][] = []
  for (const group of groups) {
    if (group.length === 0) continue
    const height = Math.max(...group.map(one => one.laid.lines.length))
    const offsets = group.map(one => (one.node.t === 'arrow' && (one.node.dir === 'right' || one.node.dir === 'left') && height >= 3 ? 1 : 0))
    for (let r = 0; r < height; r++) {
      const line: Seg[] = []
      group.forEach((one, i) => {
        if (i > 0 && gap > 0) line.push({ text: ' '.repeat(gap), tone: 'normal', bold: false })
        const at = r - offsets[i]!
        line.push(...padLine(one.laid.lines[at] ?? [], one.laid.w))
      })
      lines.push(trimEnd(line))
    }
  }
  return fromLines(lines)
}

// Trailing blanks take no room: a line ends where its last piece does.
function trimEnd(line: Seg[]): Seg[] {
  const out = [...line]
  while (out.length > 0 && out[out.length - 1]!.text.trim() === '') out.pop()
  if (out.length > 0) {
    const last = out[out.length - 1]!
    out[out.length - 1] = { ...last, text: last.text.replace(/\s+$/, '') }
  }
  return out
}

function layoutBox(node: Extract<ViewNode, { t: 'box' }>, room: number, stamp: (text: string) => string): Laid {
  const border = BORDERS[node.style]
  const tone: Tone = node.tone === 'normal' ? 'dim' : node.tone
  const innerRoom = Math.max(1, room - 4)
  const inner = layout({ t: 'col', gap: 0, c: node.c }, innerRoom, stamp)
  const title = node.title === '' ? '' : truncate(stamp(node.title), Math.max(0, innerRoom - 2))
  const innerW = Math.max(inner.w, title === '' ? 0 : width(title) + 2, 1)
  const edge = (text: string): Seg => ({ text, tone, bold: node.style === 'bold' })
  const top: Seg[] = title === '' ? [edge(border.tl + border.h.repeat(innerW + 2) + border.tr)] : [edge(`${border.tl}${border.h} `), { text: title, tone: node.tone === 'normal' ? 'normal' : node.tone, bold: true }, edge(` ${border.h.repeat(innerW - width(title) - 1)}${border.tr}`)]
  const body = (inner.lines.length === 0 ? [[]] : inner.lines).map(line => [edge(`${border.v} `), ...padLine(line, innerW), edge(` ${border.v}`)])
  return { w: innerW + 4, lines: [top, ...body, [edge(border.bl + border.h.repeat(innerW + 2) + border.br)]] }
}

function layoutArrow(node: Extract<ViewNode, { t: 'arrow' }>, room: number): Laid {
  const tone: Tone = node.tone === 'normal' ? 'dim' : node.tone
  const seg = (text: string): Seg => ({ text, tone, bold: false })
  const label = truncate(node.label, Math.max(0, room - 3))
  switch (node.dir) {
    case 'right':
      return fromLines([[seg(label === '' ? '─▶' : `─${label}─▶`)]])
    case 'left':
      return fromLines([[seg(label === '' ? '◀─' : `◀─${label}─`)]])
    case 'down':
      return fromLines([[seg(label === '' ? '│' : `│ ${label}`)], [seg('▼')]])
    case 'up':
      return fromLines([[seg('▲')], [seg(label === '' ? '│' : `│ ${label}`)]])
  }
}

function layoutTable(node: Extract<ViewNode, { t: 'table' }>, room: number, stamp: (text: string) => string): Laid {
  const all = [node.head, ...node.rows].filter(row => row.length > 0).map(row => row.map(stamp))
  const columns = Math.max(...all.map(row => row.length))
  const widths = Array.from({ length: columns }, (_, c) => Math.max(...all.map(row => width(row[c] ?? ''))))
  // Too wide: the widest column gives way first, down to four columns each.
  const sep = 2
  while (widths.reduce((a, b) => a + b, 0) + sep * (columns - 1) > room) {
    const widest = widths.indexOf(Math.max(...widths))
    if (widths[widest]! <= 4) break
    widths[widest] = widths[widest]! - 1
  }
  const lines = all.map((row, r) => {
    const isHead = r === 0 && node.head.length > 0
    const line: Seg[] = []
    widths.forEach((w, c) => {
      if (c > 0) line.push({ text: ' '.repeat(sep), tone: 'normal', bold: false })
      const text = truncate(row[c] ?? '', w)
      line.push({ text: text + ' '.repeat(Math.max(0, w - width(text))), tone: isHead ? 'dim' : node.tone, bold: isHead })
    })
    return trimEnd(line)
  })
  return fromLines(lines.map(line => clip(line, room)))
}

/** A line cut to `room` columns, the cut marked with an ellipsis. */
export function clip(line: readonly Seg[], room: number): Seg[] {
  if (lineWidth(line) <= room) return [...line]
  const out: Seg[] = []
  let used = 0
  for (const seg of line) {
    const w = width(seg.text)
    if (used + w <= room - 1) {
      out.push(seg)
      used += w
      continue
    }
    const cut = truncate(seg.text, room - used)
    if (cut !== '') out.push({ ...seg, text: cut })
    break
  }
  return out
}

/** The view's blocks laid out for the pane: the most important first, as many as fit in `rows`. */
export function fitView(view: readonly ViewNode[], columns: number, rows: number, stamp: (text: string) => string): Seg[][][] {
  const kept: Seg[][][] = []
  let used = 0
  for (const node of view) {
    const laid = layout(node, columns, stamp).lines.map(line => clip(line, columns))
    if (laid.length === 0) continue
    const need = (kept.length > 0 ? 1 : 0) + laid.length
    if (used + need > rows) {
      // The first block always shows, cut to the room it has.
      if (kept.length === 0 && rows > 0) kept.push([...laid.slice(0, Math.max(0, rows - 1)), [{ text: '…', tone: 'dim', bold: false }]])
      break
    }
    kept.push(laid)
    used += need
  }
  return kept
}

/**
 * Fills the time marks in a text from the log: {ago:12} how long ago entry 12
 * was, {for:12} how long since it (and still going), {for:12-15} from one to
 * the other. A mark naming no entry the log holds is dropped.
 */
export function stamper(byId: ReadonlyMap<number, { at: number }>, at: number, ageText: (ms: number) => string): (text: string) => string {
  return text =>
    text.replace(/\{(ago|for):(\d+)(?:-(\d+))?\}/g, (_, kind: string, a: string, b: string | undefined) => {
      const from = byId.get(Number(a))
      if (from === undefined) return ''
      if (kind === 'ago') return `${ageText(at - from.at)} 전`
      if (b === undefined) return `${ageText(at - from.at)}째`
      const to = byId.get(Number(b))
      return to === undefined ? `${ageText(at - from.at)}째` : ageText(Math.max(0, to.at - from.at))
    })
}
