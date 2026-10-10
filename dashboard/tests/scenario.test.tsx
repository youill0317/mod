import { expect, mock, test } from 'claude-code/testing'

const ANSWER = "{\"title\": \"블로그 Astro 배포\", \"now\": \"남은 이미지 최적화 후 배포 준비\", \"waiting\": \"\", \"blocks\": [{\"kind\": \"graph\", \"title\": \"\", \"nodes\": [{\"label\": \"준비\", \"state\": \"done\", \"note\": \"Astro\", \"branches\": []}, {\"label\": \"변환\", \"state\": \"done\", \"note\": \"글 12개\", \"branches\": [{\"label\": \"조사\", \"state\": \"done\", \"note\": \"이미지 용량\", \"back\": false}]}, {\"label\": \"빌드\", \"state\": \"done\", \"note\": \"12쪽\", \"branches\": [{\"label\": \"누락\", \"state\": \"failed\", \"note\": \"이미지 3개\", \"back\": true}]}, {\"label\": \"검사\", \"state\": \"done\", \"note\": \"깨진 링크 0\", \"branches\": []}, {\"label\": \"최적화\", \"state\": \"now\", \"note\": \"38/64\", \"branches\": []}, {\"label\": \"배포\", \"state\": \"todo\", \"note\": \"Vercel\", \"branches\": [{\"label\": \"승인\", \"state\": \"wait\", \"note\": \"프로덕션\", \"back\": false}]}]}, {\"kind\": \"bars\", \"title\": \"\", \"items\": [{\"label\": \"이미지\", \"value\": 38, \"max\": 64, \"note\": \"남은 26개\", \"tone\": \"normal\", \"from\": 18}]}, {\"kind\": \"metrics\", \"title\": \"점수\", \"items\": [{\"label\": \"성능\", \"value\": \"92\", \"tone\": \"good\", \"from\": 23}, {\"label\": \"접근성\", \"value\": \"100\", \"tone\": \"good\", \"from\": 23}, {\"label\": \"SEO\", \"value\": \"98\", \"tone\": \"good\", \"from\": 23}]}]}"
const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

// A real Haiku answer to a blog deploy (24 log entries over 95 minutes), replayed on the
// mock clock and drawn end to end.
test('a real Haiku answer to a blog deploy draws as a node diagram with branches, a bar and number boxes', async ($, on) => {
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  on('model.complete', () => ({ value: { isAnswered: true, text: ANSWER, usage: USAGE } }))
  on('classic.PermissionRequest', () => ({}))
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'a1' }))
  let finish: () => void = () => undefined
  let held: Promise<unknown> = Promise.resolve()
  on('tool.call', { tool: 'Bash' }, ($, e) =>
    e.run_in_background === true
      ? { result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'bg1' } }
      : new Promise(resolve => (finish = () => resolve({ result: { stdout: '', stderr: '', interrupted: false } }))),
  )
  await $.tool.call({ tool: 'mcp__dashboard__signal', phase: "사용자 요청: 내 연구 블로그를 Astro로 만들고 Vercel에 배포해줘. 글 12개는 notes 폴더에 있어" })
  await clock.advance(120000)
  await $.tool.call({ tool: 'mcp__dashboard__signal', phase: "프로젝트 준비" })
  await clock.advance(60000)
  await $.tool.call({ tool: 'mcp__dashboard__signal', phase: "셸 끝남 (40초): Astro 프로젝트 만들기 → Project initialized" })
  await clock.advance(120000)
  await $.tool.call({ tool: 'mcp__dashboard__signal', phase: "서브 에이전트 시작 (general-purpose): 글 12개를 마크다운으로 변환" })
  await clock.advance(120000)
  await $.tool.call({ tool: 'mcp__dashboard__signal', phase: "서브 에이전트 시작 (Explore): 이미지 용량 조사" })
  await clock.advance(480000)
  await $.tool.call({ tool: 'mcp__dashboard__signal', phase: "서브 에이전트 끝남: Explore: 이미지 용량 조사" })
  await clock.advance(60000)
  await $.tool.call({ tool: 'mcp__dashboard__signal', phase: "파일 수정: astro.config.mjs" })
  await clock.advance(540000)
  await $.tool.call({ tool: 'mcp__dashboard__signal', phase: "서브 에이전트 끝남: general-purpose: 글 12개를 마크다운으로 변환" })
  await clock.advance(120000)
  await $.tool.call({ tool: 'mcp__dashboard__signal', phase: "빌드와 검사" })
  await clock.advance(120000)
  await $.tool.call({ tool: 'mcp__dashboard__signal', phase: "셸 실패 (1분): 사이트 빌드 → 3 errors: image not found in knee-mri.md, colab-tips.md, gpu-cost.md" })
  await clock.advance(360000)
  await $.tool.call({ tool: 'mcp__dashboard__signal', phase: "파일 수정: knee-mri.md" })
  await clock.advance(120000)
  await $.tool.call({ tool: 'mcp__dashboard__signal', phase: "파일 수정: colab-tips.md" })
  await clock.advance(60000)
  await $.tool.call({ tool: 'mcp__dashboard__signal', phase: "파일 수정: gpu-cost.md" })
  await clock.advance(120000)
  await $.tool.call({ tool: 'mcp__dashboard__signal', phase: "셸 끝남 (1분): 사이트 빌드 → 12 pages built in 8.4s" })
  await clock.advance(300000)
  await $.tool.call({ tool: 'mcp__dashboard__signal', phase: "셸 끝남 (25초): 링크 검사 → 2 broken links: /about, /tags/gpu" })
  await clock.advance(300000)
  await $.tool.call({ tool: 'mcp__dashboard__signal', phase: "파일 수정: about.astro" })
  await clock.advance(60000)
  await $.tool.call({ tool: 'mcp__dashboard__signal', phase: "셸 끝남 (20초): 링크 검사 → 0 broken links" })
  await clock.advance(240000)
  await $.tool.call({ tool: 'mcp__dashboard__signal', phase: "셸 끝남 (2분): 이미지 최적화 → 38 of 64 images optimized (12.1MB → 4.3MB)" })
  await clock.advance(600000)
  await $.tool.call({ tool: 'mcp__dashboard__signal', phase: "Claude의 답: 빌드와 링크 검사는 통과했습니다. 이미지 64개 중 26개는 아직 최적화 전입니다. 배포 전에 마저 줄일까요?" })
  await clock.advance(300000)
  await $.tool.call({ tool: 'mcp__dashboard__signal', phase: "사용자 요청: 나머지 이미지도 최적화하고 배포까지 해줘" })
  await clock.advance(60000)
  await $.tool.call({ tool: 'Bash', command: "node scripts/optimize-images.js --rest", description: "남은 이미지 26개 최적화", run_in_background: true })
  await clock.advance(840000)
  await $.tool.call({ tool: 'mcp__dashboard__signal', phase: "배포 준비" })
  await clock.advance(120000)
  await $.tool.call({ tool: 'mcp__dashboard__signal', phase: "셸 끝남 (30초): Lighthouse 측정 → performance 92, accessibility 100, seo 98" })
  await clock.advance(300000)
  held = $.tool.call({ tool: 'Bash', command: "vercel deploy --prod", description: "Vercel에 프로덕션 배포" })
  await clock.advance(0)
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: "vercel deploy --prod", description: "Vercel에 프로덕션 배포" } })
  await clock.advance(180000)
  const ui = await $.ui.mount({
    plugin: 'dashboard', surface: 'terminal', component: 'Pane', requestId: 'dashboard',
    props: { title: '작업 과정', isFocused: false, bodyColumns: 58, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} },
  })
  const lines = (await ui.findAll({ type: 'Text' })).map(node => node.text)
  await ui.unmount()
  finish()
  await held

  // What waits and what runs, with the time each has taken
  expect(lines).toEqual(expect.arrayContaining(['◆ Vercel에 프로덕션 배포 · 권한 요청', '  3분', '↻ 남은 이미지 26개 최적화', '  24분']))
  // The main path in order, and what branched off it
  expect(lines.filter(line => /^[✓●○✗◆] /.test(line) && !/Vercel/.test(line))).toEqual(['✓ 준비', '✓ 변환', '✓ 조사', '✓ 빌드', '✗ 누락', '✓ 검사', '● 최적화', '○ 배포', '◆ 승인'])
  expect(lines).toContain('↺ 이미지 3개')
  // The bar, and number boxes all seen at once, so their time shows once
  expect(lines.find(line => /^ 38\/64/.test(line))).toBe(' 38/64  남은 26개  40분 전')
  expect(lines).toEqual(expect.arrayContaining(['점수', '92', '100', '98', '8분 전', '2분 전 정리']))
})
