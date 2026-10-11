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

// The band above the prompt, with Claude at work or at rest.
const band = (isWorking: boolean) =>
  ({
    plugin: 'dashboard',
    component: 'AbovePrompt',
    surface: 'terminal',
    requestId: 'main',
    props: { hasSurvey: false, isWorking, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} },
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

  test('a command moved to the background mid-run shows above the prompt while Claude rests', async ($, on) => {
    const clock = mock.clock(on)
    let moveIt: () => void = () => undefined
    on('tool.call', { tool: 'Bash' }, () =>
      new Promise(resolve => (moveIt = () => resolve({ result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'bg9', backgroundedByUser: true } }))),
    )
    on('model.complete', () => ({ value: { isAnswered: true, text: '테스트 실행 중', usage: USAGE } }))
    on('prompt.submit', ($, e) => ({ text: e.text }))
    on('ui.render', { component: 'AbovePrompt' }, () => ENGINE)

    const call = $.tool.call({ tool: 'Bash', command: 'npm test', description: 'Run tests' })
    await clock.advance(1_500)
    moveIt()
    await call

    // While Claude works its spinner speaks; the band stays quiet.
    const busy = await $.ui.mount(band(true))
    expect(await busy.find({ type: 'Text', text: /^↻ / })).toBeUndefined()
    await busy.unmount()

    await clock.advance(60_000)
    const idle = await $.ui.mount(band(false))
    expect(await idle.find({ type: 'Text', text: '↻ 테스트 실행 중 · 1분' })).toBeDefined()
    await idle.unmount()

    await $.prompt.submit({ text: '<task-notification><task-id>bg9</task-id></task-notification>', origin: { kind: 'task-notification' }, wait: false } as never)
    const done = await $.ui.mount(band(false))
    expect(await done.find({ type: 'Text', text: /^↻ / })).toBeUndefined()
    await done.unmount()
  })

  test('a command that ends in the foreground leaves nothing above the prompt', async ($, on) => {
    mock.clock(on)
    on('tool.call', { tool: 'Bash' }, () => DONE)
    on('ui.render', { component: 'AbovePrompt' }, () => ENGINE)

    await $.tool.call({ tool: 'Bash', command: 'npm test', description: 'Run tests' })
    const ui = await $.ui.mount(band(false))
    expect(await ui.find({ type: 'Text', text: /^↻ / })).toBeUndefined()
    await ui.unmount()
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

  test('common secret shapes in URLs, flags, headers and env names are hidden', () => {
    const hidden: [string, string][] = [
      ['psql postgres://admin:hunter2@db/app', 'hunter2'],
      ['clone https://oauth2:glpat-xxx@gitlab.com/a/b', 'glpat-xxx'],
      ['curl -u admin:hunter2 https://x', 'hunter2'],
      ['mysql -u root -phunter2 app', 'hunter2'],
      ['sshpass -p hunter2 ssh host', 'hunter2'],
      ['curl -H "X-Api-Key: abc999" https://x', 'abc999'],
      ['curl -H "Authorization: Basic dXNlcjpwdw" https://x', 'dXNlcjpwdw'],
      ['curl -H "Authorization: token ghx12" https://x', 'ghx12'],
      ['DB_PASS=hunter2 ./run', 'hunter2'],
      ['PRIVATE_KEY=zzz111 ./run', 'zzz111'],
      ['OPENAI_KEY=zzz111 ./run', 'zzz111'],
      ['secret wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY end', 'wJalrXUtnFEMI'],
    ]
    for (const [input, secret] of hidden) expect(mask(input)).not.toContain(secret)
  })

  test('ordinary commands are left alone', () => {
    for (const input of ['push -u origin main', 'mysql -P 3306 -h db app', 'ls /home/user/project/src/components', 'npm run build --port 80'])
      expect(mask(input)).toBe(input)
  })

  test('answers and descriptions are cleaned to one short line', () => {
    expect(cleanMemo('\n- "테스트 실행 중."\n다른 줄')).toBe('테스트 실행 중')
    expect(cleanDescription('Push kernel to Kaggle.\nmore')).toBe('Push kernel to Kaggle')
    expect(cleanDescription(undefined)).toBe('')
  })
})
