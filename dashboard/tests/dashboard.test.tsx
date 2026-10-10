import { describe, expect, mock, test } from 'claude-code/testing'

import { parseSummary, promptFor, stableKey } from '../hooks/register'

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
  now: 'l4a에서 epoch 2 체크포인트로 학습 재개 중',
  waiting: '',
  sections: [
    { title: '세션별 현황', lines: [{ text: 'l4a epoch 3/10', from: 2, tone: 'normal' }, { text: 'l4b 종료됨', from: 0, tone: 'bad' }] },
    { title: '지나온 단계', lines: [{ text: 'Drive에서 체크포인트 확인', from: 1, tone: 'good' }] },
    { title: '다음', lines: [{ text: 'epoch 3 결과 확인', from: 0, tone: 'normal' }] },
    { title: '막힌 것', lines: [] },
  ],
})

describe('the progress dashboard', () => {
  test('a running shell shows under what runs, then joins the steps', async ($, on) => {
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

  test('a phase signal wakes the model, and the sections it chose are drawn', async ($, on) => {
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
    expect(await ui.find({ type: 'Text', text: /지금 {2}l4a에서 epoch 2/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /▸ 세션별 현황/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /전 +l4a epoch 3\/10/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Drive에서 체크포인트 확인/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /epoch 3 결과 확인/ })).toBeDefined()
    // A section with nothing in it, and the live sections with nothing to show, stay hidden.
    expect(await ui.find({ type: 'Text', text: /막힌 것/ })).toBeUndefined()
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
    expect(await ui.find({ type: 'Text', text: /^◆ 어느 체크포인트로 이어갈까요\? · 질문/ })).toBeDefined()
    await ui.unmount()

    answer()
    await call
    const after = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await after.find({ type: 'Text', text: /^◆ 어느 체크포인트로 이어갈까요\? · 질문/ })).toBeUndefined()
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
    expect(await ui.find({ type: 'Text', text: /^◆ 셸: Kaggle 데이터셋 만들기 · 권한 요청/ })).toBeDefined()
    await ui.unmount()

    await $.prompt.submit({ text: '허용했어', origin: { kind: 'composer' }, wait: false } as never)
    const after = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await after.find({ type: 'Text', text: /^◆ / })).toBeUndefined()
    await after.unmount()
    finish()
    await call
  })

  test('a subagent runs on its own row and leaves a step when it ends', async ($, on) => {
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
      { title: 't', now: 'n', waiting: '', sections: [{ title: '지나온 단계', lines: [{ text: '확인', from: 1, tone: 'normal' }] }], covers: 1, at: 0 },
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

  test('the answer is read even around a code fence, and unknown log ids are dropped', () => {
    const written = parseSummary('여기 있습니다\n```json\n' + WRITTEN + '\n```', new Set([1]))
    expect(written?.now).toContain('학습 재개')
    expect(written?.sections.map(section => section.title)).toEqual(['세션별 현황', '지나온 단계', '다음'])
    expect(written?.sections[1]?.lines[0]).toEqual({ text: 'Drive에서 체크포인트 확인', from: 1, tone: 'good' })
    // A log id the model made up is dropped to 0.
    expect(written?.sections[0]?.lines[0]?.from).toBe(0)
    expect(parseSummary('모르겠습니다', new Set())).toBeUndefined()
  })

  test('two spellings of one input compare equal', () => {
    expect(stableKey({ b: 1, a: [1, { d: 2, c: 3 }] })).toBe(stableKey({ a: [1, { c: 3, d: 2 }], b: 1 }))
  })
})
