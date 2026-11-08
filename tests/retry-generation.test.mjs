/* 按原资料重新设置: a failed generation job puts its whole request back on the 创建题组 form, and the notice says only what was put back. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { StudyService } from '../lib/service.js';

const han = /[㐀-鿿]/;
const require = createRequire(import.meta.url);
const compiled = await build({
  stdin: { contents: `export * from './ui/i18n.js';
    export { retryForm, retryNotice } from './ui/app/retry-generation.js';
    export { generationFormDefaults } from './ui/generation-status.js';
    export { generationRequest } from './ui/generate-form.js';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text' }, logLevel: 'silent',
});
const loaded = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, loaded, loaded.exports);
const m = loaded.exports;

const formOf = (patch) => ({ ...m.generationFormDefaults(undefined, 'zh'), ...patch });

test('按原资料重新设置 puts the whole request back: kinds, the typed number, level, focus, difficulty, language, notation, references and title', () => {
  const job = { kind: 'quiz', kinds: ['quiz', 'open'], sourceIds: ['a', 'b'], count: 12, requestedTotal: 40, deckTitle: 'Week 3',
    coveragePlan: { level: 'full', goal: 40, rounds: 2 },
    asked: { focus: '区分相似模式', difficulty: 'advanced', language: 'English', notation: 'latex', role: 'Architect',
      referenceSourceIds: ['ref-1'], referenceFormat: 'strict', referenceLimits: { sources: 4, chars: 20000 },
      tokenBudget: '800K', autoComplete: true, coverageLevel: 'full', count: 40 } };
  const { patch, lost } = m.retryForm(job);
  assert.deepEqual(lost, []);
  assert.deepEqual(patch, { course: undefined, kind: 'quiz', kinds: ['quiz', 'open'], coverageLevel: 'full', customCount: '40', focus: '区分相似模式', difficulty: 'advanced',
    language: 'English', notation: 'latex', role: 'Architect', referenceSourceIds: ['ref-1'], referenceFormat: 'strict', referenceLimits: { sources: 4, chars: 20000 },
    tokenBudget: '800K', autoComplete: true, kindCounts: undefined, moduleOverrides: undefined, title: 'Week 3' });
  // Merging onto a form that currently holds another run's sample questions overwrites them cleanly (#851 B).
  const dirtyForm = { ...formOf({}), referenceSourceIds: ['different-current-sample'], referenceFormat: 'flexible', role: 'Stale role' };
  const form = { ...dirtyForm, ...patch };
  const request = m.generationRequest(form, { course: '', sourceIds: ['a', 'b'] });
  assert.equal(request.count, 40);
  assert.equal(request.coverageLevel, 'full');
  assert.deepEqual(request.kinds, ['quiz', 'open']);
  assert.equal(request.focus, '区分相似模式');
  assert.equal(request.difficulty, 'advanced');
  assert.equal(request.language, 'English');
  assert.deepEqual(request.referenceSourceIds, ['ref-1']);
  assert.equal(request.referenceFormat, 'strict');
  assert.deepEqual(request.referenceLimits, { sources: 4, chars: 20000 });
  assert.equal(request.role, 'Architect');
  assert.equal(request.title, 'Week 3');
  assert.ok(!('requestedTotal' in patch) && !('count' in patch), 'the old patch set a `count` key the form never read');
});

test('a request that only named a level comes back as that level, and explicit empty references clear stale form references', () => {
  const { patch, lost } = m.retryForm({ kinds: ['flashcard'], kind: 'flashcard', sourceIds: ['a'], count: 30, requestedTotal: 343, coveragePlan: { level: 'standard', goal: 343, rounds: 12 },
    asked: { focus: '', difficulty: 'mixed', language: '中文', notation: 'auto', referenceSourceIds: [], referenceFormat: 'balanced', coverageLevel: 'standard' } });
  assert.deepEqual(lost, []);
  assert.equal(patch.customCount, '');
  assert.equal(patch.coverageLevel, 'standard');
  assert.equal(patch.focus, '');
  const merged = { ...formOf({}), referenceSourceIds: ['different-current-sample'], referenceFormat: 'strict', ...patch };
  assert.deepEqual(merged.referenceSourceIds, []);
  assert.equal(merged.referenceFormat, 'balanced');
  assert.equal(m.generationRequest(merged, { course: '', sourceIds: ['a'] }).count, undefined, 'the level plans the questions again');
});

test('a job from before the request was recorded comes back without what it never had, clears stale references, and names missing fields', () => {
  const old = { kind: 'mixed', sourceIds: ['a'], count: 30, requestedTotal: 120, coveragePlan: { level: 'lean', goal: 120, rounds: 4 } };
  const { patch, lost } = m.retryForm(old);
  assert.deepEqual(patch.kinds, ['quiz', 'flashcard']);
  assert.equal(patch.kind, 'mixed');
  assert.equal(patch.coverageLevel, 'lean');
  for (const key of ['focus', 'difficulty', 'customCount', 'language']) assert.ok(!(key in patch), `${key} is not guessed`);
  assert.deepEqual(patch.referenceSourceIds, [], 'never inherits another run sample questions');
  assert.deepEqual(lost, ['侧重点', '难度', '自定义题数', '参考样题']);
  assert.match(m.retryNotice({ lost }), /侧重点、难度、自定义题数、参考样题当时没有记录，请重新选/);
  // A case paper's kind is not a list of the form's kinds: the form keeps its own, and the notice says what was not put back.
  const paper = m.retryForm({ kind: 'case', sourceIds: ['a'], asked: { difficulty: 'mixed', referenceSourceIds: [], referenceFormat: 'balanced' } });
  assert.ok(!('kinds' in paper.patch) && !('kind' in paper.patch));
  assert.deepEqual(paper.lost, ['题型']);
});

test('the notice claims only what was put back, including deleted reference questions, in both languages', () => {
  m.setUiLanguage('zh');
  const full = m.retryNotice({ lost: [] });
  assert.match(full, /已带回可用资料、题型、题数、覆盖强度、侧重点和难度/);
  assert.doesNotMatch(full, /学习目标/, 'the old notice asked for the goal to be checked because the goal was not put back');
  assert.match(m.retryNotice({ lost: [], gone: 2 }), /已不在资料库里/);
  assert.match(m.retryNotice({ lost: [], goneReferences: 1 }), /另有参考样题已不在资料库里/);
  assert.doesNotMatch(full, /已不在资料库里/);
  m.setUiLanguage('en');
  try {
    // The labels are looked up when the form is rebuilt, in the language then on screen.
    const { lost } = m.retryForm({ kind: 'mixed', sourceIds: ['a'], coveragePlan: { level: 'lean' } });
    assert.deepEqual(lost, ['Focus', 'Difficulty', 'Custom number of questions', 'Reference questions']);
    for (const notice of [m.retryNotice({ lost: [] }), m.retryNotice({ lost, gone: 1, goneReferences: 1 })]) assert.doesNotMatch(notice, han);
    assert.match(m.retryNotice({ lost }), /Focus, Difficulty, Custom number of questions, Reference questions were not recorded/);
    assert.match(m.retryNotice({ lost: [], gone: 1 }), /generate\. Some sources are no longer in the library/);
    assert.match(m.retryNotice({ lost: [], goneReferences: 1 }), /Some reference questions are no longer in the library/);
  } finally { m.setUiLanguage('zh'); }
});

test('the generation job keeps what the learner asked beyond what its card carries, so the retry has something to put back', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'study-retry-'));
  const service = new StudyService(root);
  t.after(async () => { service.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 10 }); });
  await service.call('source.add', { id: 'src', title: 'Notes', text: 'Architecture connects business goals to technical decisions through principles.\n'.repeat(40) });
  await service.call('source.add', { id: 'ref', title: 'Sample Paper', text: '1. Which trade-off governs queue durability? A) Latency vs persistence.' });
  service.complete = async () => { throw new Error('the model is away'); };
  const started = await service.call('generate', { sourceIds: ['src'], referenceSourceIds: ['ref'], referenceFormat: 'strict',
    count: 3, kinds: ['quiz', 'open'], focus: '取舍', difficulty: 'advanced', language: 'English', notation: 'text', role: 'Backend',
    coverageLevel: 'lean' });
  await service.call('job.wait', { jobId: started.jobId, timeoutSeconds: 30 });
  const job = (await service.call('snapshot')).jobs.find((item) => item.id === started.jobId);
  assert.ok(job, 'the job is in the snapshot');
  assert.equal(job.status, 'failed');
  assert.deepEqual(job.asked, { focus: '取舍', difficulty: 'advanced', language: 'English', notation: 'text', role: 'Backend',
    referenceSourceIds: ['ref'], referenceFormat: 'strict', coverageLevel: 'lean', count: 3 });
  assert.deepEqual(job.kinds, ['quiz', 'open']);
  assert.deepEqual(job.sourceIds, ['src']);
  // And what the card carries plus the echo is enough for the whole request, even if a reference was later deleted.
  const { patch, lost, goneReferences } = m.retryForm(job, { sources: [{ id: 'src' }] });
  assert.deepEqual(lost, []);
  assert.equal(goneReferences, 1);
  assert.deepEqual(patch.referenceSourceIds, []);
  assert.equal(patch.referenceFormat, 'strict');
  assert.equal(patch.customCount, '3');
  assert.equal(patch.focus, '取舍');
  assert.equal(patch.difficulty, 'advanced');
});
