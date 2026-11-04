import { detectLanguage } from '../../../passage-translation.js';
import { PITCH_SAMPLE_CHARS } from './constants.js';

/* The language of a 术语卡's exam pitch (#710 S1; owner, 2026-11-05): the language the course's sample papers are written in, so the sentence can be copied
   into an answer (an English pitch in a Chinese book for an English exam); without papers, or papers with nothing to read in Chinese or English, the
   book's own language. Decided once per build, in the plan (book/plan.js), from the papers the build uses. Pure. */

/** @param documents allDocuments ({ key, sourceIds }); `sources` the library's sources; `papers` the paper document keys; `language` the book's ('zh' | 'en'). */
export function pitchLanguage({ documents, sources, papers, language }) {
  const wanted = new Set(papers || []), byId = new Map((sources || []).map(source => [source.id, source]));
  let sample = '';
  for (const doc of documents || []) {
    if (!wanted.has(doc.key)) continue;
    for (const id of doc.sourceIds) { if (sample.length >= PITCH_SAMPLE_CHARS) break; sample += ` ${String(byId.get(id)?.text ?? '')}`; }
  }
  const found = detectLanguage(sample.slice(0, PITCH_SAMPLE_CHARS));
  return found === 'zh' || found === 'en' ? found : language === 'en' ? 'en' : 'zh';
}
