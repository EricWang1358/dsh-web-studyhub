import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';

/* generate.path.suggest: the model refines a locally made step plan from titles and sizes only (never the text), validated; without a model or when it
   fails the same call answers with no refinement and never throws. */

async function service(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'study-gen-path-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return new StudyService(root, options);
}
const steps = [{ id: 'step-1', title: '第 1 章 引言', pages: 10, chars: 80_000 }, { id: 'step-2', title: '第 2 章 进程', pages: 20, chars: 120_000 }];

test('the refinement is one light-model call over titles and sizes, and its answer is returned for the plan to apply', async t => {
  const seen = [];
  const s = await service(t, { light: async (system, prompt) => { seen.push({ system, prompt }); return JSON.stringify({ steps: [{ id: 'step-2', title: '先学进程', focus: '概念辨析', count: 12, reason: '后面依赖它' }, { id: 'step-1', title: '再看引言', focus: '', count: 6 }] }); } });
  const result = await s.call('generate.path.suggest', { steps, course: 'OS', goal: 'exam' });
  assert.equal(seen.length, 1, 'one light call');
  assert.match(seen[0].prompt, /第 2 章 进程/);
  assert.match(seen[0].prompt, /120000|120,000/, 'the sizes are sent');
  assert.equal(result.source, 'model');
  assert.deepEqual(result.steps.map(step => step.id), ['step-2', 'step-1']);
  assert.equal(result.steps[0].title, '先学进程');
  assert.equal(result.unavailable, undefined);
});

test('no model, a failing model or a nonsense answer leave the plan as it is and never throw', async t => {
  const none = await (await service(t)).call('generate.path.suggest', { steps });
  assert.deepEqual([none.source, none.steps, none.unavailable?.reason], ['local', [], 'no-model']);
  const failing = await (await service(t, { light: async () => { throw new Error('429 rate limit'); } })).call('generate.path.suggest', { steps });
  assert.deepEqual([failing.source, failing.unavailable?.reason], ['local', 'failed']);
  const garbage = await (await service(t, { light: async () => 'I cannot help with that' })).call('generate.path.suggest', { steps });
  assert.equal(garbage.source, 'local');
  const foreign = await (await service(t, { light: async () => JSON.stringify({ steps: [{ id: 'invented', title: 'x' }] }) })).call('generate.path.suggest', { steps });
  assert.equal(foreign.source, 'local', 'ids that were not sent are ignored: nothing usable is no refinement');
});

test('what is sent is bounded and validated: at most forty steps, titles clipped, nothing but the listed fields', async t => {
  const seen = [];
  const s = await service(t, { light: async (system, prompt) => { seen.push(prompt); return JSON.stringify({ steps: [] }); } });
  const many = Array.from({ length: 60 }, (_, i) => ({ id: `step-${i + 1}`, title: 'T'.repeat(500), pages: 1, chars: 1000, text: 'SECRET BODY TEXT' }));
  await s.call('generate.path.suggest', { steps: many });
  assert.ok(!seen[0].includes('SECRET BODY TEXT'));
  assert.ok((seen[0].match(/step-\d+/g) || []).length <= 40 + 3);
  await assert.rejects(s.call('generate.path.suggest', { steps: 'nope' }), /steps/);
});

test('an unusable first answer is retried once with the exact ids; a second one says what it looked like', async t => {
  const seen = [];
  const answers = ['{"note":"here you go"}', JSON.stringify({ steps: [{ id: 'step-1', title: '好了' }, { id: 'step-2' }] })];
  const s = await service(t, { light: async (system, prompt) => { seen.push(prompt); return answers[Math.min(seen.length - 1, answers.length - 1)]; } });
  const result = await s.call('generate.path.suggest', { steps });
  assert.equal(seen.length, 2, 'exactly one retry');
  assert.match(seen[1], /step-1/);
  assert.match(seen[1], /could not be used|exact ids/i);
  assert.equal(result.source, 'model');
  const bad = await service(t, { light: async () => '{"note":"still not a plan"}' });
  const failed = await bad.call('generate.path.suggest', { steps });
  assert.deepEqual([failed.source, failed.unavailable.reason], ['local', 'nothing-usable']);
  assert.match(failed.unavailable.sample, /still not a plan/, 'what the model said is returned so it can be shown and reported');
  assert.ok(failed.unavailable.sample.length <= 220);
});
