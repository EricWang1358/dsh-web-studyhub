import { parseJson } from './generation.js';

/* Class notes from the transcript, for a class whose context correction left no memory and no notes (every batch failed or was skipped, or there was
   no model). One bounded request per chunk of the transcript through the model the save already uses; the answer becomes the same shape the correction
   writes (a cumulative memory and notes that cite sentences), so storeLiveNotes (lib/live-job.js) makes the same document either way. */

export const LIVE_NOTES = Object.freeze({
  /** Characters of transcript in one request. A class longer than `chunkChars * maxChunks` is read in `maxChunks` bigger chunks, never more requests. */
  chunkChars: 8000,
  maxChunks: 8,
  /** Key points kept per chunk. */
  pointsPerChunk: 8,
});

const SYSTEM = `You write class notes from a live-class transcript. The transcript is a list of sentences, each starting with its number in square brackets.
Reply with JSON only: {"summary": "...", "points": [{"text": "...", "refs": [3, 4]}]}.
- summary: 3 to 6 sentences on what this part of the class covered.
- points: the key points a student should remember (definitions, rules, examples, numbers, dates, assignments), each one sentence, each citing the numbers of the sentences it comes from in refs.
- Use only what the transcript says; do not add facts. The transcript may contain recognition errors; do not guess names or numbers that look wrong, say the point is uncertain.
- Write in the language named at the end.`;

/** The sentences of the class as chunks of whole lines `[id] text`, each about `size` characters (a longer sentence is a chunk of its own). */
function chunksOf(segments) {
  const lines = segments.map(segment => ({ id: segment.id, line: `[${segment.id}] ${segment.en}` }));
  const split = size => {
    const chunks = [];
    let current = [], chars = 0;
    for (const item of lines) {
      if (current.length && chars + item.line.length > size) { chunks.push(current); current = []; chars = 0; }
      current.push(item); chars += item.line.length + 1;
    }
    if (current.length) chunks.push(current);
    return chunks;
  };
  // Bigger chunks until there are few enough: the number of requests is bounded, the size of each is not.
  let size = LIVE_NOTES.chunkChars, chunks = split(size);
  while (chunks.length > LIVE_NOTES.maxChunks) chunks = split(size = Math.ceil(size * 1.15));
  return chunks;
}

const text = value => (typeof value === 'string' ? value.trim() : '');

/**
 * What the model made of one chunk, reduced to what can be trusted: a summary, and key points that cite at least one real sentence of the chunk.
 * Anything else the model wrote is dropped.
 */
function readChunk(raw, ids) {
  let value;
  try { value = parseJson(raw); } catch { return null; }
  const points = (Array.isArray(value?.points) ? value.points : []).map(point => ({ text: text(point?.text),
    refs: [...new Set((Array.isArray(point?.refs) ? point.refs : []).map(Number).filter(id => ids.has(id)))] }))
    .filter(point => point.text && point.refs.length).slice(0, LIVE_NOTES.pointsPerChunk);
  const summary = text(value?.summary);
  return summary || points.length ? { summary, points } : null;
}

/**
 * Notes from the transcript, in the shape of the correction's own: `{ memory: { text, refs }, notes: [{ kind: 'record', text, refs }] }`, or null when
 * nothing usable came back. `complete(system, prompt, options)` is the save's text model. A request that fails or is not understood costs only its own
 * chunk; the others still count.
 */
export async function notesFromTranscript(session, language, { complete, signal } = {}) {
  const segments = session.segments.filter(segment => segment.en);
  if (!complete || !segments.length) return null;
  const chunks = chunksOf(segments), summaries = [], notes = [], cited = [];
  const target = language === 'en' ? 'English' : 'Chinese (简体中文)';
  for (let index = 0; index < chunks.length; index++) {
    signal?.throwIfAborted();
    const ids = new Set(chunks[index].map(item => item.id));
    const prompt = `${session.subject ? `Subject: ${session.subject}\n` : ''}Part ${index + 1} of ${chunks.length}.\n\n${chunks[index].map(item => item.line).join('\n')}`;
    let raw;
    try {
      raw = await complete(`${SYSTEM}\n\nWrite in: ${target}.`, prompt, { signal, task: 'audio.notes', kind: 'notes', part: index + 1, parts: chunks.length,
        stage: `${language === 'en' ? 'Class notes' : '课堂笔记'} ${index + 1}/${chunks.length}` });
    } catch (error) { if (signal?.aborted) throw error; continue; }
    const read = readChunk(raw, ids);
    if (!read) continue;
    if (read.summary) summaries.push(read.summary);
    for (const point of read.points) { notes.push({ kind: 'record', text: point.text, refs: point.refs }); cited.push(...point.refs); }
  }
  if (!summaries.length && !notes.length) return null;
  return { memory: { text: summaries.join('\n\n'), refs: [...new Set(cited)].sort((a, b) => a - b) }, notes };
}
