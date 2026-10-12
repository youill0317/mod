import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { RunningShell } from '../types'
import { backoffMs, isUnavailable, mask, truncate, width } from './text'

// The memo beside the spinner. Its session.start, agent.spawn and turn.complete
// work is done in register.tsx, which hooks those events for both views.

// What runs now, per loop: the main Claude (agentId null) or a subagent.
const shells = atom({ plugin: 'dashboard', key: 'shells' } as const, [])
// Ids of the subagents seen, so a spinner's requestId tells its loop.
const subagents = atom({ plugin: 'dashboard', key: 'subagents' } as const, [])
// Whether a person is at the prompt (register.tsx writes it at session.start):
// a `-p` run or the SDK draws no spinner, so it gets no memo.
const interactive = atom({ plugin: 'dashboard', key: 'interactive' } as const, true)

// The rest of the spinner line, as the engine reckons it: the icon (2), its own
// slack with the parentheses (5) and one more column, the time up to "1h 23m 45s"
// (10), " · " and the tokens up to "↓ 123.4k tokens" (15). The engine keeps the
// time and tokens only while the line leaves them this much, and draws no
// "esc to interrupt" there any more.
const RESERVED_COLUMNS = 36
const CACHE_SIZE = 200
// A command that ends sooner than this gets no memo: it would end before the memo came.
const MEMO_DELAY_MS = 1_500

const SYSTEM = [
  '터미널 명령이 지금 무엇을 하는지 개발자가 아닌 사람에게 알려 주는 아주 짧은 메모를 쓴다.',
  '규칙:',
  '- 한국어 한 구절, 25자 이내.',
  "- '중'으로 끝낸다. 예: 테스트 실행 중, Kaggle 결과 기다리는 중, 체크포인트를 Drive에서 받는 중",
  '- 명령어, 옵션, 파일 경로, 따옴표, 마침표를 쓰지 않는다. Kaggle, Git, Drive 같은 서비스 이름은 써도 된다.',
  '- 메모만 출력한다.',
].join('\n')

// Added to the Bash tool's description: Claude writes the memo itself, so it shows
// the moment the command starts and no model is asked. The same rules as SYSTEM.
const DESCRIBE = [
  'Write `description` as the memo shown beside the working spinner while the command runs:',
  "one short plain-Korean phrase for someone who is not a developer, at most 25 characters, ending in '중'",
  '(테스트 실행 중, Kaggle 결과 기다리는 중, 체크포인트를 Drive에서 받는 중).',
  'No commands, flags, file paths, quotes or full stops; service names such as Kaggle, Git or Drive are fine.',
].join(' ')

// Korean memos already made, by command. Module state: it starts over on a
// reload, which only costs a few model calls.
const memos = new Map<string, string>()
// The session's model, once the organization refused the preferred one.
let fallback: string | undefined
// Failed calls in a row, and until when the model is left alone after them.
let failures = 0
let pausedUntil = 0

export const register: Register = (on, options) => {
  const preferred = typeof options.model === 'string' && options.model !== '' ? options.model : 'haiku'

  on('tool.describe', { tool: 'Bash' }, async ($, e, next) => {
    const described = await next(e)
    return { ...described, description: `${described.description}\n\n${DESCRIBE}` }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (e.run_in_background === true) return next(e)

    const id = e.tool_use_id
    const agentId = e.agentId ?? null
    if (agentId !== null) await rememberSubagent($, agentId)

    const known = memos.get(e.command)
    const written = cleanDescription(e.description)
    const shell: RunningShell = { id, agentId, memo: known ?? written }
    await update($, shells, list => [...list.filter(one => one.id !== id), shell])

    // Claude wrote it in Korean, as the tool's description asks: that is the memo.
    const timer =
      known === undefined && !/[가-힣]/.test(written)
        ? $.clock.after(MEMO_DELAY_MS, async () => {
            try {
              if (!(await read($, interactive))) return
              const memo = await explain($, preferred, e.command, e.description)
              if (memo === undefined) return
              remember(e.command, memo)
              await update($, shells, list => list.map(one => (one.id === id ? { ...one, memo } : one)))
            } catch {
              // No memo this time: Claude's description stays.
            }
          })
        : undefined

    try {
      return await next(e)
    } finally {
      timer?.cancel()
      await update($, shells, list => list.filter(one => one.id !== id))
    }
  })

  // Beside the engine's own words: "✻ Sauteing… · 테스트 실행 중 (12s · …)".
  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    const list = await read($, shells)
    const seen = await read($, subagents)
    const loop = seen.includes(e.requestId) ? e.requestId : null
    const shown = list.filter(one => one.agentId === loop && one.memo !== '').map(one => one.memo)
    if (shown.length === 0) return next(e)

    const head = e.props.message ?? e.props.word
    const lead = `${e.props.suffix} · `
    const room = (e.viewport?.columns ?? 100) - width(head) - width(lead) - RESERVED_COLUMNS
    const memo = fit(shown, room)
    if (memo === '') return next(e)

    return next({ ...e, props: { ...e.props, suffix: lead + memo } })
  })
}

function remember(command: string, memo: string) {
  memos.delete(command)
  memos.set(command, memo)
  if (memos.size > CACHE_SIZE) {
    const oldest = memos.keys().next().value
    if (oldest !== undefined) memos.delete(oldest)
  }
}

async function complete($: EngineInterface, model: string, prompt: string) {
  return $.model.complete({ model, system: SYSTEM, prompt, maxTokens: 60, effort: 'low', timeoutMs: 15_000 })
}

// The Korean memo for one command, or undefined when no model answered.
async function explain($: EngineInterface, preferred: string, command: string, description: string | undefined) {
  if ((await $.clock.now()) < pausedUntil) return undefined
  const prompt = `명령:\n${mask(command).slice(0, 2_000)}\n\nClaude가 붙인 설명: ${mask(description?.trim() || '(없음)')}`
  let answer
  try {
    answer = await complete($, fallback ?? preferred, prompt)
  } catch {
    // The organization may not allow the preferred model: use the session's.
    if (fallback !== undefined) return undefined
    fallback = await $.session.model()
    answer = await complete($, fallback, prompt)
  }
  // A model this account cannot use answers an error rather than refusing: use the session's too.
  if (!answer.isAnswered && answer.reason === 'api-error' && fallback === undefined && isUnavailable(answer.error, answer.status)) {
    fallback = await $.session.model()
    answer = await complete($, fallback, prompt)
  }
  if (!answer.isAnswered && answer.reason === 'api-error') {
    // Busy or failing: wait longer after each failure in a row.
    failures += 1
    pausedUntil = (await $.clock.now()) + backoffMs(failures)
    return undefined
  }
  if (!answer.isAnswered) return undefined
  failures = 0
  return cleanMemo(answer.text)
}

async function rememberSubagent($: EngineInterface, agentId: string) {
  await update($, subagents, list => withSubagent(list, agentId))
}

// The subagents seen, with one more: the latest 50.
export function withSubagent(list: string[], agentId: string): string[] {
  return list.includes(agentId) ? list : [...list, agentId].slice(-50)
}

// Claude's own one-line description, shown until the Korean memo arrives.
export function cleanDescription(description: string | undefined): string {
  const line = (description ?? '').split('\n')[0]?.trim().replace(/\.$/, '') ?? ''
  return line
}

// The model's answer as one short memo.
export function cleanMemo(text: string): string {
  const line = text
    .split('\n')
    .map(one => one.trim())
    .find(one => one !== '') ?? ''
  const plain = line
    .replace(/^[-*•\s]+/, '')
    .replace(/["'`“”‘’]/g, '')
    .replace(/[.。]+$/, '')
    .replace(/\s+/g, ' ')
    .trim()
  return plain
}

// The memos joined beside each other, as many as the line has room for.
export function fit(memos: readonly string[], room: number): string {
  if (room < 6 || memos.length === 0) return ''
  let out = ''
  for (let i = 0; i < memos.length; i++) {
    const joined = out === '' ? memos[i]! : `${out} · ${memos[i]}`
    const left = memos.length - i - 1
    const tail = left > 0 ? ` 외 ${left}개` : ''
    if (width(joined + tail) <= room) {
      out = joined
      continue
    }
    if (out === '') {
      const more = memos.length - 1
      const rest = more > 0 ? ` 외 ${more}개` : ''
      const cut = truncate(memos[0]!, room - width(rest))
      return cut === '' ? '' : cut + rest
    }
    return `${out} 외 ${memos.length - i}개`
  }
  return out
}
