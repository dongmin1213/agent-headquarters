// Codex CLI boundary. Raw JSONL is retained; adapters expose the engine's stable event contract.
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Store } from './store.ts'

export const threadId = (id: string) => id.startsWith('codex:') ? id.slice(6) : null
export const sessionMarker = (id: string) => `hq-session-${id.replace(/[^a-zA-Z0-9_-]/g, '_')}.txt`

/** Old Claude quota/login holds do not describe the newly selected Codex account. Keep execution history. */
export function activateCodexProvider(store: Store): void {
  if (store.get('runtime.provider') === 'codex') return
  store.tx(() => {
    store.raw().exec("delete from quota; update approvals set state = 'superseded' where id = 'system:login' and state = 'open'")
    for (const k of ['limit.backoffUntil', 'limit.backoffLevel', 'login.required']) store.set(k, null)
    store.set('runtime.provider', 'codex')
  })
}

/** Never point a worker at the user's sessions/config/plugins. Only its authentication is copied. */
export function prepareCodexHome(root: string, key: string, source = process.env.CODEX_HOME ?? join(homedir(), '.codex')): string {
  const dir = join(root, 'codex', createHash('sha256').update(key).digest('hex'))
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink()) throw new Error('Codex 실행 폴더가 실제 디렉터리가 아닙니다')
  chmodSync(dir, 0o700)
  const auth = join(source, 'auth.json')
  const dest = join(dir, 'auth.json'), stamp = join(dir, '.source-auth-hash')
  if (existsSync(auth)) {
    const data = readFileSync(auth)
    const hash = createHash('sha256').update(data).digest('hex')
    // Preserve a token refreshed by this isolated CLI unless the user's login changed.
    if (!existsSync(dest) || lstatSync(dest).isSymbolicLink() || !lstatSync(dest).isFile() || !existsSync(stamp) || lstatSync(stamp).isSymbolicLink() || lstatSync(stamp).size !== 64 || readFileSync(stamp, 'utf8') !== hash) {
      // Rename replaces a malicious destination symlink rather than following it outside this directory.
      const tmp = join(dir, `.auth-${process.pid}-${randomUUID()}`)
      writeFileSync(tmp, data, { mode: 0o600, flag: 'wx' })
      renameSync(tmp, join(dir, 'auth.json'))
      writeFileSync(tmp, hash, { mode: 0o600, flag: 'wx' })
      renameSync(tmp, stamp)
    }
  } else {
    // A source logout must not leave an authenticated private copy behind.
    rmSync(dest, { force: true })
    rmSync(stamp, { force: true })
  }
  return dir
}

/** OpenAI strict structured output requires all object keys; optional fields become nullable. */
export function strictSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strictSchema)
  if (!value || typeof value !== 'object') return value
  const out = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, strictSchema(v)])) as Record<string, any>
  if (out.type === 'object' && out.properties) {
    const required = new Set(Array.isArray(out.required) ? out.required : [])
    for (const k of Object.keys(out.properties)) if (!required.has(k)) out.properties[k] = { anyOf: [out.properties[k], { type: 'null' }] }
    out.required = Object.keys(out.properties)
    out.additionalProperties = false
  }
  return out
}

export function execArgs(o: { model?: string; sessionId?: string; resume?: boolean; schemaPath?: string; externalSandbox?: boolean; imageGeneration?: boolean; webSearch?: boolean; images?: string[] }): string[] {
  const resume = o.resume && o.sessionId ? threadId(o.sessionId) : null
  return ['exec', ...(resume ? ['resume', resume] : []), '--json', '--ignore-user-config', '--ignore-rules',
    '-c', 'approval_policy="never"', '-c', 'features.shell_snapshot=false', '-c', 'features.memories=false',
    ...['apps', 'plugins', 'hooks', 'multi_agent', 'browser_use', 'computer_use'].flatMap(f => ['-c', `features.${f}=false`]),
    '-c', `features.image_generation=${o.imageGeneration === true}`,
    ...(o.webSearch ? ['-c', 'web_search="live"'] : []),
    ...(o.externalSandbox ? ['--dangerously-bypass-approvals-and-sandbox'] : ['-c', 'sandbox_mode="read-only"']),
    ...(o.images ?? []).flatMap(path => ['--image', path]),
    ...(o.model ? ['--model', o.model] : []), ...(o.schemaPath ? ['--output-schema', o.schemaPath] : []), '-']
}

/** Unwrap only the exact shell -c/-lc envelope, without executing or evaluating shell text. */
export function commandText(command: string): string {
  const m = /^(?:\/(?:bin|usr\/bin)\/)?(?:bash|zsh|sh) -l?c (.*)$/s.exec(command)
  if (!m) return command
  const s = m[1]
  let quote: "'" | '"' | null = null, out = '', started = false
  // Decode one literal shell word, including adjacent quoted fragments (shlex-style apostrophes).
  // Any expansion, operator or second argument keeps the original envelope; never evaluate shell text.
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quote === "'") { if (c === "'") quote = null; else out += c; continue }
    if (quote === '"') {
      if (c === '"') { quote = null; continue }
      if (c === '$' || c === '`') return command
      if (c === '\\') {
        const next = s[++i]
        if (next === undefined || next === '\n' || next === '\r') return command
        out += '"\\$`'.includes(next) ? next : '\\' + next
      } else out += c
      continue
    }
    started = true
    if (c === "'" || c === '"') { quote = c; continue }
    if (c === '\\') {
      const next = s[++i]
      if (next === undefined || next === '\n' || next === '\r') return command
      out += next; continue
    }
    if (!/[a-zA-Z0-9_./=:+,!%-]/.test(c)) return command
    out += c
  }
  return quote === null && started ? out : command
}

/** Codex CLI formats this retry timestamp in the local timezone of its process. Unknown formats retain backoff. */
export function codexLimitReset(message: string): number | null {
  const m = /try again at (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2})(?:st|nd|rd|th)?, (\d{4}) (\d{1,2}):(\d{2}) (AM|PM)(?:\.|$)/i.exec(message)
  if (!m) return null
  const month = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(m[1].toLowerCase())
  const day = Number(m[2]), year = Number(m[3]), hour = Number(m[4]), minute = Number(m[5])
  if (year < 2000 || day < 1 || day > 31 || hour < 1 || hour > 12 || minute > 59) return null
  const date = new Date(year, month, day, hour % 12 + (m[6].toUpperCase() === 'PM' ? 12 : 0), minute)
  if (date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day) return null
  return date.getTime() / 1000
}

type Event = Record<string, any>
export class CodexEvents {
  sessionId = ''
  text = ''
  result: Event | null = null
  consume(line: Event): Event[] {
    if (!line || typeof line !== 'object' || Array.isArray(line)) return []
    // Historical evidence remains readable after migration; newly launched Codex emits the cases below.
    if (!['thread.started', 'turn.started', 'turn.completed', 'turn.failed', 'error'].includes(line.type) && !String(line.type).startsWith('item.')) return [line]
    if (line.type === 'thread.started') {
      if (typeof line.thread_id !== 'string' || !line.thread_id) return []
      this.sessionId = `codex:${line.thread_id}`
      return [{ type: 'system', session_id: this.sessionId }]
    }
    if (line.type === 'turn.started') { this.text = ''; this.result = null; return [] }
    const item = line.item
    if (line.type === 'item.completed' && item?.type === 'agent_message') {
      this.text = String(item.text ?? '')
      return [{ type: 'assistant', message: { content: [{ type: 'text', text: this.text }] } }]
    }
    if (item?.type === 'command_execution') {
      const command = commandText(String(item.command ?? ''))
      const call = { type: 'assistant', message: { content: [{ type: 'tool_use', id: item.id, name: 'Bash', input: { command } }] } }
      if (line.type === 'item.started') return [call]
      if (line.type === 'item.completed') {
        const finished = item.status === 'completed' || (item.status === 'failed' && item.exit_code !== 0)
        const exit = finished && Number.isInteger(item.exit_code) && item.exit_code >= 0 ? item.exit_code : null
        return [call, { type: 'user', tool_use_result: { interrupted: exit === null }, message: { content: [{ type: 'tool_result', tool_use_id: item.id,
          is_error: exit !== 0, content: exit === null ? 'Unknown exit code' : exit === 0 ? String(item.aggregated_output ?? '') : `Exit code ${exit}\n${item.aggregated_output ?? ''}` }] } }]
      }
    }
    if (line.type === 'turn.completed') {
      let output: unknown
      try { output = JSON.parse(this.text) } catch { /* normal work uses done.json, not a schema */ }
      this.result = { type: 'result', subtype: 'success', is_error: false, session_id: this.sessionId, result: this.text, usage: line.usage ?? {},
        ...(output === undefined ? {} : { structured_output: output }) }
      return [this.result]
    }
    if (line.type === 'turn.failed' || line.type === 'error') {
      const error = line.error ?? line
      const message = String(error.message ?? 'Codex 실행 오류')
      const code = /usage limit|rate.?limit|quota|\b429\b/i.test(message) ? 429 : Number(error.status_code ?? error.status ?? 0)
      this.result = { type: 'result', subtype: 'error', is_error: true, session_id: this.sessionId, result: message, api_error_status: code, usage: {} }
      const resetsAt = code === 429 ? codexLimitReset(message) : null
      return [...(resetsAt === null ? [] : [{ type: 'rate_limit_event', rate_limit_info: { rateLimitType: 'codex', status: 'rejected', resetsAt } }]), this.result]
    }
    if (line.type === 'item.completed' && item) return [{ type: 'assistant', message: { content: [{ type: 'tool_use', name: item.type, input: { path: item.query ?? item.text ?? '' } }] } }]
    return []
  }
}

/** Use the saved ChatGPT login; inherited API keys must not silently switch billing/authentication. */
export function chatgptEnv(from: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...from }
  for (const key of ['CODEX_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'HQ_TOKEN', 'HQ_TOKEN_FILE']) delete env[key]
  return env
}

/** Small team helper. Scheduler supplies a private CODEX_HOME and the outer Seatbelt profile. */
export function runCodex(run: { prompt: string; cwd: string; model?: string; timeoutMs?: number }): Promise<{ ok: boolean; text: string; limited: boolean }> {
  return new Promise((resolve) => {
    const decoder = new CodexEvents()
    const child = spawn(process.env.HQ_CODEX_BIN ?? 'codex', execArgs({ model: run.model, externalSandbox: !!process.env.HQ_TEAM }),
      { cwd: run.cwd, env: chatgptEnv(), stdio: ['pipe', 'pipe', 'pipe'] })
    let error = ''
    const timer = setTimeout(() => child.kill('SIGINT'), run.timeoutMs ?? 60_000)
    createInterface({ input: child.stdout }).on('line', (raw) => { try { decoder.consume(JSON.parse(raw)) } catch { /* non-JSON diagnostic */ } })
    child.stderr.on('data', (b) => { error = (error + b).slice(-20_000) })
    child.on('error', (e) => { error = e.message })
    child.stdin.on('error', () => {})
    child.stdin.end(run.prompt)
    child.on('close', (code) => {
      clearTimeout(timer)
      const r = decoder.result
      resolve({ ok: code === 0 && !!r && !r.is_error, text: r?.result || error, limited: r?.api_error_status === 429 || (!r && /usage limit|rate.?limit|429/i.test(error)) })
    })
  })
}
