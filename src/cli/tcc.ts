// macOS TCC: folders (Desktop/Documents/Downloads) whose first read by a launchd-started `node` pops a permission dialog.
// Pure path checks only — never touches the filesystem beyond reading config/projects.json.
import { resolve } from 'node:path'
import { expandHome, shortenHome, type Ctx } from './ctx.ts'
import { readProjects } from './projects.ts'

export type ProtectedFolder = 'Desktop' | 'Documents' | 'Downloads'
export interface ProtectedHit { folder: ProtectedFolder; label: string; paths: string[] }

const FOLDERS: [ProtectedFolder, string][] = [['Desktop', '데스크탑'], ['Documents', '문서'], ['Downloads', '다운로드']]

export function protectedFolders(paths: string[], userHome: string): ProtectedHit[] {
  const home = resolve(userHome)
  const out: ProtectedHit[] = []
  for (const [folder, label] of FOLDERS) {
    const base = `${home}/${folder}`
    const hits: string[] = []
    for (const p of paths) {
      const r = resolve(p)
      if ((r === base || r.startsWith(base + '/')) && !hits.includes(p)) hits.push(p)
    }
    if (hits.length) out.push({ folder, label, paths: hits })
  }
  return out
}

/** Paths the daemon reads: repo root, $HQ_HOME and every registered project (unreadable/invalid entries skipped). */
export function hqReadPaths(ctx: Ctx): string[] {
  const paths = [ctx.root, ctx.home]
  try {
    for (const pr of readProjects(ctx) ?? []) {
      if (pr && typeof pr.path === 'string' && pr.path) paths.push(resolve(expandHome(pr.path, ctx.userHome)))
    }
  } catch { /* skip unreadable projects.json */ }
  return paths
}

export const tccLabels = (hits: ProtectedHit[]) => hits.map((h) => h.label).join('·')

/** Shortened, deduped paths across all hits: at most 3, then ' 외 N개'. */
export function tccPathList(hits: ProtectedHit[], userHome: string): string {
  const all = [...new Set(hits.flatMap((h) => h.paths))].map((p) => shortenHome(p, userHome))
  return all.slice(0, 3).join(', ') + (all.length > 3 ? ` 외 ${all.length - 3}개` : '')
}
