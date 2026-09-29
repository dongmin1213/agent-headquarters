// Runs the unmodified Claude Code CLI headless with the user's own subscription login
// (no --bare: bare mode ignores OAuth and needs an API key).
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

export interface ClaudeRun {
  prompt: string
  cwd: string
  /** Omit to use Claude Code's default model. */
  model?: string
  allowedTools?: string[]
  permissionMode?: 'default' | 'acceptEdits' | 'auto' | 'dontAsk' | 'plan'
  resumeSessionId?: string
  maxTurns?: number
  timeoutMs?: number
}

export interface ClaudeResult {
  ok: boolean
  text: string
  sessionId: string | null
  costUsd: number | null
  /** True when the run looks like a subscription usage-limit stop rather than a real failure. */
  limited: boolean
  exitCode: number
}

/** Stream-json line as emitted by `claude -p --output-format stream-json --verbose`. */
export type StreamLine = { type: string; subtype?: string; [k: string]: unknown }

const LIMIT_RE = /usage limit|rate limit|limit reached|5-hour limit|weekly limit/i

export function runClaude(run: ClaudeRun, onLine: (line: StreamLine) => void = () => {}): Promise<ClaudeResult> {
  const args = ['-p', run.prompt, '--output-format', 'stream-json', '--verbose']
  if (run.model) args.push('--model', run.model)
  if (run.allowedTools?.length) args.push('--allowedTools', run.allowedTools.join(','))
  if (run.permissionMode) args.push('--permission-mode', run.permissionMode)
  if (run.resumeSessionId) args.push('--resume', run.resumeSessionId)
  if (run.maxTurns) args.push('--max-turns', String(run.maxTurns))

  const env = { ...process.env }
  delete env.CLAUDECODE // allow running from inside a Claude Code session

  return new Promise((resolve) => {
    const child = spawn('claude', args, { cwd: run.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let result: StreamLine | null = null
    let stderr = ''
    const timer = run.timeoutMs ? setTimeout(() => child.kill('SIGINT'), run.timeoutMs) : null

    createInterface({ input: child.stdout }).on('line', (raw) => {
      if (!raw.trim()) return
      let line: StreamLine
      try { line = JSON.parse(raw) as StreamLine } catch { return }
      if (line.type === 'result') result = line
      onLine(line)
    })
    child.stderr.on('data', (b: Buffer) => { stderr += b.toString() })

    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      const r = result as Record<string, unknown> | null
      const text = r && typeof r.result === 'string' ? r.result : stderr.trim()
      const usage = (r?.usage ?? {}) as Record<string, unknown>
      const zeroOutput = r != null && Number(usage.output_tokens ?? 0) === 0
      const limited = LIMIT_RE.test(text) || (zeroOutput && r?.is_error === true)
      resolve({
        ok: code === 0 && r != null && r.is_error !== true,
        text,
        sessionId: r && typeof r.session_id === 'string' ? r.session_id : null,
        costUsd: r && typeof r.total_cost_usd === 'number' ? r.total_cost_usd : null,
        limited,
        exitCode: code ?? -1,
      })
    })
  })
}
