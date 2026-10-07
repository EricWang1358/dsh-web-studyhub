import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeSaved } from '../../lib/live.js';
import { KEY, hostModel, library, seedReview, subtitleText, wav } from './audio-family.mjs';
import { AUDIO_SWITCHES } from './audio-switch.mjs';
import { switchOptions } from './runtime-switch.mjs';
import { until } from './wait.mjs';

/* The audio side of the 任务 console regression (S6-5): one service whose switches the test can flip, a model and a transcription service that stay busy until the test lets
   them answer (so every kind can be looked at WHILE it runs), and one starter per kind of audio job. Nothing leaves the machine. */

export const ALL_SWITCHES = [...AUDIO_SWITCHES];
const reply = text => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }], usageMetadata: {} }));
/** Wait for a turn (`open` once everything is let through, or `queue` for one at a time) or for the request to be aborted (a cancelled job stops its request). */
const busy = (turn, signal) => Promise.race([turn, new Promise((_, reject) => { if (signal?.aborted) reject(signal.reason); else signal?.addEventListener('abort', () => reject(signal.reason), { once: true }); })]);

/** What a started job of each kind needs: its path's switch, the kind it has on the runtime, and the call that starts the n-th one (every n is another work, so none is a duplicate of another). */
export const KINDS = Object.freeze({
  single: { kind: 'audio-import', switchKey: 'audioSingle', start: (lib, n) => lib.service.call('audio.import', { path: lib.files[n] }) },
  batch: { kind: 'audio-batch', switchKey: 'audioBatch', start: (lib, n) => lib.service.call('audio.import', { files: [{ path: lib.files[n] }, { path: lib.files[n + 1] }], title: `Batch ${n}` }) },
  subtitles: { kind: 'audio-subtitles', switchKey: 'audioSubtitles', start: (lib, n) => lib.service.call('audio.subtitles.import', { filename: `pricing-${n}.txt`, text: subtitleText.replace('朋友们唉', `第 ${n} 位同学`) }) },
  review: { kind: 'audio-review', switchKey: 'audioReview', start: async (lib, n) => { await seedReview(lib.service, 2, `talk-${n}`); return lib.service.call('audio.corrections.review', { sourceId: `talk-${n}` }); } },
  save: { kind: 'audio-live-save', switchKey: 'audioLiveSave', start: async (lib, n) => { await savedClass(lib, n); return lib.service.call('live.save', { id: classId(n), proofread: true }); } },
  // The correction of a class: a job of the console only on the runtime; the original path leaves no card (D-12).
  correction: { kind: 'audio-live-correction', switchKey: 'audioLiveCorrection', start: async (lib, n) => { await savedClass(lib, n); await lib.service.call('live.correct', { id: classId(n) }); return correctionOf(lib, n); } },
});
const classId = n => `saved-class-${String(n).padStart(4, '0')}`;
const savedClass = (lib, n) => writeSaved(lib.root, { id: classId(n), title: `Databases class ${n}`, course: 'Databases',
  segments: [`Transactions preserve consistency across related database changes in class ${n}.`, `Partitioning splits one big table into smaller physical pieces in class ${n}.`].map((en, index) => ({ id: index + 1, t: index * 5000, en, zh: `译：${en}`, zhState: 'done' })) });
/** The receipt of a correction is the class itself; its job (when there is one) is found by its title. */
async function correctionOf(lib, n) {
  const title = `课堂校正 · Databases class ${n}`;
  const row = await until(async () => (await lib.service.call('snapshot')).jobs.find(job => (job.contract?.title ?? job.title) === title), `the correction job of class ${n}`, { timeoutMs: 3000 }).catch(() => null);
  return row ? { jobId: row.id } : null;
}

/**
 * A library whose switches can be flipped (`set(true, 'audioSingle', ...)`, a switch is read at the next submission), with eight recordings. Models and transcription
 * answer only after `release()`, or end when their job is cancelled.
 */
export async function consoleLibrary(t) {
  // Everything waits for a turn: `trickle(n)` lets the n oldest requests answer (so the jobs finish a few at a time, as they do for a learner), `release()` lets all of them.
  let release; const open = new Promise(resolve => { release = resolve; }), queue = [];
  const turn = () => Promise.race([open, new Promise(resolve => queue.push(resolve))]);
  const trickle = count => { for (const resolve of queue.splice(0, count)) resolve(); };
  const answer = hostModel([]);
  const blocked = async (system, prompt, options = {}) => { await busy(turn(), options.signal); return answer(system, prompt, options); };
  const fetch = async (url, init = {}) => { await busy(turn(), init.signal); return reply('A short lecture about database transactions and indexes.'); };
  const pilot = {}, { runtimePilot: _fixed, ...managed } = switchOptions('runtime', { complete: blocked, paths: [] });
  const lib = await library(t, { settings: { paidKey: KEY, textProvider: 'host', transcribeConcurrency: 3 }, fetch, complete: blocked, completeLight: blocked, ...managed, runtimePilot: pilot });
  t.after(release);
  const files = [];
  for (let fill = 1; fill <= 12; fill++) { const path = join(lib.dir, `W${fill}.wav`); await writeFile(path, wav(fill)); files[fill] = path; }
  return { ...lib, files, release, trickle, pilot, set: (value, ...names) => { for (const name of names) pilot[name] = value; } };
}

/** The card of a job as the console's snapshot lists it. */
export const cardOf = async (lib, id) => (await lib.service.call('snapshot')).jobs.find(job => job.id === id);
