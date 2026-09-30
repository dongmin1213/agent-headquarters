// Korean particles after interpolated words: josa('포트 17933', '을/를') → '포트 17933을'.
// The particle follows how the last character is read aloud:
// - Hangul: exact (final consonant from the syllable; ㄹ counts as "no final" for 으로/로).
// - Digits: Korean reading of the last digit — 0영 1일 2이 3삼 4사 5오 6육 7칠 8팔 9구;
//   a trailing 0 of a larger number is 십/백/천/만 (always a final consonant, never ㄹ).
// - Latin, lowercase word: a final consonant only when it ends in l (ㄹ), m, n or ng (파일, 팀, 메인, 스트링);
//   a silent e after those counts too (file 파일, name 네임, phone 폰); everything else reads as a vowel ending
//   (테스트, 서버, 체크). English spelling is ambiguous, so prefer rephrasing strings with latin words before particles. Uppercase acronyms and single letters use the
//   letter name: L 엘/R 알 (ㄹ), M 엠, N 엔; the others end in a vowel (에이, 비, 씨 …).
// - Anything else (paths, symbols, empty): the neutral form '(이)가', '(을)를' … — prefer rephrasing such strings.
// Trailing quotes, brackets and punctuation are skipped before deciding.

export type JosaPair = '을/를' | '이/가' | '은/는' | '와/과' | '으로/로' | '이에요/예요' | '이라서/라서'

type Final = 'none' | 'rieul' | 'other' | 'unknown'

const DIGIT_FINAL: Final[] = ['other', 'rieul', 'none', 'other', 'none', 'none', 'other', 'rieul', 'rieul', 'none']
const LETTER_NAME_FINAL: Record<string, Final> = { L: 'rieul', R: 'rieul', M: 'other', N: 'other' }

export function finalOf(word: string): Final {
  const s = String(word ?? '').replace(/[\s'"`)\]}>.,:;!?·…-]+$/u, '')
  if (!s) return 'unknown'
  const ch = s[s.length - 1]
  const code = ch.charCodeAt(0)
  if (code >= 0xac00 && code <= 0xd7a3) {
    const jong = (code - 0xac00) % 28
    return jong === 0 ? 'none' : jong === 8 ? 'rieul' : 'other'
  }
  if (/[0-9]/.test(ch)) {
    const digits = /[0-9]+$/.exec(s)![0]
    if (ch === '0' && digits.length > 1 && /[1-9]/.test(digits)) return 'other' // 십 · 백 · 천 · 만
    return DIGIT_FINAL[Number(ch)]
  }
  if (/[A-Za-z]/.test(ch)) {
    const letters = /[A-Za-z]+$/.exec(s)![0]
    if (letters.length === 1 || letters === letters.toUpperCase()) return LETTER_NAME_FINAL[ch.toUpperCase()] ?? 'none'
    const w = letters.toLowerCase().replace(/([lmn])e$/, '$1') // silent e: file 파일, name 네임, phone 폰
    if (w.endsWith('ng') || w.endsWith('m') || w.endsWith('n')) return 'other'
    if (w.endsWith('l')) return 'rieul'
    return 'none'
  }
  return 'unknown'
}

/** [after a final consonant, after a vowel, when unknown] per pair. */
const FORMS: Record<JosaPair, [string, string, string]> = {
  '을/를': ['을', '를', '(을)를'], '이/가': ['이', '가', '(이)가'], '은/는': ['은', '는', '(은)는'], '와/과': ['과', '와', '와(과)'],
  '으로/로': ['으로', '로', '(으)로'], '이에요/예요': ['이에요', '예요', '(이)예요'], '이라서/라서': ['이라서', '라서', '(이)라서'],
}

/** Only the particle for `word` ("을" or "를" …). */
export function particle(word: string, pair: JosaPair): string {
  const [closed, open, unknown] = FORMS[pair]
  const f = finalOf(word)
  if (f === 'unknown') return unknown
  if (pair === '으로/로') return f === 'other' ? closed : open
  return f === 'none' ? open : closed
}

/** `word` followed by the right particle. */
export function josa(word: string | number, pair: JosaPair): string {
  const w = String(word)
  return w + particle(w, pair)
}
