import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash as nodeHash } from 'node:crypto';
import { StudyService } from '../lib/service.js';
import { languageSystem } from '../lib/language.js';
import { createHash } from '../web-demo/crypto.js';
import { demoModel } from '../web-demo/model.js';
import { source, sampleCards } from '../web-demo/content.js';

test('request languages isolate model prompts and suggestion caches without translating existing cards', async t => {
  const root = await mkdtemp(join(tmpdir(), 'study-language-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const prompts=[];
  const service=new StudyService(root,{completeLight:async (system,prompt)=>{
    prompts.push({system,prompt});
    await new Promise(resolve=>setTimeout(resolve, 5));
    return JSON.stringify({questions:system.includes('preference: English') ? ['Who owns state?','Who stores history?','Why keep snapshots opaque?'] : ['谁拥有状态？','谁管理历史？','为何隐藏快照内容？']});
  }});
  await service.call('source.add',source);
  await service.call('draft.save',{deck:{id:'language-test',title:'题目保持原样',cards:[sampleCards[0]]}});
  await service.call('draft.publish',{id:'language-test'});
  const ref={deckId:'language-test',cardId:sampleCards[0].id};
  const before=(await service.call('card.get',ref)).card;
  const [en,zh]=await Promise.all(['en','zh'].map(uiLanguage=>service.call('card.followup.suggest',{...ref,uiLanguage})));
  assert.equal(en.questions[0],'Who owns state?');assert.equal(zh.questions[0],'谁拥有状态？');
  assert.equal(prompts.length,2);
  const again=await service.call('card.followup.suggest',{...ref,uiLanguage:'en'});
  assert.equal(again.questions[0],en.questions[0]);
  const after=(await service.call('card.get',{...ref,uiLanguage:'zh'})).card;
  for(const key of ['prompt','answer','options','explanation','citations','review'])assert.deepEqual(after[key],before[key]);
  assert.equal(service.language,undefined);
  await assert.rejects(service.call('snapshot',{uiLanguage:'fr'}),/Unsupported/);
  const listing=await service.call('workflow.list',{uiLanguage:'en'});
  assert.equal(listing.suggested.steps[0].title,'Set a goal');
  assert.equal((await service.call('workflow.list',{uiLanguage:'zh'})).suggested.steps[0].title,'明确目标');
});
test('language guidance preserves explicit content-language choice and leaves legacy prompts unchanged',()=>{
  const original='You are a careful Chinese tutor writing a lesson.';
  assert.equal(languageSystem(original),original);
  const en=languageSystem(original,'en');
  assert.match(en,/Application language preference: English/);
  assert.match(en,/explicit requested content language independently/);
  assert.match(en,/Do not translate or rewrite existing question/);
});
test('browser SHA-256 matches Node across Unicode and block boundaries',()=>{
  for(const value of ['', 'abc', '中文🙂\n', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(64), '学习'.repeat(300)])
    assert.equal(createHash('sha256').update(value).digest('hex'),nodeHash('sha256').update(value).digest('hex'));
});
test('demo lessons and retelling feedback are bilingual, disclosed and do not pretend to assess mastery',async()=>{
  for(const language of ['en','zh']){
    const lesson=JSON.parse(await demoModel(languageSystem('You are a careful Chinese tutor writing a lesson',language),JSON.stringify({evidence:[{sourceId:source.id,text:source.text}]})));
    assert.ok(lesson.markdown.length>=600);assert.ok(source.text.includes(lesson.citations[0].quote));
    assert.match(lesson.markdown,language==='en'?/Prerecorded/:/预置/);
    const feedback=JSON.parse(await demoModel(languageSystem("reading a learner's retelling",language),JSON.stringify({retelling:'Anything'})));
    assert.deepEqual(feedback.covered,[]);assert.deepEqual(feedback.missing,[]);
    assert.match(feedback.note,language==='en'?/No AI assessment/:/没有模型判断/);
  }
  await assert.rejects(demoModel('Repair an arbitrary card','{}'),/没有预置/);
});

test('browser storage commits atomically, serializes updates and retains progress after quota errors',async t=>{
  const saved=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
  const values=new Map();let full=false;
  Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:key=>values.get(key)??null,setItem:(key,value)=>{if(full)throw new Error('quota');values.set(key,value);},removeItem:key=>values.delete(key)}});
  t.after(()=>{if(saved)Object.defineProperty(globalThis,'localStorage',saved);else delete globalThis.localStorage;});
  const {Store}=await import('../web-demo/store.js');const store=new Store();
  await Promise.all(Array.from({length:8},()=>store.update(s=>{s.settings.dailyLimit=(s.settings.dailyLimit||0)+1;return true;})));
  const before=await store.read();assert.equal(before.revision,8);
  await assert.rejects(store.update(s=>{s.decks=[];throw new Error('cancelled');}),/cancelled/);
  assert.equal((await store.read()).decks.length,1);
  full=true;
  await store.update(s=>{s.settings.dailyLimit=77;return true;});
  assert.equal((await store.read()).settings.dailyLimit,77);
  const cloned=await store.read();cloned.decks=[];assert.equal((await store.read()).decks.length,1);
});

test('English import prompts and examples retain machine schema and contain no Chinese instructions',async()=>{
  const {importPrompt,importExample}=await import('../ui/json-prompts.js');
  for(const kind of ['mixed','quiz','multi','flashcard','open','cloze']){
    const text=importPrompt(kind,kind,'en');
    assert.doesNotMatch(text,/[\u4e00-\u9fff]/);
    assert.match(text,/unless I explicitly request another content language/);
    const deck=JSON.parse(importExample(kind,'en'));
    assert.equal(deck.cards.length,kind==='mixed'?5:1);
    for(const card of deck.cards)assert.ok(['quiz','multi','flashcard','open','cloze'].includes(card.kind));
  }
  assert.match(importPrompt('quiz','单选'),/出题质量要求/);
});
