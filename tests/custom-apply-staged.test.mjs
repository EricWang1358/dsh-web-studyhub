/* 深度定制 is not changed by one pass (gate F1): the runs a 定制方案 starts are written by the staged pipeline, so each run plans the questions the plan's estimate
   counted (the staged density), whatever 出题方式 the library has. A run already started goes on the way its draft records. No model, no network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCustom } from '../lib/custom-apply.js';
import { courseSkeleton } from '../lib/custom-skeleton.js';
import { COURSE, lecture, open, plan, save } from './helpers/custom-apply-world.mjs';

test('a 定制方案 starts its runs staged, at the level it was planned with', async t => {
  const study = await open(t), state = await study.store.read(), skeleton = courseSkeleton(state, COURSE), doc = lecture(skeleton, 3);
  await save(study, plan({ scope: { kind: 'chapters', chapters: [doc.chapters[0].id] }, questions: { make: true, kinds: ['quiz'], strength: 'standard', variants: false } }));
  const calls = [], call = async (name, args) => { calls.push([name, args]); return { jobId: `job-${calls.length}` }; };
  await applyCustom({ state: { ...(await study.store.read()), settings: { generation: { strategy: 'one-pass' } } }, call, jobs: () => [], activeJob: () => false }, { course: COURSE, confirm: true });
  const generate = calls.filter(([name]) => name === 'generate');
  assert.ok(generate.length >= 1);
  for (const [, args] of generate) {
    assert.equal(args.coverageLevel, 'standard');
    assert.deepEqual(args.performance, { strategy: 'staged' });
  }
});
