// Ported from BAXUIE's StudyHub for ZCode 0.4.8 (MIT).
/* Smoke test of the local live engine with the real model: a LiveSession over the installed engine (no panel, no Gemini, no microphone).

   It drives lib/live.js exactly as live.start does for a class on the local engine (LocalTiers, the loopback socket, PCM pushed in the panel's
   300 ms batches) and checks that finished sentences land in the session. The engine is StudyHub's own install (Settings › Audio transcription ›
   本地（不联网）, under DSH_HOME); nothing is downloaded here.

   Run: node scripts/live-local-smoke.mjs <16 kHz mono 16-bit wav> [--expect <text that must be heard>] */

import { readFileSync } from 'node:fs';
import { LiveSession } from '../lib/live.js';
import { LocalTiers, loopbackFactory } from '../lib/live-local.js';
import { effectiveLiveLocal } from '../lib/live-local-install.js';

const args = process.argv.slice(2), wavPath = args.find(arg => !arg.startsWith('--')), expect = args.includes('--expect') ? args[args.indexOf('--expect') + 1] : '';
if (!wavPath) { console.error('usage: node scripts/live-local-smoke.mjs <16kHz-mono-wav> [--expect <text>]'); process.exit(2); }
const engine = await effectiveLiveLocal();
if (!engine) { console.error('The local engine is not installed (Settings › Audio transcription › Local); DSH_HOME decides which install is read.'); process.exit(2); }

/** The PCM of a RIFF file: the data chunk, found by walking the chunks rather than trusting a 44-byte header. */
function pcmOf(buffer) {
  if (buffer.readUInt32LE(24) !== 16000 || buffer.readUInt16LE(22) !== 1 || buffer.readUInt16LE(34) !== 16) throw new Error('the wav must be 16 kHz, mono, 16-bit');
  let at = 12;
  while (at + 8 <= buffer.length) {
    const id = buffer.toString('ascii', at, at + 4), size = buffer.readUInt32LE(at + 4);
    if (id === 'data') return buffer.subarray(at + 8, at + 8 + size);
    at += 8 + size + (size % 2);
  }
  throw new Error('the wav has no data chunk');
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const pcm = pcmOf(readFileSync(wavPath));
console.log(`engine: ${engine.enginePath}`);
console.log(`model:  ${engine.modelDir}`);
console.log(`audio:  ${(pcm.length / 32000).toFixed(1)} s of 16 kHz PCM`);

let saves = 0;
const session = new LiveSession({ title: 'local engine smoke', tiers: new LocalTiers(), WebSocketImpl: loopbackFactory(engine), translate: null, save: async () => { saves += 1; } });
const began = Date.now();
await session.start();
console.log(`started: status=${session.status} tier=${session.conn?.tier} after ${Date.now() - began} ms`);
const BATCH = 9600; // 300 ms, the panel's own batch size
const streamed = Date.now();
for (let at = 0; at < pcm.length; at += BATCH) {
  session.push(pcm.subarray(at, Math.min(at + BATCH, pcm.length)));
  await sleep(300); // real time: what a class sends
}
await session.stop();
const snap = session.snapshot(0);
console.log(`ended: status=${snap.status} saves=${saves} usage=${JSON.stringify(snap.usage)} warnings=${JSON.stringify(snap.warnings)} streamed in ${Date.now() - streamed} ms`);
for (const segment of snap.segments) console.log(`[${(segment.t / 1000).toFixed(1)}s] ${segment.en}`);
const text = snap.segments.map(segment => segment.en).join('');
const ok = snap.segments.length >= 1 && snap.status === 'ended' && !snap.warnings.length && (!expect || text.includes(expect));
console.log(ok ? 'SMOKE PASS' : 'SMOKE FAIL');
process.exit(ok ? 0 : 1);
