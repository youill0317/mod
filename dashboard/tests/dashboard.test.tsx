import { describe, expect, mock, test } from 'claude-code/testing'

import { pickValue, progressOf, sparkline, statusLook, tableRows, toDashboard } from '../hooks/register'

const PANE = {
  plugin: 'dashboard',
  component: 'Pane',
  requestId: 'dashboard',
  props: { title: 'Colab', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const COLAB = {
  title: 'Colab 학습',
  refreshSeconds: 10,
  sources: { metrics: { file: 'runs/l4a/metrics.json' } },
  sections: [
    {
      title: 'l4a · L4',
      items: [
        { kind: 'status', label: '세션', from: { source: 'metrics', path: 'state' } },
        { kind: 'progress', label: 'epoch', from: { source: 'metrics', path: 'epoch' }, total: 10 },
        { kind: 'sparkline', label: 'loss', from: { source: 'metrics', path: 'loss' } },
        { kind: 'stat', label: 'GPU', value: 'L4', tone: 'accent' },
      ],
    },
  ],
}

describe('the dashboard Claude designs', () => {
  test('reads its sources and draws them in the pane on every surface', async ($, on) => {
    mock.clock(on, { now: 1_000_000 })
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('fs.read', () => ({ value: '{"state":"training","epoch":3,"loss":[0.9,0.7,0.6,0.5]}' }))

    const shown = await $.tool.call({ tool: 'mcp__dashboard__show', ...COLAB })
    expect(String(shown.result)).toContain('Colab 학습')

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface })
      expect(await ui.find({ type: 'Text', text: /l4a · L4/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /training/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /3\/10 30%/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /▇|█/ })).toBeDefined()
      await ui.unmount()
    }
  })

  test('runs no command the person did not allow', async ($, on) => {
    mock.clock(on, { now: 1_000_000 })
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('tool.call', { tool: 'AskUserQuestion' }, () => ({ deny: 'dismissed' }))
    let runs = 0
    on('process.run', () => {
      runs++
      return { value: { exitCode: 0, stdout: 'ok', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })

    const shown = await $.tool.call({
      tool: 'mcp__dashboard__show',
      title: 'GPU',
      sources: { gpu: { command: ['nvidia-smi'] } },
      sections: [{ items: [{ kind: 'stat', label: 'GPU', from: { source: 'gpu' } }] }],
    })
    expect(String(shown.result)).toContain('허용하지 않아')
    expect(runs).toBe(0)

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /허용되지 않음/ })).toBeDefined()
    await ui.unmount()
  })

  test('/dashboard asks Claude to design one from the work at hand', async ($, on) => {
    const clock = mock.clock(on)
    const sent: string[] = []
    on('prompt.submit', ($, e) => {
      sent.push(e.text)
      return { text: e.text }
    })
    const ran = await $.command.run({
      command: 'dashboard',
      args: 'Colab 세션별로',
      origin: { kind: 'composer' },
      presentation: { isFullscreen: true, columns: 160 },
    })
    expect(ran.text).toContain('설계')
    await clock.advance(1)
    expect(sent[0]).toContain('mcp__dashboard__show')
    expect(sent[0]).toContain('Colab 세션별로')
  })

  test('the empty pane says how to make one', async $ => {
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /\/dashboard/ })).toBeDefined()
    await ui.unmount()
  })
})

describe('helpers', () => {
  test('a pick reads JSON paths and regular expressions', () => {
    const readings = { m: { runs: [{ loss: 0.42 }] }, log: 'epoch 3/10 loss=0.51' }
    expect(pickValue(readings, { source: 'm', path: 'runs[0].loss' })).toBe(0.42)
    expect(pickValue(readings, { source: 'log', regex: 'loss=([\\d.]+)' })).toBe('0.51')
    expect(pickValue(readings, { source: 'missing' })).toBeUndefined()
  })

  test('progress takes a number, "a/b" or an object', () => {
    expect(progressOf({ kind: 'progress', label: 'e', from: { source: 'log', regex: '(\\d+/\\d+)' } }, { log: 'epoch 3/10' })).toEqual([3, 10])
    expect(progressOf({ kind: 'progress', label: 'e', from: { source: 'm' } }, { m: { current: 2, total: 5 } })).toEqual([2, 5])
    expect(progressOf({ kind: 'progress', label: 'e', current: 1, total: 4 }, {})).toEqual([1, 4])
  })

  test('tables take rows, objects keyed by column, or text lines', () => {
    expect(tableRows({ kind: 'table', columns: ['a', 'b'], from: { source: 't' } }, { t: [{ a: 1, b: 'x' }] })).toEqual([['1', 'x']])
    expect(tableRows({ kind: 'table', columns: ['a', 'b'], from: { source: 't' } }, { t: 'l4a  running\nl4b  done' })).toEqual([
      ['l4a', 'running'],
      ['l4b', 'done'],
    ])
  })

  test('sparklines and status looks', () => {
    expect(sparkline([0, 1])).toBe('▁█')
    expect(statusLook('training').glyph).toBe('●')
    expect(statusLook('종료됨').glyph).toBe('✗')
    expect(statusLook('done').glyph).toBe('✓')
  })

  test('a design without sections is refused', () => {
    expect(toDashboard({ title: 'x', sections: [] })).toBe('sections가 하나 이상 필요함')
    expect(typeof toDashboard(COLAB)).toBe('object')
  })
})
