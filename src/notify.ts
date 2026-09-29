// macOS notification without extra dependencies. Text is passed as argv, never interpolated into a shell.
import { execFile } from 'node:child_process'

export function notify(title: string, body: string): void {
  if (process.platform !== 'darwin' || process.env.HQ_NO_NOTIFY) return
  const script = 'on run argv\ndisplay notification (item 2 of argv) with title (item 1 of argv)\nend run'
  execFile('osascript', ['-e', script, title.slice(0, 80), body.slice(0, 200)], () => {})
}
