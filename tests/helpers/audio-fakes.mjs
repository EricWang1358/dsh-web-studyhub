/* The pure fakes of the audio tests: sound, subtitle text and what a text model answers for each step. This file imports no code of the application, so a
   process that opens an OLDER copy of it (the rollback drill) can use the same fakes without loading two versions of one module. */

export const subtitleText = `[00:00:00.080] 朋友们唉
[00:00:01.900] 今天有点情绪低落
[00:01:09.550] 就连deep sk也涨价了
[00:01:19.949] 下个月要么你升级500道套餐`;

/** A short mono 8 kHz recording whose last byte is `fill` (what the fakes tell recordings apart by). */
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

/** The deterministic answer of a text model to one step (the text of its reply). */
export function answerFor(kind, prompt, { corrections } = {}) {
  const data = kind === 'title' ? {} : JSON.parse(prompt.split('\n\nYour previous')[0]);
  if (kind === 'proofread') return JSON.stringify({ corrections: corrections ?? [] });
  if (kind === 'translate') return JSON.stringify({ titleZh: '涨价', titleEn: 'Price Rises', paragraphs: data.paragraphs.map(p => ({ n: p.n, en: `EN ${p.text}`, zh: `译 ${p.text || p.en}` })) });
  if (kind === 'title') return JSON.stringify({ titleEn: 'Coding Plans Get Pricier' });
  if (kind === 'review') return JSON.stringify({ decisions: data.items.map(item => ({ n: item.n, verdict: 'apply', right: item.right, reason: 'ok' })) });
  throw new Error(`unexpected prompt kind: ${kind}`);
}
