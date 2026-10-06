import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fakeAudioService, TEST_KEY, wav } from './audio-single-characterization-process.mjs';
import { settleJob, until } from '../helpers/wait.mjs';
import { flushAudioUsage } from '../../lib/audio-dashboard.js';

const [root, mode] = process.argv.slice(2);
if (!['pause', 'resume', 'interrupt', 'refuse'].includes(mode)) throw new Error('Unknown managed audio fixture mode');
const owner = Symbol('controlled process owner');
let output;
if (mode === 'pause' || mode === 'interrupt') {
  await mkdir(root, { recursive: true });
  const f = fakeAudioService(root, { managed: true, holdTranscription: true, runtimeOptions: { workOwner: owner } });
  await f.service.call('audio.settings.set', { paidKey: TEST_KEY, textProvider: 'host', transcribeConcurrency: 1 });
  const path = join(root, 'restart.wav'); await writeFile(path, wav());
  const started = await f.service.call('audio.import', { path });
  await until(() => f.calls.includes('transcribe'), 'controlled request in flight');
  if (mode === 'pause') {
    await f.service.call('job.control', { jobId: started.jobId, action: 'set', patch: { textConcurrency: 2 } });
    await f.service.call('job.control', { jobId: started.jobId, action: 'pause' }); f.release();
    await until(async () => (await f.service.call('snapshot')).jobs.find(job => job.id === started.jobId).contract.status === 'paused', 'saved pipeline pause');
    await flushAudioUsage();
  }
  output = { job: (await f.service.call('snapshot')).jobs.find(job => job.id === started.jobId), calls: f.calls, starts: f.starts() };
} else {
  // Read with no executor/model binding, then use a later legitimate request's
  // controlled executor on this same runtime. No fake Agent exists in production.
  const cold = fakeAudioService(root, { runtimeOptions: { workOwner: owner } });
  const before = (await cold.service.call('snapshot')).jobs.find(job => job.type === 'audio-import');
  const f = fakeAudioService(root, { managed: true, runtimeOptions: { workOwner: owner, runtime: cold.service.runtime } });
  const callsBefore = [...cold.calls, ...f.calls];
  if (mode === 'resume') {
    await f.service.call('job.control', { jobId: before.id, action: 'resume' });
    const done = await settleJob(f.service, before.id), snapshot = await f.service.call('snapshot');
    output = { before, callsBefore, done, job: snapshot.jobs.find(job => job.id === before.id), sources: snapshot.sources,
      notifications: f.notifications, calls: f.calls, starts: f.starts() };
  } else {
    let refusal;
    try { await f.service.call('audio.retry', { jobId: before.id }); } catch (error) { refusal = error.code || error.message; }
    output = { before, callsBefore, refusal, calls: f.calls, starts: f.starts(), job: (await f.service.call('snapshot')).jobs.find(job => job.id === before.id) };
  }
  await f.service.dispose(); await flushAudioUsage();
}
await new Promise(resolve => process.stdout.write(JSON.stringify(output), resolve));
process.exit(0);
