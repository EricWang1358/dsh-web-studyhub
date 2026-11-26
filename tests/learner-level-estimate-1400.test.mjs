import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateFromState, estimateRun } from '../lib/token-estimate.js';
import { settleJob } from './helpers/wait.mjs';
import { openLibrary, stagedModel } from './helpers/generation-baseline.mjs';

/* #1400 review, 建议修: the gap scan is one call a zero-foundation run really makes, so the job's own estimate counts it exactly as the
   创建题组 form's does; and a draft that already holds gap cards is not estimated with a second scan when it is continued. Fake models only. */

const source = { id: 'src-arch', title: 'Architecture notes',
  text: '架构包含指导系统设计与演化的原则，这些原则约束后续的变更。Serializable isolation prevents write skew by making concurrent transactions serial.' };
const card = id => ({ id, kind: 'flashcard', topic: '架构原则', objective: `目标 ${id}`, prompt: `第 ${id} 题：架构为什么包含指导设计与演化的原则？`,
  answer: '原则约束后续变更。', hint: '把描述和一条关于允许变更的规则放在一起比较。', explanation: '原文说明原则指导设计与演化。',
  misconception: '架构只描述当前的组件。', citations: [{ sourceId: source.id, quote: source.text.slice(0, 40) }] });
const staged = () => ({ decks: [], sources: [source], courses: [], attempts: [], runs: [], settings: { generation: {} },
  drafts: [{ id: 'd-zero', title: '架构', draftVersion: 1, cards: [card('c1')], editorial: { requested: 3, generation: { sourceIds: [source.id], kind: 'flashcard', learnerLevel: 'zero' } } }] });
const stagesOf = estimate => (estimate.stages || []).map(stage => stage.id);

test('#1400: a continuation estimate counts the gap scan once, and not at all once the draft holds gap cards', () => {
  const before = estimateFromState('generate', { resumeDraftId: 'd-zero' }, staged(), { language: '中文' });
  assert.ok(stagesOf(before).includes('prereqGapScan'), 'a zero-foundation continuation without gap cards is estimated with its scan');
  const state = staged();
  state.drafts[0].cards = [{ ...card('gap-1'), prereqGap: true }, ...state.drafts[0].cards];
  const after = estimateFromState('generate', { resumeDraftId: 'd-zero' }, state, { language: '中文' });
  assert.equal(stagesOf(after).includes('prereqGapScan'), false, 'a draft that already has gap cards is not estimated with a second scan');
  assert.equal(after.calls.low, before.calls.low - 1, 'the scan is the one call the second estimate drops');
});

test('#1400: the job a zero-foundation run keeps counts the scan call too, as the form priced it', async t => {
  const { service } = await openLibrary(t, { prefix: 'study-1400-estimate-', model: stagedModel().complete });
  await service.call('source.add', source);
  const started = await service.call('generate', { sourceIds: [source.id], count: 1, kind: 'flashcard', learnerLevel: 'zero' });
  const job = await settleJob(service, started.jobId);
  assert.ok(job.estimate?.stageTotals, 'the job keeps an estimate');
  assert.ok('prereqGapScan' in job.estimate.stageTotals, 'the job estimate counts the scan the run really makes');
  assert.ok(estimateRun('generate', { sources: [source], count: 1, kind: 'flashcard', language: '中文', learnerLevel: 'zero' }).stages.some(stage => stage.id === 'prereqGapScan'));
});
