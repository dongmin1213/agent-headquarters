// Physical play verification needs many short input actions. Keep it bounded separately from development.
export const GAME_PLAY_TOOL_LIMIT = 400
export function toolBudgetReason(total: number, gamePlay: number, generalLimit: number, game: boolean): string | null {
  const play = game ? Math.max(0, Math.min(total, gamePlay)) : 0
  if (total - play > generalLimit) return `도구 실행 상한 (${generalLimit}) 초과`
  if (play > GAME_PLAY_TOOL_LIMIT) return `게임 플레이 조작 상한 (${GAME_PLAY_TOOL_LIMIT}) 초과`
  return null
}
