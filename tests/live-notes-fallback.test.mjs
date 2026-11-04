import test from 'node:test';
import assert from 'node:assert/strict';
import { makeCorrector } from '../lib/live-correction.js';
import { LiveSession } from '../lib/live.js';
import { GeminiTiers } from '../lib/gemini.js';
import { storeLiveNotes, LIVE_NOTES } from '../lib/live-job.js';

/* After class: when the context correction left no memory and no notes (every batch failed or was skipped, or there was no model), saving the class still
   makes class notes from the transcript: one bounded request per chunk, in the same note shape, through the model the save already uses. With no model
   no notes are saved, and the caller can tell. */

const chinese = (id, length) => ({ id, en: `第${id}号桑德斯${'讲'.repeat(length)}`, zh: '', t: id * 1000, rev: id, zhState: 'none' });
const timeoutError = () => Object.assign(new Error('Model timed out after 20s'), { name: 'TimeoutError' });
const store = () => {
  const published = [];
  return { published, publishSources: async records => { published.push(...records); } };
};
// The owner's class shape: a long sentence, short ones, every batch times out, so every sentence is skipped and the class has no memory and no notes.
async function skippedClass(lengths = [900, 60]) {
  const calls = [];
  const correct = makeCorrector({ subject: '药学', complete: async (_s, prompt) => { calls.push(prompt); throw timeoutError(); } });
  const session = new LiveSession({ id: 'notes-fallback-class', title: '药学课', tiers: new GeminiTiers({}), correct,
    saved: { segments: lengths.map((length, i) => chinese(i + 1, length)) }, save: async () => {} });
  await session.correction.run();
  return { session, calls };
}
const reply = (summary, points) => JSON.stringify({ summary, points });

test('a class where every batch was skipped has no notes of its own', async () => {
  const { session } = await skippedClass();
  const snapshot = session.correction.snapshot();
  assert.deepEqual([snapshot.skipped, snapshot.memory.text, snapshot.notes.length], [2, '', 0]);
});

test('with a model, saving makes class notes from the transcript: a summary and key points that cite sentences', async () => {
  const { session } = await skippedClass();
  const prompts = [], s = store();
  const complete = async (system, prompt, options) => {
    prompts.push({ system, prompt, options });
    return reply('这堂课讲了山德斯的作用。', [{ text: '山德斯的作用', refs: [1] }, { text: '剂量', refs: [2] }, { text: '没有引用的要点', refs: [] }, { text: '引用不存在的句子', refs: [99] }]);
  };
  const id = await storeLiveNotes(s, session, 'zh', { complete });
  assert.ok(id, 'notes were stored');
  assert.equal(prompts.length, 1, 'one bounded request for a class that fits one chunk');
  assert.match(prompts[0].prompt, /\[1\] 第1号桑德斯/); assert.match(prompts[0].prompt, /\[2\] 第2号桑德斯/);
  assert.ok(prompts[0].prompt.length < LIVE_NOTES.chunkChars + 2000, 'bounded');
  const record = s.published[0];
  assert.equal(record.id, id);
  assert.deepEqual(record.live, { sessionId: 'notes-fallback-class', kind: 'notes' });
  assert.match(record.title, /药学课 · 课堂笔记/);
  assert.match(record.text, /## 累计摘要[\s\S]*这堂课讲了山德斯的作用。/);
  assert.match(record.text, /引用：句 1 · 00:01；句 2 · 00:02/);
  assert.match(record.text, /### 课堂记录 · 句 1 · 00:01[\s\S]*山德斯的作用/);
  assert.match(record.text, /### 课堂记录 · 句 2 · 00:02[\s\S]*剂量/);
  assert.doesNotMatch(record.text, /没有引用的要点|引用不存在的句子/, 'a key point without a real sentence behind it is dropped');
});

test('a class too long for one request is read in chunks, a bounded number of them, and the summaries join', async () => {
  const lengths = Array(12).fill(LIVE_NOTES.chunkChars / 3);
  const { session } = await skippedClass([10]);
  session.segments.splice(0, session.segments.length, ...lengths.map((length, i) => chinese(i + 1, length)));
  const prompts = [], s = store();
  const id = await storeLiveNotes(s, session, 'zh', { complete: async (_system, prompt) => {
    prompts.push(prompt);
    const first = Number(prompt.match(/\[(\d+)\]/)[1]);
    return reply(`第 ${prompts.length} 段摘要`, [{ text: `要点 ${first}`, refs: [first] }]);
  } });
  assert.ok(id);
  assert.ok(prompts.length > 1 && prompts.length <= LIVE_NOTES.maxChunks, `chunks: ${prompts.length}`);
  assert.ok(prompts.every(prompt => prompt.length <= LIVE_NOTES.chunkChars * 1.5), 'no request is bigger than a chunk');
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) assert.ok(prompts.some(prompt => prompt.includes(`[${n}] `)), `sentence ${n} is in some chunk`);
  const text = s.published[0].text;
  for (let i = 1; i <= prompts.length; i++) assert.match(text, new RegExp(`第 ${i} 段摘要`));
});

test('a class with no end bound still makes at most maxChunks requests', async () => {
  const { session } = await skippedClass([10]);
  session.segments.splice(0, session.segments.length, ...Array.from({ length: 40 }, (_, i) => chinese(i + 1, LIVE_NOTES.chunkChars / 2)));
  let calls = 0;
  await storeLiveNotes(store(), session, 'zh', { complete: async () => { calls++; return reply('摘要', [{ text: '要点', refs: [1] }]); } });
  assert.ok(calls <= LIVE_NOTES.maxChunks, `calls ${calls}`);
});

test('without a model no notes are saved, and the caller can tell', async () => {
  const { session } = await skippedClass();
  const s = store();
  assert.equal(await storeLiveNotes(s, session, 'zh'), null);
  assert.equal(await storeLiveNotes(s, session, 'zh', {}), null);
  assert.deepEqual(s.published, []);
});

test('a model that fails or answers nonsense saves no notes and does not fail the save', async () => {
  const { session } = await skippedClass();
  for (const complete of [async () => { throw timeoutError(); }, async () => 'not json at all', async () => reply('', []), async () => reply('', [{ text: '要点', refs: [99] }])]) {
    const s = store();
    assert.equal(await storeLiveNotes(s, session, 'zh', { complete }), null);
    assert.deepEqual(s.published, []);
  }
});

test('a summary alone is kept when its key points cite nothing real', async () => {
  const { session } = await skippedClass();
  const s = store();
  assert.ok(await storeLiveNotes(s, session, 'zh', { complete: async () => reply('只有摘要', [{ text: '要点', refs: [99] }]) }));
  assert.match(s.published[0].text, /只有摘要/); assert.doesNotMatch(s.published[0].text, /要点/);
});

test('the correction\'s own notes are used as before and the model is not asked', async () => {
  const { session } = await skippedClass();
  session.correction.memory = { text: '课程摘要', refs: [1] };
  session.correction.notes = [{ kind: 'record', text: '要点', refs: [1] }];
  const s = store();
  const id = await storeLiveNotes(s, session, 'zh', { complete: async () => { throw new Error('must not be called'); } });
  assert.ok(id); assert.match(s.published[0].text, /课程摘要/);
});

test('the notes follow the interface language', async () => {
  const { session } = await skippedClass();
  const s = store();
  await storeLiveNotes(s, session, 'en', { complete: async () => reply('A summary.', [{ text: 'A point', refs: [1] }]) });
  assert.match(s.published[0].text, /## Cumulative summary[\s\S]*A summary\./);
  assert.match(s.published[0].text, /### Class record · Sentence 1/);
  assert.match(s.published[0].title, /Class notes/);
});
