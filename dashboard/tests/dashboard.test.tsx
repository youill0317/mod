import { describe, expect, mock, test } from 'claude-code/testing'

import { clipNodes, fitBlocks, fitGraph, fitOf, graphRows, inOrder, parseSummary, promptFor, spans, stableKey, valueText } from '../hooks/register'

const PANE = {
  plugin: 'dashboard',
  component: 'Pane',
  requestId: 'dashboard',
  props: { title: '작업 현황', isFocused: false, bodyColumns: 70, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const

// The dashboard pane as the surface lists it while it shows.
const SHOWN = { id: 'dashboard', title: '작업 현황', isShown: true, isFocused: false, isPlaced: true }
const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const DONE = { result: { stdout: 'epoch 3/10 loss=0.51', stderr: '', interrupted: false } }

const WRITTEN = JSON.stringify({
  now: '체크포인트를 Kaggle로 옮기는 중',
  blocks: [
    {
      kind: 'graph',
      nodes: [
        { label: '확인', state: 'done', note: 'epoch 2', from: 1, branches: [{ label: '끊김', state: 'failed', note: 'L4 2대', back: true }] },
        { label: '이동', state: 'now', note: 'Kaggle', from: 2, branches: [] },
        { label: '재개', state: 'todo', note: '', branches: [] },
      ],
    },
    { kind: 'bars', items: [{ label: 't384_lr1e4', value: 2, max: 10, tone: 'normal', from: 1 }] },
    { kind: 'time' },
    // Kinds the dashboard does not draw any more, and one it never knew.
    { kind: 'table', columns: ['세션'], rows: [{ cells: ['l4a'] }] },
    { kind: 'metrics', items: [{ label: 'val AUC', value: '0.871' }] },
    { kind: 'chart' },
  ],
})

describe('the progress dashboard', () => {
  test('a running shell shows at the top while it runs', async ($, on) => {
    const clock = mock.clock(on)
    let finish: () => void = () => undefined
    on('tool.call', { tool: 'Bash' }, () => new Promise(resolve => (finish = () => resolve(DONE))))

    const call = $.tool.call({ tool: 'Bash', command: 'python3 train.py', description: '학습 재개' })
    await clock.advance(0)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface })
      expect(await ui.find({ type: 'Text', text: /^▶ 학습 재개/ })).toBeDefined()
      await ui.unmount()
    }

    finish()
    await call
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /^▶ / })).toBeUndefined()
    await ui.unmount()
  })

  test('a phase signal wakes the model, and below the top lines only diagrams are drawn', async ($, on) => {
    const clock = mock.clock(on)
    const asked: string[] = []
    on('model.complete', ($, e) => {
      // The memo asks a model for the shell too: only the dashboard's own asks count.
      if (e.prompt.includes('기록 (오래된 것부터):')) asked.push(e.prompt)
      return { value: { isAnswered: true, text: '```json\n' + WRITTEN + '\n```', usage: USAGE } }
    })
    on('tool.call', { tool: 'Bash' }, () => DONE)
    on('ui.panes', () => ({ value: [SHOWN] }))

    await $.tool.call({ tool: 'Bash', command: 'rclone ls gdrive:ckpt', description: '체크포인트 확인' })
    await $.tool.call({ tool: 'mcp__dashboard__signal', phase: '학습 재개' })
    await clock.advance(2_000)

    expect(asked).toHaveLength(1)
    expect(asked[0]).toContain('Claude가 알린 지금 단계: 학습 재개')

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const texts = (await ui.findAll({ type: 'Text' })).map(node => node.text)
    // The work now, as the first line, led by its symbol
    expect(texts[0]).toBe('● 체크포인트를 Kaggle로 옮기는 중')
    // The stages as boxes, and a failure that branched off and was retried
    expect(texts).toEqual(expect.arrayContaining(['✓ 확인', '● 이동', '○ 재개', '✗ 끊김', '↺ L4 2대', '─▶ ']))
    expect(texts.some(text => /^ *▼$/.test(text))).toBe(true)
    // A bar with when its value was seen, and the stages on a time axis
    expect(texts.some(text => /^ 2\/10 {2}\d+초 전$/.test(text))).toBe(true)
    expect(texts).toContain('확인  ')
    expect(texts.some(text => / 2초째$/.test(text))).toBe(true)
    // No title, no footer, no table, no number boxes
    expect(texts.some(text => /작업 현황|정리|세션|val AUC|l4a/.test(text))).toBe(false)
    await ui.unmount()
  })

  test('what Claude says the person must decide waits at the top until they write', async ($, on) => {
    mock.clock(on)
    on('prompt.submit', ($, e) => ({ text: e.text }))

    await $.tool.call({ tool: 'mcp__dashboard__signal', phase: '배포 전 확인', note: '프로덕션에 배포할지 결정' })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: '◆ 프로덕션에 배포할지 결정' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '● 배포 전 확인' })).toBeDefined()
    await ui.unmount()

    await $.prompt.submit({ text: '배포해', origin: { kind: 'composer' }, wait: false } as never)
    const after = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await after.find({ type: 'Text', text: /^◆ / })).toBeUndefined()
    await after.unmount()
  })

  test('a question to the person shows at the top while it waits', async ($, on) => {
    const clock = mock.clock(on)
    let answer: () => void = () => undefined
    on('tool.call', { tool: 'AskUserQuestion' }, () => new Promise(resolve => (answer = () => resolve({ result: { answers: {} } }))))

    const call = $.tool.call({ tool: 'AskUserQuestion', questions: [{ question: '어느 체크포인트로 이어갈까요?', header: 'Resume', options: [], multiSelect: false }] } as never)
    await clock.advance(0)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /^◆ 어느 체크포인트로 이어갈까요\? · 질문$/ })).toBeDefined()
    await ui.unmount()

    answer()
    await call
    const after = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await after.find({ type: 'Text', text: /^◆ / })).toBeUndefined()
    await after.unmount()
  })

  test('a permission dialog waits on the person until they act', async ($, on) => {
    const clock = mock.clock(on)
    let finish: () => void = () => undefined
    on('tool.call', { tool: 'Bash' }, () => new Promise(resolve => (finish = () => resolve(DONE))))
    on('prompt.submit', ($, e) => ({ text: e.text }))
    on('classic.PermissionRequest', () => ({}))

    const call = $.tool.call({ tool: 'Bash', command: 'kaggle datasets create -p .', description: 'Kaggle 데이터셋 만들기' })
    await clock.advance(0)
    await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'kaggle datasets create -p .', description: 'Kaggle 데이터셋 만들기' } })

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /^◆ Kaggle 데이터셋 만들기 · 권한 요청$/ })).toBeDefined()
    // The same call is not also listed as running while it waits.
    expect(await ui.find({ type: 'Text', text: /^▶ / })).toBeUndefined()
    await ui.unmount()

    await $.prompt.submit({ text: '허용했어', origin: { kind: 'composer' }, wait: false } as never)
    const after = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await after.find({ type: 'Text', text: /^◆ / })).toBeUndefined()
    await after.unmount()
    finish()
    await call
  })

  test('a subagent shows its role and its latest step until it ends', async ($, on) => {
    mock.clock(on)
    on('agent.spawn', () => ({ model: 'haiku', agentId: 'a1' }))
    on('turn.complete', () => ({ text: '' }))
    on('tool.call', { tool: 'Grep' }, () => ({ result: '' }))

    await $.agent.spawn({
      tool_use_id: 't1',
      prompt: 'run_gpu에 두 번째 GPU 패스 추가',
      description: 'GPU 패스 추가',
      subagentType: 'general-purpose',
      provider: { plugin: 'engine', tier: 'core' },
      parentModel: 'opus',
      background: true,
      fork: false,
    } as never)
    await $.tool.call({ tool: 'Grep', pattern: 'run_gpu', agentId: 'a1' } as never)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /^◎ GPU 패스 추가$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '  └ Grep: run_gpu' })).toBeDefined()
    await ui.unmount()

    await $.turn.complete({ answer: '끝', durationMs: 1000, isAborted: false, turnId: 'x', agentId: 'a1', reason: 'answer' } as never)
    const after = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await after.find({ type: 'Text', text: /^◎ / })).toBeUndefined()
    await after.unmount()
  })

  test('the model is told the pane size, and draws again for another size class', async ($, on) => {
    const clock = mock.clock(on)
    const asked: string[] = []
    on('model.complete', ($, e) => {
      asked.push(e.prompt)
      return { value: { isAnswered: true, text: WRITTEN, usage: USAGE } }
    })
    on('ui.panes', () => ({ value: [SHOWN] }))

    const wide = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await clock.advance(0)
    await $.tool.call({ tool: 'mcp__dashboard__signal', phase: '학습 재개' })
    await clock.advance(2_000)
    expect(asked).toHaveLength(1)
    expect(asked[0]).toContain('창: 가로 70칸, 세로 60줄. 단계 상자는 한 줄에 4개쯤 들어간다.')
    await wide.unmount()

    // A few cells narrower stays in the same class: the summary stands.
    const near = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 66, scroll: { offset: 0, bodyRows: 56 } } })
    await clock.advance(2_000)
    expect(asked).toHaveLength(1)
    await near.unmount()

    // A narrow, short pane is another class: the same log is drawn again for it,
    // and what does not fit is left out.
    const narrow = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 34, scroll: { offset: 0, bodyRows: 14 } } })
    await clock.advance(2_000)
    expect(asked).toHaveLength(2)
    expect(asked[1]).toContain('창: 가로 34칸, 세로 14줄. 단계 상자는 한 줄에 2개쯤 들어간다.')
    expect(asked[1]).toContain('창 크기가 지난번과 다르다')
    const texts = (await narrow.findAll({ type: 'Text' })).map(node => node.text)
    expect(texts).toContain('● 이동')
    // The branch does not fit the short pane: the stages are drawn without it.
    expect(texts).not.toContain('✗ 끊김')
    await narrow.unmount()
  })

  test('a closed dashboard wakes no model', async ($, on) => {
    const clock = mock.clock(on)
    const asked: string[] = []
    on('model.complete', ($, e) => {
      asked.push(e.prompt)
      return { value: { isAnswered: true, text: WRITTEN, usage: USAGE } }
    })
    on('turn.complete', () => ({ text: '' }))

    await $.tool.call({ tool: 'mcp__dashboard__signal', phase: '학습 재개' })
    await $.turn.complete({ answer: '끝', durationMs: 1000, isAborted: false, turnId: 'x', reason: 'answer' } as never)
    await clock.advance(30_000)
    expect(asked).toHaveLength(0)
  })

  test('the signal never asks the person for permission', async $ => {
    const verdict = await $.tool.check({ tool: 'mcp__dashboard__signal', input: { phase: '학습 재개' } })
    expect(verdict.decision).toBe('allow')
  })

  test('a rate-limited model is left alone a while before it is woken again', async ($, on) => {
    const clock = mock.clock(on)
    let asked = 0
    on('model.complete', () => {
      asked += 1
      return { value: { isAnswered: false, reason: 'api-error', status: 429, error: 'rate_limit', usage: USAGE } }
    })
    on('ui.panes', () => ({ value: [SHOWN] }))

    await $.tool.call({ tool: 'mcp__dashboard__signal', phase: '학습 재개' })
    await clock.advance(2_000)
    expect(asked).toBe(1)

    // Another urgent change would wake it in 2 seconds; after the failure it waits longer.
    await $.tool.call({ tool: 'mcp__dashboard__signal', phase: '평가' })
    await clock.advance(2_000)
    expect(asked).toBe(1)
    await clock.advance(8_000)
    expect(asked).toBe(2)
  })
})

describe('helpers', () => {
  test('the model gets the log, what runs, what waits and what it drew before', () => {
    const prompt = promptFor(
      [
        { id: 1, at: 0, kind: 'shell-done', text: '셸 끝남: 체크포인트 확인' },
        { id: 2, at: 60_000, kind: 'signal', text: '학습 재개' },
      ],
      { now: 'n', blocks: [{ kind: 'graph', nodes: [{ label: '확인', state: 'done', note: '', branches: [], from: 1 }] }], covers: 1, fit: '4/2' },
      [{ id: 'x', kind: 'shell', label: '학습', startedAt: 0, background: true, taskId: null, last: '' }],
      [],
      '학습 재개',
      120_000,
    )
    expect(prompt).toContain('#1 2분 전 셸 끝남')
    expect(prompt).toContain('#2 1분 전 (새) 학습 재개')
    expect(prompt).toContain('셸 학습 (2분째)')
    expect(prompt).toContain('지난번 도식')
  })

  test('the answer is read around a code fence; only diagrams it knows are kept, unknown log ids dropped', () => {
    const written = parseSummary('여기 있습니다\n```json\n' + WRITTEN + '\n```', new Set([1]))
    expect(written?.now).toContain('Kaggle로')
    // The time block needs two stages with a known start: with id 2 unknown, it is dropped.
    expect(written?.blocks.map(block => block.kind)).toEqual(['graph', 'bars'])
    const both = parseSummary(WRITTEN, new Set([1, 2]))
    expect(both?.blocks.map(block => block.kind)).toEqual(['graph', 'bars', 'time'])
    expect(parseSummary('모르겠습니다', new Set())).toBeUndefined()
  })

  test('the diagrams that fit are kept in order; the first always is', () => {
    expect(fitBlocks([{ block: 'graph', rows: 9 }, { block: 'bars', rows: 2 }, { block: 'time', rows: 4 }], 13)).toEqual(['graph', 'bars'])
    expect(fitBlocks([{ block: 'graph', rows: 20 }, { block: 'bars', rows: 2 }], 10)).toEqual(['graph'])
    expect(fitBlocks([{ block: 'time', rows: 0 }, { block: 'bars', rows: 2 }], 10)).toEqual(['bars'])
  })

  test('a graph too tall for the pane loses its quiet branches, then all, then folds its oldest stages', () => {
    const node = (label: string, state: 'done' | 'now' | 'todo', branches: { label: string; state: 'done' | 'failed'; note: string; back: boolean }[] = []) => ({ label, state, note: '12쪽', branches, from: 0 })
    const nodes = [
      node('준비', 'done', [
        { label: '조사', state: 'done', note: '64장', back: false },
        { label: '누락', state: 'failed', note: '3개', back: true },
      ]),
      node('빌드', 'done'),
      node('검사', 'done'),
      node('최적화', 'now'),
      node('배포', 'todo'),
    ]
    // Wide and tall: as it is.
    expect(fitGraph(nodes, 120, 40)).toEqual(nodes)
    // Rows for one branch: the failure stays, the side task that went fine goes.
    expect(fitGraph(nodes, 120, 12).map(one => one.branches.map(branch => branch.label))).toEqual([['누락'], [], [], [], []])
    // No room for a branch: none.
    expect(fitGraph(nodes, 120, 4).every(one => one.branches.length === 0)).toBe(true)
    // Two boxes across and nine rows: the oldest finished stages fold into one box.
    expect(fitGraph(nodes, 34, 9).map(one => `${one.label} ${one.note}`)).toEqual(['… 2단계', '검사 12쪽', '최적화 12쪽', '배포 12쪽'])
  })

  test('names are cut only where the pane needs it', () => {
    const nodes = [{ label: '이미지 오류', state: 'failed' as const, note: 'Astro 프로젝트 생성', from: 0, branches: [{ label: '깨진 링크 검사', state: 'failed' as const, note: '2개', back: true }] }]
    // Wide: whole.
    expect(clipNodes(nodes, 100)).toEqual(nodes)
    // Two boxes across 40 columns: cut to fit.
    const narrow = clipNodes(nodes, 40)[0]!
    expect([narrow.label, narrow.note, narrow.branches[0]!.label]).toEqual(['이미지 오…', 'Astro 프로…', '깨진 링크…'])
  })

  test('a ratio out of 1 shows its value alone', () => {
    expect(valueText(2, 10)).toBe('2/10')
    expect(valueText(0.871, 1)).toBe('0.871')
  })

  test('the size class changes with the boxes across or a band of rows', () => {
    expect(fitOf({ columns: 100, rows: 40 })).toBe(fitOf({ columns: 98, rows: 44 }))
    expect(fitOf({ columns: 100, rows: 40 })).not.toBe(fitOf({ columns: 100, rows: 18 }))
    expect(fitOf({ columns: 100, rows: 40 })).not.toBe(fitOf({ columns: 40, rows: 40 }))
    expect(fitOf(null)).toBe('')
  })

  test('a stage lasts until the next begins, the last until now', () => {
    const byId = new Map([[1, { at: 0 }], [2, { at: 60_000 }], [3, { at: 30_000 }]])
    const items = [
      { label: '빌드', state: 'done' as const, from: 1 },
      { label: '검사', state: 'done' as const, from: 2 },
      // Cited out of order: held at the start before it.
      { label: '배포', state: 'now' as const, from: 3 },
      { label: '없음', state: 'done' as const, from: 9 },
    ]
    expect(spans(items, byId, 120_000)).toEqual([
      { label: '빌드', state: 'done', start: 0, end: 60_000 },
      { label: '검사', state: 'done', start: 60_000, end: 60_000 },
      { label: '배포', state: 'now', start: 60_000, end: 120_000 },
    ])
  })

  test('boxes that wrap are spread evenly over the rows', () => {
    // Seven fit on the first row and one is left: four and four instead.
    expect(graphRows([13, 13, 13, 13, 13, 13, 13, 10], 98)).toEqual([[0, 1, 2, 3], [4, 5, 6, 7]])
    expect(graphRows([13, 13, 13], 98)).toEqual([[0, 1, 2]])
  })

  test('a flow reads in order', () => {
    const steps = inOrder([
      { label: '빌드', state: 'done' },
      { label: '이미지', state: 'now' },
      { label: '측정', state: 'done' },
      { label: '배포', state: 'todo' },
    ] as const)
    expect(steps.map(step => step.label)).toEqual(['빌드', '측정', '이미지', '배포'])
  })

  test('two spellings of one input compare equal', () => {
    expect(stableKey({ b: 1, a: [1, { d: 2, c: 3 }] })).toBe(stableKey({ a: [1, { c: 3, d: 2 }], b: 1 }))
  })
})
