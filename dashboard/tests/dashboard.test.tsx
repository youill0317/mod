import { describe, expect, mock, test } from 'claude-code/testing'

import { fitOf, graphRows, inOrder, parseSummary, promptFor, repeatsValue, roomFor, spans, stableKey } from '../hooks/register'

const PANE = {
  plugin: 'dashboard',
  component: 'Pane',
  requestId: 'dashboard',
  props: { title: '작업 과정', isFocused: false, bodyColumns: 70, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const

const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const DONE = { result: { stdout: 'epoch 3/10 loss=0.51', stderr: '', interrupted: false } }

const WRITTEN = JSON.stringify({
  title: 'Colab 학습 재개',
  now: '체크포인트를 Kaggle로 옮기는 중',
  waiting: '',
  blocks: [
    {
      kind: 'graph',
      title: '',
      nodes: [
        { label: '확인', state: 'done', note: 'epoch 2', from: 1, branches: [{ label: '끊김', state: 'failed', note: 'L4 2대', back: true }] },
        { label: '이동', state: 'now', note: 'Kaggle', from: 2, branches: [] },
        { label: '재개', state: 'todo', note: '', branches: [] },
      ],
    },
    { kind: 'table', title: '세션', columns: ['세션', 'GPU', '상태'], rows: [{ cells: ['l4a', 'L4', '종료'], tone: 'bad', from: 2 }, { cells: ['l4c', 'T4', '대기'], tone: 'muted', from: 0 }] },
    { kind: 'bars', title: '실험 진행 상황', items: [{ label: 't384_lr1e4', value: 2, max: 10, note: 'AUC 0.871', tone: 'normal', from: 0 }] },
    { kind: 'metrics', title: '', items: [{ label: 'val AUC', value: '0.871', tone: 'good', from: 0 }, { label: '남은 epoch', value: '8', tone: 'normal', from: 0 }] },
    { kind: 'list', title: '실패', items: [] },
    { kind: 'chart', title: '없는 종류' },
    { kind: 'time', title: '' },
  ],
})

describe('the progress dashboard', () => {
  test('a running shell shows under what runs, then joins the recent log', async ($, on) => {
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
    expect(await ui.find({ type: 'Text', text: /셸 끝남 .*학습 재개/ })).toBeDefined()
    await ui.unmount()
  })

  test('a phase signal wakes the model, and the blocks it chose are drawn as a flow, a table, bars and numbers', async ($, on) => {
    const clock = mock.clock(on)
    const asked: string[] = []
    on('model.complete', ($, e) => {
      asked.push(e.prompt)
      return { value: { isAnswered: true, text: '```json\n' + WRITTEN + '\n```', usage: USAGE } }
    })
    on('tool.call', { tool: 'Bash' }, () => DONE)

    await $.tool.call({ tool: 'Bash', command: 'rclone ls gdrive:ckpt', description: '체크포인트 확인' })
    await $.tool.call({ tool: 'mcp__dashboard__signal', phase: '학습 재개' })
    await clock.advance(2_000)

    expect(asked).toHaveLength(1)
    expect(asked[0]).toContain('Claude가 알린 지금 단계: 학습 재개')

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /Colab 학습 재개/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^체크포인트를 Kaggle로 옮기는 중$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /지금/ })).toBeUndefined()
    // The main path as boxes, and a failure that branched off and was retried
    expect(await ui.find({ type: 'Text', text: '✓ 확인' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '● 이동' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '○ 재개' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '✗ 끊김' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '↺ L4 2대' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^ *▼$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '─▶ ' })).toBeDefined()
    // A table, with how long ago each value was seen
    expect(await ui.find({ type: 'Text', text: /^세션 +GPU +상태 +확인$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^l4a +L4 +종료 +\d+초 전$/ })).toBeDefined()
    // A progress bar and the key numbers
    expect(await ui.find({ type: 'Text', text: /^█+$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^실험$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /진행 상황/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /2\/10 {2}AUC 0\.871/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '0.871' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '남은 epoch' })).toBeDefined()
    // The stages on one time axis, the current one counting up.
    expect(await ui.find({ type: 'Text', text: /^확인 {2}$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: / 2초째$/ })).toBeDefined()
    // An empty block, an unknown kind, and the live lines with nothing to show stay out.
    expect(await ui.find({ type: 'Text', text: /^실패$|없는 종류/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /^[◆▶◎↻] / })).toBeUndefined()
    await ui.unmount()
  })

  test('a question to the person shows under what waits on them', async ($, on) => {
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
    expect(await after.find({ type: 'Text', text: /^◆ 어느 체크포인트로 이어갈까요\? · 질문$/ })).toBeUndefined()
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

  test('a subagent runs on its own row and leaves a step when it ends', async ($, on) => {
    mock.clock(on)
    on('agent.spawn', () => ({ model: 'haiku', agentId: 'a1' }))
    on('turn.complete', () => ({ text: '' }))

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
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /^◎ general-purpose: GPU 패스 추가/ })).toBeDefined()
    await ui.unmount()

    await $.turn.complete({ answer: '끝', durationMs: 1000, isAborted: false, turnId: 'x', agentId: 'a1', reason: 'answer' } as never)
    const after = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await after.find({ type: 'Text', text: /^◎ / })).toBeUndefined()
    expect(await after.find({ type: 'Text', text: /서브 에이전트 끝남: general-purpose: GPU 패스 추가/ })).toBeDefined()
    await after.unmount()
  })

  test('the model is told the pane size, and lays out again for another size class', async ($, on) => {
    const clock = mock.clock(on)
    const asked: string[] = []
    on('model.complete', ($, e) => {
      asked.push(e.prompt)
      return { value: { isAnswered: true, text: WRITTEN, usage: USAGE } }
    })
    on('tool.call', { tool: 'Bash' }, () => DONE)

    const wide = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await clock.advance(0)
    await $.tool.call({ tool: 'mcp__dashboard__signal', phase: '학습 재개' })
    await clock.advance(2_000)
    expect(asked).toHaveLength(1)
    expect(asked[0]).toContain('창: 가로 70칸, 세로 60줄. graph는 상자 8개까지(한 줄에 4개씩)')
    await wide.unmount()

    // A few cells narrower stays in the same class: the summary stands.
    const near = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 66, scroll: { offset: 0, bodyRows: 56 } } })
    await clock.advance(2_000)
    expect(asked).toHaveLength(1)
    await near.unmount()

    // A narrow, short pane is another class: the same log is laid out again for it.
    const narrow = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 34, scroll: { offset: 0, bodyRows: 14 } } })
    await clock.advance(2_000)
    expect(asked).toHaveLength(2)
    expect(asked[1]).toContain('창: 가로 34칸, 세로 14줄. graph는 상자 4개까지(한 줄에 2개씩), 갈래는 넣지 않는다')
    expect(asked[1]).toContain('창 크기가 지난번과 다르다')
    await narrow.unmount()
  })

  test('the signal never asks the person for permission', async $ => {
    const verdict = await $.tool.check({ tool: 'mcp__dashboard__signal', input: { phase: '학습 재개' } })
    expect(verdict.decision).toBe('allow')
  })
})

describe('helpers', () => {
  test('the model gets the log, what runs, what waits and what it wrote before', () => {
    const prompt = promptFor(
      [
        { id: 1, at: 0, kind: 'shell-done', text: '셸 끝남: 체크포인트 확인' },
        { id: 2, at: 60_000, kind: 'signal', text: '학습 재개' },
      ],
      { title: 't', now: 'n', waiting: '', blocks: [{ kind: 'graph', title: '', nodes: [{ label: '확인', state: 'done', note: '', branches: [], from: 1 }] }], covers: 1, at: 0, fit: '4L' },
      [{ id: 'x', kind: 'shell', label: '학습', startedAt: 0, background: true, taskId: null, last: '' }],
      [],
      '학습 재개',
      120_000,
    )
    expect(prompt).toContain('#1 2분 전 셸 끝남')
    expect(prompt).toContain('#2 1분 전 (새) 학습 재개')
    expect(prompt).toContain('셸 학습 (2분째)')
    expect(prompt).toContain('지난번에 쓴 대시보드')
  })

  test('the room left for the blocks takes off the lines above and below them', () => {
    const run = { id: 'x', kind: 'agent' as const, label: '조사', startedAt: 0, background: false, taskId: null, last: 'Grep' }
    // 32 rows for the blocks: a row of six boxes (4), two branches (12), 15 left and 1 between.
    expect(roomFor({ columns: 100, rows: 40 }, [run], [])).toBe('창: 가로 100칸, 세로 40줄. graph는 상자 6개까지(한 줄에 6개씩), 갈래는 모두 합쳐 2개까지. graph 말고 다른 블록은 모두 합쳐 15줄 안에 넣는다.')
    // A narrow, short pane: four boxes in two rows and no room for anything else.
    expect(roomFor({ columns: 40, rows: 14 }, [], [])).toBe('창: 가로 40칸, 세로 14줄. graph는 상자 4개까지(한 줄에 2개씩), 갈래는 넣지 않는다. graph 말고 다른 블록은 넣지 않는다.')
    expect(fitOf({ columns: 100, rows: 40 })).toBe(fitOf({ columns: 98, rows: 41 }))
    expect(fitOf({ columns: 100, rows: 40 })).not.toBe(fitOf({ columns: 100, rows: 20 }))
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
    // Spread evenly the first row would not fit: the greedy rows stand.
    expect(graphRows([40, 40, 10, 10, 10], 90)).toEqual([[0, 1, 2], [3, 4]])
  })

  test('the answer is read even around a code fence, and unknown log ids are dropped', () => {
    const written = parseSummary('여기 있습니다\n```json\n' + WRITTEN + '\n```', new Set([1]))
    expect(written?.now).toContain('Kaggle로')
    expect(written?.blocks.map(block => block.kind)).toEqual(['graph', 'table', 'bars', 'metrics'])
    // A log id the model made up is dropped to 0.
    const table = written?.blocks[1]
    expect(table?.kind === 'table' ? table.rows[0]?.from : -1).toBe(0)
    expect(parseSummary('모르겠습니다', new Set())).toBeUndefined()
  })

  test('a flow reads in order, and a bar note does not repeat its value', () => {
    const steps = inOrder([
      { label: '빌드', state: 'done' },
      { label: '이미지', state: 'now' },
      { label: '측정', state: 'done' },
      { label: '배포', state: 'todo' },
    ] as const)
    expect(steps.map(step => step.label)).toEqual(['빌드', '측정', '이미지', '배포'])
    expect(repeatsValue('38/64장', 38, 64)).toBe(true)
    expect(repeatsValue('12.1MB → 4.3MB', 38, 64)).toBe(false)
  })

  test('two spellings of one input compare equal', () => {
    expect(stableKey({ b: 1, a: [1, { d: 2, c: 3 }] })).toBe(stableKey({ a: [1, { c: 3, d: 2 }], b: 1 }))
  })
})
