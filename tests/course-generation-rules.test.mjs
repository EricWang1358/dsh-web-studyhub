import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { createFakeModel } from '../scripts/fake-model.mjs';
import { FIX_PHRASE_LIMITS } from '../lib/fix-phrases.js';
import { GENERATION_RULE_LIMITS, addGenerationRule, canAddGenerationRule, draftRulesChanged, removeGenerationRule } from '../lib/course-rules.js';
import { computeRequirementsDigest, withCourseRules } from '../lib/generation-modules.js';
import { draftRequirementsMatchReview } from '../lib/review-integrity.js';
import { planPrompts, blueprintPrompts } from '../lib/assessment-quality.js';
import { authorPrompts, reviewPrompts } from '../lib/generation.js';
import { REQUEST_DATA, stageSystem } from '../lib/prompt-order.js';
import { Store } from '../lib/store.js';
import { createSelectionOperations } from '../lib/contexts/generation/selection.js';
import { patchPrompts } from '../lib/generation-yield.js';
import { draftCourseRulesChanged } from '../lib/courses.js';
import { authored, qualityPlan, qualityBlueprint, qualityReview } from './helpers/assessment.mjs';
import { requestData } from './helpers/request-data.mjs';

/* 出题守则 (#889): a course keeps up to 12 short rules of its own; every generation for that course carries them to the plan, answer, author and review stages,
   the zero-call preview lists them, and a draft reviewed before they changed is re-reviewed before it is published. */

const LESSON = [
  '## 第 1 节 隔离级别',
  '可串行化隔离级别通过严格并发控制阻止脏读、不可重复读与幻读，使并发事务结果等价于某种串行执行顺序。',
  '快照隔离在事务启动时读取一致快照，并在提交阶段执行首写者胜冲突检测，但若两个事务读取交集并分别写入不相交集合，仍可能出现写偏序异常。',
].join('\n\n');
const RULE = 'RULE_889_题干必须自带情境和条件';
const OTHER_RULE = 'RULE_889_干扰项各对应一个真实误解';

async function serviceWithPrompts(t) {
  const root = await mkdtemp(join(tmpdir(), 'study-889-'));
  const fake = createFakeModel({ latencyMs: 1 });
  const prompts = [];
  const service = new StudyService(root, { coach: false, complete: async (system, prompt, ctx) => {
    prompts.push({ stage: stageOf(stageSystem(system, prompt)), prompt });
    return fake(system, prompt, ctx);
  } });
  t.after(async () => { await service.dispose(); await rm(root, { recursive: true, force: true }); });
  return { service, prompts };
}
const stageOf = (system) => system.startsWith('Plan ') ? 'plan' : system.startsWith('Prepare supported') ? 'blueprint'
  : system.startsWith('You author') ? 'author' : system.startsWith('Act as a strict assessment editor') ? 'review' : 'other';
const generated = async (service, args) => {
  const started = await service.call('generate', { count: 1, kind: 'flashcard', ...args });
  const job = await service.call('job.wait', { jobId: started.jobId, timeoutSeconds: 30 });
  assert.equal(job.status, 'complete');
  return (await service.call('export')).drafts.find((draft) => draft.id === job.draftId);
};

test('S1: the rules use the 修题 phrases\' limits, and adding one is trimmed, once only and refused past the limits', () => {
  assert.deepEqual(GENERATION_RULE_LIMITS, FIX_PHRASE_LIMITS);
  assert.deepEqual(addGenerationRule(['a'], '  b  '), ['a', 'b']);
  assert.deepEqual(addGenerationRule(['a'], 'a'), ['a'], 'adding the same rule twice ends in the same list');
  assert.equal(canAddGenerationRule(['a'], 'x'.repeat(GENERATION_RULE_LIMITS.length + 1)).reason, 'long');
  const full = Array.from({ length: GENERATION_RULE_LIMITS.count }, (_, index) => `rule ${index}`);
  assert.equal(canAddGenerationRule(full, 'one more').reason, 'full');
  assert.deepEqual(removeGenerationRule(['a', 'b'], 'a'), ['b']);
});

test('S1: course.save keeps the rules on the course record, validated, and an empty list removes them', async (t) => {
  const { service } = await serviceWithPrompts(t);
  const saved = await service.call('course.save', { name: '数据库', generationRules: ['  题干要自带条件  ', '题干要自带条件', '解析要点名概念'] });
  assert.deepEqual(saved.generationRules, ['题干要自带条件', '解析要点名概念']);
  assert.deepEqual((await service.call('course.get', { name: '数据库' })).generationRules, ['题干要自带条件', '解析要点名概念']);
  await assert.rejects(service.call('course.save', { name: '数据库', generationRules: Array.from({ length: 13 }, (_, i) => `r${i}`) }), /守则/);
  await assert.rejects(service.call('course.save', { name: '数据库', generationRules: ['x'.repeat(201)] }), /守则/);
  await assert.rejects(service.call('course.save', { name: '数据库', generationRules: 'one rule' }), /守则/);
  assert.deepEqual((await service.call('course.get', { name: '数据库' })).generationRules, ['题干要自带条件', '解析要点名概念'], 'a refused save changes nothing');
  // Saving the rest of the record leaves the rules alone.
  await service.call('course.save', { name: '数据库', focusTopics: ['快照隔离'] });
  assert.deepEqual((await service.call('course.get', { name: '数据库' })).generationRules, ['题干要自带条件', '解析要点名概念']);
  await service.call('course.save', { name: '数据库', generationRules: [] });
  assert.equal((await service.call('course.get', { name: '数据库' })).generationRules, undefined);
});

test('S2: a run for the course carries its rules to the plan, answer, author and review stages; a run for another course does not', async (t) => {
  const { service, prompts } = await serviceWithPrompts(t);
  const lesson = await service.call('source.add', { title: '并发控制', text: LESSON, course: '数据库' });
  const other = await service.call('source.add', { title: '并发控制（另一门）', text: LESSON, course: '操作系统' });
  await service.call('course.save', { name: '数据库', generationRules: [RULE] });
  const draft = await generated(service, { course: '数据库', sourceIds: [lesson.id] });
  for (const stage of ['plan', 'blueprint', 'author', 'review']) {
    const sent = prompts.filter((item) => item.stage === stage);
    assert.ok(sent.length, `the ${stage} stage was asked`);
    assert.ok(sent.every((item) => item.prompt.includes(RULE)), `every ${stage} request carries the course rule`);
  }
  assert.deepEqual(draft.editorial.generation.moduleOverrides?.courseRules, [RULE], 'the draft records the rules it was written with');
  prompts.length = 0;
  await generated(service, { course: '操作系统', sourceIds: [other.id] });
  assert.ok(prompts.length > 0);
  assert.ok(prompts.every((item) => !item.prompt.includes(RULE)), 'another course\'s requests carry none of these rules');
});

test('S2: a caller cannot pass rules of its own; the run always takes the course\'s rules as they are now', async (t) => {
  const { service, prompts } = await serviceWithPrompts(t);
  const lesson = await service.call('source.add', { title: '并发控制', text: LESSON, course: '数据库' });
  await generated(service, { course: '数据库', sourceIds: [lesson.id], moduleOverrides: { courseRules: ['INJECTED_889'] } });
  assert.ok(prompts.every((item) => !item.prompt.includes('INJECTED_889')));
});

test('S2: with sources over 4,000 characters every stage\'s prompt is byte-identical up to and including the sources, with or without rules', () => {
  const sources = [{ id: 's1', title: '长讲义', text: `${LESSON}\n\n`.repeat(30) }];
  assert.ok(JSON.stringify(sources).length > 4000);
  const plain = { sources, kind: 'quiz', count: 2, language: '中文', difficulty: 'mixed' };
  const ruled = { ...plain, moduleOverrides: withCourseRules(undefined, [RULE]) };
  const plan = { targets: [{ targetId: 't1', objective: 'o', knowledge: 'k', citations: [{ sourceId: 's1', quote: '快照隔离' }] }] };
  const blueprint = { items: [] };
  const prefix = `${REQUEST_DATA}{"sources":${JSON.stringify(sources)}`;
  const pairs = {
    plan: [planPrompts(plain).prompt, planPrompts(ruled).prompt],
    blueprint: [blueprintPrompts(plain, plan).prompt, blueprintPrompts(ruled, plan).prompt],
    author: [authorPrompts(plain, plan, blueprint).prompt, authorPrompts(ruled, plan, blueprint).prompt],
    review: [reviewPrompts({ sources, deck: { cards: [] }, kind: 'quiz', count: 1 }).payload,
      reviewPrompts({ sources, deck: { cards: [] }, kind: 'quiz', count: 1, moduleOverrides: ruled.moduleOverrides }).payload],
  };
  for (const [stage, [without, withRules]] of Object.entries(pairs)) {
    assert.ok(without.startsWith(prefix), `${stage}: the sources lead the prompt`);
    assert.ok(withRules.startsWith(prefix), `${stage}: the same bytes lead it with rules`);
    assert.ok(!without.includes(RULE) && withRules.includes(RULE), `${stage}: the rule comes after the sources`);
  }
});

test('S2: the zero-call preview lists the course rules on their own row and counts them in the requirements digest', async (t) => {
  const { service, prompts } = await serviceWithPrompts(t);
  const lesson = await service.call('source.add', { title: '并发控制', text: LESSON, course: '数据库' });
  const before = await service.call('generate.preview', { course: '数据库', sourceIds: [lesson.id], count: 1, kind: 'flashcard' });
  assert.equal(before.origins.courseRules, 'none');
  await service.call('course.save', { name: '数据库', generationRules: [RULE, OTHER_RULE] });
  const preview = await service.call('generate.preview', { course: '数据库', sourceIds: [lesson.id], count: 1, kind: 'flashcard' });
  assert.equal(prompts.length, 0, 'the preview asks no model');
  assert.equal(preview.modelCalls, 0);
  const row = preview.modules.find((module) => module.id === 'course_rules');
  assert.deepEqual(row?.rules, [RULE, OTHER_RULE]);
  assert.equal(row.origin, 'course');
  assert.equal(preview.origins.courseRules, 'course');
  assert.equal(preview.origins.moduleOverrides, 'default', 'course rules are not the run\'s own module overrides');
  assert.notEqual(preview.requirementsDigest, before.requirementsDigest);
  for (const stage of preview.stages) assert.ok(stage.determinedInputs.some((line) => /守则/.test(line)), `${stage.id} lists the rules it takes`);
});

test('S2: a draft reviewed before the course\'s rules changed needs a new review before it is published, and says why', async (t) => {
  const { service, prompts } = await serviceWithPrompts(t);
  const lesson = await service.call('source.add', { title: '并发控制', text: LESSON, course: '数据库' });
  await service.call('course.save', { name: '数据库', generationRules: [RULE] });
  const draft = await generated(service, { course: '数据库', sourceIds: [lesson.id] });
  const gen = draft.editorial.generation;
  assert.equal(draftRulesChanged(draft, [RULE]), false);
  const sameDigest = computeRequirementsDigest({ ...gen, questionReferences: [] }).digest;
  assert.equal(draftRequirementsMatchReview(draft, { currentRequirementsDigest: sameDigest, currentCourseRules: [RULE] }).valid, true);

  await service.call('course.save', { name: '数据库', generationRules: [RULE, OTHER_RULE] });
  assert.equal(draftRulesChanged(draft, [RULE, OTHER_RULE]), true);
  const changedDigest = computeRequirementsDigest({ ...gen, moduleOverrides: withCourseRules(gen.moduleOverrides, [RULE, OTHER_RULE]), questionReferences: [] }).digest;
  assert.deepEqual(draftRequirementsMatchReview(draft, { currentRequirementsDigest: changedDigest, currentCourseRules: [RULE, OTHER_RULE] }),
    { valid: false, reason: 'course-rules-changed', missingIds: [], modifiedIds: [] });

  prompts.length = 0;
  const published = await service.call('draft.publish', { id: draft.id, draftVersion: draft.draftVersion });
  assert.ok(published.deckId);
  const review = prompts.filter((item) => item.stage === 'review');
  assert.ok(review.length > 0, 'publication reviewed the draft again');
  assert.ok(review.every((item) => item.prompt.includes(OTHER_RULE)), 'against the rules as they are now');
});

test('S2: a draft whose course rules did not change is published without a new review', async (t) => {
  const { service, prompts } = await serviceWithPrompts(t);
  const lesson = await service.call('source.add', { title: '并发控制', text: LESSON, course: '数据库' });
  await service.call('course.save', { name: '数据库', generationRules: [RULE] });
  const draft = await generated(service, { course: '数据库', sourceIds: [lesson.id] });
  prompts.length = 0;
  await service.call('draft.publish', { id: draft.id, draftVersion: draft.draftVersion });
  assert.equal(prompts.filter((item) => item.stage === 'review').length, 0);
});

test('S2: the quick 发布并开始练, which asks no model, counts every question of a draft reviewed before the rules changed as not reviewed', async (t) => {
  const { service } = await serviceWithPrompts(t);
  const lesson = await service.call('source.add', { title: '并发控制', text: LESSON, course: '数据库' });
  await service.call('course.save', { name: '数据库', generationRules: [RULE] });
  const kept = await generated(service, { course: '数据库', sourceIds: [lesson.id] });
  const changed = await generated(service, { course: '数据库', sourceIds: [lesson.id] });
  const unchanged = await service.call('draft.publish.quick', { id: kept.id, draftVersion: kept.draftVersion });
  assert.equal(unchanged.unchecked, 0, 'the generation review still vouches for a draft whose rules did not change');

  await service.call('course.save', { name: '数据库', generationRules: [RULE, OTHER_RULE] });
  const published = await service.call('draft.publish.quick', { id: changed.id, draftVersion: changed.draftVersion });
  assert.ok(published.deckId);
  assert.equal(published.unchecked, changed.cards.length, 'its review was made against the old rules');
  const deck = (await service.call('export')).decks.find((item) => item.id === published.deckId);
  assert.ok(changed.cards.every((card) => !deck.editorial?.reviewedCards?.[card.id]), 'the deck shows them as not reviewed, as the receipt counts them');
});

/* Review follow-ups (#889): a passage written into a course's deck takes the course's rules; deleting every rule leaves no old rules on a continued draft; the
   patch and repair stages are sent the rules; the token estimate prices them, the review included. */

const LESSON_MORE = [
  '## 第 2 节 索引与锁',
  '间隙锁锁定索引记录之间的开区间，防止其他事务在该范围内插入新记录，从而在可重复读隔离级别下阻断当前读路径上的幻读。',
  '覆盖索引直接从二级索引叶子节点返回查询所需的全部列，避免回表随机读取聚簇索引数据页。',
].join('\n\n');

test('S2: questions written from a selected passage into a course\'s deck carry its rules to every stage, the later review of saved candidates included', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'study-889-selection-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root);
  store.registerCollection('selectionJobs');
  const quote = '快照隔离在事务启动时读取一致快照，并在提交阶段执行首写者胜冲突检测。';
  const selection = { sourceId: 's', documentId: 'doc', revision: 'rev1', start: 0, end: quote.length, quote, prefix: '', suffix: '' };
  await store.update((s) => {
    (s.courses ||= []).push({ id: 'course-db', name: '数据库', aliases: [], generationRules: [RULE], guidanceSourceIds: [], focusTopics: [] });
    s.decks.push({ id: 'd', title: '数据库题组', course: '数据库', contentVersion: 0, cards: [] });
  });
  const card = { id: 'q', kind: 'flashcard', topic: '快照隔离', objective: '说明快照隔离的冲突检测时机', prompt: '快照隔离在什么时候做首写者胜冲突检测？',
    answer: '在提交阶段。', hint: '想想事务的哪个阶段会比较写集合。', explanation: '资料说快照隔离在提交阶段执行首写者胜冲突检测，所以检测发生在提交时。',
    misconception: '以为冲突检测在事务启动时进行。', citations: [{ sourceId: 's', quote }] };
  const prompts = [];
  let reviewFails = true;
  const complete = async (system, prompt) => {
    const stage = stageOf(stageSystem(system, prompt));
    prompts.push({ stage, prompt });
    const data = requestData(prompt);
    if (stage === 'plan') return JSON.stringify(qualityPlan(data));
    if (stage === 'blueprint') return JSON.stringify(qualityBlueprint(data, data.assessmentPlan, { cards: [card] }));
    if (stage === 'review') {
      if (reviewFails) throw new Error('Reviewer unavailable');
      return JSON.stringify(qualityReview(data.candidate));
    }
    return JSON.stringify(authored({ title: '片段', cards: [structuredClone(card)] }));
  };
  const bank = {
    get: async () => ({ deck: structuredClone((await store.read()).decks.find((deck) => deck.id === 'd')), version: 0 }),
    append: async (args) => ({ operationId: args.operationId, deckId: 'd', added: args.cards.length, cardIds: args.cards.map((item) => item.id), version: 1 }),
  };
  const materials = async (action) => (action === 'materials.selection.resolve'
    ? { status: 'resolved', currentRevision: 'rev1', selection: structuredClone(selection) }
    : { documentId: 'doc', revision: 'rev1', sources: [{ id: 's', title: '讲义', text: quote }] });
  const operations = createSelectionOperations({ root, ...store.scoped(['selectionJobs', 'courses']), bank, materials, complete });
  const failed = await operations['generation.selection.supplement']({ selection, deckId: 'd', operationId: 'op-889', count: 1, kind: 'flashcard' }, {});
  assert.equal(failed.status, 'review-failed', 'the first review fails, so the saved candidates are reviewed again below');
  for (const stage of ['plan', 'blueprint', 'author', 'review']) {
    const sent = prompts.filter((item) => item.stage === stage);
    assert.ok(sent.length, `the ${stage} stage was asked`);
    assert.ok(sent.every((item) => item.prompt.includes(RULE)), `every ${stage} request of the passage carries the course rule`);
  }
  prompts.length = 0;
  reviewFails = false;
  const reviewed = await operations['generation.selection.review']({ operationId: 'op-889' }, {});
  assert.equal(reviewed.status, 'complete');
  const review = prompts.filter((item) => item.stage === 'review');
  assert.ok(review.length && review.every((item) => item.prompt.includes(RULE)), 'the review of the saved candidates carries the rule too');
});

test('S2: a draft continued after every rule was deleted records no rules, says nothing changed and keeps the new run\'s review marks', async (t) => {
  const { service } = await serviceWithPrompts(t);
  const lesson = await service.call('source.add', { title: '并发控制', text: LESSON, course: '数据库' });
  const more = await service.call('source.add', { title: '索引与锁', text: LESSON_MORE, course: '数据库' });
  await service.call('course.save', { name: '数据库', generationRules: [RULE] });
  const first = await generated(service, { course: '数据库', sourceIds: [lesson.id] });
  await service.call('course.save', { name: '数据库', generationRules: [] });
  const started = await service.call('generate', { resumeDraftId: first.id, draftVersion: first.draftVersion, extraSourceIds: [more.id], count: 1 });
  assert.equal((await service.call('job.wait', { jobId: started.jobId, timeoutSeconds: 30 })).status, 'complete');
  const state = await service.call('export');
  const draft = state.drafts.find((item) => item.id === first.id);
  const added = draft.cards.filter((card) => !first.cards.some((old) => old.id === card.id));
  assert.ok(added.length, 'the continuation added a question');
  assert.equal(draft.editorial.generation.moduleOverrides, undefined, 'the draft no longer records the deleted rules');
  assert.equal(draftCourseRulesChanged(state, draft), false, 'the draft is not said to be held to rules that changed');
  assert.ok(added.every((card) => draft.editorial.reviewedCards?.[card.id]), 'the new run\'s review marks stay');
  const published = await service.call('draft.publish.quick', { id: draft.id, draftVersion: draft.draftVersion });
  assert.equal(published.unchecked, first.cards.length, 'only the questions reviewed under the old rules count as not reviewed');
});

test('S2: the patch and the background repair stages are sent the course rules', async (t) => {
  const patched = patchPrompts({ entries: [], kind: 'quiz', sources: [{ id: 's1', title: '讲义', text: LESSON }], moduleOverrides: withCourseRules(undefined, [RULE]) });
  assert.ok(patched.prompt.includes(RULE), 'the patch prompt carries the rule');

  const { service, prompts } = await serviceWithPrompts(t);
  const lesson = await service.call('source.add', { title: '并发控制', text: LESSON, course: '数据库' });
  await service.call('course.save', { name: '数据库', generationRules: [RULE] });
  const draft = await generated(service, { course: '数据库', sourceIds: [lesson.id] });
  const saved = await service.call('draft.save', { deck: { ...draft, editorial: { ...draft.editorial, rejectedIssues: { [draft.cards[0].id]: ['题干缺少场景限定'] } } } });
  prompts.length = 0;
  const repair = await service.call('draft.repair', { id: draft.id, draftVersion: saved.draftVersion });
  assert.equal((await service.call('job.wait', { jobId: repair.jobId, timeoutSeconds: 30 })).status, 'complete');
  assert.ok(prompts.length > 0, 'the repair asked the model');
  assert.ok(prompts.every((item) => item.prompt.includes(RULE)), 'the repair request and its review carry the rule');
});

test('S2: the token estimate prices the course rules into every stage, the review included, and only for that course', async (t) => {
  const { service } = await serviceWithPrompts(t);
  const lesson = await service.call('source.add', { title: '并发控制', text: LESSON, course: '数据库' });
  const ask = { feature: 'generate', sourceIds: [lesson.id], count: 1, kind: 'flashcard', course: '数据库' };
  const before = await service.call('usage.estimate', ask);
  const otherBefore = await service.call('usage.estimate', { ...ask, course: '操作系统' });
  const rules = Array.from({ length: GENERATION_RULE_LIMITS.count }, (_, index) => `第 ${index} 条：${'题干要自带情境和决定答案的条件，'.repeat(8)}`.slice(0, GENERATION_RULE_LIMITS.length));
  await service.call('course.save', { name: '数据库', generationRules: rules });
  const after = await service.call('usage.estimate', ask);
  const stage = (estimate, id) => estimate.stages.find((item) => item.id === id);
  for (const id of ['plan', 'blueprint', 'author', 'review']) {
    assert.ok(stage(before, id) && stage(after, id), `the ${id} stage is priced`);
    assert.ok(stage(after, id).inputTokens.low > stage(before, id).inputTokens.low, `the ${id} stage is priced with the rules`);
  }
  const other = await service.call('usage.estimate', { ...ask, course: '操作系统' });
  assert.deepEqual(other.inputTokens, otherBefore.inputTokens, 'another course\'s estimate takes none of them');
});
