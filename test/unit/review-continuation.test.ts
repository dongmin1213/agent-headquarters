import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { harness, task } from './helpers.ts'
import { gameWaitSignature } from '../../src/game.ts'
import { readReviewHandoff, type Live } from '../../src/exec/runner.ts'

function fixture() {
  const h = harness(); h.runner.stop(); h.projects[0].workflow = 'game'
  const spec = task('A', { department: 'gameplay', acceptance: ['A1','A2','A3'].map(id => ({id,text:id,check:'manual',kind:'new'})) })
  const id = h.plan([spec]); h.store.updateRequest(id, { status:'executing' })
  const tid = `${id}.A`, head = 'a'.repeat(40)
  h.store.insertTask({ id:tid,request_id:id,key:'A',project:'p',title:spec.title,role:'implement',grade:spec.grade,model:spec.model,review_model:'sonnet',spec:JSON.stringify(spec),status:'reviewing',branch:null,base_sha:head })
  h.store.updateTask(tid,{head_sha:head,checks_state:'passed',attempts:3})
  async function finish(n: number, passed: string[], continuation = true) {
    const dir=join(h.dir,`r${n}`), hq=join(dir,'hq');mkdirSync(hq,{recursive:true})
    writeFileSync(join(hq,'stream.jsonl'),[
      {type:'assistant',message:{content:[{type:'tool_use',id:'t1',name:'Bash',input:{command:'npm test'}}]}},
      {type:'user',message:{content:[{type:'tool_result',tool_use_id:'t1',is_error:false,content:'ok'}]}},
    ].map(x=>JSON.stringify(x)).join('\n'))
    const aid=`${tid}~r${n}`
    h.store.insertAttempt({id:aid,task_id:tid,kind:'review',n,model:'sonnet',status:'running',attempt_token:'test',dir,session_id:`s${n}`,generation:0})
    const verdict={pass:!continuation,blocking:[],advisory:[],criteria:spec.acceptance.map(c=>({id:c.id,result:passed.includes(c.id)?'pass':'manual',evidence:'actual observation'})),tests_run:[{command:'npm test',exit_code:0,summary:'executed'}],continuation:continuation?{next_step:'remaining actual play and video'}:null}
    await h.runner.finalizeReview(h.store.attempt(aid)!,{tail:{finalResult:()=>({is_error:false,structured_output:verdict})}} as unknown as Live)
    return aid
  }
  return {h,id,tid,head,finish}
}

test('review checkpoints preserve candidate and work budget, block expansion, then require a complete independent verdict', async()=>{
 const {h,tid,head,finish}=fixture()
 try {
  await finish(1,['A1'])
  assert.equal(h.store.task(tid)!.status,'reviewing')
  assert.equal(h.store.task(tid)!.head_sha,head)
  assert.equal(h.store.task(tid)!.checks_state,'passed')
  assert.equal(h.store.task(tid)!.attempts,3)
  assert.equal(h.store.task(tid)!.model,'sonnet')
  assert.equal(h.store.get(`game.review-continuations:${tid}`),'1')
  const handoff=h.store.get(`game.review-handoff:${tid}`)
  assert.ok(readReviewHandoff(handoff,h.store.task(tid)!))
  assert.equal(readReviewHandoff(handoff,{...h.store.task(tid)!,head_sha:'b'.repeat(40)}),null)
  assert.equal(readReviewHandoff(handoff,{...h.store.task(tid)!,generation:1}),null)
  await finish(2,['A1','A2'])
  assert.equal(h.store.get(`game.review-continuations:${tid}`),'2')
  await finish(3,['A1','A2','A3'],false)
  assert.equal(h.store.task(tid)!.status,'passed')
  assert.equal(h.store.attempts(tid).filter(a=>a.kind==='work').length,0)
 }finally{await h.close()}
})

test('review with no new completed criterion stops instead of consuming another identical review',async()=>{
 const {h,tid,finish}=fixture()
 try {
  await finish(1,['A1']);await finish(2,['A1'])
  assert.equal(h.store.task(tid)!.status,'blocked')
  assert.match(h.store.task(tid)!.note!,/새 완료 항목/)
  assert.equal(h.store.get(`game.review-continuations:${tid}`),'1')
  assert.equal(h.store.task(tid)!.attempts,3)
 }finally{await h.close()}
})

test('operator review-only recovery rejects stale/candidate mismatches and preserves production counters',async()=>{
 const {h,tid,head}=fixture()
 try{
  h.store.updateTask(tid,{status:'blocked'})
  const dir=join(h.dir,'review'),hq=join(dir,'hq');mkdirSync(hq,{recursive:true})
  const aid=`${tid}~r1`
  h.store.insertAttempt({id:aid,task_id:tid,kind:'review',n:1,model:'sonnet',status:'failed',attempt_token:'test',dir,session_id:'s1',generation:0})
  h.store.updateAttempt(aid,{outcome:'blocking'})
  const v={pass:false,head_sha:head,base_sha:head,blocking:[],criteria:[],tests_run:[]}
  writeFileSync(join(hq,'verdict.json'),JSON.stringify(v))
  const sig=()=>gameWaitSignature(h.store,h.store.task(tid)!)
  assert.ok(h.runner.resumeGameReview(tid,aid,'stale','remaining review'))
  writeFileSync(join(hq,'verdict.json'),JSON.stringify({...v,head_sha:'b'.repeat(40)}))
  assert.ok(h.runner.resumeGameReview(tid,aid,sig(),'remaining review'))
  writeFileSync(join(hq,'verdict.json'),JSON.stringify(v))
  assert.equal(h.runner.resumeGameReview(tid,aid,sig(),'operator confirmed reviewer incompletion'),null)
  assert.equal(h.store.task(tid)!.status,'reviewing')
  assert.equal(h.store.task(tid)!.attempts,3)
  assert.equal(h.store.task(tid)!.generation,0)
  assert.equal(h.store.attempt(aid)!.status,'failed')
  assert.ok(h.runner.resumeGameReview(tid,aid,sig(),'duplicate'))
 }finally{await h.close()}
})

test('review continuation lifetime cap is retained even when the next review reports new progress',async()=>{
 const {h,tid,finish}=fixture()
 try {
  h.store.set(`game.review-continuations:${tid}`,'2')
  await finish(1,['A1','A2'])
  assert.equal(h.store.task(tid)!.status,'blocked')
  assert.match(h.store.task(tid)!.note!,/상한 2회/)
  assert.ok(readReviewHandoff(h.store.get(`game.review-handoff:${tid}`),h.store.task(tid)!))
  assert.equal(h.store.task(tid)!.attempts,3)
  assert.equal(h.store.get(`game.review-continuations:${tid}`),'2')
 }finally{await h.close()}
})


test('validator repair replays original evidence once, retains budgets, and rejects forged commands or stale binding', async()=>{
 const {h,tid,head}=fixture()
 try {
  h.store.updateTask(tid,{status:'blocked',review_invalid:2})
  h.store.set(`game.review-continuations:${tid}`,'2')
  const dir=join(h.dir,'bad-review'),hq=join(dir,'hq');mkdirSync(hq,{recursive:true})
  const aid=`${tid}~r5`
  h.store.insertAttempt({id:aid,task_id:tid,kind:'review',n:5,model:'sonnet',status:'unverifiable',attempt_token:'test',dir,session_id:'s5',generation:0})
  h.store.updateAttempt(aid,{outcome:'invalid'})
  const verdict={pass:false,blocking:[],advisory:[],criteria:['A1','A2','A3'].map(id=>({id,result:id==='A1'?'pass':'manual',evidence:'observed or remaining'})),
    tests_run:[{command:'npm test',exit_code:0,summary:'ok'},{command:'bad invocation',exit_code:1,summary:'corrected'}],continuation:{next_step:'finish actual play'}}
  const stream=(raw:unknown)=>writeFileSync(join(hq,'stream.jsonl'),[
   {type:'assistant',message:{content:[{type:'tool_use',id:'ok',name:'Bash',input:{command:'npm test'}},{type:'tool_use',id:'bad',name:'Bash',input:{command:'bad invocation'}}]}},
   {type:'user',message:{content:[{type:'tool_result',tool_use_id:'ok',is_error:false,content:'ok'},{type:'tool_result',tool_use_id:'bad',is_error:true,content:'Exit code 1'}]}},
   {type:'result',is_error:false,structured_output:raw},
  ].map(x=>JSON.stringify(x)).join('\n'))
  const binding=(sha:string)=>writeFileSync(join(hq,'verdict.json'),JSON.stringify({...verdict,head_sha:sha,base_sha:head,invalid:'old validator'}))
  const recover=()=>h.runner.recoverInvalidGameReview(tid,aid,gameWaitSignature(h.store,h.store.task(tid)!), 'fixed validator; use current checkout')
  stream(verdict);binding('b'.repeat(40));assert.ok(recover())
  binding(head);stream({...verdict,tests_run:[{command:'never executed',exit_code:0,summary:'fake'}]});assert.ok(recover())
  stream(verdict);assert.equal(recover(),null)
  assert.equal(h.store.task(tid)!.status,'reviewing')
  assert.equal(h.store.task(tid)!.attempts,3)
  assert.equal(h.store.task(tid)!.review_invalid,2)
  assert.equal(h.store.get(`game.review-continuations:${tid}`),'2')
  assert.equal(h.store.attempt(aid)!.outcome,'invalid')
  assert.ok(readReviewHandoff(h.store.get(`game.review-handoff:${tid}`),h.store.task(tid)!))
  h.store.updateTask(tid,{status:'blocked'});assert.ok(recover(),'cannot reuse repair budget')
 }finally{await h.close()}
})


test('operator handoff counts as prior progress instead of earning another identical checkpoint',async()=>{
 const {h,tid,head,finish}=fixture()
 try {
  h.store.set(`game.review-handoff:${tid}`,JSON.stringify({head,generation:0,operatorConfirmed:true,verdict:{criteria:[{id:'A1',result:'pass'}]}}))
  await finish(1,['A1'])
  assert.equal(h.store.task(tid)!.status,'blocked')
  assert.match(h.store.task(tid)!.note!,/새 완료 항목/)
  assert.equal(h.store.get(`game.review-continuations:${tid}`),null)
  const latest=JSON.parse(h.store.get(`game.review-handoff:${tid}`)!)
  assert.equal(latest.review,`${tid}~r1`,'latest evidence survives a no-progress stop')
 }finally{await h.close()}
})
