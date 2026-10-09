import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { RunningShell } from '../types'

// What runs now, per loop: the main Claude (agentId null) or a subagent.
const running = atom({ plugin: 'shell-memo', key: 'running' } as const, [])
// Ids of the subagents seen, so a spinner's requestId tells its loop.
const subagents = atom({ plugin: 'shell-memo', key: 'subagents' } as const, [])

// The spinner line keeps this much room for what the engine draws after the
// memo: the icon, the ellipsis and "(7m 45s · ↓ 3.2k tokens · esc to interrupt)".
const RESERVED_COLUMNS = 52
const CACHE_SIZE = 200

const SYSTEM = [
  '터미널 명령이 지금 무엇을 하는지 개발자가 아닌 사람에게 알려 주는 아주 짧은 메모를 쓴다.',
  '규칙:',
  '- 한국어 한 구절, 25자 이내.',
  "- '중'으로 끝낸다. 예: 테스트 실행 중, Kaggle 결과 기다리는 중, 체크포인트를 Drive에서 받는 중",
  '- 명령어, 옵션, 파일 경로, 따옴표, 마침표를 쓰지 않는다. Kaggle, Git, Drive 같은 서비스 이름은 써도 된다.',
  '- 메모만 출력한다.',
].join('\n')

// Korean memos already made, by command. Module state: it starts over on a
// reload, which only costs a few model calls.
const memos = new Map<string, string>()
// The session's model, once the organization refused the preferred one.
let fallback: string | undefined

export const register: Register = (on, options) => {
  const preferred = typeof options.model === 'string' && options.model !== '' ? options.model : 'haiku'

  // A reload drops the old module mid-call, so nothing it tracked is still true.
  on('session.start', async ($, e, next) => {
    await update($, running, () => [])
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    const agentId = started.agentId
    if (agentId !== undefined) await rememberSubagent($, agentId)
    return started
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (e.run_in_background === true) return next(e)

    const id = e.tool_use_id
    const agentId = e.agentId ?? null
    if (agentId !== null) await rememberSubagent($, agentId)

    const known = memos.get(e.command)
    const shell: RunningShell = { id, agentId, memo: known ?? cleanDescription(e.description) }
    await update($, running, list => [...list.filter(one => one.id !== id), shell])

    if (known === undefined) {
      void explain($, preferred, e.command, e.description)
        .then(async memo => {
          if (memo === undefined) return
          remember(e.command, memo)
          await update($, running, list => list.map(one => (one.id === id ? { ...one, memo } : one)))
        })
        .catch(() => undefined)
    }

    try {
      return await next(e)
    } finally {
      await update($, running, list => list.filter(one => one.id !== id))
    }
  })

  // A turn that ended runs no foreground shell any more, whatever was missed.
  on('turn.complete', async ($, e, next) => {
    const ended = await next(e)
    const agentId = e.agentId ?? null
    await update($, running, list => list.filter(one => one.agentId !== agentId))
    return ended
  })

  // Beside the engine's own words: "✻ Sauteing… · 테스트 실행 중 (12s · …)".
  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    const list = await read($, running)
    const seen = await read($, subagents)
    const loop = seen.includes(e.requestId) ? e.requestId : null
    const shown = list.filter(one => one.agentId === loop && one.memo !== '').map(one => one.memo)
    if (shown.length === 0) return next(e)

    const head = e.props.message ?? e.props.word
    const room = (e.viewport?.columns ?? 100) - width(head) - RESERVED_COLUMNS
    const memo = fit(shown, room)
    if (memo === '') return next(e)

    return next({ ...e, props: { ...e.props, suffix: `${e.props.suffix} · ${memo}` } })
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
  return answer.isAnswered ? cleanMemo(answer.text) : undefined
}

async function rememberSubagent($: EngineInterface, agentId: string) {
  await update($, subagents, list => (list.includes(agentId) ? list : [...list, agentId].slice(-50)))
}

// Claude's own one-line description, shown until the Korean memo arrives.
export function cleanDescription(description: string | undefined): string {
  const line = (description ?? '').split('\n')[0]?.trim().replace(/\.$/, '') ?? ''
  return truncate(line, 60)
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
  return truncate(plain, 40)
}

// Hides what looks like a secret before the command leaves for the model.
export function mask(command: string): string {
  return command
    .replace(/(\b[A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|AUTH)[A-Za-z0-9_]*\s*=\s*)("[^"]*"|'[^']*'|\S+)/gi, '$1***')
    .replace(/(--?(?:token|password|passwd|secret|api-?key|auth)(?:=|\s+))("[^"]*"|'[^']*'|\S+)/gi, '$1***')
    .replace(/(Bearer\s+)\S+/gi, '$1***')
    .replace(/\b(?:sk|ghp|gho|ghs|github_pat|xox[abprs]|AKIA)[-_A-Za-z0-9]{8,}/g, '***')
    .replace(/\b[A-Za-z0-9_]{32,}\b/g, '***')
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

// Terminal columns: Hangul, CJK and full-width forms take two.
export function width(text: string): number {
  let columns = 0
  for (const char of text) columns += isWide(char.codePointAt(0) ?? 0) ? 2 : 1
  return columns
}

export function truncate(text: string, max: number): string {
  if (width(text) <= max) return text
  if (max < 2) return ''
  let out = ''
  let used = 0
  for (const char of text) {
    const w = isWide(char.codePointAt(0) ?? 0) ? 2 : 1
    if (used + w > max - 1) break
    out += char
    used += w
  }
  return `${out}…`
}

function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  )
}
