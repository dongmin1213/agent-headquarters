// Pure helpers for the web UI (no DOM globals): minimal safe markdown, diff parsing, Korean labels and formatting.
// Imported by app.js in the browser and by test/web in Node. Rendering only ever creates nodes via the `doc`
// argument (createElement / createTextNode) — never HTML strings.

/** @typedef {{t: 'text'|'code'|'strong'|'em', v: string}} Span */

/** Splits one line of markdown into inline spans. Links become plain text "label (url)"; nothing is ever a URL. */
export function parseInline(src) {
  /** @type {Span[]} */
  const out = []
  let buf = ''
  const flush = () => { if (buf) { out.push({ t: 'text', v: buf }); buf = '' } }
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (c === '`') {
      const end = src.indexOf('`', i + 1)
      if (end > i) { flush(); out.push({ t: 'code', v: src.slice(i + 1, end) }); i = end + 1; continue }
    }
    if ((c === '*' || c === '_') && src[i + 1] === c) {
      const end = src.indexOf(c + c, i + 2)
      if (end > i + 2) { flush(); out.push({ t: 'strong', v: src.slice(i + 2, end) }); i = end + 2; continue }
    }
    if (c === '*' && src[i + 1] !== ' ') {
      const end = src.indexOf('*', i + 1)
      if (end > i + 1) { flush(); out.push({ t: 'em', v: src.slice(i + 1, end) }); i = end + 1; continue }
    }
    if (c === '[') {
      const m = /^\[([^\]]*)\]\(([^)\s]*)\)/.exec(src.slice(i))
      if (m) { buf += m[2] ? `${m[1]} (${m[2]})` : m[1]; i += m[0].length; continue }
    }
    buf += c
    i++
  }
  flush()
  return out
}

/**
 * Parses a small, safe subset of markdown into plain data blocks.
 * Supported: #..###### headings, paragraphs, - * + and 1. lists, ``` fences, > quotes, --- rules, | tables.
 */
export function parseMarkdown(src) {
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n')
  const blocks = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (/^\s*$/.test(line)) { i++; continue }
    const fence = /^\s*(```|~~~)\s*([\w+-]*)\s*$/.exec(line)
    if (fence) {
      const body = []
      i++
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++])
      i++ // closing fence (or EOF)
      blocks.push({ type: 'code', lang: fence[2] || '', text: body.join('\n') })
      continue
    }
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
    if (h) { blocks.push({ type: 'heading', level: h[1].length, spans: parseInline(h[2]) }); i++; continue }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { blocks.push({ type: 'hr' }); i++; continue }
    if (/^\s*\|/.test(line)) {
      const rows = []
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        const cells = lines[i].trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())
        if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) rows.push(cells.map(parseInline))
        i++
      }
      blocks.push({ type: 'table', rows })
      continue
    }
    if (/^\s*>/.test(line)) {
      const body = []
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''))
      blocks.push({ type: 'quote', spans: parseInline(body.join(' ')) })
      continue
    }
    const li = /^\s*([-*+]|\d+[.)])\s+/
    if (li.test(line)) {
      const ordered = /^\s*\d/.test(line)
      const items = []
      while (i < lines.length && li.test(lines[i]) && /^\s*\d/.test(lines[i]) === ordered) {
        let text = lines[i++].replace(li, '')
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !li.test(lines[i])) text += ' ' + lines[i++].trim()
        items.push(parseInline(text.replace(/^\[( |x|X)\]\s+/, (_m, x) => (x === ' ' ? '☐ ' : '☑ '))))
      }
      blocks.push({ type: 'list', ordered, items })
      continue
    }
    const para = []
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^(#{1,6}\s|\s*```|\s*~~~|\s*>|\s*\||\s*([-*+]|\d+[.)])\s+)/.test(lines[i])) para.push(lines[i++].trim())
    if (para.length === 0) para.push(lines[i++].trim())
    blocks.push({ type: 'para', spans: parseInline(para.join(' ')) })
  }
  return blocks
}

function renderSpans(doc, parent, spans) {
  for (const s of spans) {
    if (s.t === 'text') { parent.appendChild(doc.createTextNode(s.v)); continue }
    const el = doc.createElement(s.t === 'code' ? 'code' : s.t === 'strong' ? 'strong' : 'em')
    el.textContent = s.v
    parent.appendChild(el)
  }
}

/** Builds DOM nodes for parsed markdown with `doc.createElement` + text nodes only. Returns a wrapper <div>. */
export function renderMarkdown(doc, src) {
  const root = doc.createElement('div')
  root.className = 'md'
  for (const b of parseMarkdown(src)) {
    let el
    if (b.type === 'heading') { el = doc.createElement('h' + Math.min(b.level + 2, 6)); renderSpans(doc, el, b.spans) }
    else if (b.type === 'para') { el = doc.createElement('p'); renderSpans(doc, el, b.spans) }
    else if (b.type === 'quote') { el = doc.createElement('blockquote'); renderSpans(doc, el, b.spans) }
    else if (b.type === 'hr') el = doc.createElement('hr')
    else if (b.type === 'code') { el = doc.createElement('pre'); const c = doc.createElement('code'); c.textContent = b.text; el.appendChild(c) }
    else if (b.type === 'list') {
      el = doc.createElement(b.ordered ? 'ol' : 'ul')
      for (const item of b.items) { const li = doc.createElement('li'); renderSpans(doc, li, item); el.appendChild(li) }
    } else if (b.type === 'table') {
      el = doc.createElement('div'); el.className = 'table-wrap'
      const table = doc.createElement('table')
      b.rows.forEach((row, ri) => {
        const tr = doc.createElement('tr')
        for (const cell of row) { const td = doc.createElement(ri === 0 ? 'th' : 'td'); renderSpans(doc, td, cell); tr.appendChild(td) }
        table.appendChild(tr)
      })
      el.appendChild(table)
    }
    if (el) root.appendChild(el)
  }
  return root
}

/** Parses a unified git diff into files with typed lines. */
export function parseDiff(src) {
  const files = []
  let cur = null
  for (const line of String(src ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line)
      cur = { path: m ? m[2] : line.slice(11), oldPath: m ? m[1] : null, added: 0, removed: 0, lines: [], binary: false, status: 'modified' }
      files.push(cur)
      cur.lines.push({ kind: 'meta', text: line })
      continue
    }
    if (!cur) { if (line) { cur = { path: '(diff)', oldPath: null, added: 0, removed: 0, lines: [], binary: false, status: 'modified' }; files.push(cur) } else continue }
    let kind = 'ctx'
    if (line.startsWith('@@')) kind = 'hunk'
    else if (line.startsWith('+++ ') || line.startsWith('--- ') || /^(index |new file|deleted file|similarity|rename |old mode|new mode|Binary files)/.test(line)) {
      kind = 'meta'
      if (line.startsWith('new file')) cur.status = 'added'
      if (line.startsWith('deleted file')) cur.status = 'deleted'
      if (line.startsWith('rename ')) cur.status = 'renamed'
      if (line.startsWith('Binary files')) cur.binary = true
    } else if (line.startsWith('+')) { kind = 'add'; cur.added++ }
    else if (line.startsWith('-')) { kind = 'del'; cur.removed++ }
    else if (line.startsWith('\\')) kind = 'meta'
    cur.lines.push({ kind, text: line })
  }
  for (const f of files) while (f.lines.length && f.lines[f.lines.length - 1].kind === 'ctx' && f.lines[f.lines.length - 1].text === '') f.lines.pop()
  return files
}

export const REQUEST_STATUS = {
  queued: ['대기열', 'neutral'], thinking: ['사장 검토 중', 'info'], asking: ['질문 대기', 'warn'], planned: ['계획 승인 대기', 'warn'],
  approved: ['승인됨', 'info'], executing: ['실행 중', 'info'], awaiting_acceptance: ['결과 수락 대기', 'warn'], accepted: ['수락됨', 'ok'],
  merging: ['병합 중', 'info'], merged: ['병합 완료', 'ok'], rejected: ['반려됨', 'neutral'], failed: ['실패', 'bad'],
  blocked: ['막힘', 'bad'], cancelled: ['중단됨', 'neutral'], expired: ['만료됨', 'neutral'],
}
export const TASK_STATUS = {
  pending: ['대기', 'neutral'], running: ['진행 중', 'info'], verifying: ['검증 중', 'info'], reviewing: ['검토 중', 'info'],
  passed: ['통과', 'ok'], rework: ['재작업 대기', 'warn'], revising: ['지시서 수정 중', 'warn'], question: ['질문 대기', 'warn'], held: ['한도 보류', 'warn'],
  blocked: ['막힘', 'bad'], cancelled: ['취소됨', 'neutral'],
}
export const ATTEMPT_STATUS = {
  starting: ['시작 중', 'info'], running: ['실행 중', 'info'], succeeded: ['성공', 'ok'], failed: ['실패', 'bad'], brief_blocked: ['지시서 막힘', 'warn'],
  question: ['질문', 'warn'], limited: ['한도 걸림', 'warn'], transient: ['일시 오류', 'warn'], runaway: ['폭주 중단', 'bad'],
  unverifiable: ['확인 불가', 'bad'], start_failed: ['시작 실패', 'bad'],
}
export const QUOTA_MODE = { normal: ['정상', 'ok'], save: ['절약 (동시 1)', 'warn'], hold: ['보류', 'bad'], unobserved: ['관측 전', 'neutral'] }
const WINDOW_NAMES = { five_hour: '5시간', seven_day: '7일', seven_day_opus: '7일 (opus)', seven_day_sonnet: '7일 (sonnet)' }
/** Korean label for a quota window name; unknown windows keep their name. */
export function windowLabel(name) { return WINDOW_NAMES[name] ?? String(name ?? '미확인') }
/** Decision kinds in the order the daemon sends them (execution.md §17), with their card label and tone. */
export const DECISION_KIND = {
  plan: ['계획 승인', 'info'], ceo_question: ['사장 질문', 'warn'], worker_question: ['작업자 질문', 'warn'], revise: ['지시서 수정 승인', 'warn'],
  blocked: ['회로 차단', 'bad'], integration: ['통합 실패', 'bad'], accept: ['결과 수락', 'ok'], merge: ['병합 승인', 'info'],
}
/** Fixed display labels for `blocked` card options, which are wire values retry|skip|stop (execution.md §17). */
export const BLOCKED_LABEL = { retry: '한 번 더 (최상위 모델)', skip: '이 작업 건너뛰기', stop: '요청 중단' }
/** Board columns, in order. */
export const TASK_GROUPS = [
  { id: 'wait', label: '대기', statuses: ['pending', 'rework', 'revising', 'held'] },
  { id: 'run', label: '진행', statuses: ['running'] },
  { id: 'check', label: '검증·검토', statuses: ['verifying', 'reviewing'] },
  { id: 'done', label: '완료', statuses: ['passed', 'cancelled'] },
  { id: 'stuck', label: '막힘', statuses: ['blocked', 'question'] },
]

export function statusInfo(table, s) { return table[s] ?? [s ? String(s) : '미확인', 'neutral'] }

export function shortSha(sha) { return typeof sha === 'string' && sha ? sha.slice(0, 7) : '미확인' }

export function formatDuration(ms) {
  if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) return '미확인'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}초`
  const m = Math.floor(s / 60)
  if (m < 60) return s % 60 ? `${m}분 ${s % 60}초` : `${m}분`
  const h = Math.floor(m / 60)
  return m % 60 ? `${h}시간 ${m % 60}분` : `${h}시간`
}

export function formatRelative(iso, nowMs = Date.now()) {
  const t = Date.parse(iso ?? '')
  if (!isFinite(t)) return '미확인'
  const d = Math.round((nowMs - t) / 1000)
  const fut = d < 0
  const a = Math.abs(d)
  let v
  if (a < 45) return fut ? '곧' : '방금'
  if (a < 3600) v = `${Math.round(a / 60)}분`
  else if (a < 86400) v = `${Math.round(a / 3600)}시간`
  else v = `${Math.round(a / 86400)}일`
  return fut ? `${v} 후` : `${v} 전`
}

export function formatClock(iso, nowMs = Date.now()) {
  const t = Date.parse(iso ?? '')
  if (!isFinite(t)) return '미확인'
  const d = new Date(t), n = new Date(nowMs)
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  if (d.toDateString() === n.toDateString()) return hm
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`
}

export function formatCost(usd) {
  if (typeof usd !== 'number' || !isFinite(usd)) return '미확인'
  return usd < 0.01 && usd > 0 ? '<$0.01' : `$${usd.toFixed(2)}`
}

export function percent(frac) {
  if (typeof frac !== 'number' || !isFinite(frac)) return null
  return Math.max(0, Math.min(100, Math.round(frac * 100)))
}
