import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { StudyService } from '../../lib/service.js';
import { settleJob } from '../helpers/wait.mjs';

const [root, mode] = process.argv.slice(2);
let transcriptions = 0;
const reply = text => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }], usageMetadata: {} }));
const fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  if (String(url).includes('transcribe:')) { transcriptions++; return reply('今天讲解持久化与索引。'); }
  const system = body.systemInstruction.parts[0].text, prompt = body.contents[0].parts[0].text;
  if (system.startsWith('You proofread')) return reply('{"corrections":[]}');
  if (system.startsWith('You translate')) return reply(JSON.stringify({ titleZh: '持久化', titleEn: 'Persistence',
    paragraphs: JSON.parse(prompt).paragraphs.map(p => ({ n: p.n, zh: '持久化译文。', en: 'Persistence.' })) }));
  return reply('{"titleEn":"Persistence"}');
};
const complete = async (system, prompt) => {
  if (mode === 'fail') throw new Error('Study subagent error');
  if (system.startsWith('You proofread')) return '{"corrections":[]}';
  if (system.startsWith('You translate')) return JSON.stringify({ titleZh: '持久化', titleEn: 'Persistence',
    paragraphs: JSON.parse(prompt).paragraphs.map(p => ({ n: p.n, zh: '持久化译文。', en: 'Persistence.' })) });
  return '{"titleEn":"Persistence"}';
};
const service = new StudyService(root, { fetch, complete });
if (mode === 'fail') {
  await mkdir(root, { recursive: true });
  await service.call('audio.settings.set', { paidKey: 'AIzaSingleRestart_0000000000001', textProvider: 'host' });
  const data = Buffer.alloc(16000, 1), header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + data.length, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(8000, 24);
  header.writeUInt32LE(16000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(data.length, 40);
  const file = join(root, 'lecture.mp3'); await writeFile(file, Buffer.concat([header, data]));
  const started = await service.call('audio.import', { path: file, course: '' });
  const failed = await settleJob(service, started.jobId);
  process.stdout.write(JSON.stringify({ failed, transcriptions }));
} else {
  const before = (await service.call('snapshot')).jobs.find(job => job.type === 'audio-import');
  const beforeCalls = transcriptions;
  const started = await service.call('audio.retry', { jobId: before.id });
  const done = await settleJob(service, started.jobId);
  process.stdout.write(JSON.stringify({ before, beforeCalls, done, transcriptions }));
}
