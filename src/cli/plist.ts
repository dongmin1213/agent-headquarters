// LaunchAgent plist generation. Every string value is XML-escaped.
import { dirname } from 'node:path'

export type PlistValue = string | number | boolean | PlistValue[] | { [k: string]: PlistValue }

export const xmlEscape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')

function value(v: PlistValue, indent: string): string {
  if (typeof v === 'string') return `${indent}<string>${xmlEscape(v)}</string>`
  if (typeof v === 'boolean') return `${indent}<${v}/>`
  if (typeof v === 'number') return Number.isInteger(v) ? `${indent}<integer>${v}</integer>` : `${indent}<real>${v}</real>`
  if (Array.isArray(v)) return v.length ? `${indent}<array>\n${v.map((x) => value(x, indent + '  ')).join('\n')}\n${indent}</array>` : `${indent}<array/>`
  const keys = Object.keys(v)
  if (!keys.length) return `${indent}<dict/>`
  return `${indent}<dict>\n${keys.map((k) => `${indent}  <key>${xmlEscape(k)}</key>\n${value(v[k], indent + '  ')}`).join('\n')}\n${indent}</dict>`
}

export function renderPlist(dict: { [k: string]: PlistValue }): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
${value(dict, '')}
</plist>
`
}

/** PATH for launchd jobs: directories of the tools hq shells out to, then the system defaults. */
export function launchPath(toolPaths: (string | null)[]): string {
  const dirs = [...toolPaths.filter((p): p is string => !!p).map((p) => dirname(p)),
    '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']
  return [...new Set(dirs)].join(':')
}

export interface DaemonPlistOpts { label: string; nodePath: string; root: string; home: string; port: number; path: string; logFile: string; tokenFile?: string }

export function daemonPlist(o: DaemonPlistOpts): string {
  const env: Record<string, string> = { PATH: o.path, HQ_HOME: o.home, HQ_PORT: String(o.port) }
  if (o.tokenFile) env.HQ_TOKEN_FILE = o.tokenFile
  return renderPlist({
    Label: o.label,
    ProgramArguments: [o.nodePath, `${o.root}/src/main.ts`],
    WorkingDirectory: o.root,
    RunAtLoad: true,
    KeepAlive: { SuccessfulExit: false },
    ThrottleInterval: 10,
    ProcessType: 'Background',
    EnvironmentVariables: env,
    StandardOutPath: o.logFile,
    StandardErrorPath: o.logFile,
  })
}

export interface PetPlistOpts { label: string; appBinary: string; logFile: string; port: number; tokenFile: string; suffix: string | null }

/**
 * The pet reads HQ_URL and HQ_TOKEN_FILE (pet/main.swift). A non-default installation also gets its own defaults suite
 * (character positions) and may run next to the default pet (HQ_ALLOW_SECOND_INSTANCE skips the single-instance exit).
 */
export function petPlist(o: PetPlistOpts): string {
  const env: Record<string, string> = { HQ_URL: `http://127.0.0.1:${o.port}`, HQ_TOKEN_FILE: o.tokenFile }
  if (o.suffix) { env.HQ_DEFAULTS_SUITE = `hqpet.${o.suffix}`; env.HQ_ALLOW_SECOND_INSTANCE = '1' }
  return renderPlist({
    Label: o.label,
    ProgramArguments: [o.appBinary],
    RunAtLoad: true,
    ProcessType: 'Interactive',
    LimitLoadToSessionType: 'Aqua',
    EnvironmentVariables: env,
    StandardOutPath: o.logFile,
    StandardErrorPath: o.logFile,
  })
}
