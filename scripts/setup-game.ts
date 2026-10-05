// Register an isolated, initially empty game project. Does not submit a production request.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { atomicJson } from '../src/exec/fsx.ts'
import type { Project } from '../src/ceo.ts'

const root = resolve(import.meta.dirname, '..')
const path = resolve(process.argv[2] ?? join(root, '..', 'game-studio'))
const config = join(root, 'config/projects.json')
const projects: Project[] = JSON.parse(readFileSync(existsSync(config) ? config : join(root, 'config/projects.example.json'), 'utf8'))
const registered = projects.find(p => p.id === 'game')
if (registered && resolve(registered.path.replace(/^~/, process.env.HOME!)) !== path) throw new Error('game 프로젝트가 다른 경로에 이미 등록되어 있습니다')
mkdirSync(path, { recursive: true })
if (!existsSync(join(path, '.git'))) {
  if (existsSync(join(path, 'README.md'))) throw new Error('기존 폴더입니다. 빈 게임 폴더를 지정하세요')
  execFileSync('git', ['init', '-q', '-b', 'main', path])
  writeFileSync(join(path, 'README.md'), `# 게임 전담팀 작업실\n\nHQ 게임 프로젝트입니다. 아직 게임 제작 요청을 시작하지 않았습니다.\n\n사용자 방향: 세밀한 픽셀 아트의 작은 완결형 메트로베니아. 론 셰프 참고 화면의 도트 밀도, 화면 내 작은 캐릭터 비율, 풍부한 다층 배경, 조명·안개·날씨를 참고합니다. 고유 캐릭터·세계관·맵·이미지는 복제하지 않습니다.\n\n주인공·세계관·핵심 능력·엔진은 조사와 제작 검증에 근거해 팀장이 결정합니다. 사용자는 출시 후보를 직접 플레이해 평가합니다. 제목 화면이나 기술 시연만으로 완료를 선언하지 않습니다.\n\n제작 순서: 시장/창작 자료 조사 → 팀장 기획 → 게임플레이/아트/레벨 → 독립 QA → 팀장 통합 → 피카츄 독립 검수 → 사용자 플레이 평가.\n\n실행물·실제 플레이 영상·출처·검증 결과를 release/game-release.json으로 제출해야 합니다. 외부 스토어 게시·결제는 별도 사용자 결정입니다.\n`)
  writeFileSync(join(path, '.gitignore'), '.DS_Store\n.env\n.env.*\nnode_modules/\n.godot/\n')
  execFileSync('git', ['add', 'README.md', '.gitignore'], { cwd: path })
  execFileSync('git', ['commit', '-qm', 'chore: initialize HQ game studio brief'], { cwd: path })
}
if (registered) registered.workflow = 'game'
else projects.push({ id: 'game', name: '게임개발팀', path, workflow: 'game' })
atomicJson(config, projects)
console.log(`게임개발팀 등록: ${path}\nHQ 재시작 후 피카츄의 새 요청에서 게임개발팀을 선택하세요. 요청은 아직 시작하지 않았습니다.`)
