import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { finishTranscript } from '../lib/audio-import.js';
import { createPool } from '../lib/audio-pool.js';
import { withQualityStages } from './helpers/assessment.mjs';
import { settleJob } from './helpers/wait.mjs';

// WP-TC step 2, through the real service: a generation run and an audio text step leave their calls on the job, with slots, and the
// snapshot carries them while the chat tools do not.

const source = { id: 'page-a', title: 'Book p.1', text: "Architecture includes the principles guiding a system's design and evolution over time." };
const card = (n) => ({ id: `q${n}`, kind: 'flashcard', topic: 'Architecture', objective: `Target ${n}`, prompt: `Question ${n}: what does the passage establish?`,
  answer: `Answer ${n}.`, hint: 'Think about scope.', explanation: 'The passage states it.', misconception: 'Confusing scope.', citations: [{ sourceId: source.id, quote: source.text }] });

test('a generation job lists its model calls in the snapshot, each with a stage and a slot, and logs its status changes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'study-calls-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root);
  await service.call('source.add', source);
  service.complete = withQualityStages(async (system, prompt) => {
    if (system.includes('editor')) return JSON.stringify({ issues: [] });
    const request = JSON.parse(prompt.split('REQUEST DATA:\n')[1]);
    return JSON.stringify({ title: 'D', cards: Array.from({ length: request.count }, (_, index) => ({ ...card(index + 1), id: `n${index + 1}`, objective: `New ${index + 1}` })) });
  });
  const started = await service.call('generate', { sourceIds: [source.id], count: 1, kind: 'flashcard' });
  const done = await settleJob(service, started.jobId);
  assert.equal(done.status, 'complete', done.stage);
  assert.equal('calls' in done, false, 'the chat tools get the lean job');
  assert.equal('events' in done, false);

  const snapshot = await service.call('snapshot');
  const job = snapshot.jobs.find((item) => item.id === started.jobId);
  assert.ok(job.calls.length >= 3, `plan, answer, write and review calls: ${job.calls.length}`);
  assert.ok(job.calls.every((call) => call.status === 'ok' && call.endedAt && Number.isInteger(call.slot) && call.slot >= 1), JSON.stringify(job.calls[0]));
  assert.ok(job.calls.some((call) => call.kind === 'plan') && job.calls.some((call) => call.kind === 'author') && job.calls.some((call) => call.kind === 'review'));
  assert.ok(job.events.some((event) => event.code === 'status' && event.level === 'done'), 'the end of the job is a line of the log');
  assert.equal('waits' in job, false);
  assert.equal('root' in job, false);
});

test('the proofread and translate calls of an audio import carry the slot they ran in', async () => {
  const paragraphs = Array.from({ length: 400 }, (_, index) => `Paragraph ${index + 1} of the lecture about software architecture.`);
  const seen = [];
  let active = 0, peak = 0;
  const complete = async (system, prompt, options) => {
    seen.push([options.kind, options.slot]);
    active++; peak = Math.max(peak, active);
    try {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return options.kind === 'proofread' ? '{"corrections":[]}' : JSON.stringify({ titleEn: 'P', titleZh: '部分', paragraphs: JSON.parse(prompt).paragraphs.map((item) => ({ n: item.n, zh: 'Translation' })) });
    } finally { active--; }
  };
  const pool = createPool({ limit: 3 });
  await finishTranscript({ paragraphs, filename: 'lecture.wav', settings: { textConcurrency: 3 }, complete, saved: { get: async () => null, set: async () => {} },
    keys: { raw: 'r', text: 't' }, pools: { text: pool } });
  const texts = seen.filter(([kind]) => ['proofread', 'translate'].includes(kind));
  assert.ok(texts.length >= 4);
  assert.ok(texts.every(([, slot]) => Number.isInteger(slot) && slot >= 1 && slot <= 3), JSON.stringify(texts));
  assert.ok(new Set(texts.map(([, slot]) => slot)).size >= 2, 'with several windows in flight more than one lane is used');
  assert.ok(peak <= 3);
});
