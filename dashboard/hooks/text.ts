// Text helpers both views share: terminal width, cutting to it, hiding secrets.

// Hides what looks like a secret before text leaves for the model.
export function mask(text: string): string {
  return text
    .replace(/(\b[A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|AUTH)[A-Za-z0-9_]*\s*=\s*)("[^"]*"|'[^']*'|\S+)/gi, '$1***')
    .replace(/(--?(?:token|password|passwd|secret|api-?key|auth)(?:=|\s+))("[^"]*"|'[^']*'|\S+)/gi, '$1***')
    .replace(/(Bearer\s+)\S+/gi, '$1***')
    .replace(/\b(?:sk|ghp|gho|ghs|github_pat|xox[abprs]|AKIA)[-_A-Za-z0-9]{8,}/g, '***')
    .replace(/\b[A-Za-z0-9_]{32,}\b/g, '***')
    .replace(/(\b[A-Za-z0-9_]*_(?:KEY|PASS)\s*=\s*)("[^"]*"|'[^']*'|\S+)/gi, '$1***')
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:\/@]*:)[^\s@\/]+@/gi, '$1***@')
    .replace(/(\s(?:-u|--user)(?:=|\s+))("[^"]*:[^"]*"|'[^']*:[^']*'|[^\s:]*:\S+)/g, '$1***')
    .replace(/(\bmysql\w*\b[^|;&\n]*?\s-p)\S+/g, '$1***')
    .replace(/(\bsshpass\b[^|;&\n]*?\s-p\s*)("[^"]*"|'[^']*'|\S+)/g, '$1***')
    .replace(/(\b(?:X-[A-Za-z-]*(?:Key|Token|Secret|Auth)[A-Za-z-]*|Api-?Key|(?:Proxy-)?Authorization|Cookie)\s*:\s*)[^"'\n]+/gi, '$1***')
    .replace(/[A-Za-z0-9+\/=]{32,}/g, found => (/^[/.]/.test(found) || !/[A-Z]/.test(found) || !/[a-z]/.test(found) || !/\d/.test(found) || !/[+\/=]/.test(found) ? found : '***'))
}

// Whether a model call's API error means this account cannot use that model
// (not offered on its provider, not allowed for its organization): the
// session's own model is asked instead. Other errors may clear on their own.
export function isUnavailable(error: string, status: number | null): boolean {
  return error === 'model_not_found' || error === 'invalid_request' || error === 'oauth_org_not_allowed' || status === 403 || status === 404
}

// How long to leave the model alone after this many failed calls in a row.
export function backoffMs(failures: number): number {
  return Math.min(10_000 * 2 ** Math.max(0, failures - 1), 600_000)
}

// Terminal columns, as the engine measures them: Hangul, CJK, full-width forms
// and emoji take two; a combining mark, a variation selector or what a joiner
// joins takes none. One user-perceived character (a cluster) is never split.
export function width(text: string): number {
  let columns = 0
  for (const [, w] of clusters(text)) columns += w
  return columns
}

export function truncate(text: string, max: number): string {
  if (width(text) <= max) return text
  if (max < 2) return ''
  let out = ''
  let used = 0
  for (const [cluster, w] of clusters(text)) {
    if (used + w > max - 1) break
    out += cluster
    used += w
  }
  return `${out}…`
}

const JOINS = /^[\p{Mn}\p{Me}\p{Cf}\u1160-\u11ff\ud7b0-\ud7ff\ufe00-\ufe0f]$/u
const ZWJ = '\u200d'
const VS16 = '\ufe0f'
const KEYCAP = '\u20e3'
const EMOJI = /^\p{Emoji_Presentation}$/u
const PICTOGRAPHIC = /^\p{Extended_Pictographic}$/u
const SKIN = /^\p{Emoji_Modifier}$/u
const FLAG = /^\p{Regional_Indicator}$/u

/** The text's clusters, each with the columns it takes. */
function* clusters(text: string): Generator<[string, number]> {
  let cluster = ''
  let base = ''
  let joined = false
  for (const char of text) {
    const joins =
      cluster !== '' &&
      (JOINS.test(char) || joined || (SKIN.test(char) && PICTOGRAPHIC.test(base)) || (FLAG.test(char) && FLAG.test(base) && cluster === base))
    if (joins) {
      cluster += char
      joined = char === ZWJ
      continue
    }
    if (cluster !== '') yield [cluster, columnsOf(cluster, base)]
    cluster = char
    base = char
    joined = false
  }
  if (cluster !== '') yield [cluster, columnsOf(cluster, base)]
}

function columnsOf(cluster: string, base: string): number {
  if (JOINS.test(base)) return 0
  if (FLAG.test(base)) return cluster === base ? 1 : 2
  if (EMOJI.test(base) || cluster.includes(KEYCAP)) return 2
  if (cluster.includes(VS16) && PICTOGRAPHIC.test(base)) return 2
  return isWide(base.codePointAt(0) ?? 0) ? 2 : 1
}

function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2329 && cp <= 0x232a) ||
    (cp >= 0x2630 && cp <= 0x2637) ||
    (cp >= 0x268a && cp <= 0x268f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x3247) ||
    (cp >= 0x3250 && cp <= 0xa4cf) ||
    (cp >= 0xa960 && cp <= 0xa97f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x16fe0 && cp <= 0x1b2ff) ||
    (cp >= 0x1f200 && cp <= 0x1f2ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  )
}
