// One vocabulary for every chairman surface (web, pet, CLI, notifications).
// Copies that cannot import this file must stay identical (test/unit/glossary.test.ts checks them):
//   src/web/assets/lib.js  GLOSSARY / KIND_LABELS
//   pet/main.swift         Pet.kindLabels

/** Words for the same things everywhere. "CEO" is never shown: the agent is 사장. */
export const GLOSSARY = {
  ceo: '사장',
  task: '작업',
  blocked: '막힘',
  accept: '수락',
  merge: '병합',
} as const

/** Card label per decision kind (execution.md §17). */
export const KIND_LABELS = {
  system: '로그인 필요',
  plan: '계획 승인',
  ceo_question: '사장 질문',
  worker_question: '작업자 질문',
  revise: '지시서 수정안',
  blocked: '막힘',
  integration: '통합 문제',
  accept: '결과 수락',
  merge: '병합 승인',
  team: '팀 결정',
} as const
