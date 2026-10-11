import { describe, expect, mock, test } from 'claude-code/testing'

import { cleanDescription, cleanMemo, fit } from '../hooks/memo'
import { mask, width } from '../hooks/text'

const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const ENGINE = { type: 'engine', ref: 0 } as const
const DONE = { result: { stdout: '', stderr: '', interrupted: false } }

const spinner = (requestId: string) =>
  ({
    component: 'Spinner',
    surface: 'terminal',
    requestId,
    props: { word: 'Sauteing', message: null, suffix: '…', mode: 'tool-use' },
    viewport: { columns: 120, rows: 40 },
  }) as const

describe('the memo beside the spinner', () => {
  test('shows Claude\'s description, then the Korean memo, then clears', async ($, on) => {
    const clock = mock.clock(on)

    let finish: () => void = () => undefined
    on('tool.call', { tool: 'Bash' }, () => new Promise(resolve => (finish = () => resolve(DONE))))

    let answer: () => void = () => undefined
    on('model.complete', () =>
      new Promise(resolve => {
        answer = () => resolve({ value: { isAnswered: true, text: '"Kaggle 결과 기다리는 중."', usage: USAGE } })
      }),
    )

    const drawn: string[] = []
    on('ui.render', { component: 'Spinner' }, ($, e) => {
      drawn.push(e.props.suffix)
      return ENGINE
    })

    const call = $.tool.call({ tool: 'Bash', command: 'kaggle kernels push -p .', description: 'Push kernel to Kaggle.' })
    await clock.advance(0)
    await $.ui.render(spinner('main'))
    expect(drawn.at(-1)).toBe('… · Push kernel to Kaggle')

    answer()
    await clock.advance(0)
    await $.ui.render(spinner('main'))
    expect(drawn.at(-1)).toBe('… · Kaggle 결과 기다리는 중')

    finish()
    await call
    await clock.advance(0)
    await $.ui.render(spinner('main'))
    expect(drawn.at(-1)).toBe('…')
  })

  test('leaves the spinner alone for a background command', async ($, on) => {
    const clock = mock.clock(on)
    on('tool.call', { tool: 'Bash' }, () => new Promise(() => undefined))
    on('model.complete', () => ({ value: { isAnswered: true, text: '학습 돌리는 중', usage: USAGE } }))

    const drawn: string[] = []
    on('ui.render', { component: 'Spinner' }, ($, e) => {
      drawn.push(e.props.suffix)
      return ENGINE
    })

    void $.tool.call({ tool: 'Bash', command: 'python3 train.py', description: 'Train', run_in_background: true })
    await clock.advance(0)
    await $.ui.render(spinner('main'))
    expect(drawn.at(-1)).toBe('…')
  })

  test('a subagent\'s spinner shows only its own memo, even before it runs a command', async ($, on) => {
    const clock = mock.clock(on)
    on('agent.spawn', () => ({ model: 'haiku', agentId: 'a1' }))
    on('tool.call', { tool: 'Bash' }, () => new Promise(() => undefined))
    on('model.complete', () => new Promise(() => undefined))

    const drawn: string[] = []
    on('ui.render', { component: 'Spinner' }, ($, e) => {
      drawn.push(e.props.suffix)
      return ENGINE
    })

    await $.agent.spawn({
      tool_use_id: 't1',
      prompt: '테스트 고치기',
      description: '테스트 고치기',
      subagentType: 'general-purpose',
      provider: { plugin: 'engine', tier: 'core' },
      parentModel: 'opus',
      background: true,
      fork: false,
    } as never)
    void $.tool.call({ tool: 'Bash', command: 'npm test', description: 'Run tests.' })
    await clock.advance(0)
    await $.ui.render(spinner('a1'))
    expect(drawn.at(-1)).toBe('…')
    await $.ui.render(spinner('main'))
    expect(drawn.at(-1)).toBe('… · Run tests')
  })

  test('a turn that ends clears the memos of its own loop only', async ($, on) => {
    const clock = mock.clock(on)
    on('tool.call', { tool: 'Bash' }, () => new Promise(() => undefined))
    on('model.complete', () => new Promise(() => undefined))
    on('turn.complete', () => ({ text: '' }))

    const drawn: string[] = []
    on('ui.render', { component: 'Spinner' }, ($, e) => {
      drawn.push(e.props.suffix)
      return ENGINE
    })

    void $.tool.call({ tool: 'Bash', command: 'npm test', description: 'Run tests.' })
    void $.tool.call({ tool: 'Bash', command: 'npm run lint', description: 'Lint.', agentId: 'a1' } as never)
    await clock.advance(0)

    await $.turn.complete({ answer: '끝', durationMs: 1000, isAborted: false, turnId: 'x', agentId: 'a1', reason: 'answer' } as never)
    await $.ui.render(spinner('a1'))
    expect(drawn.at(-1)).toBe('…')
    await $.ui.render(spinner('main'))
    expect(drawn.at(-1)).toBe('… · Run tests')

    await $.turn.complete({ answer: '끝', durationMs: 1000, isAborted: false, turnId: 'y', reason: 'answer' } as never)
    await $.ui.render(spinner('main'))
    expect(drawn.at(-1)).toBe('…')
  })

  test('a new session starts with no memos', async ($, on) => {
    const clock = mock.clock(on)
    on('tool.call', { tool: 'Bash' }, () => new Promise(() => undefined))
    on('model.complete', () => new Promise(() => undefined))
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('command.register', ($, e) => ({ value: { command: e.name } }))
    on('tool.register', ($, e) => ({ value: { tool: e.name } }))

    const drawn: string[] = []
    on('ui.render', { component: 'Spinner' }, ($, e) => {
      drawn.push(e.props.suffix)
      return ENGINE
    })

    void $.tool.call({ tool: 'Bash', command: 'npm test', description: 'Run tests.' })
    await clock.advance(0)
    await $.ui.render(spinner('main'))
    expect(drawn.at(-1)).toBe('… · Run tests')

    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    await $.ui.render(spinner('main'))
    expect(drawn.at(-1)).toBe('…')
  })
})

describe('helpers', () => {
  test('memos sit side by side and the rest is counted when the line is full', () => {
    expect(fit(['테스트 실행 중', '코드 형식 검사 중'], 60)).toBe('테스트 실행 중 · 코드 형식 검사 중')
    expect(fit(['테스트 실행 중', '코드 형식 검사 중', 'Kaggle 결과 기다리는 중'], 41)).toBe('테스트 실행 중 · 코드 형식 검사 중 외 1개')
    expect(fit(['테스트 실행 중', '코드 형식 검사 중', 'Kaggle 결과 기다리는 중'], 40)).toBe('테스트 실행 중 외 2개')
    expect(fit(['체크포인트를 Kaggle 데이터셋으로 올리는 중'], 20)).toBe('체크포인트를 Kaggle…')
    expect(fit(['테스트 실행 중'], 3)).toBe('')
  })

  test('Hangul counts two columns', () => {
    expect(width('중')).toBe(2)
    expect(width('ab 중')).toBe(5)
  })

  test('secrets are hidden before the command leaves for the model', () => {
    const masked = mask('export KAGGLE_API_TOKEN="abc123"; curl -H "Authorization: Bearer xyz" --password hunter2 ghp_abcdefghijkl')
    expect(masked).not.toContain('abc123')
    expect(masked).not.toContain('xyz')
    expect(masked).not.toContain('hunter2')
    expect(masked).not.toContain('ghp_abcdefghijkl')
    expect(masked).toContain('KAGGLE_API_TOKEN=***')
  })

  test('answers and descriptions are cleaned to one short line', () => {
    expect(cleanMemo('\n- "테스트 실행 중."\n다른 줄')).toBe('테스트 실행 중')
    expect(cleanDescription('Push kernel to Kaggle.\nmore')).toBe('Push kernel to Kaggle')
    expect(cleanDescription(undefined)).toBe('')
  })
})
