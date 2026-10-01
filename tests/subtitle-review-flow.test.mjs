import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStudyRuntime } from '../lib/runtime/builtins.js';
import { Store } from '../lib/store.js';
import { storeDocuments } from '../lib/audio-job.js';
import { domainTool } from '../lib/runtime/tools.js';

const subtitles = `[00:00:00.080] 朋友们唉
[00:00:01.900] 今天有点情绪低落
[00:01:09.550] 就连deep sk也涨价了
[00:01:19.949] 下个月要么你升级500道套餐`;

/** A DSH model that proofreads, translates, titles and reviews deterministically. */
function fakeModel(log) {
  return async (system, prompt) => {
    const data = JSON.parse(prompt);
    if (system.includes('You proofread speech-to-text')) {
      log.push('proofread');
      return JSON.stringify({ corrections: [
        { wrong: 'deep sk', right: 'DeepSeek', context: '就连deep sk也涨价了', reason: '模型名', confidence: 'high' },
        { wrong: '500道', right: '500刀', context: '升级500道套餐', reason: '美元口语', confidence: 'low' },
      ] });
    }
    if (system.includes('translate paragraphs of a Chinese')) {
      log.push('translate');
      return JSON.stringify({ titleZh: '涨价', titleEn: 'Price Rises', paragraphs: data.paragraphs.map(p => ({ n: p.n, en: `EN ${p.text}` })) });
    }
    if (system.includes('one English title')) return JSON.stringify({ titleEn: 'Coding Plans Get Pricier' });
    if (system.includes('re-examine suspected speech-recognition errors')) {
      log.push(`review:${data.items.length}`);
      return JSON.stringify({ decisions: data.items.map(item => ({ n: item.n, verdict: 'apply', right: item.right,
        translation: { wrong: '500道', right: '500刀' }, reason: '美元套餐' })) });
    }
    throw new Error(`unexpected prompt: ${system.slice(0, 60)}`);
  };
}

test('a subtitle file is proofread and translated without transcription, then its unsure fixes are reviewed into the transcript', async t => {
  const root = await mkdtemp(join(tmpdir(), 'study-subtitle-')), home = await mkdtemp(join(tmpdir(), 'study-subtitle-home-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const log = [];
  const runtime = createStudyRuntime(root, { contexts: ['audio', 'materials'], complete: fakeModel(log) });
  t.after(async () => {
    runtime.dispose();
    if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous;
    await rm(root, { recursive: true, force: true }); await rm(home, { recursive: true, force: true });
  });

  await assert.rejects(runtime.call('audio.subtitles.import', { filename: 'notes.txt', text: 'no timestamps here' }), /没有找到带时间戳的字幕/);
  const started = await runtime.call('audio.subtitles.import', { filename: 'pricing.txt', text: subtitles, title: '订阅涨价' });
  const imported = await runtime.call('audio.job.wait', { jobId: started.jobId, timeoutSeconds: 30 });
  assert.equal(imported.status, 'complete', imported.stage);
  assert.equal(imported.subtitle, true); assert.equal(imported.corrected, 1); assert.equal(imported.uncertain, 1);
  assert.ok(!log.includes('transcribe'));

  let state = await new Store(root).read();
  const source = state.sources.find(item => item.id === imported.sourceIds[0]);
  // Short pieces are not left as paragraphs of their own; the CJK-adjacent Latin fix is applied.
  assert.match(source.text, /【中文原文】\n\[0:00\] 朋友们唉，今天有点情绪低落，就连DeepSeek也涨价了，下个月要么你升级500道套餐/);
  assert.match(source.text, /【英文对照】\n\[0:00\] EN 朋友们唉/);
  assert.equal(source.audio.subtitle, true);
  assert.equal(source.audio.corrections.skipped.filter(item => item.skipped === 'low-confidence').length, 1);

  const changed = await runtime.call('audio.subtitles.import', { filename: 'pricing.txt', text: subtitles.replaceAll('[00:', '[01:'), title: '订阅涨价' });
  const changedDone = await runtime.call('audio.job.wait', { jobId: changed.jobId, timeoutSeconds: 30 });
  assert.equal(changedDone.status, 'complete', changedDone.stage);
  assert.notEqual(changedDone.sourceIds[0], source.id, 'updated timestamps create a new source even when its words are identical');
  const changedSource = (await new Store(root).read()).sources.find(item => item.id === changedDone.sourceIds[0]);
  assert.match(changedSource.text, /\[1:00:00\]/);

  const review = await runtime.call('audio.corrections.review', { sourceId: source.id });
  const reviewed = await runtime.call('audio.job.wait', { jobId: review.jobId, timeoutSeconds: 30 });
  assert.equal(reviewed.status, 'complete', reviewed.stage);
  assert.deepEqual(reviewed.review, { applied: 1, rejected: 0, unsure: 0 });
  assert.match(reviewed.stage, /改进正稿 1 处/);
  assert.deepEqual(log.filter(entry => entry.startsWith('review')), ['review:1']);

  state = await new Store(root).read();
  for (const record of [state.sources.find(item => item.id === source.id), state.audioResults.find(item => item.id === source.id)]) {
    assert.match(record.text, /升级500刀套餐/);
    assert.match(record.text, /EN .*升级500刀套餐/, 'the paired translation paragraph is corrected too');
    assert.equal(record.audio.corrections.appliedCount, 2);
    assert.ok(record.audio.corrections.applied.at(-1).reviewed);
  }
  await assert.rejects(runtime.call('audio.corrections.review', { sourceId: source.id }), /没有待复核的存疑处/);
});

test('standalone audio tool imports subtitles and reviews a later transcript volume, including legacy membership', async t => {
  const root = await mkdtemp(join(tmpdir(), 'study-audio-tool-')), home = await mkdtemp(join(tmpdir(), 'study-audio-tool-home-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const runtime = createStudyRuntime(root, { contexts: ['audio'], complete: fakeModel([]) });
  t.after(async () => {
    runtime.dispose();
    if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous;
    await rm(root, { recursive: true, force: true }); await rm(home, { recursive: true, force: true });
  });
  const tool = domainTool('audio', { resolveWorkspace: async () => root, requestServices: async () => ({}), forLibrary: () => runtime });
  for (const operation of ['audio.subtitles.import', 'audio.corrections.review']) assert.ok(tool.parameters.properties.operation.enum.includes(operation));
  for (const field of ['filename', 'text', 'sourceId']) assert.equal(tool.parameters.properties[field].type, 'string');
  const imported = await tool.execute({ operation: 'audio.subtitles.import', filename: 'a.txt', text: subtitles }, {});
  assert.equal((await tool.execute({ operation: 'job.wait', jobId: imported.jobId }, {})).status, 'complete');
  assert.deepEqual(runtime.describe().map(item => item.id), ['audio']);

  for (const legacy of [false, true]) {
    const ids = [`single-${legacy}`, `single-${legacy}-p2`], documents = ['First volume.', 'The patient is a database subdivision.'];
    const corrections = { applied: [], skipped: [{ wrong: 'patient', right: 'partition', context: documents[1], confidence: 'low', skipped: 'low-confidence' }] };
    await storeDocuments({ store: { publishSources: async sources => runtime.storage.update(state => { state.audioResults.push(...sources); }) },
      ids, documents, title: 'Two volumes', meta: { partCount: 2 }, corrections });
    if (legacy) await runtime.storage.update(state => { for (const record of state.audioResults.filter(record => ids.includes(record.id))) delete record.audio.sourceIds; });
    const started = await tool.execute({ operation: 'audio.corrections.review', sourceId: ids[1] }, {});
    const done = await tool.execute({ operation: 'job.wait', jobId: started.jobId }, {});
    assert.equal(done.status, 'complete', done.stage);
    const saved = await runtime.storage.read();
    assert.match(saved.audioResults.find(record => record.id === ids[1]).text, /The partition is/);
    assert.equal(saved.audioResults.find(record => record.id === ids[0]).audio.corrections.appliedCount, 1);
    await assert.rejects(tool.execute({ operation: 'audio.corrections.review', sourceId: ids[1] }, {}), /没有待复核/);
  }
});

test('public correction review keeps the first batch when the second fails or is cancelled', async t => {
  for (const outcome of ['failed', 'cancelled']) await t.test(outcome, async t => {
    const root = await mkdtemp(join(tmpdir(), 'study-review-batches-')), home = await mkdtemp(join(tmpdir(), 'study-review-batches-home-'));
    const previous = process.env.DSH_HOME;
    process.env.DSH_HOME = home;
    let calls = 0, entered;
    const secondEntered = new Promise(resolve => { entered = resolve; });
    const runtime = createStudyRuntime(root, { contexts: ['audio', 'materials'], complete: async (_system, prompt, { signal }) => {
      const { items } = JSON.parse(prompt);
      if (++calls === 1) return JSON.stringify({ decisions: items.map(item => ({ n: item.n, verdict: 'apply', right: item.right })) });
      entered();
      if (outcome === 'failed') throw Object.assign(new Error('credential rejected'), { code: 'AUTH' });
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    } });
    t.after(async () => {
      runtime.dispose();
      if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous;
      await rm(root, { recursive: true, force: true }); await rm(home, { recursive: true, force: true });
    });
    const skipped = Array.from({ length: 16 }, (_, n) => ({ wrong: `word${n}`, right: `term${n}`,
      context: `The word${n} is here.`, confidence: 'low', skipped: 'low-confidence' }));
    const record = { id: 'batch-source', title: 'Batch transcript', text: skipped.map(item => item.context).join('\n\n'),
      audio: { corrections: { applied: [], appliedCount: 0, skipped, skippedCount: skipped.length } } };
    await runtime.storage.update(state => { state.sources = [structuredClone(record)]; state.audioResults = [structuredClone(record)]; });
    const started = await runtime.call('audio.corrections.review', { sourceId: record.id });
    await secondEntered;
    if (outcome === 'cancelled') await runtime.call('audio.job.cancel', { jobId: started.jobId });
    const done = await runtime.call('audio.job.wait', { jobId: started.jobId, timeoutSeconds: 30 });
    assert.equal(done.status, outcome, done.stage);
    const saved = await runtime.storage.read();
    for (const item of [saved.sources[0], saved.audioResults[0]]) {
      assert.equal(item.audio.corrections.appliedCount, 15);
      assert.equal(item.audio.corrections.skipped.filter(item => !item.review).length, 1);
      assert.match(item.text, /The term0 is here/);
      assert.match(item.text, /The word15 is here/);
    }
  });
});
