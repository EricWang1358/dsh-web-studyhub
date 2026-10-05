import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { StudyService } from '../../lib/service.js';
import { settleJob } from '../helpers/wait.mjs';

const [root, mode] = process.argv.slice(2), calls = [], transcribed = [];
const reply = text => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }], usageMetadata: {} }));
const fetch = async (url, init) => {
  const body = JSON.parse(init.body); calls.push(String(url));
  if (String(url).includes('transcribe:')) {
    const bytes = Buffer.from(body.contents[0].parts.find(part => part.inlineData).inlineData.data, 'base64');
    const name = bytes.at(-1) === 1 ? 'A' : 'B'; transcribed.push(name);
    if (mode === 'interrupt' && name === 'B') await new Promise(() => {});
    return reply(`${name} explains database indexes and transactions.`);
  }
  const system = body.systemInstruction.parts[0].text, prompt = body.contents[0].parts[0].text;
  if (system.startsWith('You proofread')) return reply('{"corrections":[]}');
  if (system.startsWith('You translate')) return reply(JSON.stringify({ titleZh: '数据库', titleEn: 'Databases', paragraphs: JSON.parse(prompt).paragraphs.map(p => ({ n: p.n, zh: '数据库译文。' })) }));
  return reply('{"titleEn":"Lecture"}');
};
const service = new StudyService(root, { fetch });
if (mode === 'interrupt') {
  await mkdir(root, { recursive: true });
  await service.call('audio.settings.set', { paidKey: 'AIzaRestartBatch_000000000000001', textProvider: 'gemini', transcribeConcurrency: 1 });
  const bytes = fill => {
    const data = Buffer.alloc(16000, fill), header = Buffer.alloc(44);
    header.write('RIFF'); header.writeUInt32LE(36 + data.length, 4); header.write('WAVEfmt ', 8);
    header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(8000, 24);
    header.writeUInt32LE(16000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(data.length, 40);
    return Buffer.concat([header, data]);
  };
  const a = join(root, 'A.wav'); await writeFile(a, bytes(1));
  const b = bytes(2), { uploadId } = await service.call('audio.upload.start', { name: 'B.wav', size: b.length });
  await service.call('audio.upload.chunk', { uploadId, offset: 0, data: b.toString('base64') });
  await service.call('audio.upload.finish', { uploadId });
  const started = await service.call('audio.import', { files: [{ path: a }, { uploadId }], courses: ['Frozen A'] });
  // The manifest is replaced while this reads it (a half-written read is read again) and a busy machine can take long: wait for the condition, not for a count of polls.
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const batch = await readFile(join(root, 'audio-batches', started.batchId, 'manifest.json'), 'utf8').then(JSON.parse, () => null);
    if (batch?.members[0].status === 'complete') { process.stdout.write(JSON.stringify(started)); process.exit(0); }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('First member never completed');
} else {
  const before = (await service.call('snapshot')).jobs[0], callsBeforeRetry = calls.length;
  // A fresh upload invokes stale-upload pruning; the unfinished batch owns an independent copy.
  const upload = await service.call('audio.upload.start', { name: 'new.wav', size: 1 });
  await service.call('audio.upload.cancel', upload);
  const started = await service.call('audio.retry', { jobId: before.id });
  const done = await settleJob(service, started.jobId);
  const state = await service.store.read();
  process.stdout.write(JSON.stringify({ before, callsBeforeRetry, done, transcribed, sources: state.sources,
    oldFailureLetters: state.inbox.filter(item => item.jobId === before.id && item.kind === 'audio-failed').length }));
}
