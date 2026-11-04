import { createHash } from 'node:crypto';
import { displayTitle } from '../../../../document-title.js';
import { short16 } from '../sources.js';
import { KIT_TINY, KIT_TINY_PER_CALL, KIT_VERSION } from '../constants.js';
import { groupQuestions } from './group.js';
import { paperLanguage, paperQuestions } from './questions.js';

/* What the exam answer kit of one build has to do, decided by the program before any call. Nothing without sample papers or without a question the outline
   placed on a point. The kit's `fingerprint` is the paper places (each paper's fingerprint, the quote, the points holding it) and the book's language: the
   same as the saved kit's (and nothing missing in it) keeps that kit whole, no call. Else each type has its own `print` (its questions and both languages):
   a type of the saved kit with the same print is kept, the others are asked, one call per type, the tiny ones KIT_TINY_PER_CALL to a call. Pure. */

const short = value => createHash('sha1').update(JSON.stringify(value)).digest('hex').slice(0, 12);

/** The calls: every type to ask in its own call, a tiny one sharing a call with the next tiny ones (the call stands where its first type does). */
function batchesOf(types) {
  const batches = [];
  let tiny = null;
  for (const type of types) {
    if (type.questions.length > KIT_TINY) { batches.push({ types: [type] }); continue; }
    if (!tiny || tiny.types.length >= KIT_TINY_PER_CALL) { tiny = { types: [] }; batches.push(tiny); }
    tiny.types.push(type);
  }
  return batches.map((batch, at) => ({ number: at + 1, key: `cb:kit:${short(batch.types.map(type => type.print))}`, types: batch.types }));
}

/**
 * @param work the build's work ({ items, papers }: book/work.js); `plan` the build's plan ({ language, previous, state, documents })
 * @returns null (no kit), or { fingerprint, language, questions, order, types, batches, reuse? }: `reuse` the saved kit when nothing changed (then no batch)
 */
export function planKit(work, plan) {
  if (!work.papers?.length) return null;
  const byId = new Map((plan.state?.sources || []).map(source => [source.id, source]));
  const titles = new Map((plan.documents || []).map(doc => [doc.key, displayTitle(doc.title)]));
  const questions = paperQuestions(work.items, { papers: work.papers, byId, titles });
  if (!questions.length) return null;
  const language = paperLanguage(questions), book = plan.language === 'en' ? 'en' : 'zh';
  const known = new Map(work.papers.map(paper => [paper.key, paper.fingerprint ?? '']));
  const fingerprint = short16(['kit', KIT_VERSION, book, questions.map(q => [q.paper, known.get(q.paper), q.sourceId, q.quote, q.leaves])]);
  const order = new Map(work.items.map((item, at) => [item.id, at])), saved = plan.previous?.courseNotes?.examKit ?? null;
  const base = { fingerprint, language, questions, order, titles: new Map(work.items.map(item => [item.id, item.title])) };
  if (saved?.fingerprint === fingerprint && !saved.missing) return { ...base, types: [], batches: [], reuse: saved };
  const kept = new Map((saved?.types || []).map(type => [type.print, type]));
  const types = groupQuestions(questions).map(type => {
    const print = short16(['kit-type', KIT_VERSION, book, language, type.family, type.questions.map(q => [q.id, q.text])]);
    return { ...type, print, ...(kept.has(print) ? { kept: kept.get(print) } : {}) };
  });
  return { ...base, types, batches: batchesOf(types.filter(type => !type.kept)) };
}
