import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { createFakeModel } from '../scripts/fake-model.mjs';
import { mergedTranscript } from './helpers/merged-transcript.mjs';
import { settleJob } from './helpers/wait.mjs';
import { pinStaged } from './helpers/staged-strategy.mjs';

/* The machine's calibration (lib/estimate-calibration.js) holds ratios per stage id (plan, blueprint, author, review), learned from the staged pipeline. A run written
   in one pass spends on those ids very differently (one write call per portion, reviews of 7 cards), so its usage would skew the ratios every staged estimate is
   corrected by (gate S2): a one-pass run records nothing; a staged run on the same machine still does. */

const world = mergedTranscript({ recordings: 2, parts: 4, paragraphs: 8 });

async function machine(t) {
  const home = await mkdtemp(join(tmpdir(), 'study-dsh-home-')), roots = [];
  const saved = { home: process.env.DSH_HOME, off: process.env.STUDY_NO_CALIBRATION };
  process.env.DSH_HOME = home;
  delete process.env.STUDY_NO_CALIBRATION;
  const services = [];
  t.after(async () => {
    for (const service of services) await service.dispose();
    for (const [key, value] of [['DSH_HOME', saved.home], ['STUDY_NO_CALIBRATION', saved.off]]) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await Promise.all([home, ...roots].map(dir => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })));
  });
  const library = async () => {
    const root = await mkdtemp(join(tmpdir(), 'study-one-pass-calibration-'));
    roots.push(root);
    const service = new StudyService(root, { coach: false, complete: createFakeModel({ usage: true }), coverage: { roundLimit: 8 } });
    services.push(service);
    for (const source of world.sources) await service.call('source.add', { id: source.id, title: source.title, text: source.text, audio: source.audio });
    return service;
  };
  const runs = async () => { try { return JSON.parse(await readFile(join(home, 'study', 'estimate-calibration.json'), 'utf8')).runs || []; } catch (error) { if (error.code === 'ENOENT') return []; throw error; } };
  return { library, runs };
}

test('a coverage run written in one pass teaches the staged calibration nothing; a staged run on the same machine still does', async t => {
  const { library, runs } = await machine(t), ids = world.sources.map(source => source.id);
  const onePass = await library();
  const quick = await settleJob(onePass, (await onePass.call('generate', { sourceIds: ids, coverageLevel: 'standard', kind: 'quiz', language: 'English' })).jobId);
  assert.equal(quick.status, 'complete', quick.stage);
  assert.equal((await onePass.call('export')).drafts[0].editorial.generation.performance.strategy, 'one-pass');
  assert.equal((await runs()).length, 0, 'the one-pass run recorded no ratio');

  const staged = await library();
  await pinStaged(staged);
  const slow = await settleJob(staged, (await staged.call('generate', { sourceIds: ids, coverageLevel: 'standard', kind: 'quiz', language: 'English' })).jobId);
  assert.equal(slow.status, 'complete', slow.stage);
  assert.equal((await runs()).length, 1, 'the staged run recorded its first round');
});

// Gate N2 (round 2): what decides is how the round was WRITTEN, not what the setting says. A round of a one-pass run that has no section to write in one pass (a top-up
// whose parts are all targets written again, which stay staged parts: lib/batch.js) is written by the staged pipeline, and teaches the staged calibration as staged.
test('a round is written in one pass only when it has sections to write that way: a round of only targets written again is staged', async () => {
  const { roundInOnePass } = await import('../lib/one-pass/route.js');
  const request = { kind: 'quiz', performance: { strategy: 'one-pass' } }, assignments = [{ key: 's1', sectionId: 's1', sourceId: 'doc', start: 0, end: 100, quota: 2 }];
  assert.equal(roundInOnePass(request, assignments), true);
  assert.equal(roundInOnePass(request, []), false, 'only targets written again: staged');
  assert.equal(roundInOnePass(request, undefined), false);
  assert.equal(roundInOnePass({ ...request, performance: { strategy: 'staged' } }, assignments), false);
  assert.equal(roundInOnePass({ ...request, kind: 'flashcard' }, assignments), false);
});
