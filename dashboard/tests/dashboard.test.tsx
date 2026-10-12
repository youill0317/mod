import { describe, expect, mock, test } from 'claude-code/testing'

import { condense, fitText, nextPlan, parseAnswer, promptFor } from '../hooks/context'
import type { Gathered } from '../hooks/context'
import { ageText, fitOf, keyOf, resumeAt, stableKey } from '../hooks/register'
import { fitView, layout, parseView, stamper } from '../hooks/view'
import type { Seg } from '../hooks/view'

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
// The dashboard's own model calls, told from the memo's by their system prompt.
const own = (e: { system?: string }) => e.system?.includes('작업 대시보드') === true

// A view built from materials: stages as boxes and arrows, a bar, a table, and
// one material the dashboard does not know.
const VIEW = [
  {
    t: 'row',
    c: [
      { t: 'box', c: ['✓ 확인', { t: 'text', v: 'epoch 2', tone: 'dim' }] },
      { t: 'arrow', dir: 'right' },
      { t: 'box', style: 'bold', tone: 'accent', c: [{ t: 'text', v: '● 이동', bold: true }, 'Kaggle {for:1}'] },
    ],
  },
  { t: 'row', c: ['epoch', { t: 'bar', value: 2, max: 10, w: 10 }, '2/10 {ago:1}'] },
  { t: 'table', head: ['실험', 'AUC'], rows: [['t384', '0.871']] },
  { t: 'chart', values: [1, 2] },
]
const ANSWER = JSON.stringify({ notes: '목표: 체크포인트를 Kaggle로 옮겨 학습 재개.', now: '체크포인트를 Kaggle로 옮기는 중', ask: '', view: VIEW })

const answering = (text: string) => ({ value: { isAnswered: true as const, text, usage: USAGE } })
const TODOS = [
  { content: '체크포인트 확인', status: 'completed', activeForm: '확인 중' },
  { content: 'Kaggle로 옮기기', status: 'in_progress', activeForm: '옮기는 중' },
  { content: '학습 재개', status: 'pending', activeForm: '재개 중' },
]

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

  test('the model reads the conversation, the plan and the working copy, and draws its own view', async ($, on) => {
    const clock = mock.clock(on)
    const asked: string[] = []
    on('model.complete', ($, e) => {
      if (own(e)) asked.push(e.prompt)
      return answering('```json\n' + ANSWER + '\n```')
    })
    on('ui.panes', () => ({ value: [SHOWN] }))
    on('session.messages', () => ({
      value: [
        { role: 'user', text: '체크포인트를 Kaggle로 옮기고 학습 이어서 해줘', toolUses: [] },
        { role: 'assistant', text: '먼저 Drive의 체크포인트를 확인하겠습니다.', toolUses: [{ tool_use_id: 'u1', tool: 'Bash', input: { command: 'rclone ls gdrive:ckpt', description: '체크포인트 확인' }, text: 'ckpt_epoch2.pt' }] },
      ],
    }))
    on('process.run', ($, e) => ({ value: { exitCode: 0, stdout: e.argv[1] === 'status' ? '## main\n M train.py' : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
    on('tool.call', { tool: 'TodoWrite' as never }, () => ({ result: {} }))

    // Claude's own plan wakes the dashboard: no tool of the dashboard's is in the main conversation.
    await $.tool.call({ tool: 'TodoWrite', todos: TODOS } as never)
    await clock.advance(2_000)

    expect(asked).toHaveLength(1)
    expect(asked[0]).toContain('[0] 사용자: 체크포인트를 Kaggle로 옮기고 학습 이어서 해줘')
    expect(asked[0]).toContain('↳ Bash 체크포인트 확인 · rclone ls gdrive:ckpt → ckpt_epoch2.pt')
    expect(asked[0]).toContain('[진행] Kaggle로 옮기기')
    expect(asked[0]).toContain('M train.py')
    expect(asked[0]).toMatch(/#1 \d+초 전 \(새\) 계획 갱신: 1\/3 완료, 지금: Kaggle로 옮기기/)

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const texts = (await ui.findAll({ type: 'Text' })).map(node => node.text)
    expect(texts[0]).toBe('● 체크포인트를 Kaggle로 옮기는 중')
    // The materials drawn: boxes, the arrow between them, the bar with its time filled in, the table.
    expect(texts.some(text => text.includes('✓ 확인'))).toBe(true)
    expect(texts.some(text => text.includes('● 이동'))).toBe(true)
    expect(texts.some(text => text.includes('─▶'))).toBe(true)
    expect(texts.some(text => text.includes('██'))).toBe(true)
    expect(texts.some(text => /2\/10 \d+초 전/.test(text))).toBe(true)
    expect(texts.some(text => text.includes('0.871'))).toBe(true)
    await ui.unmount()
  })

  test('after the first read, only the notes and what is new go to the model', async ($, on) => {
    const clock = mock.clock(on)
    const asked: string[] = []
    on('model.complete', ($, e) => {
      if (own(e)) asked.push(e.prompt)
      return answering(ANSWER)
    })
    on('ui.panes', () => ({ value: [SHOWN] }))
    const messages: { role: 'user'; text: string; toolUses: [] }[] = [{ role: 'user', text: '오래된 요청', toolUses: [] }]
    on('session.messages', () => ({ value: [...messages] }))
    on('tool.call', { tool: 'TodoWrite' as never }, () => ({ result: {} }))

    await $.tool.call({ tool: 'TodoWrite', todos: TODOS.slice(0, 1) } as never)
    await clock.advance(2_000)
    messages.push({ role: 'user', text: '새 요청', toolUses: [] })
    await $.tool.call({ tool: 'TodoWrite', todos: TODOS.slice(0, 2) } as never)
    await clock.advance(2_000)

    expect(asked).toHaveLength(2)
    expect(asked[0]).toContain('## 대화 (처음부터')
    expect(asked[1]).toContain('## 지금까지의 노트 (네가 지난번에 쓴 것)\n목표: 체크포인트를 Kaggle로')
    expect(asked[1]).toContain('## 노트 이후의 새 대화\n[1] 사용자: 새 요청')
    expect(asked[1]).not.toContain('오래된 요청')
  })

  test('what the person asks the dashboard to look at goes first, until reset', async ($, on) => {
    const clock = mock.clock(on)
    const asked: string[] = []
    on('model.complete', ($, e) => {
      if (own(e)) asked.push(e.prompt)
      return answering(ANSWER)
    })
    on('ui.panes', () => ({ value: [SHOWN] }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('session.messages', () => ({ value: [{ role: 'user', text: '학습 돌려줘', toolUses: [] }] }))

    const reply = await $.command.run({ command: 'dashboard', args: 'loss 추세 위주로' } as never)
    expect(reply.text).toContain('loss 추세 위주로')
    await clock.advance(1_000)
    expect(asked.at(-1)).toContain('## 사용자가 대시보드에 바라는 것 (가장 우선)\nloss 추세 위주로')

    await $.command.run({ command: 'dashboard', args: 'reset' } as never)
    await clock.advance(1_000)
    expect(asked).toHaveLength(2)
    expect(asked[1]).not.toContain('사용자가 대시보드에 바라는 것')
  })

  test('what the model reads the person must decide waits at the top until they write', async ($, on) => {
    const clock = mock.clock(on)
    on('model.complete', () => answering(JSON.stringify({ notes: '', now: '배포 전 확인', ask: '프로덕션에 배포할지 결정', view: [] })))
    on('ui.panes', () => ({ value: [SHOWN] }))
    on('session.messages', () => ({ value: [{ role: 'assistant', text: '배포할까요?', toolUses: [] }] }))
    on('turn.complete', () => ({ text: '' }))
    on('prompt.submit', ($, e) => ({ text: e.text }))

    await $.turn.complete({ answer: '배포할까요?', durationMs: 1000, isAborted: false, turnId: 'x', reason: 'answer' } as never)
    await clock.advance(2_000)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: '◆ 프로덕션에 배포할지 결정' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '● 배포 전 확인' })).toBeDefined()
    await ui.unmount()

    await $.prompt.submit({ text: '배포해', origin: { kind: 'composer' }, wait: false } as never)
    const after = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await after.find({ type: 'Text', text: /^◆ / })).toBeUndefined()
    await after.unmount()
  })

  test('a running subagent\'s own conversation reaches the model', async ($, on) => {
    const clock = mock.clock(on)
    const asked: string[] = []
    on('model.complete', ($, e) => {
      if (own(e)) asked.push(e.prompt)
      return answering(ANSWER)
    })
    on('ui.panes', () => ({ value: [SHOWN] }))
    on('agent.spawn', () => ({ model: 'haiku', agentId: 'a1' }))
    on('session.messages', ($, e) =>
      (e as { agentId?: string }).agentId === 'a1'
        ? { value: [{ role: 'assistant', text: 'run_gpu 안의 두 번째 패스를 찾았다', toolUses: [] }] }
        : { value: [{ role: 'user', text: 'GPU 패스 추가해줘', toolUses: [] }] },
    )
    on('tool.call', { tool: 'TodoWrite' as never }, () => ({ result: {} }))

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
    await $.tool.call({ tool: 'TodoWrite', todos: TODOS } as never)
    await clock.advance(2_000)
    expect(asked.at(-1)).toContain('### GPU 패스 추가\n[0] Claude: run_gpu 안의 두 번째 패스를 찾았다')
  })

  test('what Claude says between its steps is noted and wakes the dashboard; its last words are left to its answer', async ($, on) => {
    const clock = mock.clock(on)
    const asked: string[] = []
    on('model.complete', ($, e) => {
      if (own(e)) asked.push(e.prompt)
      return answering(ANSWER)
    })
    on('ui.panes', () => ({ value: [SHOWN] }))
    const step = (answer: string, tools: number) =>
      ({ turnId: 't1', index: 0, answer, toolUses: Array.from({ length: tools }, (_, i) => ({ id: `u${i}`, name: 'Bash', input: {} })), stopReason: tools > 0 ? 'tool_use' : 'end_turn', usage: null }) as never
    let next = step('', 0)
    on('turn.step', async function* () {
      return next
    })
    const run = async () => {
      const stream = $.turn.step({ turnId: 't1', index: 0, model: 'opus', messageCount: 3 } as never)
      // The chunks are the engine's; only the result is read.
      let read = await stream.next()
      while (read.done !== true) read = await stream.next()
      return read.value
    }

    next = step('이제 실패한 테스트를 고치겠습니다.', 1)
    const passed = (await run()) as unknown as { answer: string }
    // The step passes through as it came.
    expect(passed.answer).toBe('이제 실패한 테스트를 고치겠습니다.')
    await clock.advance(2_000)
    expect(asked).toHaveLength(1)
    expect(asked[0]).toContain('Claude: 이제 실패한 테스트를 고치겠습니다.')

    next = step('다 고쳤습니다.', 0)
    await run()
    await clock.advance(30_000)
    expect(asked).toHaveLength(1)
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
    on('tool.call', { tool: 'Grep' as never }, () => ({ result: '' }))

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
      if (own(e)) asked.push(e.prompt)
      return answering(ANSWER)
    })
    on('ui.panes', () => ({ value: [SHOWN] }))
    on('tool.call', { tool: 'TodoWrite' as never }, () => ({ result: {} }))

    const wide = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await clock.advance(0)
    await $.tool.call({ tool: 'TodoWrite', todos: TODOS } as never)
    await clock.advance(2_000)
    expect(asked).toHaveLength(1)
    expect(asked[0]).toContain('가로 70칸, 세로 60줄')
    await wide.unmount()

    // A few cells narrower stays in the same class: the summary stands.
    const near = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 66, scroll: { offset: 0, bodyRows: 56 } } })
    await clock.advance(2_000)
    expect(asked).toHaveLength(1)
    await near.unmount()

    // A narrow, short pane is another class: drawn again for it, the blocks that do not fit left out.
    const narrow = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 34, scroll: { offset: 0, bodyRows: 8 } } })
    await clock.advance(2_000)
    expect(asked).toHaveLength(2)
    expect(asked[1]).toContain('가로 34칸, 세로 8줄')
    const texts = (await narrow.findAll({ type: 'Text' })).map(node => node.text)
    expect(texts.some(text => text.includes('0.871'))).toBe(false)
    await narrow.unmount()
  })

  test('a closed dashboard wakes no model', async ($, on) => {
    const clock = mock.clock(on)
    const asked: string[] = []
    on('model.complete', ($, e) => {
      if (own(e)) asked.push(e.prompt)
      return answering(ANSWER)
    })
    on('turn.complete', () => ({ text: '' }))

    await $.turn.complete({ answer: '끝', durationMs: 1000, isAborted: false, turnId: 'x', reason: 'answer' } as never)
    await clock.advance(30_000)
    expect(asked).toHaveLength(0)
  })

  test('a prompt taken back with Esc before any answer leaves the dashboard', async ($, on) => {
    const clock = mock.clock(on)
    const asked: string[] = []
    on('model.complete', ($, e) => {
      if (own(e)) asked.push(e.prompt)
      return answering(ANSWER)
    })
    on('ui.panes', () => ({ value: [SHOWN] }))
    on('prompt.submit', ($, e) => ({ text: e.text }))
    on('turn.complete', () => ({ text: '' }))
    on('tool.call', { tool: 'TodoWrite' as never }, () => ({ result: {} }))

    await $.tool.call({ tool: 'TodoWrite', todos: TODOS } as never)
    await $.prompt.submit({ text: '/dataviz', origin: { kind: 'composer' }, wait: false } as never)
    await clock.advance(2_000)
    expect(asked.at(-1)).toContain('사용자 요청: /dataviz')

    await $.turn.complete({ answer: '', durationMs: 300, isAborted: true, turnId: 't1', reason: 'aborted' } as never)
    await clock.advance(2_000)
    // The summary that drew it is drawn again, from a log without it.
    expect(asked).toHaveLength(2)
    expect(asked[1]).toContain('계획 갱신')
    expect(asked[1]).not.toContain('/dataviz')
    expect(asked[1]).not.toContain('중단')
  })

  test('a summary drawn only from a prompt taken back is cleared', async ($, on) => {
    const clock = mock.clock(on)
    on('model.complete', () => answering(ANSWER))
    on('ui.panes', () => ({ value: [SHOWN] }))
    on('prompt.submit', ($, e) => ({ text: e.text }))
    on('turn.complete', () => ({ text: '' }))

    await $.prompt.submit({ text: '/dataviz', origin: { kind: 'composer' }, wait: false } as never)
    await clock.advance(20_000)
    const before = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await before.find({ type: 'Text', text: '● 체크포인트를 Kaggle로 옮기는 중' })).toBeDefined()
    await before.unmount()
    await $.turn.complete({ answer: '', durationMs: 300, isAborted: true, turnId: 't1', reason: 'aborted' } as never)
    await clock.advance(2_000)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /^● / })).toBeUndefined()
    await ui.unmount()
  })

  test('a turn interrupted after it did something keeps its prompt', async ($, on) => {
    const clock = mock.clock(on)
    const asked: string[] = []
    on('model.complete', ($, e) => {
      if (own(e)) asked.push(e.prompt)
      return answering(ANSWER)
    })
    on('ui.panes', () => ({ value: [SHOWN] }))
    on('prompt.submit', ($, e) => ({ text: e.text }))
    on('turn.complete', () => ({ text: '' }))
    on('tool.call', { tool: 'Bash' }, () => DONE)

    await $.prompt.submit({ text: '테스트 돌려줘', origin: { kind: 'composer' }, wait: false } as never)
    await $.tool.call({ tool: 'Bash', command: 'npm test', description: '테스트 실행' })
    await $.turn.complete({ answer: '', durationMs: 9000, isAborted: true, turnId: 't1', reason: 'aborted' } as never)
    await clock.advance(2_000)
    expect(asked.at(-1)).toContain('사용자 요청: 테스트 돌려줘')
    expect(asked.at(-1)).toContain('사용자가 중단함')
  })

  test('secrets in the conversation, a prompt or a step label never reach the model', async ($, on) => {
    const clock = mock.clock(on)
    const asked: string[] = []
    on('model.complete', ($, e) => {
      if (own(e)) asked.push(e.prompt)
      return answering(ANSWER)
    })
    on('ui.panes', () => ({ value: [SHOWN] }))
    on('tool.call', { tool: 'Bash' }, () => new Promise(() => undefined))
    on('prompt.submit', ($, e) => ({ text: e.text }))
    on('session.messages', () => ({ value: [{ role: 'user', text: 'postgres://admin:s3cr3tpw@db 에 붙어서 확인해줘', toolUses: [] }] }))

    await $.prompt.submit({ text: 'DB_PASS=hunter2 로 접속해줘', origin: { kind: 'composer' } } as never)
    void $.tool.call({ tool: 'Bash', command: 'true', description: 'deploy with API_TOKEN=abc123xyz' })
    await clock.advance(20_000)

    expect(asked.length).toBeGreaterThan(0)
    for (const prompt of asked) {
      for (const secret of ['hunter2', 'abc123xyz', 's3cr3tpw']) expect(prompt).not.toContain(secret)
    }
  })

  test('a shell moved to the background keeps running there until its notification', async ($, on) => {
    mock.clock(on)
    on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'bg7', backgroundedByUser: true } }))
    on('prompt.submit', ($, e) => ({ text: e.text }))

    await $.tool.call({ tool: 'Bash', command: 'python3 train.py', description: '학습 재개' })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /^↻ 학습 재개/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^▶ / })).toBeUndefined()
    await ui.unmount()

    await $.prompt.submit({ text: '<task-notification><task-id>bg7</task-id></task-notification>', origin: { kind: 'task-notification' }, wait: false } as never)
    const after = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await after.find({ type: 'Text', text: /^↻ / })).toBeUndefined()
    await after.unmount()
  })

  test('a subagent\'s permission dialog waits as its own, not as the main shell', async ($, on) => {
    const clock = mock.clock(on)
    const finish: Record<string, () => void> = {}
    on('tool.call', { tool: 'Bash' }, ($, e) => new Promise(resolve => (finish[e.tool_use_id] = () => resolve(DONE))))
    on('agent.spawn', () => ({ model: 'haiku', agentId: 'a1' }))
    on('classic.PermissionRequest', () => ({}))

    const main = $.tool.call({ tool: 'Bash', command: 'python3 train.py', description: '학습 재개', tool_use_id: 'm1' } as never)
    await $.agent.spawn({
      tool_use_id: 't1',
      prompt: '데이터셋 올리기',
      description: '데이터셋 올리기',
      subagentType: 'general-purpose',
      provider: { plugin: 'engine', tier: 'core' },
      parentModel: 'opus',
      background: true,
      fork: false,
    } as never)
    const sub = $.tool.call({ tool: 'Bash', command: 'kaggle datasets create -p .', description: 'Kaggle 데이터셋 만들기', agentId: 'a1', tool_use_id: 's1' } as never)
    await clock.advance(0)
    await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'kaggle datasets create -p .', description: 'Kaggle 데이터셋 만들기' }, agent_id: 'a1' })

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /^◆ Kaggle 데이터셋 만들기 · 권한 요청$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^▶ 학습 재개/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^◎ 데이터셋 올리기/ })).toBeDefined()
    await ui.unmount()

    finish.s1!()
    await sub
    const after = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await after.find({ type: 'Text', text: /^◆ / })).toBeUndefined()
    await after.unmount()
    finish.m1!()
    await main
  })

  test('a rate-limited model is left alone a while before it is woken again', async ($, on) => {
    const clock = mock.clock(on)
    let asked = 0
    on('model.complete', ($, e) => {
      if (own(e)) asked += 1
      return { value: { isAnswered: false, reason: 'api-error', status: 429, error: 'rate_limit', usage: USAGE } }
    })
    on('ui.panes', () => ({ value: [SHOWN] }))
    on('tool.call', { tool: 'TodoWrite' as never }, () => ({ result: {} }))

    await $.tool.call({ tool: 'TodoWrite', todos: TODOS.slice(0, 1) } as never)
    await clock.advance(2_000)
    expect(asked).toBe(1)

    // Another urgent change would wake it in 2 seconds; after the failure it waits longer.
    await $.tool.call({ tool: 'TodoWrite', todos: TODOS.slice(0, 2) } as never)
    await clock.advance(2_000)
    expect(asked).toBe(1)
    await clock.advance(8_000)
    expect(asked).toBe(2)
  })

  test('the pane says the model is reading, and says why a call failed instead of staying blank', async ($, on) => {
    const clock = mock.clock(on)
    let reply: (value: never) => void = () => undefined
    on('model.complete', ($, e) => (own(e) ? new Promise(resolve => (reply = resolve)) : answering('메모 중')))
    on('ui.panes', () => ({ value: [SHOWN] }))
    on('session.messages', () => ({ value: [{ role: 'user', text: '학습 돌려줘', toolUses: [] }] }))
    on('tool.call', { tool: 'TodoWrite' as never }, () => ({ result: {} }))

    await $.tool.call({ tool: 'TodoWrite', todos: TODOS } as never)
    await clock.advance(2_000)
    await clock.advance(10_000)
    const reading = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await reading.find({ type: 'Text', text: /^대시보드 모델이 세션을 읽는 중… \d+초째$/ })).toBeDefined()
    await reading.unmount()

    // An answer cut off mid-JSON: nothing to draw, and the pane says so.
    reply({ value: { isAnswered: true, text: '{"notes":"목표', usage: USAGE } } as never)
    await clock.advance(0)
    const failed = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await failed.find({ type: 'Text', text: '모델 응답을 받지 못함 (응답을 읽지 못함) · 곧 다시 시도' })).toBeDefined()
    await failed.unmount()
  })

  test('a first read that fails is tried again smaller, and a long answer has room', async ($, on) => {
    const clock = mock.clock(on)
    const asked: { prompt: string; maxTokens: unknown }[] = []
    on('model.complete', ($, e) => {
      if (own(e)) asked.push({ prompt: e.prompt, maxTokens: (e as { maxTokens?: unknown }).maxTokens })
      return { value: { isAnswered: false as const, reason: 'aborted' as const, usage: USAGE } }
    })
    on('ui.panes', () => ({ value: [SHOWN] }))
    const long = Array.from({ length: 400 }, (_, i) => ({ role: 'user' as const, text: `요청 ${i} ${'가'.repeat(200)}`, toolUses: [] as [] }))
    on('session.messages', () => ({ value: long }))
    on('tool.call', { tool: 'TodoWrite' as never }, () => ({ result: {} }))

    await $.tool.call({ tool: 'TodoWrite', todos: TODOS.slice(0, 1) } as never)
    await clock.advance(2_000)
    await clock.advance(20_000)
    await $.tool.call({ tool: 'TodoWrite', todos: TODOS.slice(0, 2) } as never)
    await clock.advance(30_000)

    expect(asked).toHaveLength(2)
    expect(asked[0]!.maxTokens).toBe(32_000)
    // The second first read takes half as much of the conversation.
    expect(asked[1]!.prompt.length).toBeLessThan(asked[0]!.prompt.length * 0.6)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /^모델 응답을 받지 못함 \(시간 초과\)/ })).toBeDefined()
    await ui.unmount()
  })

  test('the dashboard model thinks hard: effort high', async ($, on) => {
    const clock = mock.clock(on)
    const efforts: unknown[] = []
    on('model.complete', ($, e) => {
      if (own(e)) efforts.push((e as { effort?: unknown }).effort)
      return answering(ANSWER)
    })
    on('ui.panes', () => ({ value: [SHOWN] }))
    on('tool.call', { tool: 'TodoWrite' as never }, () => ({ result: {} }))
    await $.tool.call({ tool: 'TodoWrite', todos: TODOS } as never)
    await clock.advance(2_000)
    expect(efforts).toEqual(['high'])
  })
})

describe('reading the session', () => {
  test('the conversation is condensed: what was said, each tool call and how it ended, markup out', () => {
    const text = condense(
      [
        { role: 'user', text: '테스트 고쳐줘 <system-reminder>secret harness</system-reminder>' },
        { role: 'assistant', text: '실패 원인을 보겠습니다.', toolUses: [{ tool: 'Bash', input: { command: 'npm test', description: '테스트 실행' }, text: '2 failed', isError: true }] },
        { role: 'assistant', text: '', toolUses: [{ tool: 'Edit', input: { file_path: '/src/a.ts' } }] },
      ],
      10_000,
    )
    expect(text).toBe(['[0] 사용자: 테스트 고쳐줘', '[1] Claude: 실패 원인을 보겠습니다.', '  ↳ Bash 테스트 실행 · npm test → 실패: 2 failed', '  ↳ Edit /src/a.ts → (실행 중)'].join('\n'))
  })

  test('a long conversation keeps its start and its end, and counts what it left out', () => {
    const blocks = Array.from({ length: 50 }, (_, i) => `메시지 ${i} ${'가'.repeat(30)}`)
    const text = fitText(blocks, 600)
    expect(text.length).toBeLessThanOrEqual(600)
    expect(text.startsWith('메시지 0 ')).toBe(true)
    expect(text).toContain('메시지 49 ')
    expect(text).toMatch(/… \(중간 \d+개 생략\) …/)
  })

  test('the notes pick up just past the last message they read, even after older ones scroll out', () => {
    const m = (text: string) => ({ role: 'user' as const, text })
    const messages = [m('a'), m('b'), m('c'), m('d')]
    expect(resumeAt(messages, null)).toBe(0)
    expect(resumeAt(messages, { text: '', upTo: 2, key: keyOf(m('b')) })).toBe(2)
    // Two older messages scrolled out: 'b' is now at index 0.
    expect(resumeAt(messages.slice(2), { text: '', upTo: 2, key: keyOf(m('b')) })).toBe(0)
    expect(resumeAt(messages.slice(1), { text: '', upTo: 2, key: keyOf(m('b')) })).toBe(1)
    // Compacted: the last one read is gone, so the conversation is read again.
    expect(resumeAt([m('요약'), m('d')], { text: '', upTo: 3, key: keyOf(m('c')) })).toBe(0)
  })

  test('Claude\'s plan follows its todo list and its task tools', () => {
    const todos = nextPlan([], 'TodoWrite', { todos: TODOS }, {})
    expect(todos.map(item => `${item.status} ${item.text}`)).toEqual(['completed 체크포인트 확인', 'in_progress Kaggle로 옮기기', 'pending 학습 재개'])
    const created = nextPlan([], 'TaskCreate', { subject: '빌드' }, { task: { id: '7' } })
    expect(created).toEqual([{ id: '7', text: '빌드', status: 'pending' }])
    expect(nextPlan(created, 'TaskUpdate', { taskId: '7', status: 'in_progress' }, {})).toEqual([{ id: '7', text: '빌드', status: 'in_progress' }])
    expect(nextPlan(created, 'TaskUpdate', { taskId: '7', status: 'deleted' }, {})).toEqual([])
  })

  test('the prompt holds each source in its own section, the empty ones left out', () => {
    const g: Gathered = {
      size: { columns: 70, rows: 40 },
      hint: '',
      notes: null,
      earlier: '지난번엔 블로그 배포',
      plan: [{ id: '1', text: '빌드', status: 'in_progress' }],
      runs: [{ id: 'x', kind: 'shell', label: '학습', startedAt: 0, background: true, taskId: null, last: '' }],
      waits: [],
      agents: [],
      workspace: 'git status:\n## main',
      project: '# 블로그',
      log: [{ id: 1, at: 0, kind: 'shell-done', text: '셸 끝남: 빌드' }],
      conversation: '[0] 사용자: 빌드해줘',
      compacted: false,
      previous: null,
      at: 120_000,
    }
    const prompt = promptFor(g, ageText)
    expect(prompt).toContain('## 이 프로젝트의 지난 세션 노트 (참고만, 지금 작업과 다를 수 있다)\n지난번엔 블로그 배포')
    expect(prompt).toContain('## 프로젝트 소개\n# 블로그')
    expect(prompt).toContain('[진행] 빌드')
    expect(prompt).toContain('백그라운드 셸 학습 (2분째)')
    expect(prompt).toContain('#1 2분 전 (새) 셸 끝남: 빌드')
    expect(prompt).toContain('## 대화 (처음부터, 길면 중간 생략)\n[0] 사용자: 빌드해줘')
    expect(prompt).not.toContain('사용자를 기다리는 것')
    expect(prompt).not.toContain('지금까지의 노트')
    // Once the notes exist, an earlier session's are no longer offered.
    expect(promptFor({ ...g, notes: { text: '노트', upTo: 1, key: '' } }, ageText)).not.toContain('지난 세션 노트')
  })

  test('the answer is read around a code fence, the view kept as materials', () => {
    const answer = parseAnswer('여기 있습니다\n```json\n' + ANSWER + '\n```')
    expect(answer?.notes).toContain('학습 재개')
    expect(answer?.summary.now).toBe('체크포인트를 Kaggle로 옮기는 중')
    // The material it does not know is dropped; the rest stays.
    expect(answer?.summary.view.map(node => node.t)).toEqual(['row', 'row', 'table'])
    expect(parseAnswer('모르겠습니다')).toBeUndefined()
  })

  test('the size class changes with a band of columns or of rows', () => {
    expect(fitOf({ columns: 70, rows: 60 })).toBe(fitOf({ columns: 66, rows: 56 }))
    expect(fitOf({ columns: 70, rows: 60 })).not.toBe(fitOf({ columns: 34, rows: 60 }))
    expect(fitOf({ columns: 70, rows: 60 })).not.toBe(fitOf({ columns: 70, rows: 14 }))
  })

  test('two spellings of one input compare equal', () => {
    expect(stableKey({ b: 1, a: [1, { d: 2, c: 3 }] })).toBe(stableKey({ a: [1, { c: 3, d: 2 }], b: 1 }))
  })
})

describe('drawing the materials', () => {
  const text = (lines: readonly (readonly Seg[])[]) => lines.map(line => line.map(seg => seg.text).join(''))
  const draw = (node: unknown, columns: number) => text(layout(parseView([node])[0]!, columns).lines)

  test('boxes joined by an arrow, the arrow on the first inner line', () => {
    expect(draw({ t: 'row', c: [{ t: 'box', c: ['✓ 빌드', '12쪽'] }, { t: 'arrow', dir: 'right' }, { t: 'box', style: 'bold', c: ['● 배포'] }] }, 60)).toEqual([
      '╭────────╮    ┏━━━━━━━━┓',
      '│ ✓ 빌드 │ ─▶ ┃ ● 배포 ┃',
      '│ 12쪽   │    ┗━━━━━━━━┛',
      '╰────────╯',
    ])
  })

  test('a row too wide for the pane wraps to the next line', () => {
    const boxes = { t: 'row', c: ['가나다라마', '바사아자차', '카타파하'] }
    expect(draw(boxes, 28)).toEqual(['가나다라마 바사아자차', '카타파하'])
  })

  test('a box with a title, a column under it, an arrow down', () => {
    expect(draw({ t: 'col', c: [{ t: 'box', title: '실패', tone: 'bad', c: ['✗ 경로'] }, { t: 'arrow', dir: 'down', label: '다시' }] }, 40)).toEqual([
      '╭─ 실패 ─╮',
      '│ ✗ 경로 │',
      '╰────────╯',
      '│ 다시',
      '▼',
    ])
  })

  test('a bar, a sparkline and a table, Hangul counted as two columns', () => {
    expect(draw({ t: 'bar', value: 3, max: 10, w: 10 }, 40)).toEqual(['███░░░░░░░'])
    expect(draw({ t: 'spark', values: [1, 2, 3, 4, 5, 6, 7, 8] }, 40)).toEqual(['▁▂▃▄▅▆▇█'])
    expect(draw({ t: 'table', head: ['실험', 'AUC'], rows: [['t384', '0.871'], ['긴 실험 이름', '0.85']] }, 40)).toEqual(['실험          AUC', 't384          0.871', '긴 실험 이름  0.85'])
  })

  test('text past the pane is cut with an ellipsis', () => {
    expect(draw('체크포인트를 Kaggle 데이터셋으로 올리는 중', 20)).toEqual(['체크포인트를 Kaggle…'])
  })

  test('the blocks that fit are kept in order; the first always is, cut to the room', () => {
    const view = parseView([{ t: 'col', c: ['1', '2', '3'] }, '4', '5'])
    expect(fitView(view, 20, 6, t => t).map(text)).toEqual([['1', '2', '3'], ['4']])
    expect(fitView(view, 20, 2, t => t).map(text)).toEqual([['1', '…']])
  })

  test('time marks are filled from the log, and a mark naming no entry is dropped', () => {
    const byId = new Map([
      [1, { at: 0 }],
      [2, { at: 600_000 }],
    ])
    const stamp = stamper(byId, 1_800_000, ageText)
    expect(stamp('학습 {for:1}')).toBe('학습 30분째')
    expect(stamp('빌드 {for:1-2}')).toBe('빌드 10분')
    expect(stamp('값 {ago:2}')).toBe('값 20분 전')
    expect(stamp('없음 {ago:9}')).toBe('없음 ')
  })

  test('malformed or unknown materials are dropped, never drawn', () => {
    expect(parseView([{ t: 'bar', value: 1, max: 0 }, { t: 'graph' }, 3, null, { t: 'row', c: [] }])).toEqual([])
    expect(parseView('not a list')).toEqual([])
  })
})
