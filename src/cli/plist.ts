// LaunchAgent plist generation. Every string value is XML-escaped.
import { dirname } from 'node:path'
import { DAEMON_LABEL, PET_LABEL } from './ctx.ts'

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

export interface DaemonPlistOpts { nodePath: string; root: string; home: string; port: number; path: string; logFile: string; tokenFile?: string }

export function daemonPlist(o: DaemonPlistOpts): string {
  const env: Record<string, string> = { PATH: o.path, HQ_HOME: o.home, HQ_PORT: String(o.port) }
  if (o.tokenFile) env.HQ_TOKEN_FILE = o.tokenFile
  return renderPlist({
    Label: DAEMON_LABEL,
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

export function petPlist(o: { appBinary: string; logFile: string }): string {
  return renderPlist({
    Label: PET_LABEL,
    ProgramArguments: [o.appBinary],
    RunAtLoad: true,
    ProcessType: 'Interactive',
    LimitLoadToSessionType: 'Aqua',
    StandardOutPath: o.logFile,
    StandardErrorPath: o.logFile,
  })
}
