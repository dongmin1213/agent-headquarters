// Loads config/hq.json (optional) and merges defaults. See docs/design/execution.md §2.
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { josa, particle } from './josa.ts'

export type Grade = 'L0' | 'L1' | 'L2' | 'L3'
export type ModelAlias = 'haiku' | 'sonnet' | 'opus'

export interface HqConfig {
  /** Root for runtime data (db, worktrees, evidence). */
  home: string
  maxWorkers: number
  attemptWallMinutes: Record<Grade, number>
  maxTurns: number
  checkTimeoutMinutes: number
  /** Model alias → value passed to `codex exec --model`. */
  models: Record<ModelAlias, string>
  ladder: ModelAlias[]
  maxAttempts: number
  quota: { saveAt: number; holdAt: number }
  workerDisallowedTools: string[]
  /** Globs whose changes are always flagged to the reviewer and on the acceptance card. */
  protectedPaths: string[]
  /** Extra writable (and readable) roots inside the worker sandbox (execution.md §6). Package-manager caches are per run, not here. */
  sandbox: { extraWritable: string[] }
  notify: boolean
  /** Codex CLI executable (tests point this at a fake). */
  codexBin: string
}

export const DEFAULTS: Omit<HqConfig, 'home' | 'codexBin'> = {
  maxWorkers: 2,
  attemptWallMinutes: { L0: 20, L1: 45, L2: 90, L3: 120 },
  maxTurns: 200,
  checkTimeoutMinutes: 15,
  models: { haiku: 'gpt-6-luna', sonnet: 'gpt-6.1-sol', opus: 'gpt-6-astra' },
  ladder: ['haiku', 'sonnet', 'opus'],
  maxAttempts: 3,
  quota: { saveAt: 0.85, holdAt: 0.95 },
  workerDisallowedTools: ['Bash(git push:*)', 'Bash(git remote:*)', 'Read(**/.env*)', 'Edit(**/.env*)', 'Write(**/.env*)'],
  protectedPaths: ['**/*.test.*', '**/*.spec.*', 'test/**', 'tests/**', '**/__tests__/**', 'package.json', '*.lock', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', '.github/**', 'tsconfig*.json', '**/*.config.*'],
  sandbox: { extraWritable: [] },
  notify: true,
}

const expand = (p: string) => p.replace(/^~(?=\/|$)/, homedir())

/** Throws with a readable message on invalid values; unknown keys are rejected so typos surface. */
export function loadConfig(root: string, env: NodeJS.ProcessEnv = process.env): HqConfig {
  const file = resolve(root, 'config/hq.json')
  const raw: Record<string, unknown> = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
  // Legacy executable settings never cause a Claude binary to be invoked as Codex.
  delete raw.claudeBin
  const known = new Set([...Object.keys(DEFAULTS), 'home', 'codexBin'])
  for (const k of Object.keys(raw)) if (!known.has(k)) throw new Error(`config/hq.json: 알 수 없는 키 "${k}"`)
  // Nested objects are checked too, so removed keys (e.g. quota.reviewOnlyAt) surface instead of being ignored.
  const nested = { attemptWallMinutes: DEFAULTS.attemptWallMinutes, models: DEFAULTS.models, quota: DEFAULTS.quota, sandbox: DEFAULTS.sandbox } as Record<string, object>
  for (const [k, def] of Object.entries(nested)) {
    const v = raw[k]
    if (v === undefined) continue
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`config/hq.json: "${k}"${particle(k, '은/는')} 객체여야 합니다`)
    for (const sub of Object.keys(v)) if (!(sub in def)) throw new Error(`config/hq.json: 알 수 없는 키 "${k}.${sub}"`)
  }
  const c = {
    ...DEFAULTS, ...raw,
    attemptWallMinutes: { ...DEFAULTS.attemptWallMinutes, ...(raw.attemptWallMinutes as object | undefined) },
    models: { ...DEFAULTS.models, ...(raw.models as object | undefined) },
    quota: { ...DEFAULTS.quota, ...(raw.quota as object | undefined) },
    sandbox: { ...DEFAULTS.sandbox, ...(raw.sandbox as object | undefined) },
    home: expand(env.HQ_HOME ?? (raw.home as string | undefined) ?? '~/.hq'),
    codexBin: env.HQ_CODEX_BIN ?? (raw.codexBin as string | undefined) ?? 'codex',
  } as HqConfig
  for (const k of Object.keys(c.models) as ModelAlias[]) if (/^(haiku|sonnet|opus)$|^claude-/.test(c.models[k])) c.models[k] = DEFAULTS.models[k]
  const posInt = (v: unknown) => Number.isInteger(v) && (v as number) > 0
  if (!posInt(c.maxWorkers)) throw new Error('config: maxWorkers는 양의 정수')
  if (!posInt(c.maxTurns)) throw new Error('config: maxTurns는 양의 정수')
  if (!posInt(c.maxAttempts)) throw new Error('config: maxAttempts는 양의 정수')
  if (!(c.checkTimeoutMinutes > 0)) throw new Error('config: checkTimeoutMinutes는 양수')
  for (const g of ['L0', 'L1', 'L2', 'L3'] as const) if (!(c.attemptWallMinutes[g] > 0)) throw new Error(`config: attemptWallMinutes.${josa(g, '은/는')} 양수`)
  const q = c.quota
  if (!(0 < q.saveAt && q.saveAt <= q.holdAt && q.holdAt <= 1)) throw new Error('config: quota는 0 < saveAt ≤ holdAt ≤ 1')
  if (!Array.isArray(c.protectedPaths) || c.protectedPaths.some((x) => typeof x !== 'string' || !x)) throw new Error('config: protectedPaths는 문자열 목록')
  if (!Array.isArray(c.sandbox.extraWritable)) throw new Error('config: sandbox.extraWritable은 경로 목록')
  c.sandbox.extraWritable = c.sandbox.extraWritable.map(expand)
  if (Object.values(c.models).some((m) => typeof m !== 'string' || !m)) throw new Error('config: models 값은 비어 있지 않은 문자열')
  if (new Set(c.ladder).size !== c.ladder.length) throw new Error('config: ladder에 중복')
  if (!c.ladder.length || c.ladder.some((m) => !(m in c.models))) throw new Error('config: ladder는 models의 키 목록')
  return c
}
