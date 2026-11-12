import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { Store } from '../lib/store.js';
import { createFakeModel } from '../scripts/fake-model.mjs';
import { stageSystem } from '../lib/prompt-order.js';
import { createSelectionOperations } from '../lib/contexts/generation/selection.js';
import { languageRule, languageIssues, cardLanguage, LANGUAGE_ISSUE } from '../lib/contexts/generation/content-language.js';
import { writeVariants, writeRewrite } from '../lib/coach.js';
import { createAssistService } from '../lib/assist.js';
import { authored, qualityPlan, qualityBlueprint, qualityReview } from './helpers/assessment.mjs';
import { requestData } from './helpers/request-data.mjs';
import { loadUi } from './helpers/ui-module.mjs';

/* #1002, every way questions are made: a run (and the 待出题 batch, which is one), a case paper, a passage added to a deck (补题), the background repair of a
   draft and the publication check before it, a variant, a rewrite after feedback, 修题 and 出成题 (a prerequisite). The learner chose English, the material
   and the interface are Chinese: every model call that writes question text is sent the same English rule, and what is not English never reaches a deck. */

const ENGLISH = languageRule('English');
const LESSON = [
  '## 第 1 节 隔离级别',
  '可串行化隔离级别通过严格并发控制阻止脏读、不可重复读与幻读，使并发事务结果等价于某种串行执行顺序。',
  '快照隔离在事务启动时读取一致快照，并在提交阶段执行首写者胜冲突检测，但若两个事务读取交集并分别写入不相交集合，仍可能出现写偏序异常。',
].join('\n\n');
const stageOf = (system) => system.startsWith('Plan ') ? 'plan' : system.startsWith('Prepare supported') ? 'blueprint' : system.startsWith('You author') ? 'author'
  : system.startsWith('Act as a strict assessment editor') ? 'review' : system.startsWith('Rewrite only the wording') ? 'patch'
  : system.startsWith('Repair one draft card') ? 'repair' : system.startsWith('You write original case-study') ? 'case-author'
  : system.startsWith('You independently review a case-study') ? 'case-review' : 'other';

async function englishLibrary(t) {
  const root = await mkdtemp(join(tmpdir(), 'study-1002-'));
  const fake = createFakeModel({ latencyMs: 1 });
  const calls = [];
  // A Chinese interface: every call also carries the Chinese interface preference (lib/language.js), which the content rule outranks.
  const service = new StudyService(root, { coach: false, language: 'zh', complete: async (system, prompt, ctx) => {
    calls.push({ stage: stageOf(stageSystem(system, prompt)), text: `${system}\n${prompt}` });
    return fake(system, prompt, ctx);
  } });
  t.after(async () => { await service.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  await service.call('settings', { generation: { language: 'English' } });
  const lesson = await service.call('source.add', { title: '并发控制', text: LESSON, course: '数据库' });
  return { service, calls, lesson };
}
const finished = async (service, started) => {
  const job = await service.call('job.wait', { jobId: started.jobId, timeoutSeconds: 30 });
  assert.equal(job.status, 'complete', job.error || job.stage);
  return (await service.call('export')).drafts.find((draft) => draft.id === job.draftId);
};

test('a run and a 待出题 batch from Chinese material with English chosen: every stage carries the English rule and every question is English', async (t) => {
  const { service, calls, lesson } = await englishLibrary(t);
  const { batchRequest, setUiLanguage } = await loadUi(`export { batchRequest } from './ui/document-preview/marks/model.js'; export { setUiLanguage } from './ui/i18n.js';`);
  setUiLanguage('zh');
  const settings = (await service.call('snapshot')).settings;
  const queue = [{ id: 'm1', style: 'queue', status: 'resolved', selection: { sourceId: lesson.id, start: 0, end: 20, quote: LESSON.slice(30, 60) } }];
  const request = batchRequest({ queue, perPassage: 2, settings, title: '并发控制' });
  assert.equal(request.language, 'English', 'the batch is the ordinary run with the saved 出题语言, not the interface language');
  assert.match(request.focus, /段原文/, 'its focus is in the interface language, which the rule outranks');
  const draft = await finished(service, await service.call('generate', { ...request, kind: 'quiz', kinds: ['quiz'] }));
  for (const stage of ['plan', 'blueprint', 'author', 'review']) {
    const sent = calls.filter((call) => call.stage === stage);
    assert.ok(sent.length, `the ${stage} stage was asked`);
    assert.ok(sent.every((call) => call.text.includes(ENGLISH)), `every ${stage} call carries the English rule`);
  }
  assert.equal(draft.editorial.generation.language, 'English');
  assert.ok(draft.cards.length > 0);
  assert.deepEqual(languageIssues(draft, 'English'), []);
});

test('a case paper asked in English carries the rule to its author and its review', async (t) => {
  const { service, calls, lesson } = await englishLibrary(t);
  await finished(service, await service.call('generate', { sourceIds: [lesson.id], kind: 'case', title: 'Case' }));
  for (const stage of ['case-author', 'case-review']) {
    const sent = calls.filter((call) => call.stage === stage);
    assert.ok(sent.length, `the ${stage} stage was asked`);
    assert.ok(sent.every((call) => call.text.includes(ENGLISH)), `every ${stage} call carries the English rule`);
  }
});

test('a generated question that is not English is held back in the draft at publication with the reason, and its background repair is sent the rule', async (t) => {
  const { service, calls, lesson } = await englishLibrary(t);
  const draft = await finished(service, await service.call('generate', { sourceIds: [lesson.id], count: 2, kind: 'quiz', kinds: ['quiz'] }));
  const [first] = draft.cards;
  const slipped = { ...first, options: first.options.map((option) => option === first.options.find((item) => !item.correct) ? { ...option, text: '它只是给这条要点换了一个名字' } : option) };
  const saved = await service.call('draft.save', { deck: { ...draft, cards: [slipped, ...draft.cards.slice(1)] } });
  const published = await service.call('draft.publish', { id: draft.id, draftVersion: saved.draftVersion });
  assert.equal(published.rejected, 1, 'the card is not published silently');
  const state = await service.call('export');
  const deck = state.decks.find((item) => item.id === published.deckId);
  assert.ok(!deck.cards.some((card) => card.prompt === first.prompt), 'it is not in the deck');
  const held = state.drafts.find((item) => item.cards.some((card) => card.id === first.id));
  assert.ok(held, 'it stays in a draft');
  assert.ok(held.editorial.rejectedIssues[first.id].some((issue) => issue.includes(LANGUAGE_ISSUE)), 'with the language reason the learner sees');
  calls.length = 0;
  const repair = await service.call('draft.repair', { id: held.id, draftVersion: held.draftVersion });
  await service.call('job.wait', { jobId: repair.jobId, timeoutSeconds: 30 });
  const repairCalls = calls.filter((call) => call.stage === 'repair');
  assert.ok(repairCalls.length > 0, 'the repair asked the model');
  assert.ok(calls.every((call) => call.text.includes(ENGLISH)), 'the repair and its review are sent the English rule');
});

test('a passage added to a deck (补题) follows the saved 出题语言, or the deck\'s own, never the interface language alone', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'study-1002-selection-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const store = new Store(root);
  store.registerCollection('selectionJobs');
  const quote = '快照隔离在事务启动时读取一致快照，并在提交阶段执行首写者胜冲突检测。';
  const selection = { sourceId: 's', documentId: 'doc', revision: 'rev1', start: 0, end: quote.length, quote, prefix: '', suffix: '' };
  await store.update((s) => {
    s.settings = { ...s.settings, generation: { ...(s.settings?.generation || {}), language: 'English' } };
    s.decks.push({ id: 'imported', title: '数据库题组', contentVersion: 0, cards: [] });
    s.decks.push({ id: 'chinese', title: '中文题组', contentVersion: 0, cards: [], editorial: { generation: { language: '中文' } } });
  });
  const card = { id: 'q', kind: 'flashcard', topic: 'Snapshot isolation', objective: 'When the conflict check runs', prompt: 'When does snapshot isolation run its first-committer-wins check?',
    answer: 'At commit time.', hint: 'Think about when write sets can be compared.', explanation: 'The check runs at commit, after both transactions wrote.',
    misconception: 'Believing it runs when the snapshot is read.', citations: [{ sourceId: 's', quote }] };
  const calls = [];
  const complete = async (system, prompt) => {
    const stage = stageOf(stageSystem(system, prompt));
    calls.push({ stage, text: `${system}\n${prompt}` });
    const data = requestData(prompt);
    if (stage === 'plan') return JSON.stringify(qualityPlan(data));
    if (stage === 'blueprint') return JSON.stringify(qualityBlueprint(data, data.assessmentPlan, { cards: [card] }));
    if (stage === 'review') return JSON.stringify(qualityReview(data.candidate));
    return JSON.stringify(authored({ title: 'Passage', cards: [structuredClone(card)] }));
  };
  const bank = { get: async (deckId) => ({ deck: structuredClone((await store.read()).decks.find((deck) => deck.id === deckId)), version: 0 }),
    append: async (args) => ({ operationId: args.operationId, deckId: args.deckId, added: args.cards.length, cardIds: args.cards.map((item) => item.id), version: 1 }) };
  const materials = async (action) => (action === 'materials.selection.resolve'
    ? { status: 'resolved', currentRevision: 'rev1', selection: structuredClone(selection) }
    : { documentId: 'doc', revision: 'rev1', sources: [{ id: 's', title: '讲义', text: quote }] });
  const operations = createSelectionOperations({ root, ...store.scoped(['selectionJobs', 'courses', 'settings']), bank, materials, complete });
  const done = await operations['generation.selection.supplement']({ selection, deckId: 'imported', operationId: 'op-en', count: 1, kind: 'flashcard' }, { language: 'zh' });
  assert.equal(done.status, 'complete');
  for (const stage of ['plan', 'blueprint', 'author', 'review'])
    assert.ok(calls.some((call) => call.stage === stage) && calls.filter((call) => call.stage === stage).every((call) => call.text.includes(ENGLISH)), `the ${stage} stage carries the English rule`);
  calls.length = 0;
  await operations['generation.selection.supplement']({ selection, deckId: 'chinese', operationId: 'op-zh', count: 1, kind: 'flashcard' }, { language: 'zh' });
  assert.ok(calls.length && calls.every((call) => call.text.includes(languageRule('中文')) && !call.text.includes(ENGLISH)), 'a deck written in Chinese is added to in Chinese');
});

test('questions made from an existing card keep its language: a variant, a rewrite after feedback, 修题 and 出成题', async () => {
  const englishDeck = { id: 'd', title: 'Databases', editorial: { generation: { language: 'English' } }, cards: [] };
  const importedChinese = { id: 'i', title: '导入题组', cards: [] };
  const card = { id: 'c', kind: 'quiz', topic: 'Isolation', objective: 'Snapshot isolation', prompt: 'When does snapshot isolation check for conflicts?', answer: 'At commit', citations: [] };
  const chineseCard = { ...card, prompt: '快照隔离什么时候检测冲突？' };
  assert.equal(cardLanguage(englishDeck, chineseCard), 'English', 'the deck\'s recorded language decides');
  assert.equal(cardLanguage(importedChinese, chineseCard), '中文', 'an imported card keeps its own');
  assert.equal(cardLanguage(importedChinese, card), 'English');

  const sent = [];
  const record = async (system, prompt) => { sent.push(`${system}\n${prompt}`); return '{"cards":[],"patch":{},"summary":""}'; };
  await writeVariants(record, { targets: [{ card, deck: englishDeck, kind: 'quiz', reason: 'wrong' }], sources: [], learner: {} });
  await writeRewrite(record, { card, deck: englishDeck, tags: ['unclear'], evidence: [], learner: {} });
  assert.ok(sent.every((text) => text.includes(ENGLISH)), 'the variant and the rewrite are sent the English rule');
  sent.length = 0;
  await writeVariants(record, { targets: [{ card: chineseCard, deck: importedChinese, kind: 'quiz', reason: 'wrong' }, { card, deck: englishDeck, kind: 'quiz', reason: 'wrong' }], sources: [], learner: {} });
  assert.ok(sent[0].includes(ENGLISH) && sent[0].includes(languageRule('中文')), 'a batch of two languages names both, each card its own');

  const systems = [];
  const state = { decks: [{ ...englishDeck, cards: [card] }], sources: [], settings: { generation: { language: '中文' } } };
  const service = { store: { read: async () => structuredClone(state) }, saveAssistResult: async () => ({ message: 'saved' }),
    complete: async (system) => { systems.push(system); return '{}'; } };
  const assist = createAssistService({ children: { clearAssistChildren() {}, withAssistChild() {}, disposeAssistChildren() {} } });
  const ctx = { get: () => null };
  for (const [mode, text, derive] of [['improve', 'The stem is unclear', undefined], ['derive', 'MVCC', { relation: 'prerequisite' }], ['ask', 'Why commit?', undefined]])
    await assist.startAssist(ctx, { root: 'r', service, sessionId: 's', mode, ref: { deckId: 'd', cardId: 'c' }, text, derive, card, deckTitle: 'Databases', language: 'zh' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assist.dispose();
  assert.equal(systems.length, 3);
  assert.ok(systems[0].includes(ENGLISH), '修题 keeps the card\'s English');
  assert.ok(systems[1].includes(ENGLISH), '出成题 writes the prerequisite in the card\'s English');
  assert.ok(!systems[2].includes('Content language:'), 'an answer to the learner\'s question follows the interface language');
});
