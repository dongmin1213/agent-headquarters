// `hq projects list|add|remove`: edits config/projects.json atomically.
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { expandHome, projectsFile, shortenHome, writeAtomic, type Ctx } from './ctx.ts'

export interface ProjectEntry { id: string; name: string; path: string }

export const ID_RE = /^[a-z0-9-]+$/

export function readProjects(ctx: Ctx): ProjectEntry[] | null {
  const f = projectsFile(ctx)
  if (!existsSync(f)) return null
  const raw = JSON.parse(readFileSync(f, 'utf8'))
  if (!Array.isArray(raw)) throw new Error('config/projects.json은 배열이어야 합니다')
  return raw as ProjectEntry[]
}

function save(ctx: Ctx, list: ProjectEntry[]) {
  writeAtomic(projectsFile(ctx), JSON.stringify(list, null, 2) + '\n')
}

export const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')

async function isGit(ctx: Ctx, dir: string): Promise<boolean> {
  const r = await ctx.run('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree'], { timeoutMs: 10_000 })
  return r.code === 0 && r.stdout.trim() === 'true'
}

function load(ctx: Ctx): ProjectEntry[] | number {
  try { return readProjects(ctx) ?? [] } catch (e) { ctx.err(`config/projects.json을 읽지 못함: ${(e as Error).message}`); return 1 }
}

export async function projectsList(ctx: Ctx): Promise<number> {
  let list: ProjectEntry[] | null
  try { list = readProjects(ctx) } catch (e) { ctx.err(`config/projects.json을 읽지 못함: ${(e as Error).message}`); return 1 }
  if (!list) { ctx.out('config/projects.json 없음 (데몬은 예시 파일로 동작). 추가: hq projects add <경로>'); return 0 }
  if (!list.length) { ctx.out('등록된 프로젝트 없음. 추가: hq projects add <경로>'); return 0 }
  for (const p of list) {
    const abs = expandHome(p.path, ctx.userHome)
    const note = !existsSync(abs) ? '  [경로 없음]' : !(await isGit(ctx, abs)) ? '  [git 아님]' : ''
    ctx.out(`${p.id}\t${p.name}\t${p.path}${note}`)
  }
  return 0
}

export async function projectsAdd(ctx: Ctx, path: string, opts: { id?: string; name?: string }): Promise<number> {
  const abs = resolve(expandHome(path, ctx.userHome))
  if (!existsSync(abs) || !statSync(abs).isDirectory()) { ctx.err(`폴더가 없습니다: ${abs}`); return 1 }
  const id = opts.id ?? slugify(basename(abs))
  if (!ID_RE.test(id)) { ctx.err(`id는 소문자·숫자·하이픈만 가능합니다 ([a-z0-9-]+): "${id}"${opts.id ? '' : ' → --id로 지정하세요'}`); return 1 }
  const list = load(ctx)
  if (typeof list === 'number') return list
  if (list.some((p) => p.id === id)) { ctx.err(`이미 있는 id입니다: ${id} (--id로 다른 값을 주세요)`); return 1 }
  const stored = shortenHome(abs, ctx.userHome)
  const dup = list.find((p) => resolve(expandHome(p.path, ctx.userHome)) === abs)
  if (dup) { ctx.err(`이미 등록된 경로입니다: ${stored} (id ${dup.id})`); return 1 }
  list.push({ id, name: opts.name ?? basename(abs), path: stored })
  save(ctx, list)
  ctx.out(`추가됨: ${id} → ${stored}`)
  if (!(await isGit(ctx, abs))) ctx.out(`경고: ${stored}는 git 저장소가 아닙니다 — 실행 단계에는 git 필요 (git init)`)
  ctx.out('데몬에 반영하려면: hq restart')
  return 0
}

export async function projectsRemove(ctx: Ctx, id: string): Promise<number> {
  const list = load(ctx)
  if (typeof list === 'number') return list
  const next = list.filter((p) => p.id !== id)
  if (next.length === list.length) { ctx.err(`없는 id입니다: ${id} (목록: hq projects list)`); return 1 }
  save(ctx, next)
  ctx.out(`삭제됨: ${id}`)
  if (!next.length) ctx.out('경고: 등록된 프로젝트가 없습니다. 요청을 받으려면 hq projects add <경로>')
  ctx.out('데몬에 반영하려면: hq restart')
  return 0
}
