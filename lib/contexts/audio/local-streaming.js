/* Pure-JS streaming commit & backpressure primitives for local ASR (lib/live-local-worker.mjs).
   `LocalAgreement` is a lightweight JS port of the MIT-licensed LocalAgreement-2 algorithm from
   ufal/whisper_streaming (Macháček et al., 2023): an offline encoder-decoder model like Whisper
   re-decodes a sliding overlapping audio window and commits the longest common token prefix agreed
   upon across two consecutive passes, deduplicating the overlap tail so words at window boundaries
   are neither swallowed nor duplicated. */

import os from 'node:os';

const CJK_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const TOKEN_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}][.,!?;:，。！？；：、…]*|[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*[.,!?;:，。！？；：、…]*|[^\s]/gu;
const EDGE_PUNCT_RE = /^[.,!?;:，。！？；：、…"'“”‘’()（）[\]【】]+|[.,!?;:，。！？；：、…"'“”‘’()（）[\]【】]+$/g;
const LATIN_TAIL_RE = /[A-Za-z0-9]$/;
const LATIN_HEAD_RE = /^[A-Za-z0-9]/;
const ASCII_PUNCT_SPACE_RE = /[.,!?;:]$/;

/** Dynamic CPU thread count for sherpa-onnx (provider stays 'cpu' for official ORT compatibility). */
export function recommendedNumThreads({ cpus, override } = {}) {
  if (Number.isFinite(override) && override >= 1) {
    return Math.min(16, Math.max(1, Math.floor(override)));
  }
  const available = Number.isFinite(cpus) && cpus > 0 ? Math.floor(cpus) : (os.cpus()?.length || 4);
  return Math.min(6, Math.max(2, Math.floor(available / 2)));
}

/** Tokenize multilingual (CJK + Latin/digits) ASR output for prefix agreement & overlap alignment. */
export function tokenizeTranscript(text) {
  const input = String(text || '').trim();
  if (!input) return [];
  const matches = input.match(TOKEN_RE);
  if (!matches) return [];
  const tokens = [];
  for (const raw of matches) {
    const stripped = raw.replace(EDGE_PUNCT_RE, '').toLowerCase();
    const norm = stripped || raw.toLowerCase();
    tokens.push({ raw, norm, cjk: CJK_CHAR.test(raw[0]) });
  }
  return tokens;
}

/** Join tokens back into readable text (spaces between Latin words, compact CJK). */
export function joinTranscriptTokens(tokens) {
  if (!Array.isArray(tokens) || !tokens.length) return '';
  let out = '';
  for (const token of tokens) {
    const part = typeof token === 'string' ? token : token?.raw || '';
    if (!part) continue;
    if (!out) { out = part; continue; }
    const needsSpace = (LATIN_TAIL_RE.test(out) && LATIN_HEAD_RE.test(part))
      || (ASCII_PUNCT_SPACE_RE.test(out) && LATIN_HEAD_RE.test(part));
    out = needsSpace ? `${out} ${part}` : out + part;
  }
  return out.trim();
}

/**
 * Find how many leading tokens of `incoming` overlap with a suffix of `committed`.
 * Supports both full-prefix continuation (window not trimmed yet) and suffix overlap (after left-trim).
 */
function findOverlapPrefix(committed, incoming, maxOverlap = 32) {
  if (!committed.length || !incoming.length) return 0;
  // Fast path: full prefix match when the audio window has not yet been trimmed.
  if (incoming.length >= committed.length) {
    let fullMatch = true;
    for (let i = 0; i < committed.length; i += 1) {
      if (committed[i].norm !== incoming[i].norm) { fullMatch = false; break; }
    }
    if (fullMatch) return committed.length;
  }
  // Suffix-to-prefix overlap after sliding-window trim: search longest overlap first.
  const limit = Math.min(committed.length, incoming.length, maxOverlap);
  const minRequired = committed.length === 1 ? 1 : 2;
  for (let len = limit; len >= minRequired; len -= 1) {
    const offset = committed.length - len;
    let matches = true;
    for (let i = 0; i < len; i += 1) {
      if (committed[offset + i].norm !== incoming[i].norm) { matches = false; break; }
    }
    if (matches) return len;
  }
  // Fallback for a 1-token overlap only when committed ended with a distinctive non-trivial word (>= 3 chars).
  if (minRequired > 1 && committed.at(-1).norm.length >= 3 && committed.at(-1).norm === incoming[0].norm) {
    return 1;
  }
  return 0;
}

/**
 * MIT LocalAgreement-2 hypothesis buffer (ufal/whisper_streaming).
 * Commits the longest common prefix between two consecutive decodes of the sliding window.
 */
export class LocalAgreement {
  constructor({ maxCommittedHistory = 64 } = {}) {
    this.maxCommittedHistory = Math.max(8, maxCommittedHistory);
    this.committed = [];
    this.prevBuffer = [];
    this.seenUpdates = 0;
  }

  /** Whether any streaming hypothesis has been processed in the current utterance. */
  hasActivity() {
    return this.seenUpdates > 0 || this.committed.length > 0 || this.prevBuffer.length > 0;
  }

  /** Feed the latest full-window decode; returns newly confirmed stable text and remaining interim text. */
  insert(hypothesisText) {
    this.seenUpdates += 1;
    const incoming = tokenizeTranscript(hypothesisText);
    if (!incoming.length) return { confirmed: '', interim: joinTranscriptTokens(this.prevBuffer) };

    const overlap = findOverlapPrefix(this.committed, incoming, this.maxCommittedHistory);
    const fresh = incoming.slice(overlap);
    if (!fresh.length) {
      this.prevBuffer = [];
      return { confirmed: '', interim: '' };
    }

    let lcp = 0;
    const commonLimit = Math.min(this.prevBuffer.length, fresh.length);
    while (lcp < commonLimit && this.prevBuffer[lcp].norm === fresh[lcp].norm) lcp += 1;

    // Take tokens from `fresh` (latest pass has richer right context / punctuation).
    const confirmedTokens = fresh.slice(0, lcp);
    const unconfirmedTokens = fresh.slice(lcp);

    if (confirmedTokens.length) {
      this.committed.push(...confirmedTokens);
      if (this.committed.length > this.maxCommittedHistory) {
        this.committed = this.committed.slice(-this.maxCommittedHistory);
      }
    }
    this.prevBuffer = unconfirmedTokens;

    return {
      confirmed: joinTranscriptTokens(confirmedTokens),
      interim: joinTranscriptTokens(unconfirmedTokens),
    };
  }

  /** Flush remaining uncommitted text at a VAD silence boundary or stream end, then reset. */
  flush(finalHypothesisText) {
    let tailTokens = this.prevBuffer;
    if (typeof finalHypothesisText === 'string' && finalHypothesisText.trim()) {
      const incoming = tokenizeTranscript(finalHypothesisText);
      const overlap = findOverlapPrefix(this.committed, incoming, this.maxCommittedHistory);
      tailTokens = incoming.slice(overlap);
    }
    const text = joinTranscriptTokens(tailTokens);
    this.reset();
    return text;
  }

  reset() {
    this.committed = [];
    this.prevBuffer = [];
    this.seenUpdates = 0;
  }
}

/**
 * Simple adaptive backpressure controller for speculative streaming decodes.
 * Stretches the decode cadence when CPU decode time approaches real time or unread audio piles up,
 * and smoothly recovers once decodes become fast again — never dropping audio samples.
 */
export function createBackpressureController({
  sampleRate = 16000,
  baseStepSamples = sampleRate * 2,
  maxStepSamples = sampleRate * 6,
  backlogThresholdMs = 1500,
} = {}) {
  let stepSamples = Math.max(512, Math.round(baseStepSamples));
  const minStep = stepSamples;
  const maxStep = Math.max(minStep, Math.round(maxStepSamples));
  let lastDecodeMs = 0;
  let skipped = 0;

  return {
    shouldDecode(samplesSinceDecode, queueLagMs = 0) {
      if (samplesSinceDecode < stepSamples) return false;
      if (queueLagMs > backlogThresholdMs) {
        skipped += 1;
        return false;
      }
      return true;
    },
    recordDecode(decodeMs) {
      lastDecodeMs = Math.max(0, Number(decodeMs) || 0);
      const stepMs = (stepSamples / sampleRate) * 1000;
      if (lastDecodeMs > stepMs * 0.65) {
        stepSamples = Math.min(maxStep, Math.round(stepSamples * 1.5));
      } else if (lastDecodeMs < stepMs * 0.35 && stepSamples > minStep) {
        stepSamples = Math.max(minStep, Math.round(stepSamples * 0.8));
      }
    },
    reset() {
      stepSamples = minStep;
      lastDecodeMs = 0;
      skipped = 0;
    },
    state: () => ({ stepSamples, lastDecodeMs, skipped, overloaded: stepSamples > minStep }),
  };
}
