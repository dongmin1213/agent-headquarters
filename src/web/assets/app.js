// HQ web detail UI ("자세히 보기"). Vanilla JS, no dependencies.
// Security: every piece of data reaches the DOM through textContent / text nodes / setAttribute — never as HTML.
import {
  ATTEMPT_STATUS, DECISION_KIND, QUOTA_MODE, REQUEST_STATUS, TASK_GROUPS, TASK_STATUS, BLOCKED_LABEL, formatClock, formatCost, formatDuration,
  createSseParser, formatRelative, parseDiff, parseFragment, percent, renderMarkdown, shortSha, statusInfo, windowLabel,
} from './lib.js'

const $ = (id) => document.getElementById(id)

// ---------- tiny DOM builder ----------
function h(tag, props, ...children) {
  const el = document.createElement(tag)
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue
      if (k === 'class') el.className = v
      else if (k === 'text') el.textContent = String(v)
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v)
      else if (k === 'hidden' || k === 'disabled' || k === 'value' || k === 'checked') el[k] = v
      else el.setAttribute(k, v === true ? '' : String(v))
    }
  }
  append(el, children)
  return el
}
function append(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue
    if (Array.isArray(c)) append(el, c)
    else el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c)
  }
}
const txt = (v, fallback = '미확인') => (v === null || v === undefined || v === '' ? fallback : String(v))
function chip([label, tone], extra = '') { return h('span', { class: `chip chip-${tone} ${extra}`.trim() }, label) }
function timeEl(iso, mode = 'rel') {
  const ok = isFinite(Date.parse(iso ?? ''))
  return h('time', { datetime: ok ? iso : null, title: ok ? new Date(iso).toLocaleString('ko-KR') : null }, mode === 'rel' ? formatRelative(iso) : formatClock(iso))
}

/** Replaces a container's children, keeping focus (by data-fkey), caret and scroll position stable. */
function swap(container, ...children) {
  const active = document.activeElement
  let fkey = null, selStart = null, selEnd = null
  if (active && container.contains(active)) {
    fkey = active.getAttribute('data-fkey')
    if ('selectionStart' in active) { try { selStart = active.selectionStart; selEnd = active.selectionEnd } catch { /* not a text input */ } }
  }
  const y = window.scrollY
  container.replaceChildren()
  append(container, children)
  if (fkey) {
    const el = [...container.querySelectorAll('[data-fkey]')].find((x) => x.getAttribute('data-fkey') === fkey)
    if (el) { el.focus({ preventScroll: true }); if (selStart !== null && 'setSelectionRange' in el) { try { el.setSelectionRange(selStart, selEnd) } catch { /* ignore */ } } }
  }
  if (window.scrollY !== y) window.scrollTo({ top: y })
}

// ---------- state ----------
const state = {
  snap: null, snapError: null,
  conn: 'connecting', // connecting | live | retry | down
  selected: null, // request id
  detail: null, detailFor: null, detailError: null, detailLoading: false,
  drawer: null, // { taskKey, tab, attemptId }
}
const drafts = new Map() // input key → text
const ui = { rejectOpen: new Set(), rejectTasks: new Map(), confirm: new Set(), pending: new Set(), errors: new Map(), rawOpen: new Set(), decisionsCollapsed: false }
try { ui.decisionsCollapsed = localStorage.getItem('hq.decisionsCollapsed') === '1' } catch { /* storage unavailable */ }
const sigs = new Map() // section → last rendered signature
const activity = new Map() // attemptId → { lines, loading, error }
const evidence = new Map() // cache key → { status, data }
const diffs = new Map() // taskId|headSha → { status, files, error }
let follow = true
let paneVersion = 0 // bumps when evidence/diff caches change
let lastFocusBeforeDrawer = null

// ---------- session (execution.md §16: one-time #code → session token in sessionStorage, Bearer on every call) ----------
const SESSION_KEY = 'hq.session'
let sessionToken = ''
function readToken() { try { return sessionStorage.getItem(SESSION_KEY) ?? '' } catch { return '' } }
function saveToken(t) { try { if (t) sessionStorage.setItem(SESSION_KEY, t); else sessionStorage.removeItem(SESSION_KEY) } catch { /* storage unavailable: session lasts for this page only */ } }
/** Shows the sign-in gate instead of the dashboard. */
function showGate(title, text) {
  sessionToken = ''
  saveToken('')
  stopStream()
  $('gate-title').textContent = title
  $('gate-text').textContent = text
  $('gate').hidden = false
  for (const id of ['topbar', 'main']) $(id).hidden = true
  document.querySelector('.skip-link')?.setAttribute('hidden', '')
  document.title = 'HQ · 로그인이 필요해요'
}
async function startSession() {
  const { code } = parseFragment(location.hash)
  if (code) {
    history.replaceState(null, '', location.pathname) // the code never stays in the address bar or history
    try {
      const res = await fetch('/ui-api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) })
      const data = await res.json().catch(() => null)
      if (res.ok && typeof data?.token === 'string') { sessionToken = data.token; saveToken(sessionToken); return true }
      showGate('링크가 만료됐어요', typeof data?.error === 'string' ? data.error : "펫에서 '자세히 보기'로 열어 주세요")
    } catch { showGate('데몬에 연결할 수 없어요', "hq가 켜져 있는지 확인하고 펫에서 '자세히 보기'로 열어 주세요") }
    return false
  }
  sessionToken = readToken()
  if (!sessionToken) { showGate('로그인이 필요해요', "펫에서 '자세히 보기'로 열어 주세요"); return false }
  return true
}

// ---------- API ----------
class ApiError extends Error { constructor(status, msg) { super(msg); this.status = status } }
async function api(path, opts = {}) {
  const init = { method: opts.method ?? 'GET', headers: { accept: 'application/json', authorization: `Bearer ${sessionToken}` } }
  if (init.method !== 'GET') {
    init.headers['content-type'] = 'application/json'
    init.body = JSON.stringify(opts.body ?? {})
  }
  let res
  try { res = await fetch('/ui-api' + path, init) } catch { throw new ApiError(0, '데몬에 연결할 수 없어요') }
  if (res.status === 401) { showGate('세션이 끝났어요', "펫에서 '자세히 보기'로 열어 주세요"); throw new ApiError(401, '세션이 만료됐어요') }
  const type = res.headers.get('content-type') ?? ''
  const data = type.includes('json') ? await res.json().catch(() => null) : await res.text()
  if (!res.ok) throw new ApiError(res.status, (data && typeof data === 'object' && data.error) ? String(data.error) : `HTTP ${res.status}`)
  return data
}
const enc = encodeURIComponent

function errorText(e) {
  if (!(e instanceof ApiError)) return '알 수 없는 오류가 났어요'
  // Every error body is {error: <Korean reason>} (execution.md §15); fall back only when a proxy or network layer answered.
  if (e.status !== 0 && !e.message.startsWith('HTTP ')) return e.message
  if (e.status === 0) return e.message
  if (e.status === 409) return '처리할 수 없는 상태예요. 최신 내용을 다시 불러왔어요.'
  if (e.status === 404) return '대상을 찾을 수 없어요'
  if (e.status === 413) return '내용이 너무 커요'
  return `요청 실패 (${e.status})`
}

// ---------- data loading ----------
async function loadState() {
  try {
    state.snap = await api('/state')
    state.snapError = null
    if (state.conn === 'down') setConn('retry')
  } catch (e) {
    state.snapError = errorText(e)
    if (e.status === 0) setConn('down')
  }
  if (!state.selected && state.snap?.requests?.length) {
    const r = state.snap.requests.find((x) => x.status === 'executing') ?? state.snap.requests[0]
    selectRequest(r.id, { replace: true, silent: true })
  }
  render()
}

async function loadDetail() {
  const id = state.selected
  if (!id) return
  if (state.detailFor !== id) { state.detail = null; state.detailLoading = true; render() }
  try {
    const d = await api(`/requests/${enc(id)}`)
    if (state.selected !== id) return
    state.detail = d; state.detailFor = id; state.detailError = null
  } catch (e) {
    if (state.selected !== id) return
    state.detailError = errorText(e); state.detailFor = id
    if (e.status === 404) state.detail = null
  }
  state.detailLoading = false
  render()
  if (state.drawer) refreshDrawerData()
}

let refreshTimer = null
function scheduleRefresh(delay = 300) {
  clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => { loadState(); loadDetail() }, delay)
}

// ---------- SSE (fetch + ReadableStream so the session token travels in Authorization, never in the URL) ----------
let sse = null, lastBeat = 0, hadError = false, backoff = 1000, reconnectTimer = null
function stopStream() { clearTimeout(reconnectTimer); sse?.abort(); sse = null }
async function connect() {
  stopStream()
  if (!sessionToken) return
  const ctrl = new AbortController()
  sse = ctrl
  try {
    const res = await fetch('/ui-api/events', { headers: { accept: 'text/event-stream', authorization: `Bearer ${sessionToken}` }, cache: 'no-store', signal: ctrl.signal })
    if (res.status === 401) { showGate('세션이 끝났어요', "펫에서 '자세히 보기'로 열어 주세요"); return }
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
    setConn('live'); lastBeat = Date.now(); backoff = 1000
    if (hadError) { hadError = false; scheduleRefresh(0) } // missed events are not replayed: refetch instead
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
    const feed = createSseParser(onStreamEvent)
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      lastBeat = Date.now()
      feed(value)
    }
    throw new Error('stream closed')
  } catch {
    if (sse !== ctrl || !sessionToken) return // replaced by a newer connection, or signed out
    sse = null
    hadError = true
    setConn(state.conn === 'down' ? 'down' : 'retry')
    reconnectTimer = setTimeout(connect, backoff + Math.floor(Math.random() * 500))
    backoff = Math.min(backoff * 2, 30_000)
  }
}
function onStreamEvent(ev) {
  if (ev.event === 'heartbeat') { if (state.conn !== 'live') setConn('live'); return }
  scheduleRefresh()
  try {
    const data = JSON.parse(ev.data)
    if (data?.kind === 'attempt' && state.drawer) pollActivity()
  } catch { /* ignore malformed event */ }
}
function setConn(c) {
  state.conn = c
  renderConn()
}

// ---------- routing (#/r/<id>[/t/<key>[/<tab>]]) ----------
function parseHash() {
  const p = location.hash.replace(/^#\/?/, '').split('/').map((x) => { try { return decodeURIComponent(x) } catch { return x } })
  return p[0] === 'r' && p[1] ? { req: p[1], task: p[2] === 't' ? p[3] ?? null : null, tab: p[4] ?? null } : { req: null, task: null, tab: null }
}
function writeHash(replace) {
  let hash = ''
  if (state.selected) {
    hash = `#/r/${enc(state.selected)}`
    if (state.drawer) hash += `/t/${enc(state.drawer.taskKey)}/${enc(state.drawer.tab)}`
  }
  if (location.hash === hash) return
  if (replace) history.replaceState(null, '', hash || location.pathname)
  else history.pushState(null, '', hash || location.pathname)
}
function applyHash() {
  // A new login link opened in an existing tab only changes the fragment: start over so the code is exchanged.
  const f = parseFragment(location.hash)
  if (f.code) { location.reload(); return }
  if (f.request) { navigateTo(f); return }
  const r = parseHash()
  if (r.req && r.req !== state.selected) { state.selected = r.req; loadDetail() }
  if (r.task) openDrawer(r.task, r.tab ?? 'activity', { fromHash: true })
  else if (state.drawer) closeDrawer({ fromHash: true })
  render()
}
/** Opens a request (and its task drawer) from a `#request=…&task=…` fragment, then rewrites it as a route. */
function navigateTo(f) {
  if (f.request !== state.selected) { state.selected = f.request; state.drawer = null; loadDetail() }
  if (f.task) openDrawer(f.task, 'activity', { replace: true })
  else { if (state.drawer) state.drawer = null; writeHash(true); render() }
}
function selectRequest(id, opts = {}) {
  if (state.selected === id && !opts.force) return
  state.selected = id
  state.drawer = null
  writeHash(opts.replace)
  if (!opts.silent) render()
  loadDetail()
}

// ---------- rendering ----------
function changed(section, sig) {
  if (sigs.get(section) === sig) return false
  sigs.set(section, sig)
  return true
}
const minute = () => Math.floor(Date.now() / 60_000)

function render() {
  renderTop()
  renderDecisions()
  renderWorkers()
  renderRequests()
  renderDetail()
  renderDrawer()
}

function renderConn() {
  const el = $('conn')
  const map = { connecting: ['연결 중…', 'neutral'], live: ['실시간', 'ok'], retry: ['재연결 중…', 'warn'], down: ['데몬 연결 끊김', 'bad'] }
  const [label, tone] = map[state.conn] ?? map.connecting
  el.className = `conn conn-${tone}`
  el.querySelector('.conn-label').textContent = label
}

function renderTop() {
  const s = state.snap
  if (!changed('top', JSON.stringify([s?.headline, s?.quota, state.snapError, minute()]))) return
  const headline = $('headline')
  if (!s) headline.textContent = state.snapError ?? '불러오는 중…'
  else headline.textContent = s.headline?.text ? s.headline.text : '상황 문장 미확인'
  headline.classList.toggle('is-error', !s && !!state.snapError)
  const badge = $('needs-badge')
  const n = s?.headline?.needsYou ?? 0
  badge.hidden = !n
  badge.textContent = n ? `결정 ${n}` : ''
  badge.setAttribute('aria-label', `회장님 결정 ${n}건`)

  const q = s?.quota
  const quota = $('quota')
  if (!s) { swap(quota); return }
  if (!q) { swap(quota, h('span', { class: 'quota-none' }, '한도 미확인')); return }
  const meter = (label, frac, reset) => {
    const p = percent(frac)
    const tone = p === null ? 'neutral' : p >= 95 ? 'bad' : p >= 85 ? 'warn' : 'ok'
    return h('div', { class: 'meter', title: reset ? `${formatClock(reset)} 초기화` : '초기화 시각 미확인' },
      h('span', { class: 'meter-label' }, label),
      h('span', { class: 'meter-track', role: 'progressbar', 'aria-label': `${label} 사용량`, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': p ?? null },
        h('span', { class: `meter-fill tone-${tone}`, 'data-w': p ?? 0 })),
      h('span', { class: 'meter-value' }, p === null ? '미확인' : `${p}%`),
      h('span', { class: 'meter-reset' }, reset ? `${formatClock(reset)} 초기화` : '초기화 미확인'))
  }
  const windows = Array.isArray(q.windows) ? q.windows : []
  swap(quota,
    windows.length ? windows.map((w) => meter(windowLabel(w.name), w.utilization, w.resetsAt)) : h('span', { class: 'quota-none' }, '한도 창 미확인'),
    chip(QUOTA_MODE[q.mode] ?? [txt(q.mode), 'neutral'], 'quota-mode'))
  // Width via CSSOM (CSP forbids inline style attributes).
  for (const f of quota.querySelectorAll('.meter-fill')) f.style.width = `${f.getAttribute('data-w')}%`
}

// ---------- decisions (Snapshot.decisions, in the daemon's order; never rebuilt here) ----------
function renderDecisions() {
  const s = state.snap
  const el = $('decisions')
  const items = Array.isArray(s?.decisions) ? s.decisions : []
  const reqTasks = items.filter((d) => d.kind === 'accept').map((d) => requestOf(d.requestId)?.tasks?.map((t) => [t.key, t.status, t.title]))
  const sig = JSON.stringify([items, reqTasks, [...ui.rejectOpen], [...ui.rejectTasks].map(([k, v]) => [k, [...v]]), [...ui.confirm], [...ui.pending], [...ui.errors], [...ui.rawOpen], ui.decisionsCollapsed, minute()])
  if (!changed('decisions', sig)) return
  el.hidden = items.length === 0
  if (!items.length) { swap(el); return }
  const collapsed = ui.decisionsCollapsed
  swap(el,
    h('div', { class: 'section-head' },
      h('h2', { id: 'decisions-title', class: 'section-title' }, '회장님 결정'),
      h('span', { class: 'count' }, `${items.length}건`),
      h('button', { class: 'btn btn-small section-toggle', type: 'button', 'data-fkey': 'decisions-toggle', 'aria-expanded': collapsed ? 'false' : 'true', 'aria-controls': 'decision-grid',
        onclick: () => { ui.decisionsCollapsed = !ui.decisionsCollapsed; try { localStorage.setItem('hq.decisionsCollapsed', ui.decisionsCollapsed ? '1' : '0') } catch { /* storage unavailable */ } sigs.delete('decisions'); renderDecisions() } },
      collapsed ? '펼치기' : '접기')),
    h('div', { class: 'decision-grid', id: 'decision-grid', hidden: collapsed }, items.map(decisionCard)))
}

function requestOf(id) { return state.snap?.requests?.find((r) => r.id === id) ?? null }
function taskKeyOf(d) { return d.taskId && d.taskId.startsWith(d.requestId + '.') ? d.taskId.slice(d.requestId.length + 1) : null }
function rerenderDecisions() { sigs.delete('decisions'); renderDecisions() }

function decisionCard(d) {
  const key = `${d.kind}:${d.id}`
  const busy = ui.pending.has(key)
  const err = ui.errors.get(key)
  const [kl, kt] = DECISION_KIND[d.kind] ?? [txt(d.kind), 'neutral']
  const req = requestOf(d.requestId)
  const tkey = taskKeyOf(d)
  const meta = [
    req ? h('span', null, req.project) : null,
    tkey ? h('span', { class: 'mono' }, tkey) : null,
    d.revision > 0 && (d.kind === 'worker_question' || d.kind === 'blocked' || d.kind === 'revise') ? h('span', null, `리비전 ${d.revision}`) : null,
    h('span', null, formatRelative(d.createdAt)),
    tkey ? taskLink(d.requestId, tkey) : reqLink(d.requestId),
  ]
  const opts = Array.isArray(d.options) ? d.options : []
  const optLabel = (o) => (d.kind === 'blocked' ? BLOCKED_LABEL[o] ?? o : o)
  const rec = d.recommendation && typeof d.recommendation.option === 'string' && opts.includes(d.recommendation.option) ? d.recommendation : null
  const help = d.optionHelp && typeof d.optionHelp === 'object' ? d.optionHelp : {}
  const explain = explainBlock(d, rec, opts, optLabel, help)
  // Raw material (request text, daemon detail): shown as-is when there is no explanation, otherwise folded under 원문 보기.
  const raw = []
  if (req && !tkey) raw.push(h('p', { class: 'why muted' }, h('span', { class: 'sub-label' }, '요청 '), req.text))
  if (d.detail) raw.push(h('pre', { class: 'card-body' }, d.detail))
  const rawEl = !raw.length ? null : !d.situation ? raw
    : h('details', { class: 'decision-raw', open: ui.rawOpen.has(key) ? true : null, ontoggle: (e) => { if (e.target.open) ui.rawOpen.add(key); else ui.rawOpen.delete(key) } },
      h('summary', null, '원문 보기'), raw)
  const body = []
  const actions = []
  const post = (path, payload, msg, onOk) => act(key, path, payload, msg, onOk)

  if (d.kind === 'ceo_question' || d.kind === 'worker_question') {
    const send = d.kind === 'ceo_question'
      ? (answer) => post(`/requests/${enc(d.requestId)}/answer`, { questionId: d.id, answer }, '답변을 보냈어요')
      : (answer) => post(`/tasks/${enc(d.taskId ?? '')}/answer`, { questionId: d.id, answer, revision: d.revision }, '답변을 보냈어요')
    actions.push(...answerControls(key, opts, busy, send, rec?.option))
  } else if (d.kind === 'blocked') {
    // Options are wire values (retry|skip|stop); unknown values are shown but cannot be sent.
    opts.forEach((decision, i) => {
      const label = BLOCKED_LABEL[decision] ?? decision
      const known = decision in BLOCKED_LABEL
      const ck = `${key}:stop`
      if (decision === 'stop' && ui.confirm.has(ck)) {
        actions.push(h('span', { class: 'confirm' },
          h('button', { class: 'btn btn-danger', type: 'button', disabled: busy, 'data-fkey': `stopyes:${key}`, onclick: () => { ui.confirm.delete(ck); post(`/tasks/${enc(d.taskId ?? '')}/decide`, { decision, revision: d.revision }, '요청을 중단했어요') } }, '정말 중단'),
          h('button', { class: 'btn', type: 'button', onclick: () => { ui.confirm.delete(ck); rerenderDecisions() } }, '아니요')))
        return
      }
      actions.push(h('button', {
        class: `btn ${rec?.option === decision ? 'btn-primary' : decision === 'stop' ? 'btn-danger-ghost' : ''}`, type: 'button', disabled: busy || !known || !d.taskId,
        title: known ? null : '알 수 없는 결정이라 보낼 수 없어요', 'data-fkey': `opt:${key}:${i}`,
        onclick: () => {
          if (decision === 'stop') { ui.confirm.add(ck); rerenderDecisions(); document.querySelector(`[data-fkey="stopyes:${CSS.escape(key)}"]`)?.focus(); return }
          post(`/tasks/${enc(d.taskId ?? '')}/decide`, { decision, revision: d.revision }, `${label} — 보냈어요`)
        },
      }, busy ? '보내는 중…' : label))
    })
  } else if (d.kind === 'accept' && ui.rejectOpen.has(key)) {
    const dk = `reason:${key}`
    const chosen = ui.rejectTasks.get(key) ?? new Set()
    const passed = (req?.tasks ?? []).filter((t) => t.status === 'passed')
    body.push(h('div', { class: 'reject-form' },
      h('textarea', { class: 'input', rows: 3, 'data-fkey': dk, placeholder: '무엇을 고쳐야 하는지 적어 주세요', 'aria-label': '반려 사유 (필수)', required: true, value: drafts.get(dk) ?? '', disabled: busy,
        oninput: (e) => {
          drafts.set(dk, e.target.value)
          // Toggle the send button in place (no re-render while typing).
          const btn = document.querySelector(`[data-fkey="send:${CSS.escape(key)}"]`)
          if (btn) btn.disabled = busy || !e.target.value.trim()
        } }),
      passed.length ? h('fieldset', { class: 'task-pick' },
        h('legend', null, '다시 할 작업 (고르지 않으면 통과한 작업 전부)'),
        passed.map((t) => h('label', { class: 'check-row' },
          h('input', { type: 'checkbox', 'data-fkey': `pick:${key}:${t.key}`, checked: chosen.has(t.key), disabled: busy,
            onchange: (e) => { const set = ui.rejectTasks.get(key) ?? new Set(); if (e.target.checked) set.add(t.key); else set.delete(t.key); ui.rejectTasks.set(key, set); rerenderDecisions() } }),
          h('span', { class: 'mono' }, t.key), h('span', null, t.title)))) : null))
    actions.push(
      h('button', { class: 'btn btn-danger', type: 'button', disabled: busy || !(drafts.get(dk) ?? '').trim() || !d.subjectHash, 'data-fkey': `send:${key}`, onclick: () => {
        const reason = (drafts.get(dk) ?? '').trim()
        if (!reason || !d.subjectHash) return
        // Accept 반려 always goes through /reject with the card's subjectHash, never approvals/:id (execution.md §12).
        const payload = chosen.size ? { reason, subjectHash: d.subjectHash, tasks: [...chosen] } : { reason, subjectHash: d.subjectHash }
        post(`/requests/${enc(d.requestId)}/reject`, payload, '반려했어요', () => { ui.rejectOpen.delete(key); ui.rejectTasks.delete(key); drafts.delete(dk) })
      } }, busy ? '보내는 중…' : '반려 보내기'),
      h('button', { class: 'btn', type: 'button', disabled: busy, onclick: () => { ui.rejectOpen.delete(key); ui.errors.delete(key); rerenderDecisions() } }, '취소'))
  } else {
    // plan, accept, merge, revise, integration: approval-backed cards.
    opts.forEach((opt, i) => {
      const danger = /반려|폐기|거절|중단/.test(opt)
      actions.push(h('button', {
        class: `btn ${rec?.option === opt ? 'btn-primary' : danger ? 'btn-danger-ghost' : ''}`, type: 'button', disabled: busy || !d.subjectHash, 'data-fkey': `opt:${key}:${i}`,
        onclick: () => {
          if (d.kind === 'accept' && opt === '반려') { ui.rejectOpen.add(key); ui.errors.delete(key); rerenderDecisions(); document.querySelector(`[data-fkey="reason:${CSS.escape(key)}"]`)?.focus(); return }
          post(`/approvals/${enc(d.id)}`, { decision: opt, subjectHash: d.subjectHash }, `${opt} — 보냈어요`)
        },
      }, busy ? '보내는 중…' : opt))
    })
    if (!d.subjectHash) body.push(h('p', { class: 'card-error' }, '승인 해시가 없어 결정할 수 없어요'))
  }

  return h('article', { class: `card decision decision-${d.kind}${busy ? ' is-busy' : ''}`, 'aria-busy': busy ? 'true' : null },
    h('div', { class: 'decision-head' }, chip([kl, kt]), h('div', { class: 'decision-meta' }, meta)),
    h('h3', { class: 'decision-title' }, txt(d.title, '제목 미확인')),
    explain,
    d.situation ? null : rawEl,
    body,
    h('div', { class: 'actions' }, actions),
    err ? h('p', { class: 'card-error', role: 'alert' }, err) : null,
    d.situation ? rawEl : null)
}

/** §17 explanation: situation, cause (확인됨/추정), highlighted recommendation, then one consequence line per option. Text only. */
function explainBlock(d, rec, opts, optLabel, help) {
  const out = []
  if (d.situation) out.push(h('p', { class: 'decision-situation' }, d.situation))
  if (d.cause) out.push(h('p', { class: 'decision-cause' },
    h('span', { class: `cause-label ${d.causeConfirmed ? 'is-confirmed' : 'is-guess'}` }, d.causeConfirmed ? '원인(확인됨)' : '원인(추정)'), ' ', d.cause))
  if (rec) out.push(h('div', { class: 'decision-rec' },
    h('p', { class: 'rec-head' }, h('strong', null, `추천 · ${optLabel(rec.option)}`)),
    rec.reason ? h('p', { class: 'rec-reason' }, rec.reason) : null))
  const lines = opts.filter((o) => typeof help[o] === 'string' && help[o])
  if (lines.length) out.push(h('ul', { class: 'option-help' }, lines.map((o) => h('li', { class: rec?.option === o ? 'is-rec' : null },
    h('span', { class: 'option-name' }, `${optLabel(o)}:`), ' ', help[o]))))
  return out
}

function answerControls(key, options, busy, send, recOption) {
  const dk = `ans:${key}`
  const out = options.map((opt, i) => h('button', { class: `btn ${opt === recOption ? 'btn-primary' : ''}`, type: 'button', disabled: busy, 'data-fkey': `ansopt:${key}:${i}`, onclick: () => send(opt) }, opt))
  const input = h('input', { class: 'input input-inline', type: 'text', 'data-fkey': dk, placeholder: '직접 답하기', 'aria-label': '직접 답하기', value: drafts.get(dk) ?? '', disabled: busy,
    oninput: (e) => drafts.set(dk, e.target.value),
    onkeydown: (e) => { if (e.key === 'Enter' && e.target.value.trim()) { send(e.target.value.trim()); drafts.delete(dk) } } })
  out.push(h('span', { class: 'free-answer' }, input,
    h('button', { class: 'btn', type: 'button', disabled: busy, onclick: () => { const v = (drafts.get(dk) ?? '').trim(); if (v) { send(v); drafts.delete(dk) } } }, '보내기')))
  return out
}

function reqLink(id) {
  return id ? h('button', { class: 'link', type: 'button', onclick: () => { selectRequest(id); $('detail').scrollIntoView({ block: 'start', behavior: 'smooth' }) } }, '요청 보기') : null
}
function taskLink(reqId, key) {
  return h('button', { class: 'link', type: 'button', onclick: (e) => { lastFocusBeforeDrawer = e.currentTarget; if (state.selected !== reqId) selectRequest(reqId); openDrawer(key, 'activity') } }, '작업 보기')
}

async function act(key, path, body, okMsg, onOk) {
  ui.pending.add(key); ui.errors.delete(key)
  rerenderDecisions()
  try {
    await api(path, { method: 'POST', body })
    onOk?.()
    toast(okMsg)
  } catch (e) {
    ui.errors.set(key, errorText(e))
  } finally {
    ui.pending.delete(key)
    rerenderDecisions()
  }
  // Success or 409 (stale card / revision): refetch so the card reflects the daemon's current state.
  await loadState()
  loadDetail()
}

let toastTimer = null
function toast(msg) {
  const el = $('toast')
  el.textContent = msg
  el.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { el.hidden = true }, 2600)
}

// ---------- workers ----------
const MODEL_TONE = { haiku: 'm-haiku', sonnet: 'm-sonnet', opus: 'm-opus' }
function modelBadge(model) {
  const m = String(model ?? '')
  return h('span', { class: `model ${MODEL_TONE[m] ?? 'm-other'}`, title: m || '모델 미확인' }, m ? m[0].toUpperCase() : '?')
}
function renderWorkers() {
  const s = state.snap
  const el = $('workers')
  const ws = s?.workers ?? []
  if (!changed('workers', JSON.stringify([ws, minute()]))) return
  el.hidden = ws.length === 0
  if (!ws.length) { swap(el); return }
  const stateLabel = { running: ['구현 중', 'info'], verifying: ['검증 중', 'info'], reviewing: ['검토 중', 'info'], held: ['보류', 'warn'] }
  swap(el,
    h('div', { class: 'section-head' }, h('h2', { class: 'section-title' }, '지금 일하는 중'), h('span', { class: 'count' }, `${ws.length}명`)),
    h('ul', { class: 'worker-list' }, ws.map((w) => h('li', null, h('button', {
      class: 'worker', type: 'button',
      onclick: (e) => { lastFocusBeforeDrawer = e.currentTarget; if (state.selected !== w.requestId) selectRequest(w.requestId); openDrawer(w.taskId.split('/').slice(1).join('/'), 'activity') },
    },
    modelBadge(w.model),
    h('span', { class: 'worker-main' },
      h('span', { class: 'worker-title' }, w.title),
      h('span', { class: 'worker-bubble' }, txt(w.bubble, '활동 없음'))),
    h('span', { class: 'worker-side' }, chip(stateLabel[w.state] ?? [txt(w.state), 'neutral']), h('span', { class: 'muted small' }, formatDuration(Date.now() - Date.parse(w.startedAt)))))))))
}

// ---------- requests ----------
function progress(tasks) {
  if (!tasks?.length) return null
  const done = tasks.filter((t) => t.status === 'passed').length
  const bad = tasks.some((t) => t.status === 'blocked')
  const bar = h('span', { class: `progress-fill${bad ? ' tone-bad' : ''}`, 'data-w': Math.round((done / tasks.length) * 100) })
  return h('span', { class: 'progress', title: `작업 ${done}/${tasks.length} 통과` }, h('span', { class: 'progress-track' }, bar), h('span', { class: 'progress-label' }, `${done}/${tasks.length}`))
}
function applyWidths(root) { for (const f of root.querySelectorAll('[data-w]')) f.style.width = `${f.getAttribute('data-w')}%` }

function renderRequests() {
  const s = state.snap
  const el = $('request-list')
  if (!changed('requests', JSON.stringify([s?.requests?.map((r) => [r.id, r.text, r.status, r.project, r.updatedAt, r.tasks?.map((t) => t.status)]), state.selected, state.snapError, !!s, minute()]))) return
  if (!s) { swap(el, state.snapError ? h('p', { class: 'state state-error' }, state.snapError) : skeleton(4)); return }
  if (!s.requests?.length) { swap(el, h('p', { class: 'state' }, '아직 요청이 없어요. 펫에서 새 요청을 보내 보세요.')); return }
  const projects = new Map((s.projects ?? []).map((p) => [p.id, p.name]))
  swap(el, h('ul', { class: 'req-items' }, s.requests.map((r) => h('li', null, h('button', {
    class: `req-item${r.id === state.selected ? ' is-selected' : ''}`, type: 'button', 'aria-current': r.id === state.selected ? 'true' : null,
    'data-fkey': `req:${r.id}`, onclick: () => { selectRequest(r.id); if (window.matchMedia('(max-width: 900px)').matches) $('detail').scrollIntoView({ block: 'start' }) },
  },
  h('span', { class: 'req-top' }, chip(statusInfo(REQUEST_STATUS, r.status)), h('span', { class: 'req-project' }, projects.get(r.project) ?? r.project), h('span', { class: 'req-time' }, timeEl(r.updatedAt))),
  h('span', { class: 'req-text' }, r.text),
  progress(r.tasks))))))
  applyWidths(el)
}

function skeleton(n) { return h('div', { class: 'skeleton', 'aria-label': '불러오는 중' }, Array.from({ length: n }, () => h('span', { class: 'skeleton-line' }))) }

// ---------- request detail ----------
function renderDetail() {
  const el = $('detail')
  const d = state.detail
  const sig = JSON.stringify([state.selected, d, state.detailError, state.detailLoading, state.drawer?.taskKey, minute()])
  if (!changed('detail', sig)) return
  if (!state.selected) { swap(el, h('p', { class: 'state' }, '왼쪽에서 요청을 고르세요')); return }
  if (!d) {
    swap(el, state.detailError ? h('div', { class: 'state state-error' }, h('p', null, `요청을 불러오지 못했어요: ${state.detailError}`), h('button', { class: 'btn', type: 'button', onclick: loadDetail }, '다시 시도')) : skeleton(6))
    return
  }
  const r = d.request
  const tasks = d.tasks ?? []
  const projects = new Map((state.snap?.projects ?? []).map((p) => [p.id, p.name]))
  const header = h('header', { class: 'detail-head' },
    h('div', { class: 'detail-meta' }, chip(statusInfo(REQUEST_STATUS, r.status)), h('span', null, projects.get(r.project) ?? r.project), h('span', { class: 'mono muted' }, r.id),
      h('span', { class: 'muted' }, `턴 ${r.turns ?? '미확인'} · ${formatCost(r.costUsd)}`), h('span', { class: 'muted' }, '갱신 ', timeEl(r.updatedAt))),
    h('h2', { class: 'detail-title' }, r.text),
    r.note ? h('p', { class: `callout ${['failed', 'blocked'].includes(r.status) ? 'callout-bad' : ''}` }, r.note) : null,
    state.detailError ? h('p', { class: 'callout callout-bad' }, `최신 정보를 불러오지 못했어요: ${state.detailError}`) : null)

  const plan = r.plan
    ? h('section', { class: 'card plan', 'aria-label': '계획' },
      h('h3', { class: 'card-title' }, '계획'),
      h('p', { class: 'plan-summary' }, plan_summary(r.plan)),
      h('div', { class: 'sub' }, h('span', { class: 'sub-label' }, '가정'),
        r.plan.assumptions?.length ? h('ul', { class: 'compact' }, r.plan.assumptions.map((x) => h('li', null, x))) : h('span', { class: 'muted' }, ' 없음')))
    : h('section', { class: 'card plan' }, h('h3', { class: 'card-title' }, '계획'), h('p', { class: 'muted' }, planPendingText(r.status)))

  const answered = (r.questions ?? []).filter((q) => q.answer !== null && q.answer !== undefined)
  const qa = answered.length ? h('details', { class: 'card qa' }, h('summary', null, `사장 질문과 답 ${answered.length}개`),
    h('dl', { class: 'qa-list' }, answered.map((q) => [h('dt', null, q.question), h('dd', null, q.answer)]))) : null

  let board
  if (tasks.length) {
    board = h('section', { class: 'board', 'aria-label': '작업 보드' }, TASK_GROUPS.map((g) => {
      const list = tasks.filter((t) => g.statuses.includes(t.status))
      return h('div', { class: `col col-${g.id}` },
        h('h3', { class: 'col-head' }, h('span', null, g.label), h('span', { class: 'count' }, String(list.length))),
        list.length ? h('ul', { class: 'col-list' }, list.map((t) => h('li', null, taskCard(t)))) : h('p', { class: 'col-empty' }, '없음'))
    }))
    const other = tasks.filter((t) => !TASK_GROUPS.some((g) => g.statuses.includes(t.status)))
    if (other.length) board.appendChild(h('div', { class: 'col' }, h('h3', { class: 'col-head' }, '기타'), h('ul', { class: 'col-list' }, other.map((t) => h('li', null, taskCard(t))))))
  } else if (r.plan?.tasks?.length) {
    board = h('section', { class: 'card' }, h('h3', { class: 'card-title' }, `계획된 작업 ${r.plan.tasks.length}개`), h('p', { class: 'muted small' }, '계획이 승인되면 실행 상태가 여기에 보여요.'),
      h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
        h('thead', null, h('tr', null, ['작업', '제목', '역할', '등급', '모델', '프로젝트'].map((x) => h('th', null, x)))),
        h('tbody', null, r.plan.tasks.map((t) => h('tr', null, h('td', { class: 'mono' }, t.id), h('td', null, t.title), h('td', null, t.role), h('td', null, t.grade), h('td', null, t.model), h('td', null, t.project)))))))
  } else board = null

  swap(el, header, h('div', { class: 'detail-grid' }, plan, qa), board)
}
function plan_summary(plan) { return txt(plan.summary, '요약 미확인') }
function planPendingText(status) {
  if (['queued', 'thinking'].includes(status)) return '사장이 계획을 세우는 중이에요.'
  if (status === 'asking') return '사장이 질문에 대한 답을 기다리고 있어요.'
  return '계획이 없어요.'
}

function taskCard(t) {
  const [sl, st] = statusInfo(TASK_STATUS, t.status)
  const open = state.drawer?.taskKey === t.key
  return h('button', {
    class: `task${open ? ' is-open' : ''} task-${st}`, type: 'button', 'data-fkey': `task:${t.id}`, 'aria-haspopup': 'dialog',
    onclick: (e) => { lastFocusBeforeDrawer = e.currentTarget; openDrawer(t.key, state.drawer?.tab ?? 'activity') },
  },
  h('span', { class: 'task-top' }, h('span', { class: 'task-key mono' }, t.key), chip([sl, st])),
  h('span', { class: 'task-title' }, t.title),
  h('span', { class: 'task-meta' }, modelBadge(t.model), h('span', null, `${t.role} · ${t.grade} · ${t.model}`), h('span', { class: 'muted' }, `시도 ${t.attempts}`)),
  t.lastActivity ? h('span', { class: 'task-activity' }, t.lastActivity) : null,
  t.note && !t.lastActivity ? h('span', { class: 'task-activity' }, t.note) : null,
  h('span', { class: 'task-foot' }, h('span', { class: 'mono', title: t.headSha ?? '' }, t.headSha ? shortSha(t.headSha) : 'SHA 없음'), timeEl(t.updatedAt)))
}

// ---------- drawer ----------
const TABS = [['activity', '활동'], ['attempts', '시도'], ['report', '보고서'], ['checks', '검사'], ['verdict', '검토'], ['diff', '변경']]

function currentTask() { return state.detail?.tasks?.find((t) => t.key === state.drawer?.taskKey) ?? null }

function openDrawer(taskKey, tab = 'activity', opts = {}) {
  const same = state.drawer?.taskKey === taskKey
  if (!lastFocusBeforeDrawer) lastFocusBeforeDrawer = document.activeElement
  state.drawer = { taskKey, tab: TABS.some(([k]) => k === tab) ? tab : 'activity', attemptId: same ? state.drawer.attemptId : null }
  if (!opts.fromHash) writeHash(opts.replace)
  sigs.delete('drawer'); sigs.delete('detail')
  render()
  refreshDrawerData()
  if (!same) $('drawer').querySelector('.drawer-close')?.focus()
}
function closeDrawer(opts = {}) {
  state.drawer = null
  if (!opts.fromHash) writeHash(false)
  sigs.delete('drawer'); sigs.delete('detail')
  render()
  const back = lastFocusBeforeDrawer
  lastFocusBeforeDrawer = null
  if (back && document.contains(back)) back.focus()
  else if (back?.getAttribute?.('data-fkey')) document.querySelector(`[data-fkey="${CSS.escape(back.getAttribute('data-fkey'))}"]`)?.focus()
}
function setTab(tab) {
  if (!state.drawer) return
  state.drawer.tab = tab
  writeHash(true)
  renderDrawer()
  refreshDrawerData()
  $('drawer').querySelector(`[data-tab="${tab}"]`)?.focus()
}

function attemptsOf(t) { return t?.attemptsList ?? [] }
function selectedAttempt(t) {
  const list = attemptsOf(t)
  return list.find((a) => a.id === state.drawer?.attemptId) ?? list.find((a) => a.id === t?.currentAttemptId) ?? list[list.length - 1] ?? null
}
function evidenceAttempt(t, kind) {
  const sel = attemptsOf(t).find((a) => a.id === state.drawer?.attemptId)
  if (sel?.kind === kind) return sel
  // Evidence files exist only after an attempt ends: prefer the latest finished one of that kind.
  const list = attemptsOf(t).filter((a) => a.kind === kind)
  return [...list].reverse().find((a) => !isLive(a)) ?? list[list.length - 1] ?? null
}
const isLive = (a) => a && (a.status === 'running' || a.status === 'starting')

function refreshDrawerData() {
  const t = currentTask()
  if (!t || !state.drawer) return
  const tab = state.drawer.tab
  if (tab === 'activity') pollActivity()
  if (tab === 'report') loadEvidence(evidenceAttempt(t, 'work'), 'report.md')
  if (tab === 'checks') loadEvidence(evidenceAttempt(t, 'work'), 'checks.json')
  if (tab === 'verdict') loadEvidence(evidenceAttempt(t, 'review'), 'verdict.json')
  if (tab === 'diff') loadDiff(t)
}

let pollTimer = null
async function pollActivity() {
  clearTimeout(pollTimer)
  pollTimer = null
  const t = currentTask()
  const a = selectedAttempt(t)
  if (!a || state.drawer?.tab !== 'activity') return
  let entry = activity.get(a.id)
  if (!entry) { entry = { lines: [], next: 0, loading: false, error: null, loaded: false }; activity.set(a.id, entry) }
  if (entry.loading) return
  entry.loading = true
  try {
    const got = await api(`/attempts/${enc(a.id)}/activity?after=${entry.next}`) // {lines, next} (execution.md §15)
    if (Array.isArray(got?.lines)) entry.lines.push(...got.lines)
    if (Number.isInteger(got?.next)) entry.next = got.next
    entry.error = null
    if (Array.isArray(got?.lines) && got.lines.length >= 500) pollTimer = setTimeout(pollActivity, 0) // more pages waiting
  } catch (e) { entry.error = e.status === 404 ? null : errorText(e) }
  entry.loading = false
  entry.loaded = true
  if (state.drawer?.tab === 'activity' && selectedAttempt(currentTask())?.id === a.id) renderActivityLog()
  if (isLive(a) && !pollTimer) pollTimer = setTimeout(() => { pollTimer = null; pollActivity() }, 3000)
}

async function loadEvidence(a, name) {
  if (!a) return
  const key = `${a.id}|${a.status}|${name}`
  if (evidence.has(key)) return
  if (isLive(a)) { evidence.set(key, { status: 'missing' }); paneVersion++; sigs.delete('drawer'); renderDrawer(); return }
  evidence.set(key, { status: 'loading' })
  try { evidence.set(key, { status: 'ok', data: await api(`/attempts/${enc(a.id)}/files/${enc(name)}`) }) }
  catch (e) { evidence.set(key, e.status === 404 ? { status: 'missing' } : { status: 'error', error: errorText(e) }) }
  paneVersion++; sigs.delete('drawer'); renderDrawer()
}

async function loadDiff(t) {
  const key = `${t.id}|${t.headSha}`
  if (diffs.has(key)) return
  diffs.set(key, { status: 'loading' })
  try {
    const d = await api(`/requests/${enc(t.requestId)}/diff?task=${enc(t.key)}`) // {files, diff, truncated} (execution.md §15)
    diffs.set(key, { status: 'ok', files: Array.isArray(d?.files) ? d.files : [], parsed: parseDiff(typeof d?.diff === 'string' ? d.diff : ''), truncated: d?.truncated === true })
  } catch (e) { diffs.set(key, e.status === 404 ? { status: 'missing' } : { status: 'error', error: errorText(e) }) }
  paneVersion++; sigs.delete('drawer'); renderDrawer()
}

function renderDrawer() {
  const el = $('drawer'), back = $('drawer-backdrop')
  const t = currentTask()
  const open = !!state.drawer
  const sig = JSON.stringify([state.drawer, t, !!state.detail])
  if (!changed('drawer', sig)) return
  el.hidden = !open; back.hidden = !open
  document.body.classList.toggle('drawer-open', open)
  if (!open) { swap(el); return }
  if (!t) {
    swap(el, h('div', { class: 'drawer-head' }, h('h2', { id: 'drawer-title', class: 'drawer-title' }, state.detail ? '작업을 찾을 수 없어요' : '불러오는 중…'),
      h('button', { class: 'btn btn-icon drawer-close', type: 'button', 'aria-label': '닫기', onclick: () => closeDrawer() }, '✕')))
    return
  }
  // Stable skeleton: header, facts and tabs refresh in place; the pane is rebuilt only when what it shows changed,
  // so its scroll position, open <details> and the live log survive SSE refreshes.
  if (el.getAttribute('data-task') !== t.key || !el.querySelector('.drawer-pane')) {
    swap(el, h('div', { class: 'drawer-head' }), h('div', { class: 'drawer-body' }), h('div', { class: 'tabs', role: 'tablist', 'aria-label': '작업 정보' }),
      h('div', { class: 'drawer-pane', id: 'drawer-pane', role: 'tabpanel', tabindex: '0' }))
    el.setAttribute('data-task', t.key)
    el.removeAttribute('data-pane')
  }
  const a = selectedAttempt(t)
  swap(el.querySelector('.drawer-head'),
    h('div', { class: 'drawer-heading' },
      h('div', { class: 'detail-meta' }, chip(statusInfo(TASK_STATUS, t.status)), h('span', { class: 'mono' }, t.key), h('span', null, t.project)),
      h('h2', { id: 'drawer-title', class: 'drawer-title' }, t.title)),
    h('button', { class: 'btn btn-icon drawer-close', type: 'button', 'aria-label': '닫기', 'data-fkey': 'drawer-close', onclick: () => closeDrawer() }, '✕'))
  swap(el.querySelector('.drawer-body'),
    h('dl', { class: 'facts' },
      fact('역할', t.role), fact('등급', t.grade), fact('모델', t.model), fact('검토 모델', txt(t.reviewModel)),
      fact('시도', `${t.attempts}회`), fact('리비전', Number.isInteger(t.revision) ? `r${t.revision}` : '미확인'),
      fact('HEAD', t.headSha ? shortSha(t.headSha) : '미확인', 'mono', t.headSha), fact('BASE', t.baseSha ? shortSha(t.baseSha) : '미확인', 'mono', t.baseSha),
      fact('브랜치', txt(t.branch), 'mono', t.branch), fact('갱신', formatRelative(t.updatedAt))),
    t.note ? h('p', { class: `callout ${t.status === 'blocked' ? 'callout-bad' : ''}` }, t.note) : null)
  swap(el.querySelector('.tabs'), TABS.map(([k, label]) => h('button', {
    class: 'tab', type: 'button', role: 'tab', id: `tab-${k}`, 'data-tab': k, 'data-fkey': `tab:${k}`, 'aria-selected': state.drawer.tab === k ? 'true' : 'false', 'aria-controls': 'drawer-pane',
    tabindex: state.drawer.tab === k ? '0' : '-1', onclick: () => setTab(k),
    onkeydown: (e) => {
      const i = TABS.findIndex(([x]) => x === k)
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); setTab(TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length][0]) }
    },
  }, label, k === 'attempts' ? h('span', { class: 'tab-count' }, String(attemptsOf(t).length)) : null)))
  const pane = el.querySelector('.drawer-pane')
  const paneSig = JSON.stringify([state.drawer, a?.id, a?.status, t.attemptsList, t.headSha, t.baseSha, paneVersion, state.drawer.tab === 'attempts' ? minute() : 0])
  if (el.getAttribute('data-pane') !== paneSig) {
    const sameTab = el.getAttribute('data-pane-tab') === state.drawer.tab
    const y = pane.scrollTop
    swap(pane, paneContent(t, a))
    pane.setAttribute('aria-labelledby', `tab-${state.drawer.tab}`)
    pane.scrollTop = sameTab ? y : 0
    el.setAttribute('data-pane', paneSig)
    el.setAttribute('data-pane-tab', state.drawer.tab)
  }
  if (state.drawer.tab === 'activity') renderActivityLog()
}
function fact(label, value, cls, title) { return h('div', { class: 'fact' }, h('dt', null, label), h('dd', { class: cls ?? null, title: title ?? null }, value)) }

function paneContent(t, a) {
  const tab = state.drawer.tab
  if (tab === 'activity') return activityPane(t, a)
  if (tab === 'attempts') return attemptsPane(t)
  if (tab === 'report') return evidencePane(evidenceAttempt(t, 'work'), 'report.md', (data) => renderMarkdown(document, typeof data === 'string' ? data : JSON.stringify(data, null, 2)))
  if (tab === 'checks') return evidencePane(evidenceAttempt(t, 'work'), 'checks.json', checksView)
  if (tab === 'verdict') return evidencePane(evidenceAttempt(t, 'review'), 'verdict.json', verdictView)
  if (tab === 'diff') return diffPane(t)
  return null
}

function attemptLabel(a) { return `${a.kind === 'review' ? '검토' : '작업'} ${a.n}회차 · ${a.model}` }
function attemptDuration(a) {
  const s = Date.parse(a.startedAt ?? ''), e = Date.parse(a.endedAt ?? '')
  if (!isFinite(s)) return '미확인'
  if (!isFinite(e)) return isLive(a) ? `${formatDuration(Date.now() - s)} 경과` : '미확인'
  return formatDuration(e - s)
}

function attemptPicker(t, a, kind) {
  const list = attemptsOf(t).filter((x) => !kind || x.kind === kind)
  if (!list.length) return null
  return h('label', { class: 'picker' }, h('span', { class: 'sub-label' }, '시도'),
    h('select', { class: 'input select', 'data-fkey': 'attempt-picker', onchange: (e) => { state.drawer.attemptId = e.target.value; sigs.delete('drawer'); renderDrawer(); refreshDrawerData() } },
      list.map((x) => h('option', { value: x.id, selected: a?.id === x.id ? true : null }, `${attemptLabel(x)} — ${statusInfo(ATTEMPT_STATUS, x.status)[0]}`))))
}

function activityPane(t, a) {
  if (!a) return h('p', { class: 'state' }, '아직 시도가 없어요. 배정되면 활동이 여기에 보여요.')
  return h('div', { class: 'activity' },
    h('div', { class: 'pane-toolbar' }, attemptPicker(t, a),
      h('span', { class: 'toolbar-spacer' }),
      isLive(a) ? h('span', { class: 'live-dot', title: '실시간' }, '실시간') : chip(statusInfo(ATTEMPT_STATUS, a.status)),
      h('button', { class: `btn btn-small${follow ? ' is-on' : ''}`, type: 'button', 'aria-pressed': follow ? 'true' : 'false', 'data-fkey': 'follow',
        onclick: () => { follow = !follow; syncFollowButton(); if (follow) scrollLogEnd() } }, follow ? '자동 따라가기' : '일시정지됨')),
    h('ol', { class: 'log', id: 'activity-log', 'aria-live': 'off', onscroll: onLogScroll }))
}
function onLogScroll(e) {
  const el = e.currentTarget
  const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 24
  // Programmatic scrolls always land at the end, so only a user scrolling up pauses; scrolling back down resumes.
  if (follow !== atEnd) { follow = atEnd; syncFollowButton() }
}
function syncFollowButton() {
  const b = $('drawer').querySelector('[data-fkey="follow"]')
  if (!b) return
  b.textContent = follow ? '자동 따라가기' : '일시정지됨'
  b.classList.toggle('is-on', follow)
  b.setAttribute('aria-pressed', follow ? 'true' : 'false')
}
function scrollLogEnd() { const log = $('activity-log'); if (log) log.scrollTop = log.scrollHeight }

const KIND_TEXT = { message: ['메시지', 'neutral'], tool: ['도구', 'info'], error: ['오류', 'bad'], usage: ['사용량', 'ok'] }
function renderActivityLog() {
  const log = $('activity-log')
  const a = selectedAttempt(currentTask())
  if (!log || !a) return
  const entry = activity.get(a.id)
  const lines = entry?.lines ?? []
  let count = Number(log.getAttribute('data-count') ?? 0) || 0
  if (log.getAttribute('data-attempt') !== a.id || count > lines.length) { log.replaceChildren(); log.setAttribute('data-attempt', a.id); count = 0 }
  for (const s of log.querySelectorAll('.log-state')) s.remove()
  if (!lines.length) {
    const msg = !entry?.loaded ? '불러오는 중…' : entry.error ?? (isLive(a) ? '아직 활동이 없어요. 기다리는 중…' : '활동 기록이 없어요')
    log.appendChild(h('li', { class: `log-state${entry?.error ? ' log-error' : ''}` }, msg))
    log.setAttribute('data-count', '0')
    return
  }
  for (const line of lines.slice(count)) {
    const [kl, kt] = KIND_TEXT[line.kind] ?? [line.kind, 'neutral']
    log.appendChild(h('li', { class: `log-line log-${kt}` },
      h('span', { class: 'log-time mono' }, line.at ? formatClockSec(line.at) : '--:--:--'),
      h('span', { class: `log-kind kind-${kt}` }, kl),
      h('span', { class: 'log-text' }, line.text)))
  }
  log.setAttribute('data-count', String(lines.length))
  if (entry.error) log.appendChild(h('li', { class: 'log-state log-error' }, entry.error))
  if (follow) scrollLogEnd()
}
function formatClockSec(iso) {
  const d = new Date(iso)
  return isFinite(d.getTime()) ? [d.getHours(), d.getMinutes(), d.getSeconds()].map((x) => String(x).padStart(2, '0')).join(':') : '--:--:--'
}

function attemptsPane(t) {
  const list = attemptsOf(t)
  if (!list.length) return h('p', { class: 'state' }, '아직 시도가 없어요.')
  const sel = selectedAttempt(t)
  return h('ol', { class: 'attempts' }, [...list].reverse().map((a) => h('li', null, h('button', {
    class: `attempt${sel?.id === a.id ? ' is-selected' : ''}`, type: 'button', 'data-fkey': `att:${a.id}`,
    onclick: () => { state.drawer.attemptId = a.id; setTab(a.kind === 'review' ? 'verdict' : 'activity') },
  },
  h('span', { class: 'attempt-top' },
    h('span', { class: `attempt-kind kind-${a.kind}` }, a.kind === 'review' ? '검토' : '작업'),
    h('span', { class: 'attempt-n' }, `${a.n}회차`), modelBadge(a.model), h('span', null, a.model),
    h('span', { class: 'toolbar-spacer' }), chip(statusInfo(ATTEMPT_STATUS, a.status))),
  h('span', { class: 'attempt-meta muted' }, `${attemptDuration(a)} · ${formatCost(a.costUsd)} · 시작 ${formatClock(a.startedAt)}`),
  a.reason ? h('span', { class: 'attempt-reason' }, a.reason) : null))))
}

function evidencePane(a, name, view) {
  if (!a) return h('p', { class: 'state' }, name === 'verdict.json' ? '아직 검토 시도가 없어요.' : '아직 작업 시도가 없어요.')
  const e = evidence.get(`${a.id}|${a.status}|${name}`)
  const caption = h('p', { class: 'pane-caption muted small' }, `${attemptLabel(a)} · `, h('span', { class: 'mono' }, name))
  if (!e || e.status === 'loading') return [caption, skeleton(5)]
  if (e.status === 'missing') return [caption, h('p', { class: 'state' }, isLive(a) ? '시도가 끝나면 생겨요.' : '이 파일이 없어요.')]
  if (e.status === 'error') return [caption, h('p', { class: 'state state-error' }, e.error)]
  let data = e.data
  if (name.endsWith('.json') && typeof data === 'string') { try { data = JSON.parse(data) } catch { return [caption, h('p', { class: 'state state-error' }, 'JSON 형식이 아니에요'), h('pre', { class: 'code' }, data)] } }
  try { return [caption, view(data)] } catch { return [caption, h('p', { class: 'state state-error' }, '형식을 해석할 수 없어요'), h('pre', { class: 'code' }, JSON.stringify(data, null, 2))] }
}

function passChip(pass) { return pass === true ? chip(['통과', 'ok']) : pass === false ? chip(['실패', 'bad']) : chip(['미확인', 'neutral']) }

function checksView(c) {
  const checks = Array.isArray(c?.checks) ? c.checks : []
  const secrets = Array.isArray(c?.secrets) ? c.secrets : []
  return h('div', { class: 'stack' },
    h('div', { class: 'summary-row' }, h('span', null, '전체 '), passChip(c?.pass), h('span', { class: 'muted' }, `검사 ${checks.filter((x) => x.pass).length}/${checks.length} 통과`),
      h('span', { class: secrets.length ? 'meta-bad' : 'muted' }, secrets.length ? `비밀값 의심 ${secrets.length}건` : '비밀값 없음')),
    secrets.length ? h('ul', { class: 'compact callout callout-bad' }, secrets.map((s) => h('li', { class: 'mono' }, typeof s === 'string' ? s : JSON.stringify(s)))) : null,
    checks.length ? h('div', { class: 'checks' }, checks.map((x) => h('details', { class: `check${x.pass ? '' : ' is-fail'}`, open: x.pass ? null : true },
      h('summary', null,
        passChip(x.pass), h('span', { class: 'mono check-id' }, txt(x.id)), h('code', { class: 'check-cmd' }, txt(x.command)),
        h('span', { class: 'check-side muted small' }, `종료 ${x.exitCode ?? '미확인'} · ${formatDuration(x.durationMs)}`)),
      x.outputTail ? h('pre', { class: 'code output' }, x.outputTail) : h('p', { class: 'muted small pad' }, '출력 없음')))) : h('p', { class: 'state' }, '검사 항목이 없어요'))
}

function verdictView(v) {
  const list = (arr) => (Array.isArray(arr) ? arr : [])
  const RESULT = { pass: ['통과', 'ok'], fail: ['실패', 'bad'], manual: ['사람 확인', 'warn'] }
  return h('div', { class: 'stack' },
    h('div', { class: 'summary-row' }, h('span', null, '판정 '), passChip(v?.pass),
      h('span', { class: 'muted' }, `검토 ${txt(v?.reviewer_model)} → 구현 ${txt(v?.implementer_model)}`),
      v?.sameFamily ? h('span', { class: 'chip chip-neutral', title: '같은 Claude 계열 모델끼리의 교차 검토예요' }, '같은 계열') : null,
      v?.head_sha ? h('span', { class: 'mono muted', title: v.head_sha }, `@${shortSha(v.head_sha)}`) : null),
    h('section', { class: 'vsec' }, h('h4', null, `차단 (blocking) ${list(v?.blocking).length}`),
      list(v?.blocking).length ? h('ul', { class: 'issues' }, list(v.blocking).map((b) => h('li', { class: 'issue issue-bad' }, h('span', { class: 'mono issue-id' }, txt(b.id)), h('span', { class: 'issue-sum' }, txt(b.summary)), b.evidence ? h('span', { class: 'issue-ev muted' }, b.evidence) : null))) : h('p', { class: 'muted small' }, '없음')),
    h('section', { class: 'vsec' }, h('h4', null, `권고 (advisory) ${list(v?.advisory).length}`),
      list(v?.advisory).length ? h('ul', { class: 'issues' }, list(v.advisory).map((b) => h('li', { class: 'issue' }, h('span', { class: 'mono issue-id' }, txt(b.id)), h('span', { class: 'issue-sum' }, txt(b.summary))))) : h('p', { class: 'muted small' }, '없음')),
    h('section', { class: 'vsec' }, h('h4', null, '수용 기준'),
      list(v?.criteria).length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, h('thead', null, h('tr', null, h('th', null, '기준'), h('th', null, '결과'), h('th', null, '근거'))),
        h('tbody', null, list(v.criteria).map((c) => h('tr', null, h('td', { class: 'mono' }, txt(c.id)), h('td', null, chip(RESULT[c.result] ?? [txt(c.result), 'neutral'])), h('td', null, txt(c.evidence, '')))))))
        : h('p', { class: 'muted small' }, '없음')),
    h('section', { class: 'vsec' }, h('h4', null, '검토자가 실행한 테스트'),
      list(v?.tests_run).length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, h('thead', null, h('tr', null, h('th', null, '명령'), h('th', null, '종료'), h('th', null, '결과'))),
        h('tbody', null, list(v.tests_run).map((x) => h('tr', null, h('td', null, h('code', null, txt(x.command))), h('td', { class: x.exit_code === 0 ? 'ok-text' : 'bad-text' }, txt(x.exit_code)), h('td', null, txt(x.summary, '')))))))
        : h('p', { class: 'callout callout-bad' }, '실행한 테스트가 없어요')))
}

const DIFF_LINE_LIMIT = 6000
function diffPane(t) {
  if (!t.headSha) return h('p', { class: 'state' }, '아직 커밋이 없어요.')
  const d = diffs.get(`${t.id}|${t.headSha}`)
  if (!d || d.status === 'loading') return skeleton(8)
  if (d.status === 'missing') return h('p', { class: 'state' }, 'diff를 찾을 수 없어요.')
  if (d.status === 'error') return h('p', { class: 'state state-error' }, d.error)
  if (!d.files.length && !d.parsed.length) return h('p', { class: 'state' }, '변경 사항이 없어요.')
  const num = (v) => (Number.isFinite(v) ? v : 0)
  const added = d.files.reduce((n, f) => n + num(f.added), 0), removed = d.files.reduce((n, f) => n + num(f.removed), 0)
  const bodyIndex = new Map(d.parsed.map((f, i) => [f.path, i]))
  let budget = DIFF_LINE_LIMIT
  const STATUS = { added: '추가', deleted: '삭제', renamed: '이름 변경', modified: '수정' }
  const counts = (a, r) => h('span', { class: 'file-counts' }, h('span', { class: 'add-text' }, Number.isFinite(a) ? `+${a}` : '+?'), ' ', h('span', { class: 'del-text' }, Number.isFinite(r) ? `−${r}` : '−?'))
  return h('div', { class: 'diff' },
    h('div', { class: 'summary-row' }, h('span', null, `파일 ${d.files.length}개`), h('span', { class: 'add-text' }, `+${added}`), h('span', { class: 'del-text' }, `−${removed}`),
      h('span', { class: 'muted mono small' }, `${shortSha(t.baseSha)}..${shortSha(t.headSha)}`)),
    d.truncated ? h('p', { class: 'callout' }, 'diff가 너무 커서 앞부분만 보여요 (2MB 제한). 파일 목록과 줄 수는 전체 기준이에요.') : null,
    h('ul', { class: 'file-list' }, d.files.map((f) => {
      const i = bodyIndex.get(f.path)
      return h('li', null, h('button', { class: 'file-link', type: 'button', disabled: i === undefined, title: i === undefined ? '본문이 잘려서 보이지 않아요' : null,
        onclick: () => document.getElementById(`diff-file-${i}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }) },
      h('span', { class: `file-status fs-${d.parsed[i]?.status ?? 'modified'}` }, STATUS[d.parsed[i]?.status] ?? '수정'), h('span', { class: 'mono file-path' }, txt(f.path)), counts(f.added, f.removed)))
    })),
    d.parsed.map((f, i) => {
      const lines = f.lines.filter((l) => !(l.kind === 'meta' && /^(diff --git|index |--- |\+\+\+ )/.test(l.text)))
      const shown = lines.slice(0, Math.max(0, budget))
      budget -= shown.length
      return h('section', { class: 'diff-file', id: `diff-file-${i}` },
        h('header', { class: 'diff-file-head' }, h('span', { class: 'mono file-path' }, f.path), counts(f.added, f.removed)),
        f.binary ? h('p', { class: 'muted small pad' }, '바이너리 파일') : h('pre', { class: 'diff-body' }, shown.map((l) => h('span', { class: `dl dl-${l.kind}` }, l.text || ' '))),
        shown.length < lines.length ? h('p', { class: 'muted small pad' }, `나머지 ${lines.length - shown.length}줄은 생략했어요`) : null)
    }))
}

// ---------- global events ----------
$('drawer-backdrop').addEventListener('click', () => closeDrawer())
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.drawer) { e.preventDefault(); closeDrawer() }
  if (e.key === 'Tab' && state.drawer) { // keep focus inside the modal drawer
    const f = [...$('drawer').querySelectorAll('button:not([disabled]), select, [tabindex="0"], summary, input, textarea')].filter((x) => x.offsetParent !== null)
    if (!f.length) return
    const first = f[0], last = f[f.length - 1]
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
    else if (!$('drawer').contains(document.activeElement)) { e.preventDefault(); first.focus() }
  }
})
$('needs-badge').addEventListener('click', () => $('decisions').scrollIntoView({ block: 'start', behavior: 'smooth' }))
window.addEventListener('popstate', applyHash)
setInterval(() => { render() }, 30_000) // relative times
// No bytes (not even a heartbeat) for 90 s: treat the stream as dead and reconnect (then refetch).
setInterval(() => { if (sse && lastBeat && Date.now() - lastBeat > 90_000) { hadError = true; setConn('retry'); connect() } }, 15_000)
document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleRefresh(0) })

// ---------- boot ----------
// The pet opens /ui/#code=…&request=…&task=… (detailPath): read the target before the code exchange clears the fragment.
const bootTarget = parseFragment(location.hash)
{
  const r = bootTarget.request ? { req: bootTarget.request, task: bootTarget.task, tab: null } : parseHash()
  if (r.req) { state.selected = r.req; if (r.task) state.drawer = { taskKey: r.task, tab: TABS.some(([k]) => k === r.tab) ? r.tab : 'activity', attemptId: null } }
}
startSession().then((ok) => {
  if (!ok) return
  if (bootTarget.request) writeHash(true) // #request=…&task=… becomes #/r/<id>/t/<key>/activity
  render()
  loadState()
  loadDetail()
  connect()
})
document.querySelector('.skip-link')?.addEventListener('click', (e) => { e.preventDefault(); const m = $('main'); m.setAttribute('tabindex', '-1'); m.focus() })
