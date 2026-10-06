import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { answerFor, kindOfPrompt, subtitleText, wav } from '../../helpers/audio-fakes.mjs';
import { endAfterMemberResult } from '../../helpers/audio-batch-child.mjs';
import { managedRuntimeOptions } from '../../helpers/runtime-switch.mjs';
import { settleJob, until } from '../../helpers/wait.mjs';

/* The S2-7 rollback drill, one step per process, every fake and no network (run it with run-drill.mjs):
     prepare <scenario>   the CURRENT code, every audio switch on, makes the finished artifacts or the unfinished work, then the process ENDS HARD (no dispose, no cleanup: a crash or a rollback);
     read <scenario>      a code tree (the fixed older one, or the current one) opens the same library and DSH home, reports what it sees, and with `act` goes on with the unfinished work.
   argv: mode, scenario, workdir, libRoot, switches ('on' | 'off'), act ('act' | 'look'). The result is one line, `RESULT <json>`. */

const [mode, scenario, work, libRoot, switches, act] = process.argv.slice(2);
const root = join(work, 'library'), recordings = join(work, 'recordings');
process.env.DSH_HOME = join(work, 'home');
const SWITCHES = ['audioSingle', 'audioBatch', 'audioSubtitles', 'audioReview', 'audioLiveCorrection', 'audioLiveSave'];
const digest = value => createHash('sha256').update(value).digest('hex').slice(0, 16);
const tree = name => import(pathToFileURL(join(libRoot, 'lib', name)).href);
const state = name => join(work, name);
const counts = { transcribe: 0, proofread: 0, translate: 0, title: 0, review: 0, correct: 0 };
const NAMES = { 1: 'A', 2: 'B', 3: 'C' };
const CLASS = 'saved-class-0001', SOURCE = 'talk-1';
const reply = text => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }], usageMetadata: {} }));
let heldCount = 0;

/* What stops the CURRENT process in the middle: a request that is never answered (it writes a marker so the driver knows it is in flight). */
const holds = new Set(mode === 'prepare' ? ({ single: ['proofread'], batch: ['transcribe:C'], text: ['proofread', 'review', 'correct'] }[scenario] ?? []) : []);
const hold = async (what, signal) => {
  if (!holds.has(what)) return;
  await writeFile(state(`held-${++heldCount}`), what);
  await new Promise((_, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true }));
};
const fetch = async (url, init = {}) => {
  const body = JSON.parse(init.body);
  if (!String(url).includes('transcribe:')) throw new Error(`the drill sends no text request over the network: ${url}`);
  const name = NAMES[Buffer.from(body.contents[0].parts.find(part => part.inlineData).inlineData.data, 'base64').at(-1)];
  counts.transcribe++;
  await hold(`transcribe:${name}`, init.signal);
  return reply(`${name} explains database indexes and transactions.`);
};
const complete = async (system, prompt, options = {}) => {
  const kind = kindOfPrompt(system);
  if (kind === 'unknown') {
    counts.correct++;
    await hold('correct', options.signal);
    const last = JSON.parse(prompt).items.at(-1).n;
    return JSON.stringify({ items: [], note: { text: '知识点', refs: [last] }, memory: { text: '摘要', refs: [last] }, followups: [] });
  }
  counts[kind]++;
  await hold(kind, options.signal);
  return answerFor(kind, prompt);
};

async function build({ withSwitches }) {
  const { StudyService } = await tree('service.js');
  const options = { fetch, complete, completeLight: complete };
  if (withSwitches) { const { starts: _starts, ...managed } = managedRuntimeOptions({ complete, paths: SWITCHES }); Object.assign(options, managed); }
  const service = new StudyService(root, options);
  await service.call('audio.settings.set', { paidKey: 'AIzaDrillAudio_00000000000000001', textProvider: 'host', transcribeConcurrency: 1 });
  return service;
}
const files = fills => fills.map(fill => ({ path: join(recordings, `W${fill}.wav`) }));
const seedReview = async service => {
  const skipped = Array.from({ length: 2 }, (_, i) => ({ wrong: `word${i}`, right: `term${i}`, context: `The word${i} is here.`, confidence: 'low', skipped: 'low-confidence' }));
  const record = { id: SOURCE, title: `${SOURCE} · 中英对照逐字稿`, text: skipped.map(item => item.context).join('\n\n'), courses: [],
    audio: { sourceIds: [SOURCE], corrections: { applied: [], appliedCount: 0, skipped, skippedCount: skipped.length } } };
  await service.store.update(data => { (data.sources ||= []).push(structuredClone(record)); (data.audioResults ||= []).push(structuredClone(record)); });
};
const saveClass = async () => (await tree('live.js')).writeSaved(root, { id: CLASS, title: 'Databases week 5', course: 'Databases',
  segments: ['Transactions preserve consistency.', 'Partitioning splits one big table.'].map((en, i) => ({ id: i + 1, t: i * 5000, en, zh: `译：${en}`, zhState: 'done' })) });
const covered = service => until(() => { const session = service.runtime.liveSessions.registered(root, CLASS), snapshot = session?.correction.snapshot(); return snapshot && snapshot.pending === 0 && !snapshot.running; }, 'the class correction');

/* What a code tree sees of the library, in words both versions can answer. */
async function view(service) {
  const data = await service.store.read(), jobs = (await service.call('snapshot')).jobs;
  const final = data.inbox.filter(item => ['audio-result', 'audio-failed'].includes(item.kind)).map(item => item.kind).sort();
  return { sources: data.sources.length, sourceHash: digest(data.sources.map(source => `${source.id}:${digest(String(source.text))}`).sort().join('|')),
    ids: data.sources.map(source => source.id.replace(/audio-batch-[0-9a-f-]{36}/, 'audio-batch-<id>')).sort(),
    closingLetters: final, jobs: jobs.map(job => `${job.status}${(job.contract?.actions?.retry?.available ?? job.retryable) ? '+retry' : ''}`).sort() };
}
const refusal = error => String(error.code ?? error.message).slice(0, 60);
const settled = async (service, start) => { try { const job = await settleJob(service, (await start()).jobId); return { status: job.status }; } catch (error) { return { refused: refusal(error) }; } };

/* "Go on with it": the retry the learner clicks (single, batch), or the same request again (the work that lives only in memory). */
const finishWork = {
  async retry(service) {
    const [job] = (await service.call('snapshot')).jobs, before = { ...counts };
    const result = await settled(service, () => service.call('audio.retry', { jobId: job.id }));
    return { ...result, requests: Object.fromEntries(Object.entries(counts).map(([kind, count]) => [kind, count - before[kind]]).filter(([, count]) => count)) };
  },
  async text(service) {
    const done = {};
    done.subtitles = await settled(service, () => service.call('audio.subtitles.import', { filename: 'pricing.txt', text: subtitleText, course: 'Pricing' }));
    done.review = await settled(service, () => service.call('audio.corrections.review', { sourceId: SOURCE }));
    done.save = await settled(service, () => service.call('live.save', { id: CLASS, proofread: true }));
    await service.call('live.correct', { id: CLASS }); await covered(service);
    done.correction = { covered: service.runtime.liveSessions.registered(root, CLASS).correction.snapshot().pending === 0 };
    return done;
  },
};
const PLAN = { settled: null, single: 'retry', batch: 'retry', batchAnswered: 'retry', text: 'text' };

if (mode === 'prepare') {
  await mkdir(recordings, { recursive: true });
  for (const fill of [1, 2, 3]) await writeFile(join(recordings, `W${fill}.wav`), wav(fill));
  const service = await build({ withSwitches: switches === 'on' });
  if (scenario === 'batchAnswered') await import(`data:text/javascript,${encodeURIComponent(endAfterMemberResult(1))}`); // ends this process when the last result is saved
  const crash = () => { console.log(`RESULT ${JSON.stringify({ scenario, prepared: true, endedHard: true })}`); process.exit(0); }; // no dispose, no cleanup
  if (scenario === 'settled') {
    await seedReview(service); await saveClass();
    const done = [await settled(service, () => service.call('audio.import', { path: join(recordings, 'W1.wav') })),
      await settled(service, () => service.call('audio.import', { files: files([2, 3]), title: 'Week 3' })),
      await settled(service, () => service.call('audio.subtitles.import', { filename: 'pricing.txt', text: subtitleText, course: 'Pricing' })),
      await settled(service, () => service.call('audio.corrections.review', { sourceId: SOURCE })),
      await settled(service, () => service.call('live.save', { id: CLASS, proofread: true }))];
    await service.call('live.correct', { id: CLASS }); await covered(service);
    await writeFile(state('prepared.json'), JSON.stringify({ ...await view(service), done }));
    await service.dispose();
  } else if (scenario === 'single') {
    await service.call('audio.import', { path: join(recordings, 'W1.wav') });
    await until(() => heldCount >= 1, 'the proofread request to be in flight', { timeoutMs: 240_000 });
    crash();
  } else if (scenario === 'batch') {
    await service.call('audio.import', { files: files([2, 3]), title: 'Week 3' });
    await until(() => heldCount >= 1, 'the second recording to be in flight', { timeoutMs: 240_000 });
    await until(async () => (await Promise.all((await readdir(join(root, 'audio-batches'))).map(folder => readFile(join(root, 'audio-batches', folder, 'manifest.json'), 'utf8').then(JSON.parse, () => null))))
      .some(manifest => manifest?.members?.[0]?.status === 'complete'), 'the first recording to be saved', { timeoutMs: 240_000 });
    crash();
  } else if (scenario === 'batchAnswered') {
    await service.call('audio.import', { files: files([2, 3]), title: 'Week 3' });
    await new Promise(() => {});
  } else if (scenario === 'text') {
    await seedReview(service); await saveClass();
    await service.call('audio.subtitles.import', { filename: 'pricing.txt', text: subtitleText, course: 'Pricing' });
    await service.call('audio.corrections.review', { sourceId: SOURCE });
    await service.call('live.save', { id: CLASS, proofread: true });
    await service.call('live.correct', { id: CLASS });
    await until(() => heldCount >= 4, 'four requests to be in flight', { timeoutMs: 240_000 });
    crash();
  }
  console.log(`RESULT ${JSON.stringify({ scenario, prepared: true })}`);
  process.exit(0);
}

const kinds = async (folder, prefix = '') => {
  const found = new Set();
  for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
    const name = `${prefix}${entry.name}`.replace(/[0-9a-f]{8}-[0-9a-f-]{27}|[0-9a-f]{8,}/g, '<id>');
    if (entry.isDirectory()) for (const kind of await kinds(join(folder, entry.name), `${name}/`)) found.add(kind); else found.add(name);
  }
  return found;
};

if (mode === 'read') {
  const lib = switches === 'on' ? 'current' : 'older', service = await build({ withSwitches: switches === 'on' });
  // A version that cannot read what the other one wrote says so; the drill records that, it does not stop.
  const seen = await view(service).catch(error => ({ unreadable: String(error.code ?? error.message).slice(0, 80) })), result = { scenario, lib, seen };
  if (seen.unreadable) { await service.dispose().catch(() => {}); console.log(`RESULT ${JSON.stringify(result)}`); process.exit(0); }
  if (act === 'act' && PLAN[scenario]) { result.finished = await finishWork[PLAN[scenario]](service); result.after = await view(service); }
  if (scenario === 'settled') { result.prepared = JSON.parse(await readFile(state('prepared.json'), 'utf8')); result.fileKinds = [...await kinds(root)].sort(); }
  await service.dispose();
  console.log(`RESULT ${JSON.stringify(result)}`);
  process.exit(0);
}
throw new Error(`unknown mode ${mode}`);
