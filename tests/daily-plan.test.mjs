import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { boardAction } from '../lib/board.js';

async function isolated(fn) {
  const home = await mkdtemp(join(tmpdir(), 'daily-plan-'));
  const old = process.env.DSH_HOME; process.env.DSH_HOME = home;
  const root = join(home, 'library');
  const service = new StudyService(root);
  try {
    await service.store.update(s => {
      s.decks.push({ id: 'deck', title: 'Probability', course: 'Math', cards: Array.from({length: 7}, (_, i) => ({
        id: `q${i}`, kind: 'flashcard', topic: 'Conditional probability', prompt: `Question ${i}`, answer: 'Answer',
        options: [], citations: [], requires: [], review: {repetitions: 0, interval_days: 0, ease_factor: 2.5, due_at: null},
      })) });
      s.sources.push({ id: 'source', title: 'Lecture', text: 'Probability notes', courses: ['Math'] });
    });
    await fn(service, root);
  } finally { await service.dispose(); if (old === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = old; await rm(home, {recursive:true,force:true}); }
}
const date = '2026-10-05';

test('daily suggestions are persisted, bounded and create board tasks only after idempotent acceptance', () => isolated(async (service, root) => {
  assert.equal((await service.call('daily.plan.get', {date})).proposal, null);
  const draft = await service.call('daily.plan.suggest', {date, minutes: 20});
  assert.equal(draft.proposal.method, 'local');
  assert.ok(draft.proposal.items.length);
  assert.ok(draft.proposal.items.reduce((n,x) => n+x.minutes,0) <= 20);
  assert.equal(Object.keys((await boardAction('board.get')).cards).length, 0);
  assert.equal((await new StudyService(root).call('daily.plan.get', {date})).proposal.id, draft.proposal.id);
  const results = await Promise.all([1,2,3].map(() => service.call('daily.plan.accept', {date,proposalId:draft.proposal.id})));
  assert.ok(results.every(x => x.tasks.length === draft.proposal.items.length));
  assert.equal(Object.keys((await boardAction('board.get')).cards).length, draft.proposal.items.length);
  assert.equal((await service.call('daily.plan.get', {date:'2026-10-06'})).budgetMinutes, 40);
}));

test('AI chooses only real candidates; budgets and links are owned by the server', () => isolated(async (service) => {
  service.light = async (_system,prompt) => { const context=JSON.parse(prompt); return JSON.stringify({items:[{candidateId:context.candidates[0].candidateId,reason:'巩固已有内容',minutes:999,studyRef:{root:'other'}}],summary:'先巩固再阅读'}); };
  const plan=await service.call('daily.plan.suggest',{date,minutes:10});
  assert.equal(plan.proposal.method,'ai');
  assert.equal(plan.proposal.items[0].minutes,10);
  assert.equal(plan.proposal.items[0].studyRef.kind,'deck');
  const accepted=await service.call('daily.plan.accept',{date,proposalId:plan.proposal.id});
  assert.equal(accepted.tasks.length,1);
  assert.equal(accepted.tasks[0].reason,'巩固已有内容');
}));

test('invalid or failed AI yields a labelled local proposal without creating tasks', () => isolated(async service => {
  for (const response of ['bad JSON',JSON.stringify({items:[{candidateId:'invented'}]}),null]) {
    service.light=async()=>{if(response===null) throw new Error('offline'); return response;};
    const plan=await service.call('daily.plan.suggest',{date,minutes:20,feedback:'今天少一点'});
    assert.equal(plan.proposal.method,'local');
    assert.ok(plan.proposal.warnings.some(warning=>warning.includes('本地建议')));
    assert.equal(Object.keys((await boardAction('board.get')).cards).length,0);
  }
}));

test('temporary feedback and rest days never rewrite explicit weekday/weekend habits', () => isolated(async (service,root) => {
  await service.call('daily.plan.profile',{date,weekdayMinutes:30,weekendMinutes:45});
  service.light=async(_system,prompt)=>{const context=JSON.parse(prompt);return JSON.stringify({todayMinutes:15,items:context.candidates.map(candidate=>({candidateId:candidate.candidateId}))});};
  const proposal=await service.call('daily.plan.suggest',{date,feedback:'今天只有15分钟'});
  assert.equal(proposal.budgetMinutes,15);
  assert.equal(proposal.profile.weekdayMinutes,30);
  assert.equal((await new StudyService(root).call('daily.plan.get',{date:'2026-10-10'})).budgetMinutes,45);
  const rest=await service.call('daily.plan.suggest',{date:'2026-10-06',minutes:0});
  assert.deepEqual(rest.proposal.items,[]);
  assert.deepEqual((await service.call('daily.plan.accept',{date:'2026-10-06',proposalId:rest.proposal.id})).tasks,[]);
  assert.equal((await service.call('daily.plan.get',{date:'2026-10-07'})).budgetMinutes,30);
}));

test('start resumes an exact task run and answering drives progress without closing ordinary reviews', () => isolated(async service => {
  const ordinary=await service.call('review.start',{mode:'path',scope:[{deckId:'deck',cardId:'q0'}]});
  const proposal=await service.call('daily.plan.suggest',{date,minutes:10});
  const accepted=await service.call('daily.plan.accept',{date,proposalId:proposal.proposal.id});
  const taskId=accepted.tasks[0].id;
  let started=await service.call('daily.plan.start',{date,taskId});
  assert.equal(started.run.total,5);
  assert.equal((await service.call('daily.plan.start',{date,taskId})).run.id,started.run.id);
  assert.equal((await service.call('review.get',{runId:ordinary.id})).closed,false);
  assert.equal((await service.call('daily.plan.get',{date})).tasks[0].progress.done,0);
  await assert.rejects(service.call('daily.plan.complete',{date,taskId}),/实际完成/);
  for(let i=0;i<5;i++) {
    let run=await service.call('review.get',{runId:started.run.id});
    await service.call('review.reveal',{runId:run.id,cardId:run.card.id});
    await service.call('review.answer',{runId:run.id,cardId:run.card.id,grade:4});
    if(i<4) await service.call('review.move',{runId:run.id,direction:1});
  }
  const final=await service.call('daily.plan.get',{date});
  assert.deepEqual(final.tasks[0].progress,{done:5,total:5});
  assert.equal(final.tasks[0].status,'done');
  assert.ok((await boardAction('board.get')).columns.find(column=>column.done).cardIds.includes(taskId));
}));

test('navigating and ending a run do not complete the task; reopening resumes unanswered content', () => isolated(async service => {
  const proposal=await service.call('daily.plan.suggest',{date,minutes:10});
  const accepted=await service.call('daily.plan.accept',{date,proposalId:proposal.proposal.id});
  const taskId=accepted.tasks[0].id;
  const {run}=await service.call('daily.plan.start',{date,taskId});
  await service.call('review.move',{runId:run.id,index:1});
  await service.call('review.end',{runId:run.id});
  assert.equal((await service.call('daily.plan.get',{date})).tasks[0].progress.done,0);
  const reopened=await service.call('daily.plan.start',{date,taskId});
  assert.equal(reopened.run.id,run.id);
  assert.equal(reopened.run.closed,false);
}));

test('reading records explicit completion and actual minutes; completed work consumes replanning budget', () => isolated(async service => {
  service.light=async(_system,prompt)=>JSON.stringify({items:JSON.parse(prompt).candidates.filter(candidate=>candidate.kind==='reading').map(candidate=>({candidateId:candidate.candidateId}))});
  const proposed=await service.call('daily.plan.suggest',{date,minutes:20});
  const accepted=await service.call('daily.plan.accept',{date,proposalId:proposed.proposal.id});
  const taskId=accepted.tasks[0].id;
  const reading=await service.call('daily.plan.start',{date,taskId});
  assert.equal(reading.studyRef.id,'source');
  assert.equal(reading.run,undefined);
  assert.equal(reading.task.progress.done,0);
  const done=await service.call('daily.plan.complete',{date,taskId,minutes:12});
  assert.equal(done.tasks[0].actualMinutes,12);
  assert.deepEqual(done.tasks[0].progress,{done:1,total:1});
  service.light=undefined;
  const next=await service.call('daily.plan.suggest',{date});
  assert.ok(next.proposal.items.reduce((sum,item)=>sum+item.minutes,0)<=8);
  await assert.rejects(service.call('daily.plan.complete',{date,taskId,minutes:999}),/分钟/);
  const rest=await service.call('daily.plan.suggest',{date,minutes:0});
  const stopped=await service.call('daily.plan.accept',{date,proposalId:rest.proposal.id});
  assert.equal(stopped.tasks.length,1,'rest preserves already completed work without scheduling more');
  assert.equal(stopped.tasks[0].status,'done');
}));

test('carryover stays bounded, reacceptance reuses tasks and removed tasks are never resurrected', () => isolated(async service => {
  const proposed=await service.call('daily.plan.suggest',{date,minutes:20});
  const accepted=await service.call('daily.plan.accept',{date,proposalId:proposed.proposal.id});
  const initialIds=accepted.tasks.map(task=>task.id);
  const tomorrow='2026-10-06';
  const revised=await service.call('daily.plan.suggest',{date:tomorrow,minutes:10});
  assert.ok(revised.proposal.items.reduce((sum,item)=>sum+item.minutes,0)<=10);
  const continued=await service.call('daily.plan.accept',{date:tomorrow,proposalId:revised.proposal.id});
  assert.ok(continued.tasks.every(task=>initialIds.includes(task.id)));
  assert.equal(Object.keys((await boardAction('board.get')).cards).length,initialIds.length);
  const again=await service.call('daily.plan.suggest',{date:tomorrow,minutes:10});
  const board=await boardAction('board.get');
  await boardAction('board.card.archive',{revision:board.revision,id:again.proposal.items[0].taskId});
  await assert.rejects(service.call('daily.plan.accept',{date:tomorrow,proposalId:again.proposal.id}),/删除|归档/);
  assert.equal((await boardAction('board.get')).archived.length,1);
}));

test('stale proposals and stale content fail without partial acceptance', () => isolated(async service => {
  const old=await service.call('daily.plan.suggest',{date,minutes:20});
  const next=await service.call('daily.plan.suggest',{date,minutes:10,proposalId:old.proposal.id});
  await assert.rejects(service.call('daily.plan.accept',{date,proposalId:old.proposal.id}),/更新/);
  await service.store.update(state=>{state.decks[0].cards=state.decks[0].cards.filter(card=>card.id!=='q0');});
  await assert.rejects(service.call('daily.plan.accept',{date,proposalId:next.proposal.id}),/删除|归档/);
  assert.equal(Object.keys((await boardAction('board.get')).cards).length,0);
}));

test('empty, archived and parked learning libraries produce no invented actions', () => isolated(async service => {
  await service.store.update(state=>{state.decks[0].archived=true;state.sources[0].archived=true;});
  assert.deepEqual((await service.call('daily.plan.suggest',{date})).proposal.items,[]);
  await service.store.update(state=>{delete state.decks[0].archived;delete state.sources[0].archived;state.courses.find(course=>course.name==='Math').active=false;});
  assert.deepEqual((await service.call('daily.plan.suggest',{date})).proposal.items,[]);
}));

test('date and library boundaries keep consent and links local', () => isolated(async(service,root)=> {
  for(const value of ['2026-02-30','2026-2-3','',undefined]) await assert.rejects(service.call('daily.plan.get',{date:value}),/日期/);
  const plan=await service.call('daily.plan.suggest',{date:'2026-10-04',minutes:10});
  assert.equal((await service.call('daily.plan.get',{date:'2026-10-05'})).proposal,null);
  const other=new StudyService(join(root,'other'));
  try {
    assert.equal((await other.call('daily.plan.get',{date:'2026-10-04'})).proposal,null);
    await assert.rejects(other.call('daily.plan.accept',{date:'2026-10-04',proposalId:plan.proposal.id}),/建议/);
  } finally {await other.dispose();}
}));

test('small budgets produce real smaller practice blocks', () => isolated(async service=> {
  const proposed=await service.call('daily.plan.suggest',{date,minutes:5});
  assert.ok(proposed.proposal.items.length);
  assert.ok(proposed.proposal.items.reduce((sum,item)=>sum+item.minutes,0)<=5);
  const accepted=await service.call('daily.plan.accept',{date,proposalId:proposed.proposal.id});
  assert.deepEqual(accepted.tasks[0].progress,{done:0,total:2});
  assert.equal((await service.call('daily.plan.start',{date,taskId:accepted.tasks[0].id})).run.total,2);
}));

test('partly answered carryover uses the remaining estimate instead of a fresh full workload', () => isolated(async service=> {
  const proposed=await service.call('daily.plan.suggest',{date,minutes:10});
  const accepted=await service.call('daily.plan.accept',{date,proposalId:proposed.proposal.id});
  const taskId=accepted.tasks[0].id;
  const {run}=await service.call('daily.plan.start',{date,taskId});
  await service.call('review.reveal',{runId:run.id,cardId:run.card.id});
  await service.call('review.answer',{runId:run.id,cardId:run.card.id,grade:4});
  const tomorrow='2026-10-06';
  const carried=await service.call('daily.plan.suggest',{date:tomorrow,minutes:8});
  assert.equal(carried.proposal.items[0].taskId,taskId);
  assert.equal(carried.proposal.items[0].minutes,8);
  const again=await service.call('daily.plan.accept',{date:tomorrow,proposalId:carried.proposal.id});
  assert.equal(again.tasks[0].id,taskId);
  assert.equal(again.tasks[0].minutes,8);
  assert.equal(again.tasks[0].progress.done,1);
}));

test('editing a suggested question invalidates acceptance even when its ID stays the same', () => isolated(async service=> {
  const proposed=await service.call('daily.plan.suggest',{date,minutes:10});
  await service.store.update(state=>{state.decks[0].cards[0].answer='Updated answer';});
  await assert.rejects(service.call('daily.plan.accept',{date,proposalId:proposed.proposal.id}),/内容已更新/);
  assert.equal(Object.keys((await boardAction('board.get')).cards).length,0);
}));

test('slow competing suggestions cannot overwrite a newer accepted plan', () => isolated(async service=> {
  let finish,entered;
  const started=new Promise(resolve=>{entered=resolve;});
  service.light=async(_system,prompt)=> {const context=JSON.parse(prompt);entered();await new Promise(resolve=>{finish=resolve;});return JSON.stringify({items:[{candidateId:context.candidates[0].candidateId}]});};
  const pending=service.call('daily.plan.suggest',{date,minutes:10});
  await started;
  service.light=undefined;
  const local=await service.call('daily.plan.suggest',{date,minutes:10});
  await service.call('daily.plan.accept',{date,proposalId:local.proposal.id});
  finish();
  await assert.rejects(pending,/安排已更新/);
  assert.equal((await service.call('daily.plan.get',{date})).tasks.length,1);
}));

test('English local suggestions and AI request include saved exam dates', () => isolated(async service=> {
  service.language='en';
  let proposed=await service.call('daily.plan.suggest',{date,minutes:20});
  assert.match(proposed.proposal.items[0].title,/Learn Probability/);
  assert.match(proposed.proposal.items[0].reason,/Build a foundation/);
  assert.match(proposed.proposal.warnings[0],/local suggestion/);
  await service.store.update(state=>{state.courses.find(course=>course.name==='Math').exam={format:'quiz',date:'2026-10-07'};});
  let modelContext;
  service.light=async(_system,prompt)=>{modelContext=JSON.parse(prompt);return JSON.stringify({items:[]});};
  await service.call('daily.plan.suggest',{date,minutes:20});
  assert.ok(modelContext.candidates.some(candidate=>candidate.examDate==='2026-10-07'));
}));

test('habit inference waits for five actual completion days and explicit preferences always win', () => isolated(async service=> {
  service.light=async(_system,prompt)=>JSON.stringify({items:JSON.parse(prompt).candidates.filter(candidate=>candidate.kind==='reading').map(candidate=>({candidateId:candidate.candidateId}))});
  for(const day of ['2026-10-05','2026-10-06','2026-10-07','2026-10-08','2026-10-09']) {
    const proposed=await service.call('daily.plan.suggest',{date:day});
    const accepted=await service.call('daily.plan.accept',{date:day,proposalId:proposed.proposal.id});
    await service.call('daily.plan.complete',{date:day,taskId:accepted.tasks[0].id,minutes:20});
  }
  const observed=await service.call('daily.plan.get',{date:'2026-10-12'});
  assert.equal(observed.profile.sampleDays,5);
  assert.equal(observed.profile.observedWeekdayMinutes,20);
  assert.equal(observed.budgetBasis,'habit');
  assert.equal(observed.budgetMinutes,20,'five comparable actual days establish the inferred median');
  assert.equal(observed.profile.source,'inferred');
  const explicit=await service.call('daily.plan.profile',{date:'2026-10-12',weekdayMinutes:35,weekendMinutes:50});
  assert.equal(explicit.budgetMinutes,35);
  assert.equal(explicit.budgetBasis,'profile');
}));

test('carryover reading completion contributes only its real completion day to habits', () => isolated(async service=> {
  service.light=async(_system,prompt)=>JSON.stringify({items:JSON.parse(prompt).candidates.filter(candidate=>candidate.kind==='reading').map(candidate=>({candidateId:candidate.candidateId}))});
  const first=await service.call('daily.plan.suggest',{date,minutes:10});
  const accepted=await service.call('daily.plan.accept',{date,proposalId:first.proposal.id});
  const tomorrow='2026-10-06';
  const second=await service.call('daily.plan.suggest',{date:tomorrow,minutes:10});
  await service.call('daily.plan.accept',{date:tomorrow,proposalId:second.proposal.id});
  const finished=await service.call('daily.plan.complete',{date:tomorrow,taskId:accepted.tasks[0].id,minutes:10});
  assert.equal(finished.profile.sampleDays,1);
}));

test('existing learning flows link to real sessions and derive completed steps', () => isolated(async service=> {
  await service.store.update(state=>state.workflowSessions.push({id:'flow',topic:'Probability recap',status:'active',version:1,currentStepId:'a',template:{steps:[{id:'a',kind:'reading'},{id:'b',kind:'reflection'}]},records:{},scope:[{deckId:'deck'}]}));
  service.light=async(_system,prompt)=>JSON.stringify({items:JSON.parse(prompt).candidates.filter(candidate=>candidate.kind==='workflow').map(candidate=>({candidateId:candidate.candidateId}))});
  const proposed=await service.call('daily.plan.suggest',{date,minutes:20});
  const accepted=await service.call('daily.plan.accept',{date,proposalId:proposed.proposal.id});
  const taskId=accepted.tasks[0].id;
  assert.equal((await service.call('daily.plan.start',{date,taskId})).studyRef.sessionId,'flow');
  await assert.rejects(service.call('daily.plan.complete',{date,taskId}),/实际完成/);
  await service.store.update(state=>{state.workflowSessions[0].records.a={outcome:'done'};});
  assert.deepEqual((await service.call('daily.plan.get',{date})).tasks[0].progress,{done:1,total:2});
  await service.store.update(state=>{state.workflowSessions[0].status='completed';});
  assert.equal((await service.call('daily.plan.get',{date})).tasks[0].status,'done');
}));

test('AI sees feasible candidate counts before proposing a small budget', () => isolated(async service=> {
  let context;
  service.light=async(_system,prompt)=>{context=JSON.parse(prompt);return JSON.stringify({items:[{candidateId:context.candidates[0].candidateId}]});};
  const proposed=await service.call('daily.plan.suggest',{date,minutes:5,feedback:'优先练习'});
  assert.ok(context.candidates.every(candidate=>candidate.minutes<=5));
  assert.equal(context.candidates[0].progress.total,2);
  assert.equal(proposed.proposal.method,'ai');
  assert.ok(proposed.proposal.items.length);
}));

test('acceptance rechecks actual completed time changed since the proposal', () => isolated(async service=> {
  service.light=async(_system,prompt)=>JSON.stringify({items:JSON.parse(prompt).candidates.filter(candidate=>candidate.kind==='reading').map(candidate=>({candidateId:candidate.candidateId}))});
  const original=await service.call('daily.plan.suggest',{date,minutes:20});
  const accepted=await service.call('daily.plan.accept',{date,proposalId:original.proposal.id});
  const taskId=accepted.tasks[0].id;
  service.light=async(_system,prompt)=>JSON.stringify({items:JSON.parse(prompt).candidates.filter(candidate=>candidate.kind==='practice').map(candidate=>({candidateId:candidate.candidateId}))});
  const replacement=await service.call('daily.plan.suggest',{date,minutes:20});
  await service.call('daily.plan.complete',{date,taskId,minutes:15});
  await assert.rejects(service.call('daily.plan.accept',{date,proposalId:replacement.proposal.id}),/用时已更新/);
  assert.equal(Object.keys((await boardAction('board.get')).cards).length,1);
}));

test('revision feedback survives reload and retains earlier exclusions', () => isolated(async(service,root)=> {
  const contexts=[];
  const model=async(_system,prompt)=>{const context=JSON.parse(prompt);contexts.push(context);return JSON.stringify({items:context.candidates.filter(candidate=>candidate.kind==='practice').map(candidate=>({candidateId:candidate.candidateId}))});};
  service.light=model;
  const first=await service.call('daily.plan.suggest',{date,feedback:'不要阅读'});
  const restored=new StudyService(root,{light:model});
  try {
    await restored.call('daily.plan.suggest',{date,proposalId:first.proposal.id,feedback:'今天20分钟'});
    assert.deepEqual(contexts[1].feedbackHistory,['不要阅读','今天20分钟']);
    assert.equal(contexts[1].feedback,'今天20分钟');
  } finally {await restored.dispose();}
}));

test('practice completion ignores the board done column and acceptance retries do not write', () => isolated(async service=> {
  const suggested=await service.call('daily.plan.suggest',{date,minutes:10});
  const accepted=await service.call('daily.plan.accept',{date,proposalId:suggested.proposal.id});
  let board=await boardAction('board.get');
  const revision=board.revision;
  await Promise.all([1,2,3].map(()=>service.call('daily.plan.accept',{date,proposalId:suggested.proposal.id})));
  assert.equal((await boardAction('board.get')).revision,revision);
  board=await boardAction('board.get');
  await boardAction('board.card.move',{revision:board.revision,id:accepted.tasks[0].id,column:'done'});
  assert.equal((await service.call('daily.plan.get',{date})).tasks[0].status,'todo');
  assert.ok((await service.call('daily.plan.suggest',{date,minutes:10})).proposal.items.some(item=>item.taskId===accepted.tasks[0].id));
}));

test('same-day partial progress reduces remaining budget and survives archive and delete', () => isolated(async service=> {
  const suggested=await service.call('daily.plan.suggest',{date,minutes:10});
  const accepted=await service.call('daily.plan.accept',{date,proposalId:suggested.proposal.id});
  const taskId=accepted.tasks[0].id;
  const {run}=await service.call('daily.plan.start',{date,taskId});
  await service.call('review.reveal',{runId:run.id,cardId:run.card.id});
  await service.call('review.answer',{runId:run.id,cardId:run.card.id,grade:4});
  const revised=await service.call('daily.plan.suggest',{date,minutes:10});
  assert.equal(revised.spentMinutes,2);
  assert.ok(revised.proposal.items.reduce((sum,item)=>sum+item.minutes,0)<=8);
  const board=await boardAction('board.get');
  await boardAction('board.card.archive',{revision:board.revision,id:taskId});
  let after=await service.call('daily.plan.suggest',{date,minutes:10});
  assert.equal(after.spentMinutes,2);
  await boardAction('board.card.remove',{revision:(await boardAction('board.get')).revision,id:taskId});
  after=await service.call('daily.plan.suggest',{date,minutes:10});
  assert.equal(after.spentMinutes,2);
  assert.ok(after.proposal.items.reduce((sum,item)=>sum+item.minutes,0)<=8);
}));

test('archived and deleted completed work retains budget and timed habit history', () => isolated(async service=> {
  service.light=async(_s,prompt)=>JSON.stringify({items:JSON.parse(prompt).candidates.filter(item=>item.kind==='reading').map(item=>({candidateId:item.candidateId}))});
  const suggestion=await service.call('daily.plan.suggest',{date,minutes:20});
  const accepted=await service.call('daily.plan.accept',{date,proposalId:suggestion.proposal.id});
  const taskId=accepted.tasks[0].id;
  await service.call('daily.plan.complete',{date,taskId,minutes:12});
  let board=await boardAction('board.get');
  await boardAction('board.card.archive',{revision:board.revision,id:taskId});
  let state=await service.call('daily.plan.get',{date});
  assert.equal(state.spentMinutes,12);
  assert.equal(state.profile.sampleDays,1);
  assert.equal(state.tasks[0].id,taskId);
  await boardAction('board.card.remove',{revision:(await boardAction('board.get')).revision,id:taskId});
  state=await service.call('daily.plan.get',{date});
  assert.equal(state.spentMinutes,12);
  assert.equal(state.profile.sampleDays,1);
  const revised=await service.call('daily.plan.suggest',{date,minutes:20});
  assert.ok(revised.proposal.items.reduce((sum,item)=>sum+item.minutes,0)<=8);
  const final=await service.call('daily.plan.accept',{date,proposalId:revised.proposal.id});
  assert.ok(final.tasks.some(task=>task.id===taskId && task.status==='done'));
}));

test('natural feedback raising time exposes longer candidates before final fitting', () => isolated(async service=> {
  await service.call('daily.plan.suggest',{date,minutes:5});
  service.light=async(_s,prompt)=>{
    const context=JSON.parse(prompt);
    assert.ok(context.candidates.some(item=>item.minutes===10));
    return JSON.stringify({todayMinutes:20,items:context.candidates.map(item=>({candidateId:item.candidateId}))});
  };
  const next=await service.call('daily.plan.suggest',{date,feedback:'今天可以学20分钟'});
  assert.equal(next.budgetMinutes,20);
  assert.equal(next.proposal.method,'ai');
  assert.ok(next.proposal.items.some(item=>item.kind==='practice' && item.progress.total===5));
  assert.ok(next.proposal.items.reduce((sum,item)=>sum+item.minutes,0)<=20);
}));

test('tomorrow freezes previous effort and charges only newly answered remaining work', () => isolated(async service=> {
  const first=await service.call('daily.plan.suggest',{date,minutes:10});
  const accepted=await service.call('daily.plan.accept',{date,proposalId:first.proposal.id});
  const taskId=accepted.tasks[0].id;
  let {run}=await service.call('daily.plan.start',{date,taskId});
  await service.call('review.reveal',{runId:run.id,cardId:run.card.id});
  await service.call('review.answer',{runId:run.id,cardId:run.card.id,grade:4});
  const tomorrow='2026-10-06';
  const next=await service.call('daily.plan.suggest',{date:tomorrow,minutes:10});
  assert.equal(next.spentMinutes,0);
  await service.call('daily.plan.accept',{date:tomorrow,proposalId:next.proposal.id});
  await service.call('review.move',{runId:run.id,direction:1});
  run=await service.call('review.get',{runId:run.id});
  await service.call('review.reveal',{runId:run.id,cardId:run.card.id});
  await service.call('review.answer',{runId:run.id,cardId:run.card.id,grade:4});
  assert.equal((await service.call('daily.plan.get',{date:tomorrow})).spentMinutes,2);
  assert.equal((await service.call('daily.plan.get',{date})).spentMinutes,2);
}));

test('restored slain questions rejoin exact daily queue while prior answers persist', () => isolated(async service=> {
  const suggestion=await service.call('daily.plan.suggest',{date,minutes:10});
  const accepted=await service.call('daily.plan.accept',{date,proposalId:suggestion.proposal.id});
  const taskId=accepted.tasks[0].id;
  const {run}=await service.call('daily.plan.start',{date,taskId});
  await service.call('review.reveal',{runId:run.id,cardId:run.card.id});
  await service.call('review.answer',{runId:run.id,cardId:run.card.id,grade:4});
  const slain=await service.call('card.slay',{deckId:'deck',cardId:'q1'});
  await service.call('review.end',{runId:run.id});
  await service.call('card.restore',{deckId:slain.deckId,cardId:'q1'});
  const resumed=await service.call('daily.plan.start',{date,taskId});
  assert.equal(resumed.run.id,run.id);
  assert.equal(resumed.run.total,5);
  assert.equal(resumed.run.answered,1);
  assert.equal(resumed.run.card.id,'q1');
  const state=await service.call('export');
  assert.deepEqual(state.runs.find(item=>item.id===run.id).entries.filter(entry=>!entry.retry).map(entry=>entry.card.id),['q0','q1','q2','q3','q4']);
}));

test('varied actual days use a robust median even after archive or delete', () => isolated(async service=> {
  service.light=async(_s,prompt)=>JSON.stringify({items:JSON.parse(prompt).candidates.filter(item=>item.kind==='reading').map(item=>({candidateId:item.candidateId}))});
  for (const [index,actual] of [20,25,30,35,200].entries()) {
    const day=`2026-10-0${index+5}`;
    const suggestion=await service.call('daily.plan.suggest',{date:day});
    const accepted=await service.call('daily.plan.accept',{date:day,proposalId:suggestion.proposal.id});
    const taskId=accepted.tasks[0].id;
    await service.call('daily.plan.complete',{date:day,taskId,minutes:actual});
    const board=await boardAction('board.get');
    await boardAction(index%2?'board.card.archive':'board.card.remove',{revision:board.revision,id:taskId});
  }
  const next=await service.call('daily.plan.get',{date:'2026-10-12'});
  assert.equal(next.profile.sampleDays,5);
  assert.equal(next.profile.observedWeekdayMinutes,30);
  assert.equal(next.budgetMinutes,30);
}));

test('positive tiny observed habits are never converted into a rest day', () => isolated(async service=> {
  service.light=async(_s,prompt)=>JSON.stringify({items:JSON.parse(prompt).candidates.filter(item=>item.kind==='reading').map(item=>({candidateId:item.candidateId}))});
  for (let index=0;index<5;index++) {
    const day=`2026-10-0${index+5}`;
    const suggestion=await service.call('daily.plan.suggest',{date:day});
    const accepted=await service.call('daily.plan.accept',{date:day,proposalId:suggestion.proposal.id});
    await service.call('daily.plan.complete',{date:day,taskId:accepted.tasks[0].id,minutes:1});
  }
  assert.equal((await service.call('daily.plan.get',{date:'2026-10-12'})).budgetMinutes,1);
}));

test('partly completed workflow replanning retains its ten-minute remaining step', () => isolated(async service=> {
  await service.store.update(state=>state.workflowSessions.push({id:'flow',topic:'Recap',status:'active',version:1,currentStepId:'a',template:{steps:[{id:'a',kind:'reading'},{id:'b',kind:'reflection'}]},records:{},scope:[{deckId:'deck'}]}));
  service.light=async(_s,prompt)=>JSON.stringify({items:JSON.parse(prompt).candidates.filter(item=>item.kind==='workflow').map(item=>({candidateId:item.candidateId}))});
  const suggestion=await service.call('daily.plan.suggest',{date,minutes:20});
  const accepted=await service.call('daily.plan.accept',{date,proposalId:suggestion.proposal.id});
  await service.store.update(state=>{state.workflowSessions[0].records.a={outcome:'done'};});
  const revised=await service.call('daily.plan.suggest',{date,minutes:20});
  assert.equal(revised.spentMinutes,10);
  assert.equal(revised.proposal.items.length,1);
  assert.equal(revised.proposal.items[0].taskId,accepted.tasks[0].id);
  assert.equal(revised.proposal.items[0].minutes,10);
  await service.call('daily.plan.accept',{date,proposalId:revised.proposal.id});
  await service.store.update(state=>{state.workflowSessions[0].records.b={outcome:'done'};state.workflowSessions[0].status='completed';});
  assert.equal((await service.call('daily.plan.get',{date})).spentMinutes,20);
}));

test('a new workflow task with an already completed step charges the remaining allocated ten minutes', () => isolated(async service=> {
  await service.store.update(state=>state.workflowSessions.push({id:'flow',topic:'Recap',status:'active',version:1,currentStepId:'b',template:{steps:[{id:'a',kind:'reading'},{id:'b',kind:'reflection'}]},records:{a:{outcome:'done'}},scope:[{deckId:'deck'}]}));
  service.light=async(_s,prompt)=>JSON.stringify({items:JSON.parse(prompt).candidates.filter(item=>item.kind==='workflow').map(item=>({candidateId:item.candidateId}))});
  const suggestion=await service.call('daily.plan.suggest',{date,minutes:10});
  assert.equal(suggestion.proposal.items[0].minutes,10);
  const accepted=await service.call('daily.plan.accept',{date,proposalId:suggestion.proposal.id});
  assert.equal(accepted.spentMinutes,0);
  await service.store.update(state=>{state.workflowSessions[0].records.b={outcome:'done'};state.workflowSessions[0].status='completed';});
  const finished=await service.call('daily.plan.get',{date});
  assert.equal(finished.spentMinutes,10);
}));
