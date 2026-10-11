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

    // The model is asked once the command has run a moment.
    await clock.advance(1_500)
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

  test('a command that ends before the memo is due asks no model', async ($, on) => {
    const clock = mock.clock(on)
    let finish: () => void = () => undefined
    on('tool.call', { tool: 'Bash' }, () => new Promise(resolve => (finish = () => resolve(DONE))))
    let asked = 0
    on('model.complete', () => {
      asked += 1
      return { value: { isAnswered: true, text: '파일 찾는 중', usage: USAGE } }
    })

    const call = $.tool.call({ tool: 'Bash', command: 'grep -rn TODO src', description: 'Find TODOs' })
    await clock.advance(100)
    finish()
    await call
    await clock.advance(5_000)
    expect(asked).toBe(0)
  })

  test('a session with nobody at the prompt makes no memo', async ($, on) => {
    const clock = mock.clock(on)
    on('tool.call', { tool: 'Bash' }, () => new Promise(() => undefined))
    let asked = 0
    on('model.complete', () => {
      asked += 1
      return { value: { isAnswered: true, text: '학습 돌리는 중', usage: USAGE } }
    })

    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('command.register', () => ({ value: { command: 'dashboard' } }))
    on('tool.register', () => ({ value: { tool: 'mcp__dashboard__signal' } }))

    await $.session.start({ cwd: '/', surface: null, isInteractive: false })
    void $.tool.call({ tool: 'Bash', command: 'python3 headless.py', description: 'Train' })
    await clock.advance(5_000)
    expect(asked).toBe(0)
  })

  test('a model this account cannot use gives way to the session\'s own', async ($, on) => {
    const clock = mock.clock(on)
    on('tool.call', { tool: 'Bash' }, () => new Promise(() => undefined))
    on('session.model', () => ({ value: 'session-model' }))
    const models: string[] = []
    on('model.complete', ($, e) => {
      models.push(e.model)
      return e.model === 'session-model'
        ? { value: { isAnswered: true, text: '테스트 실행 중', usage: USAGE } }
        : { value: { isAnswered: false, reason: 'api-error', status: 404, error: 'model_not_found', usage: USAGE } }
    })
    const drawn: string[] = []
    on('ui.render', { component: 'Spinner' }, ($, e) => {
      drawn.push(e.props.suffix)
      return ENGINE
    })

    void $.tool.call({ tool: 'Bash', command: 'npm test', description: 'Run tests' })
    await clock.advance(1_500)
    await clock.advance(0)
    expect(models).toEqual(['haiku', 'session-model'])
    await $.ui.render(spinner('main'))
    expect(drawn.at(-1)).toBe('… · 테스트 실행 중')
  })

  test('a busy model is left alone a while, not asked for every command', async ($, on) => {
    const clock = mock.clock(on)
    const finishers: (() => void)[] = []
    on('tool.call', { tool: 'Bash' }, () => new Promise(resolve => finishers.push(() => resolve(DONE))))
    let asked = 0
    on('model.complete', () => {
      asked += 1
      return { value: { isAnswered: false, reason: 'api-error', status: 429, error: 'rate_limit', usage: USAGE } }
    })
    const run = async (command: string) => {
      const call = $.tool.call({ tool: 'Bash', command, description: 'Build' })
      await clock.advance(1_500)
      finishers.shift()?.()
      await call
    }

    await run('make one')
    expect(asked).toBe(1)
    await run('make two')
    await run('make three')
    expect(asked).toBe(1)
    await clock.advance(10_000)
    await run('make four')
    expect(asked).toBe(2)
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
