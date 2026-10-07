import test from 'node:test';
import assert from 'node:assert/strict';
import { loadUi } from './helpers/ui-module.mjs';
import { jobContract } from '../lib/job-contract.js';

/* The detail of an audio task speaks for ITS kind (S6-7: the real host showed a subtitle import saying no request had gone to the transcription service, with a
   transcription entry in the timeline's legend). Each kind names only the calls it can make. */

const { usageLine } = await loadUi(`export { usageLine } from './ui/tasks/task-facts.js';`);
const parallel = { limit: 3, effective: 3, lowest: 3 };
const card = (kind, detail = {}) => ({ contract: { ...jobContract({ type: 'audio-import', id: 'job-1', status: 'running', filename: 'x', startedAt: new Date().toISOString() }), kind,
  detail: { files: [{ status: 'running', phase: 'proofread', steps: {} }], parallel: { text: parallel }, ...detail } } });
const TEXT_ONLY = ['audio-subtitles', 'audio-review', 'audio-live-save', 'audio-live-correction'], TRANSCRIBING = ['audio-import', 'audio-batch'];

for (const kind of TEXT_ONLY) test(`${kind}: the request line says nothing about the transcription service, before and after its first request`, () => {
  for (const detail of [{}, { usage: { gemini: { free: 0, paid: 0 }, siliconflow: 0, groq: 0 }, textProvider: 'host' }]) {
    const line = usageLine(card(kind, detail));
    assert.doesNotMatch(line, /转写/, `"${line}"`);
  }
});

for (const kind of TRANSCRIBING) test(`${kind}: the request line still speaks for the transcription service`, () => {
  assert.match(usageLine(card(kind)), /还没有向转写服务发请求/);
});

test('a text-only task says what it does instead of nothing: the model asked, the parallel windows', () => {
  assert.match(usageLine(card('audio-subtitles')), /并行 3/);
  assert.ok(usageLine(card('audio-review', { files: [] })).length > 0, 'the line is never empty: the console keeps its height for every audio task');
});

test('the legend of the timeline names the calls of that kind only', async () => {
  const { timelineLegend } = await loadUi(`export { timelineLegend } from './ui/tasks/call-model.js';`);
  const names = kind => timelineLegend('audio', kind).map(([call]) => call);
  assert.deepEqual(names('audio-import'), ['transcribe', 'proofread', 'translate']);
  assert.deepEqual(names('audio-batch'), ['transcribe', 'proofread', 'translate']);
  assert.deepEqual(names('audio-subtitles'), ['proofread', 'translate']);
  assert.deepEqual(names('audio-live-save'), ['proofread', 'translate']);
  assert.deepEqual(names('audio-review'), ['proofread']);
  assert.deepEqual(names('audio-live-correction'), ['live.correct']);
  assert.deepEqual(names(undefined), ['transcribe', 'proofread', 'translate'], 'a task of the original path is one kind for all of them');
  assert.deepEqual(timelineLegend('coach').map(([call]) => call), ['prep']);
  assert.ok(timelineLegend('generation').length > 2);
});
