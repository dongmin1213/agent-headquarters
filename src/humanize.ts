// Raw technical errors → one Korean sentence for the chairman (execution.md §17 "원인").
// The raw text is never dropped: callers keep it in `detail`, shown behind "원문 보기".

export const UNKNOWN_ERROR = '예상하지 못한 오류가 났어요 · 원문을 확인해 주세요'
export const SERVER_ERROR = '서버에서 문제가 생겼어요 · hq logs로 원문을 확인할 수 있어요'

/** Known patterns, checked in order; the first match wins. Each text says what happened and what to do. */
export const ERROR_PATTERNS: [RegExp, string][] = [
  [/Not logged in|Please run \/login|Invalid API key|authentication_error|\b401\b|Unauthorized/i, 'Claude에 로그인되어 있지 않아요 · 터미널에서 claude를 실행해 로그인해 주세요'],
  [/rate[ _-]?limit|usage limit|\b429\b/i, 'Claude 사용 한도에 걸렸어요 · 한도가 풀리면 다시 시도할 수 있어요'],
  [/index\.lock/, '다른 git 작업이 저장소를 잠그고 있어요 · 진행 중인 git 명령이 없으면 .git/index.lock을 지운 뒤 다시 시도해 주세요'],
  [/\bCONFLICT\b|Automatic merge failed|merge conflict/, '합치는 중에 같은 부분을 서로 다르게 고친 충돌이 났어요 · 해당 작업을 다시 하거나 직접 합쳐 주세요'],
  [/not something we can merge/, '합칠 커밋을 찾지 못했어요 · 다시 통합해 주세요'],
  [/fatal: bad object|bad revision|unknown revision|Not a valid object name|invalid object/, '필요한 커밋을 저장소에서 찾지 못했어요 · 다시 통합하거나 작업을 다시 해 주세요'],
  [/ECONNREFUSED|Connection refused/, '상대 프로그램이 연결을 받지 않았어요 · 켜져 있는지 확인한 뒤 다시 시도해 주세요'],
  [/ETIMEDOUT|ENOTFOUND|EAI_AGAIN|timed out|Could not resolve host/i, '네트워크 응답이 없어요 · 인터넷 연결을 확인한 뒤 다시 시도해 주세요'],
  [/EACCES|EPERM|Permission denied|Operation not permitted/, '권한이 없어 파일이나 폴더에 접근하지 못했어요 · 권한 설정을 확인해 주세요'],
  [/ENOENT|No such file or directory|command not found|does not exist/, '필요한 파일이나 프로그램을 찾지 못했어요 · 경로가 맞는지 확인해 주세요'],
]

/** Signs of pasted program output (stack traces, git/Node error codes). */
const TECH = /\b(?:[A-Z][a-zA-Z]*Error|Exception|fatal|error|errno)\b\s*:|\bE[A-Z]{3,}\b|^\s*at .+:\d+:\d+\)?$/m

const hasHangul = (s: string) => /[\uac00-\ud7a3]/.test(s)

export interface Explained {
  /** One Korean sentence. */
  cause: string
  /** The raw text, untouched (empty when there was none). */
  detail: string
  /** A known pattern matched, or the text was already hq's own Korean sentence. */
  known: boolean
}

/** hq's own Korean lead-in before pasted output: "미러 갱신 실패: Error: …" → "미러 갱신 실패". */
function koreanHead(text: string): string {
  const i = text.search(/:\s/)
  if (i <= 0) return ''
  const head = text.slice(0, i).split('\n')[0].trim()
  return hasHangul(head) && !TECH.test(head) ? head : ''
}

/**
 * - known pattern → its Korean sentence, after hq's own Korean lead-in if there is one ("미러 갱신 실패 · …");
 * - hq's own Korean sentence without program output → its first line, unchanged;
 * - Korean lead-in + unknown output → "<lead-in> · 원문을 확인해 주세요";
 * - anything else → UNKNOWN_ERROR.
 */
export function explainError(raw: string | null | undefined): Explained {
  const detail = String(raw ?? '').trim()
  if (!detail) return { cause: UNKNOWN_ERROR, detail: '', known: false }
  const technical = TECH.test(detail) || !hasHangul(detail)
  const head = technical ? koreanHead(detail) : ''
  const hit = ERROR_PATTERNS.find(([re]) => re.test(detail))
  if (!technical) return { cause: detail.split('\n').find((l) => l.trim())!.trim().slice(0, 300), detail, known: true }
  if (hit) return { cause: head ? `${head} · ${hit[1]}` : hit[1], detail, known: true }
  return { cause: head ? `${head} · 원문을 확인해 주세요` : UNKNOWN_ERROR, detail, known: false }
}
