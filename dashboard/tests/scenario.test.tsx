import { expect, mock, test } from 'claude-code/testing'

const ANSWER = "{\"title\": \"Astro 연구 블로그 배포\", \"now\": \"배포 준비: 이미지 26개 최적화 중\", \"waiting\": \"\", \"blocks\": [{\"kind\": \"flow\", \"title\": \"\", \"steps\": [{\"label\": \"프로젝트\", \"state\": \"done\"}, {\"label\": \"글 변환\", \"state\": \"done\"}, {\"label\": \"빌드 검사\", \"state\": \"done\"}, {\"label\": \"이미지 줄이기\", \"state\": \"now\"}, {\"label\": \"배포\", \"state\": \"todo\"}]}, {\"kind\": \"bars\", \"title\": \"이미지\", \"items\": [{\"label\": \"최적화\", \"value\": 38, \"max\": 64, \"note\": \"남은 26개 진행\", \"tone\": \"normal\", \"from\": 18}]}, {\"kind\": \"metrics\", \"title\": \"\", \"items\": [{\"label\": \"성능\", \"value\": \"92\", \"tone\": \"good\", \"from\": 23}, {\"label\": \"접근성\", \"value\": \"100\", \"tone\": \"good\", \"from\": 23}, {\"label\": \"SEO\", \"value\": \"98\", \"tone\": \"good\", \"from\": 23}, {\"label\": \"페이지\", \"value\": \"12\", \"tone\": \"good\", \"from\": 14}]}, {\"kind\": \"list\", \"title\": \"실패\", \"items\": [{\"text\": \"이미지 경로 3개 누락, 수정 후 빌드 통과\", \"tone\": \"good\"}, {\"text\": \"깨진 링크 2개, 수정 후 0개\", \"tone\": \"good\"}]}]}"
const LOG = ["사용자 요청: 내 연구 블로그를 Astro로 만들고 Vercel에 배포해줘. 글 12개는 notes 폴더에 있어", "프로젝트 준비", "셸 끝남 (40초): Astro 프로젝트 만들기 → Project initialized", "서브 에이전트 시작 (general-purpose): 글 12개를 마크다운으로 변환", "서브 에이전트 시작 (Explore): 이미지 용량 조사", "서브 에이전트 끝남: Explore: 이미지 용량 조사", "파일 수정: astro.config.mjs", "서브 에이전트 끝남: general-purpose: 글 12개를 마크다운으로 변환", "빌드와 검사", "셸 실패 (1분): 사이트 빌드 → 3 errors: image not found in knee-mri.md, colab-tips.md, gpu-cost.md", "파일 수정: knee-mri.md", "파일 수정: colab-tips.md", "파일 수정: gpu-cost.md", "셸 끝남 (1분): 사이트 빌드 → 12 pages built in 8.4s", "셸 끝남 (25초): 링크 검사 → 2 broken links: /about, /tags/gpu", "파일 수정: about.astro", "셸 끝남 (20초): 링크 검사 → 0 broken links", "셸 끝남 (2분): 이미지 최적화 → 38 of 64 images optimized (12.1MB → 4.3MB)", "Claude의 답: 빌드와 링크 검사는 통과했습니다. 이미지 64개 중 26개는 아직 최적화 전입니다. 배포 전에 마저 줄일까요?", "사용자 요청: 나머지 이미지도 최적화하고 배포까지 해줘", "백그라운드 셸 시작: 남은 이미지 26개 최적화", "배포 준비", "셸 끝남 (30초): Lighthouse 측정 → performance 92, accessibility 100, seo 98", "권한 요청: 셸: Vercel에 프로덕션 배포"]
const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

// A real Haiku answer to the blog scenario (24 log entries), drawn end to end.
test('a real Haiku answer to a blog deploy draws as a flow, a bar, number boxes and a list', async ($, on) => {
  const clock = mock.clock(on)
  on('model.complete', () => ({ value: { isAnswered: true, text: ANSWER, usage: USAGE } }))
  on('classic.PermissionRequest', () => ({}))
  let finish: () => void = () => undefined
  on('tool.call', { tool: 'Bash' }, ($, e) =>
    e.run_in_background === true
      ? { result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'bg1' } }
      : new Promise(resolve => (finish = () => resolve({ result: { stdout: '', stderr: '', interrupted: false } }))),
  )

  // The scenario's 24 log entries, in order, so the model's "from" ids point at them.
  for (const text of LOG) await $.tool.call({ tool: 'mcp__dashboard__signal', phase: text })
  await $.tool.call({ tool: 'Bash', command: 'node optimize-images.js --rest', description: '남은 이미지 26개 최적화', run_in_background: true })
  const deploy = $.tool.call({ tool: 'Bash', command: 'vercel deploy --prod', description: 'Vercel에 프로덕션 배포' })
  await clock.advance(0)
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'vercel deploy --prod', description: 'Vercel에 프로덕션 배포' } })
  await clock.advance(3000)

  const ui = await $.ui.mount({
    plugin: 'dashboard',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'dashboard',
    props: { title: '작업 과정', isFocused: false, bodyColumns: 56, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
  })
  const lines = (await ui.findAll({ type: 'Text' })).map(node => node.text)
  await ui.unmount()
  finish()
  await deploy

  expect(lines).toContain('Astro 연구 블로그 배포')
  // The call waiting on permission shows once, as waiting, with no tool prefix.
  expect(lines).toContain('◆ Vercel에 프로덕션 배포 · 권한 요청')
  expect(lines.filter(line => /Vercel/.test(line))).toHaveLength(1)
  expect(lines).toContain('↻ 남은 이미지 26개 최적화')
  // The flow in order, the bar without a repeated value, the boxes and the list.
  expect(lines.filter(line => /^[✓●○✗] /.test(line))).toEqual(['✓ 프로젝트', '✓ 글 변환', '✓ 빌드 검사', '● 이미지 줄이기', '○ 배포'])
  expect(lines.find(line => /38\/64/.test(line))).toMatch(/^ 38\/64 {2}남은 26개 진행 {2}\d+초 전$/)
  expect(lines).toEqual(expect.arrayContaining(['92', '100', '98', '12', '실패']))
})
