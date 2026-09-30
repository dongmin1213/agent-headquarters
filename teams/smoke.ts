// Minimal team used to test the daemon: asks one approval, then runs one tiny Claude call.
import { runClaude } from '../src/claude.ts'
const hq = process.env.HQ_URL!, team = process.env.HQ_TEAM!
const headers = { authorization: `Bearer ${process.env.HQ_TOKEN}`, 'content-type': 'application/json' }
const subjectHash = 'smoke-v1' // hash of what is being approved (fixed prompt here)
const id = 'team:smoke:approval-1'
let a = await (await fetch(`${hq}/api/approvals/${id}`, { headers })).json() as { decision?: string | null; error?: string }
if (a.error) {
  await fetch(`${hq}/api/approvals`, { method: 'POST', headers, body: JSON.stringify({ id, teamId: team, title: '시험 실행 승인', body: 'Claude에게 한 줄 답을 요청합니다.', options: ['승인', '반려'], subjectHash, expiresInMinutes: 60 }) })
  console.log('STATUS: 승인 대기'); process.exit(3)
}
if (!a.decision) { console.log('STATUS: 승인 대기'); process.exit(3) }
if (a.decision !== '승인') { console.log('STATUS: 반려됨'); process.exit(0) }
console.log('STATUS: Claude 호출 중')
const r = await runClaude({ prompt: 'Reply with exactly: HQ OK', cwd: process.cwd(), model: 'haiku', maxTurns: 1 })
if (r.limited) { console.log('STATUS: 사용 한도'); process.exit(75) }
console.log(`STATUS: ${r.ok ? '완료: ' + r.text.trim() : '실패: ' + r.text.slice(0, 80)}`)
process.exit(r.ok ? 0 : 1)
