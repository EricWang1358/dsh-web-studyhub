/* Offline long-WAV segmentation reusing the installed Silero VAD (silero_vad.onnx via sherpa-onnx)
   when present, with automatic smooth fallback to energy-based quiet-window splitting (`splitWavQuiet`).
   Never downloads anything and never fails an offline import if the local engine is absent or unusable:
   only the ±reach search windows around target cut points are scanned (typically 60 s per boundary),
   keeping CPU cost under ~50 ms per boundary even for multi-hour recordings. */

import { createRequire } from 'node:module';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { effectiveLiveLocal } from '../../live-local-install.js';
import { DEFAULT_LOCAL_MODEL, LOCAL_MODELS } from '../../live-local-models.js';

const VAD_SAMPLE_RATE = 16000;
const VAD_WINDOW = 512;
const MIN_GAP_SEC = 0.25;

/** Check whether an installed local live engine with `silero_vad.onnx` is ready on disk. Never throws. */
export async function detectInstalledVad({ resolveEngine } = {}) {
  const probe = resolveEngine || (modelId => effectiveLiveLocal({ modelId }));
  const order = [DEFAULT_LOCAL_MODEL, ...LOCAL_MODELS.map(m => m.id).filter(id => id !== DEFAULT_LOCAL_MODEL)];
  for (const modelId of order) {
    try {
      const found = await probe(modelId);
      if (!found?.enginePath || !found?.modelDir) continue;
      const vadModelPath = path.join(found.modelDir, 'silero_vad.onnx');
      const [engineStat, vadStat] = await Promise.all([
        stat(found.enginePath).catch(() => null),
        stat(vadModelPath).catch(() => null),
      ]);
      if (engineStat && vadStat?.isFile()) {
        return { enginePath: found.enginePath, vadModelPath, modelId };
      }
    } catch {
      // Fall through to next installed model or energy fallback.
    }
  }
  return null;
}

/**
 * Downmix a 16-bit PCM WAV byte slice `[startByte, endByte)` (relative to `info.dataStart`) to mono
 * and linearly resample to 16 kHz `Float32Array` in `[-1, 1]` for Silero VAD.
 */
export function extractMono16k(bytes, info, startByte, endByte) {
  const channels = Math.max(1, info.channels || 1);
  const frameBytes = Math.max(2, info.blockAlign || channels * 2);
  const clampedStart = Math.max(0, Math.floor(startByte / frameBytes) * frameBytes);
  const clampedEnd = Math.min(info.dataLength, Math.floor(endByte / frameBytes) * frameBytes);
  const srcFrames = Math.max(0, Math.floor((clampedEnd - clampedStart) / frameBytes));
  if (!srcFrames || !(info.sampleRate > 0)) return new Float32Array(0);

  const mono = new Float32Array(srcFrames);
  const invScale = 1 / (32768 * channels);
  for (let frame = 0; frame < srcFrames; frame += 1) {
    const base = info.dataStart + clampedStart + frame * frameBytes;
    let sum = 0;
    for (let ch = 0; ch < channels; ch += 1) {
      sum += bytes.readInt16LE(base + ch * 2);
    }
    mono[frame] = sum * invScale;
  }

  if (info.sampleRate === VAD_SAMPLE_RATE) return mono;
  const ratio = info.sampleRate / VAD_SAMPLE_RATE;
  const dstFrames = Math.max(1, Math.round(srcFrames / ratio));
  const resampled = new Float32Array(dstFrames);
  for (let i = 0; i < dstFrames; i += 1) {
    const srcPos = i * ratio;
    const lo = Math.min(srcFrames - 1, Math.floor(srcPos));
    const hi = Math.min(srcFrames - 1, lo + 1);
    const frac = srcPos - lo;
    resampled[i] = mono[lo] * (1 - frac) + mono[hi] * frac;
  }
  return resampled;
}

/**
 * Scan 16 kHz mono samples through a `sherpa.Vad` instance and return non-speech gaps
 * `[{ startSec, endSec, durationSec }]` within `[0, durationSec]`.
 */
export function findVadSpeechGaps(vad, samples, sampleRate = VAD_SAMPLE_RATE, windowSize = VAD_WINDOW) {
  const totalSec = samples.length / sampleRate;
  if (!samples.length) return [];
  const speechSpans = [];
  let inSpeech = false;
  let speechStartSample = 0;

  for (let at = 0; at < samples.length; at += windowSize) {
    const piece = samples.subarray(at, Math.min(at + windowSize, samples.length));
    vad.acceptWaveform(piece);
    while (!vad.isEmpty()) vad.pop();
    const detected = Boolean(vad.isDetected());
    if (detected && !inSpeech) {
      inSpeech = true;
      speechStartSample = at;
    } else if (!detected && inSpeech) {
      inSpeech = false;
      speechSpans.push([speechStartSample / sampleRate, Math.min(samples.length, at + piece.length) / sampleRate]);
    }
  }
  if (inSpeech) speechSpans.push([speechStartSample / sampleRate, totalSec]);
  if (typeof vad.flush === 'function') {
    vad.flush();
    while (!vad.isEmpty()) vad.pop();
  }

  if (!speechSpans.length) return [{ startSec: 0, endSec: totalSec, durationSec: totalSec }];
  const gaps = [];
  let cursor = 0;
  for (const [start, end] of speechSpans) {
    if (start > cursor) gaps.push({ startSec: cursor, endSec: start, durationSec: start - cursor });
    cursor = Math.max(cursor, end);
  }
  if (totalSec > cursor) gaps.push({ startSec: cursor, endSec: totalSec, durationSec: totalSec - cursor });
  return gaps;
}

/** Choose the best cut timestamp (absolute seconds) inside the search window, or null when no speech gap qualifies. */
export function pickBestVadCut({ gaps, windowStartSec, targetSec, minGapSec = MIN_GAP_SEC }) {
  const aimSec = targetSec;
  let best = null;
  let bestScore = Infinity;
  for (const gap of gaps) {
    if (gap.durationSec < minGapSec) continue;
    const mid = windowStartSec + (gap.startSec + gap.endSec) / 2;
    const dist = Math.abs(mid - aimSec);
    // Prefer closer pauses, with a gentle bonus for clearer pauses (>= 0.6 s).
    const bonus = Math.min(gap.durationSec, 1.5) * 2;
    const score = dist - bonus;
    if (score < bestScore) {
      bestScore = score;
      best = mid;
    }
  }
  return best;
}

function wavPiece(bytes, info, from, to) {
  const length = to - from;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1'); header.writeUInt32LE(36 + length, 4); header.write('WAVEfmt ', 8, 'latin1');
  header.writeUInt32LE(16, 16); header.writeUInt16LE(info.tag === 0xfffe ? 1 : info.tag, 20); header.writeUInt16LE(info.channels, 22);
  header.writeUInt32LE(info.sampleRate, 24); header.writeUInt32LE(info.byteRate, 28); header.writeUInt16LE(info.blockAlign, 32);
  header.writeUInt16LE(info.bits, 34); header.write('data', 36, 'latin1'); header.writeUInt32LE(length, 40);
  return { bytes: Buffer.concat([header, bytes.subarray(info.dataStart + from, info.dataStart + to)]), seconds: length / info.byteRate };
}

function quietCutFallback(bytes, info, lowByte, highByte) {
  const align = n => Math.floor(n / info.blockAlign) * info.blockAlign;
  const hopFrames = Math.max(1, Math.round(info.sampleRate * 0.1));
  const hopBytes = hopFrames * info.blockAlign;
  const startBlock = Math.floor(lowByte / hopBytes);
  const endBlock = Math.floor(highByte / hopBytes) - 1;
  if (endBlock <= startBlock) return align(Math.round((lowByte + highByte) / 2));
  let best = -1, quiet = Infinity;
  let prevEnergy = null;
  for (let b = startBlock; b <= endBlock + 1; b += 1) {
    let sum = 0;
    const base = info.dataStart + b * hopBytes;
    const stop = Math.min(info.dataStart + info.dataLength, base + hopBytes);
    for (let at = base; at + 1 < stop; at += 2) {
      const v = bytes.readInt16LE(at);
      sum += v * v;
    }
    const curEnergy = sum / Math.max(1, (stop - base) / 2);
    if (prevEnergy !== null) {
      const pair = prevEnergy + curEnergy;
      if (pair < quiet) { quiet = pair; best = b - 1; }
    }
    prevEnergy = curEnergy;
  }
  return best >= 0 ? align((best + 1) * hopBytes) : align(Math.round((lowByte + highByte) / 2));
}

/**
 * Split a 16-bit PCM WAV into `parts` pieces using installed `silero_vad.onnx` speech pauses around each
 * target boundary, falling back smoothly to `fallbackSplit` (`splitWavQuiet`) when VAD is not installed or fails.
 */
export async function splitWavWithVad(bytes, info, parts, {
  reach = 30,
  vad: explicitVad,
  resolveEngine,
  loadEngine,
  fallbackSplit,
} = {}) {
  const fallback = () => ({ chunks: fallbackSplit(bytes, info, parts, reach), strategy: 'energy-quiet' });
  if (parts <= 1 || !info || info.tag !== 1 || info.bits !== 16 || !(info.byteRate > 0) || explicitVad === false) {
    return fallback();
  }
  const detected = explicitVad && typeof explicitVad === 'object' ? explicitVad : await detectInstalledVad({ resolveEngine });
  if (!detected?.enginePath || !detected?.vadModelPath) return fallback();

  let sherpa;
  try {
    sherpa = loadEngine ? await loadEngine(detected.enginePath) : createRequire(import.meta.url)(detected.enginePath);
  } catch {
    return fallback();
  }
  if (typeof sherpa?.Vad !== 'function') return fallback();

  try {
    const align = n => Math.floor(n / info.blockAlign) * info.blockAlign;
    const reachBytes = align(Math.round(reach * info.byteRate));
    const cuts = [0];
    let usedVadCuts = 0;

    for (let part = 1; part < parts; part += 1) {
      const targetByte = align(Math.round((info.dataLength * part) / parts));
      const lowByte = Math.max(cuts.at(-1) + info.blockAlign, targetByte - reachBytes);
      const highByte = Math.min(info.dataLength - info.blockAlign, targetByte + reachBytes);
      if (highByte <= lowByte) {
        cuts.push(targetByte);
        continue;
      }
      const samples = extractMono16k(bytes, info, lowByte, highByte);
      const vad = new sherpa.Vad({
        sileroVad: {
          model: detected.vadModelPath,
          threshold: 0.5,
          minSilenceDuration: 0.35,
          minSpeechDuration: 0.25,
          maxSpeechDuration: 30,
          windowSize: VAD_WINDOW,
        },
        sampleRate: VAD_SAMPLE_RATE,
      }, 90);
      const gaps = findVadSpeechGaps(vad, samples, VAD_SAMPLE_RATE, VAD_WINDOW);
      const windowStartSec = lowByte / info.byteRate;
      const targetSec = targetByte / info.byteRate;
      const pickedSec = pickBestVadCut({ gaps, windowStartSec, targetSec });
      if (pickedSec !== null) {
        const cutByte = Math.min(highByte, Math.max(lowByte, align(Math.round(pickedSec * info.byteRate))));
        cuts.push(cutByte);
        usedVadCuts += 1;
      } else {
        cuts.push(quietCutFallback(bytes, info, lowByte, highByte));
      }
    }
    cuts.push(info.dataLength);
    const chunks = cuts.slice(0, -1).map((from, i) => wavPiece(bytes, info, from, cuts[i + 1])).filter(piece => piece.seconds > 0);
    if (!chunks.length) return fallback();
    return { chunks, strategy: usedVadCuts > 0 ? 'silero-vad' : 'energy-quiet' };
  } catch {
    return fallback();
  }
}
