import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../../lib/service.js';
import { usageLedger } from '../../lib/model-usage.js';
import { reportUsage } from '../../lib/usage-scope.js';
import { listSaved } from '../../lib/live.js';
import { audioSwitch } from './audio-switch.mjs';

/* Shared fixtures of the S2-0 audio-family baseline tests (docs/plans/unified-job-runtime/s2-0-audio-baseline.md).
   Everything is a fake: no network, no key, a private library and DSH_HOME per test. */

export const KEY = 'AIzaAudioFamilyBase_000000000001';
/** What every fake host model reply reports to the usage scope (one call = this much). */
export const REPORTED = Object.freeze({ uncachedInputTokens: 100, outputTokens: 10 });

export const subtitleText = `[00:00:00.080] 朋友们唉
[00:00:01.900] 今天有点情绪低落
[00:01:09.550] 就连deep sk也涨价了
[00:01:19.949] 下个月要么你升级500道套餐`;

const json = body => new Response(JSON.stringify(body));
const geminiReply = text => json({ candidates: [{ content: { parts: [{ text }] } }], usageMetadata: {} });
export function wav(fill) {
  const data = Buffer.alloc(16000, fill), header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + data.length, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(8000, 24);
  header.writeUInt32LE(16000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** The step a text prompt asks for, from its system prompt. */
export const kindOfPrompt = system => system.includes('You proofread speech-to-text') ? 'proofread'
  : /translate paragraphs|You translate/.test(system) ? 'translate'
  : system.includes('one English title') || system.startsWith('Write one') ? 'title'
  : system.includes('re-examine suspected speech-recognition errors') ? 'review' : 'unknown';

/** A DSH-style text model: answers the four text steps deterministically, logs `kind` per call and reports a fixed token usage. */
export function hostModel(log, { failOn = () => false, corrections } = {}) {
  return async (system, prompt, options = {}) => {
    const kind = kindOfPrompt(system);
    log.push(kind);
    options.signal?.throwIfAborted();
    if (failOn(kind, log.filter(item => item === kind).length)) throw Object.assign(new Error(`${kind} refused`), { code: 'AUTH' });
    reportUsage({ ...REPORTED });
    const data = kind === 'title' ? {} : JSON.parse(prompt.split('\n\nYour previous')[0]);
    if (kind === 'proofread') return JSON.stringify({ corrections: corrections ?? [] });
    if (kind === 'translate') return JSON.stringify({ titleZh: '涨价', titleEn: 'Price Rises', paragraphs: data.paragraphs.map(p => ({ n: p.n, en: `EN ${p.text}`, zh: `译 ${p.text || p.en}` })) });
    if (kind === 'title') return JSON.stringify({ titleEn: 'Coding Plans Get Pricier' });
    if (kind === 'review') return JSON.stringify({ decisions: data.items.map(item => ({ n: item.n, verdict: 'apply', right: item.right, reason: 'ok' })) });
    throw new Error(`unexpected prompt: ${system.slice(0, 60)}`);
  };
}

/** The same text answers as `hostModel`, served as Gemini HTTP replies (the Gemini text route of subtitles, reviews and live saves). */
export function geminiTextFake(log) {
  const model = hostModel(log);
  return async (_url, init = {}) => {
    const body = JSON.parse(init.body);
    return geminiReply(await model(body.systemInstruction.parts[0].text, body.contents[0].parts[0].text, {}));
  };
}

/** A Gemini fake for transcription and text; `calls` is the ordered request log ("transcribe:A", "proofread:B", ...).
 * With `hold`, a transcription waits until `held.get(name)()` (or until its request is aborted). */
export function geminiFake({ failTranslate = () => false, hold = false } = {}) {
  const calls = [], held = new Map();
  const fetch = async (url, init = {}) => {
    const body = JSON.parse(init.body);
    if (String(url).includes('transcribe:')) {
      const audio = body.contents[0].parts.find(part => part.inlineData).inlineData.data;
      const name = Buffer.from(audio, 'base64').at(-1) === 1 ? 'A' : 'B';
      calls.push(`transcribe:${name}`);
      if (hold) await new Promise((resolve, reject) => { held.set(name, resolve); init.signal?.addEventListener('abort', () => reject(init.signal.reason), { once: true }); });
      return geminiReply(`${name} describes database transactions and indexes.`);
    }
    const system = body.systemInstruction.parts[0].text, prompt = body.contents[0].parts[0].text;
    const kind = system.startsWith('You proofread') ? 'proofread' : system.startsWith('You translate') ? 'translate' : 'title';
    const name = /B describes|"filename":"B/.test(prompt) ? 'B' : 'A';
    calls.push(`${kind}:${name}`);
    if (kind === 'proofread') return geminiReply('{"corrections":[]}');
    if (kind === 'title') return geminiReply('{"titleEn":"Database lecture"}');
    if (failTranslate(name)) return geminiReply('bad JSON');
    const payload = JSON.parse(prompt.split('\n\nYour previous')[0]);
    return geminiReply(JSON.stringify({ titleZh: '数据库', titleEn: 'Databases', paragraphs: payload.paragraphs.map(p => ({ n: p.n, zh: `${name} 的翻译。` })) }));
  };
  return { fetch, calls, held };
}

/**
 * A private library with a service on it. `open()` builds another service on the same folder (a restart: no in-memory job, retry closure or gate survives).
 * Options reach StudyService as they are (fetch, complete, notify, audioGate ...); `settings` go through audio.settings.set.
 */
export async function library(t, { settings = {}, ...options } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'audio-family-')), root = join(dir, 'library'), previous = process.env.DSH_HOME;
  process.env.DSH_HOME = join(dir, 'home');
  const services = [];
  t.after(async () => {
    // A live class writes its snapshot in the background: stop its writer before the folder goes, or the folder comes back.
    for (const service of services) for (const { id } of await listSaved(root).catch(() => [])) await service.runtime.liveSessions.registered(root, id)?.retirePersistence();
    if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous;
    await rm(dir, { recursive: true, force: true });
  });
  const open = async extra => {
    const service = new StudyService(root, { ...audioSwitch({ complete: options.complete }), ...options, ...extra });
    services.push(service);
    await service.call('audio.settings.set', settings);
    return service;
  };
  const service = await open();
  const state = () => service.store.read();
  const ledger = async () => (await usageLedger(root).summary()).byFeature.audio ?? null;
  return { dir, root, service, open, state, ledger };
}

/** A Gemini-routed library with two recordings, A.wav and B.wav (`a`, `b`), the request log `calls`, session notices and the batch folders. `keys` are the audio settings. */
export async function batchLibrary(t, { keys = { paidKey: KEY }, failTranslate, hold, ...extra } = {}) {
  const fake = geminiFake({ failTranslate: name => failTranslate?.(name) ?? false, hold }), notices = [];
  const lib = await library(t, { fetch: fake.fetch, notify: notice => notices.push(notice), settings: { textProvider: 'gemini', ...keys }, ...extra });
  const [a, b] = [join(lib.dir, 'A.wav'), join(lib.dir, 'B.wav')];
  await writeFile(a, wav(1)); await writeFile(b, wav(2));
  return { ...lib, ...fake, notices, a, b, folders: () => readdir(join(lib.root, 'audio-batches')).catch(() => []) };
}
/** The session-notification texts a service was given, and the inbox letters of one job. */
export const letters = (state, jobId) => state.inbox.filter(item => item.jobId === jobId).map(item => item.kind);

/** One transcript source (and its audioResults twin) whose first `count` unsure fixes await a review: `audio.corrections.review { sourceId: 'talk-1' }`. */
export async function seedReview(service, count, id = 'talk-1') {
  const skipped = Array.from({ length: count }, (_, i) => ({ wrong: `word${i}`, right: `term${i}`, context: `The word${i} is here.`, confidence: 'low', skipped: 'low-confidence' }));
  const record = { id, title: `${id} · 中英对照逐字稿`, text: skipped.map(item => item.context).join('\n\n'), courses: [],
    audio: { sourceIds: [id], corrections: { applied: [], appliedCount: 0, skipped, skippedCount: skipped.length } } };
  await service.store.update(state => { (state.sources ||= []).push(structuredClone(record)); (state.audioResults ||= []).push(structuredClone(record)); });
  return record;
}
