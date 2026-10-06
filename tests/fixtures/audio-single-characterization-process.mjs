import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StudyService } from '../../lib/service.js';
import { flushAudioUsage } from '../../lib/audio-dashboard.js';
import { settleJob, until } from '../helpers/wait.mjs';

// Shared synthetic input/provider for both the in-process boundary test and a real restart.
// Neither the import nor either child process can reach a real provider.
export const TEST_KEY = 'AIzaCharacterization_000000000001';
export function wav() {
  const data = Buffer.alloc(16000, 1), header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + data.length, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(8000, 24);
  header.writeUInt32LE(16000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

export function fakeAudioService(root, { holdTranscription = false, runtimeOptions = {}, managed = false, responses = {} } = {}) {
  const calls = [], notifications = [], signals = [];
  let release, starts = 0;
  if (managed) runtimeOptions = { runtimePilot: { audioSingle: true }, workOwner: Symbol('controlled-audio-owner'),
    jobExecutor: { assertAvailable() {}, witness: () => ({ pid: process.pid, host: 'fixture', instance: 'controlled' }), inspect: () => ({ state: 'lost', reason: 'controlled' }),
      start({ run, cancel }) { void run(); return { id: `controlled-${++starts}`, ownerAgentId: 'controlled-owner', stop: cancel, append() {} }; } },
    jobModelHost: { ctx: {}, route: { provider: 'fixture', model: 'fixture' } }, ...runtimeOptions };
  const fetch = async (url, options) => {
    assertTranscription(url);
    calls.push('transcribe'); signals.push(options.signal);
    if (holdTranscription) await new Promise((resolve, reject) => {
      const abort = () => { options.signal.removeEventListener('abort', abort); reject(options.signal.reason); };
      release = () => { options.signal.removeEventListener('abort', abort); resolve(); };
      options.signal.addEventListener('abort', abort, { once: true });
      if (options.signal.aborted) abort();
    });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Today we discuss transactions and database indexes.' }] } }],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10 } }));
  };
  const complete = async (system, prompt, options) => {
    const kind = system.startsWith('You proofread') ? 'proofread' : system.startsWith('You translate') ? 'translate' : 'title';
    calls.push(kind);
    options.onEvent?.({ runtime: 'subagent', childId: `fake-child-${calls.length}`, status: 'running' });
    const reply = responses[kind] !== undefined ? responses[kind] : kind === 'proofread' ? '{"corrections":[]}' : kind === 'title' ? '{"titleEn":"Database Lecture"}'
      : JSON.stringify({ titleZh: '数据库', titleEn: 'Databases', paragraphs: JSON.parse(prompt).paragraphs.map(p => ({ n: p.n, zh: '数据库事务与索引。' })) });
    options.onOutput?.(reply);
    options.onEvent?.({ runtime: 'subagent', childId: `fake-child-${calls.length}`, status: 'complete' });
    return reply;
  };
  const service = new StudyService(root, { fetch, complete, notify: notice => { notifications.push(notice); }, ...runtimeOptions, ...(runtimeOptions.jobModelHost ? { jobModelHost: { ...runtimeOptions.jobModelHost, complete } } : {}) });
  return { service, calls, notifications, signals, release: () => release?.(), starts: () => starts };
}

function assertTranscription(url) {
  if (!String(url).includes('transcribe:')) throw new Error(`Unexpected fake HTTP request: ${url}`);
}

async function childMain(root, mode) {
  if (!['interrupt', 'resume'].includes(mode)) throw new Error('Unknown characterization fixture mode');
  const fixture = fakeAudioService(root, { holdTranscription: mode === 'interrupt' });
  const { service, calls } = fixture;
  let output;
  if (mode === 'interrupt') {
    await mkdir(root, { recursive: true });
    await service.call('audio.settings.set', { paidKey: TEST_KEY, textProvider: 'host', transcribeConcurrency: 1 });
    const path = join(root, 'lecture.wav'); await writeFile(path, wav());
    const started = await service.call('audio.import', { path, courses: ['Database course'] });
    await until(() => calls.includes('transcribe'), 'the single transcription to be in flight');
    const observed = (await service.call('snapshot')).jobs.find(job => job.id === started.jobId);
    const manifest = JSON.parse(await readFile(join(root, 'audio-batches', observed.singleId, 'manifest.json'), 'utf8'));
    output = { observed, manifest, calls };
    // The real request is still unresolved and the preparation manifest is durable.
    // End this process without invoking the job's finally/cancel path.
  } else {
    const before = (await service.call('snapshot')).jobs.find(job => job.type === 'audio-import');
    const callsBeforeRetry = [...calls];
    const started = await service.call('audio.retry', { jobId: before.id });
    const done = await settleJob(service, started.jobId);
    const snapshot = await service.call('snapshot');
    const observed = snapshot.jobs.find(job => job.id === done.id);
    const manifest = JSON.parse(await readFile(join(root, 'audio-batches', observed.singleId, 'manifest.json'), 'utf8'));
    await flushAudioUsage();
    output = { before, callsBeforeRetry, done, observed, manifest, calls, sources: snapshot.sources, jobs: snapshot.jobs };
  }
  await new Promise(resolve => process.stdout.write(JSON.stringify(output), resolve));
  process.exit(0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await childMain(...process.argv.slice(2));
