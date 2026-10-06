import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GAME_QUALITY_AXES, gameQualityProblem } from '../../src/game-quality.ts'

test('quality cannot be approved with failed, unobserved, missing or invented evidence, even when overall pass=true', () => {
  const root = mkdtempSync(join(tmpdir(), 'hq-quality-'))
  const frames = [join(root, 'frame.png')]
  writeFileSync(frames[0], 'fixture')
  writeFileSync(join(root, 'source.ts'), 'fixture')
  const verdict = () => ({ pass: true, reason: 'fixture', repairs: [] as object[], criteria: GAME_QUALITY_AXES.map(id => ({ id, result: 'pass', observation: 'fixture', evidence: ['source.ts', ...frames] })) })
  try {
    assert.equal(gameQualityProblem(verdict(), root, frames), null)
    for (const result of ['fail', 'unverified']) {
      const v = verdict(); v.criteria[1].result = result
      assert.match(gameQualityProblem(v, root, frames)!, new RegExp(result))
    }
    const missing = verdict(); missing.criteria.pop()
    assert.match(gameQualityProblem(missing, root, frames)!, /빠졌거나/)
    const duplicate = verdict(); duplicate.criteria[1] = duplicate.criteria[0]
    assert.match(gameQualityProblem(duplicate, root, frames)!, /중복/)
    const nonexistent = verdict(); nonexistent.criteria[1].evidence = ['invented.png']
    assert.match(gameQualityProblem(nonexistent, root, frames)!, /증거 파일/)
    const noVideo = verdict(); noVideo.criteria[2].evidence = ['source.ts']
    assert.match(gameQualityProblem(noVideo, root, frames)!, /프레임/)
    const escape = verdict(); escape.criteria[0].evidence = ['../source.ts']
    assert.match(gameQualityProblem(escape, root, frames)!, /증거 파일/)
    symlinkSync('source.ts', join(root, 'link'))
    const link = verdict(); link.criteria[0].evidence = ['link']
    assert.match(gameQualityProblem(link, root, frames)!, /증거 파일/)
    const repairs = verdict(); repairs.repairs.push({ department: 'art', instruction: 'fix readability' })
    assert.match(gameQualityProblem(repairs, root, frames)!, /결함/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
