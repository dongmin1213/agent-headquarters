// Rendering safety: assets never turn data into HTML, markdown/diff helpers keep hostile strings inert.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
// @ts-expect-error — plain browser JS module without type declarations
import * as lib from '../../src/web/assets/lib.js'
import { createMockApi, XSS } from './mock-api.ts'

const assetsDir = join(import.meta.dirname, '../../src/web/assets')
const assets = readdirSync(assetsDir).map((name) => ({ name, text: readFileSync(join(assetsDir, name), 'utf8') }))

test('assets never write HTML strings into the DOM', () => {
  const forbidden = /\b(innerHTML|outerHTML|insertAdjacentHTML|createContextualFragment|document\.write|srcdoc|DOMParser)\b|\beval\s*\(|new\s+Function\s*\(|setTimeout\s*\(\s*['"`]|javascript:/
  for (const a of assets.filter((x) => x.name.endsWith('.js'))) {
    a.text.split('\n').forEach((line, i) => {
      if (line.trim().startsWith('//')) return
      assert.doesNotMatch(line, forbidden, `${a.name}:${i + 1}`)
    })
  }
})

test('assets make no external requests and use no inline script/style', () => {
  for (const a of assets) assert.doesNotMatch(a.text, /https?:\/\/|\/\/cdn|@import|url\(\s*['"]?(https?:)?\/\//, a.name)
  const html = assets.find((a) => a.name === 'index.html')!.text
  for (const m of html.matchAll(/<script\b[^>]*>/g)) assert.match(m[0], /src="\/ui\/assets\//, 'scripts are external files')
  assert.doesNotMatch(html, /<script\b[^>]*>[^<\s]/, 'no inline script body')
  assert.doesNotMatch(html, /<style|\sstyle=|\son\w+=/i, 'no inline style or handlers')
  const js = assets.filter((a) => a.name.endsWith('.js')).map((a) => a.text).join('\n')
  assert.doesNotMatch(js, /setAttribute\(\s*['"]style['"]/, 'no style attributes (CSP style-src self)')
})

test('the page shell carries no data or secrets (it is served without auth)', () => {
  const html = assets.find((a) => a.name === 'index.html')!.text
  assert.doesNotMatch(html, /\{\{|csrf|token|hq_session/i)
})

// Minimal DOM stand-in: records what renderMarkdown builds without any HTML parser.
interface FakeNode { tag?: string; text?: string; className?: string; children: FakeNode[]; textContent?: string; appendChild(n: FakeNode): FakeNode }
function fakeDoc() {
  const made: FakeNode[] = []
  const node = (tag?: string, text?: string): FakeNode => {
    const n: FakeNode = { tag, text, children: [], appendChild(c) { this.children.push(c); return c } }
    made.push(n)
    return n
  }
  return { made, doc: { createElement: (t: string) => node(t), createTextNode: (s: string) => node(undefined, s) } }
}
function textOf(n: FakeNode): string { return (n.text ?? '') + (n.textContent ?? '') + n.children.map(textOf).join('') }

test('markdown renders hostile input as inert text nodes', () => {
  const src = `## 요약 ${XSS}\n\n본문 **굵게 ${XSS}** 와 \`<b>코드</b>\` [클릭](javascript:alert(1))\n\n- 항목 <iframe src=x>\n\n| a | b |\n| - | - |\n| <svg onload=alert(1)> | ok |\n\n\`\`\`html\n<script>evil()</script>\n\`\`\`\n`
  const { made, doc } = fakeDoc()
  const root = lib.renderMarkdown(doc, src) as FakeNode
  const allowed = new Set(['div', 'p', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'code', 'pre', 'ul', 'ol', 'li', 'blockquote', 'hr', 'table', 'tr', 'th', 'td'])
  for (const n of made) if (n.tag) assert.ok(allowed.has(n.tag), `unexpected element <${n.tag}>`)
  assert.ok(!made.some((n) => n.tag === 'a' || n.tag === 'script' || n.tag === 'img' || n.tag === 'iframe' || n.tag === 'svg'))
  const text = textOf(root)
  assert.ok(text.includes('<script>alert("xss")</script>'), 'script tag kept as literal text')
  assert.ok(text.includes('<svg onload=alert(1)>'))
  assert.ok(text.includes('클릭 (javascript:alert(1))'), 'links become plain text')
  assert.ok(text.includes('<script>evil()</script>'))
})

test('markdown block parsing', () => {
  const b = lib.parseMarkdown('# 제목\n문단 한 줄\n이어짐\n\n- a\n- b\n1. x\n2. y\n\n> 인용\n\n---\n```\ncode\n```')
  assert.deepEqual(b.map((x: { type: string }) => x.type), ['heading', 'para', 'list', 'list', 'quote', 'hr', 'code'])
  assert.equal(b[1].spans[0].v, '문단 한 줄 이어짐')
  assert.equal(b[2].ordered, false)
  assert.equal(b[3].ordered, true)
  assert.equal(b[6].text, 'code')
  assert.deepEqual(lib.parseInline('a `b` **c** *d*'), [{ t: 'text', v: 'a ' }, { t: 'code', v: 'b' }, { t: 'text', v: ' ' }, { t: 'strong', v: 'c' }, { t: 'text', v: ' ' }, { t: 'em', v: 'd' }])
})

test('diff parsing counts lines per file and flags binary/new files', () => {
  const files = lib.parseDiff('diff --git a/x.ts b/x.ts\nnew file mode 100644\n--- /dev/null\n+++ b/x.ts\n@@ -0,0 +1,2 @@\n+a\n+<script>\ndiff --git a/y b/y\n--- a/y\n+++ b/y\n@@ -1 +1 @@\n-old\n+new\n ctx\ndiff --git a/p.png b/p.png\nBinary files a/p.png and b/p.png differ\n')
  assert.equal(files.length, 3)
  assert.deepEqual(files.map((f: { path: string; added: number; removed: number; status: string; binary: boolean }) => [f.path, f.added, f.removed, f.status, f.binary]),
    [['x.ts', 2, 0, 'added', false], ['y', 1, 1, 'modified', false], ['p.png', 0, 0, 'modified', true]])
  assert.equal(lib.parseDiff('').length, 0)
})

test('labels and formatting', () => {
  assert.deepEqual(lib.BLOCKED_LABEL, { retry: '한 번 더 (최상위 모델)', skip: '이 작업 건너뛰기', stop: '요청 중단' })
  assert.equal(lib.windowLabel('five_hour'), '5시간')
  assert.equal(lib.windowLabel('some_new_window'), 'some_new_window')
  for (const m of ['normal', 'save', 'hold', 'unobserved']) assert.ok(lib.QUOTA_MODE[m], m)
  for (const k of ['plan', 'ceo_question', 'worker_question', 'revise', 'blocked', 'integration', 'accept', 'merge']) assert.ok(lib.DECISION_KIND[k], k)
  assert.equal(lib.shortSha(null), '미확인')
  assert.equal(lib.shortSha('0123456789abcdef'), '0123456')
  assert.equal(lib.formatDuration(125_000), '2분 5초')
  assert.equal(lib.formatCost(null), '미확인')
  assert.equal(lib.percent(0.724), 72)
  assert.equal(lib.percent(null), null)
  assert.deepEqual(lib.statusInfo(lib.TASK_STATUS, 'weird'), ['weird', 'neutral'])
  assert.deepEqual(lib.statusInfo(lib.TASK_STATUS, null), ['미확인', 'neutral'])
  const all = ['pending', 'running', 'verifying', 'reviewing', 'passed', 'rework', 'revising', 'question', 'held', 'blocked', 'cancelled']
  for (const s of all) assert.ok(lib.TASK_GROUPS.some((g: { statuses: string[] }) => g.statuses.includes(s)), `${s} has a board column`)
})

test('mock fixtures follow v2 shapes: every task status, every decision kind in order, hostile strings', async () => {
  const mock = createMockApi()
  const snapRes = await callMock(mock, '/api/state')
  const snap = JSON.parse(snapRes)
  const statuses = new Set(snap.requests.flatMap((r: { tasks: { status: string }[] }) => r.tasks.map((t) => t.status)))
  for (const s of ['pending', 'running', 'verifying', 'reviewing', 'passed', 'rework', 'revising', 'question', 'held', 'blocked', 'cancelled']) assert.ok(statuses.has(s), s)
  const order = ['plan', 'ceo_question', 'worker_question', 'revise', 'blocked', 'integration', 'accept', 'merge']
  const kinds = snap.decisions.map((d: { kind: string }) => d.kind)
  for (const k of order) assert.ok(kinds.includes(k), k)
  assert.deepEqual(kinds, [...kinds].sort((a: string, b: string) => order.indexOf(a) - order.indexOf(b)), 'daemon order')
  assert.equal(snap.headline.needsYou, snap.decisions.length)
  assert.deepEqual(snap.decisions.find((d: { kind: string }) => d.kind === 'blocked').options, ['retry', 'skip', 'stop'])
  assert.ok(snap.quota.windows.length >= 2)
  assert.ok(snapRes.includes('<script>'))
  const act = JSON.parse(await callMock(mock, '/api/attempts/req-7f3a9c21.runner~a2/activity?after=0'))
  assert.ok(Array.isArray(act.lines) && act.next === act.lines.length)
  const diff = JSON.parse(await callMock(mock, '/api/requests/req-7f3a9c21/diff?task=runner'))
  assert.ok(Array.isArray(diff.files) && typeof diff.diff === 'string' && typeof diff.truncated === 'boolean')
  mock.close()
})

async function callMock(mock: ReturnType<typeof createMockApi>, url: string): Promise<string> {
  const { PassThrough } = await import('node:stream')
  const req = Object.assign(new PassThrough(), { method: 'GET', url, headers: { authorization: 'Bearer mock-token' } })
  req.end()
  let out = ''
  const res = { writeHead() { return res }, write(c: string) { out += c; return true }, end(c?: string) { if (c) out += c }, on() { return res } }
  await mock.routeApi(req as never, res as never)
  return out
}
