import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { ROOT } from './helpers.ts'

test('play restore verifies every original save hash before copying and rejects fixture contamination', () => {
  execFileSync('python3', ['-c', `
import sys
sys.dont_write_bytecode=True
import importlib.util,pathlib,tempfile,json,hashlib
spec=importlib.util.spec_from_file_location('play',${JSON.stringify(join(ROOT, 'tools/game-play/play.py'))})
play=importlib.util.module_from_spec(spec);spec.loader.exec_module(play)
with tempfile.TemporaryDirectory() as temp:
 root=pathlib.Path(temp);source=root/'source';source.mkdir();(source/'session.json').write_text('{}');(source/'save').mkdir()
 slot=source/'save'/'slot1.json';original=b'{"checkpoint":"earned"}';slot.write_bytes(original)
 hashes=root/'hashes.json';hashes.write_text(json.dumps({'slot1.json':hashlib.sha256(original).hexdigest()}))
 receipt=play.restore_save(source,root/'copy',hashes)
 assert (root/'copy'/'slot1.json').read_bytes()==original
 assert receipt['sha256']['slot1.json']==hashlib.sha256(original).hexdigest()
 slot.write_text('{"checkpoint":"fixture"}')
 try:play.restore_save(source,root/'bad',hashes);raise AssertionError('contamination accepted')
 except ValueError as e:assert 'mismatch' in str(e)
 assert not (root/'bad').exists()
 slot.unlink();slot.symlink_to(root/'copy'/'slot1.json')
 try:play.restore_save(source,root/'link',hashes);raise AssertionError('symlink accepted')
 except ValueError:pass
`], { stdio: 'pipe' })
})
