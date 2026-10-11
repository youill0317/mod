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
