/* The pure rules of annotations (materials.annotation.*): the questions and answers a learner kept about a passage, as a thread of
   nodes (the first answer, and the answers asked inside it). No store, no model, no DOM: the backend (contexts/materials/
   annotation-operations.js) and the reader (ui/document-preview/annotation/) share these, like the translation's lib/passage-translation.js.

   One node is one item. Items are kept per document REVISION beside the document's own records (like a translation), keyed
   by the passage they are about; a thread is the items that share a passage key. */
import { textHash } from './passage-translation.js';

export const ANNOTATION_LIMITS = Object.freeze({
  /** Nodes kept in one document revision; a full revision refuses more, with a plain message. */
  items: 200,
  /** Nodes in the thread of one passage, and how deep a question inside an answer may go (the first answer is level 1). */
  thread: 8, depth: 3,
  question: 2000, answer: 20000, term: 80, label: 40, language: 40, quote: 4000, context: 80, stale: 20,
});

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const text = value => typeof value === 'string' ? value : '';
const clip = (value, size) => text(value).slice(0, size);

/** Which passage a node is about: its source and the stored offsets. A thread is every node with the same key. */
export const passageKey = ({ sourceId, start, end }) => `${sourceId}|${start}|${end}`;
export { textHash };

/** A node as the caller sent it, checked and cut to size. Throws a plain Error for what can never be right. */
export function normalizeNode(input) {
  if (!input || typeof input !== 'object') throw new Error('An annotation node is required');
  if (!ID.test(text(input.id))) throw new Error('Annotation node id must be 1-64 letters, digits, - or _');
  if (input.parentId !== undefined && input.parentId !== null && !ID.test(text(input.parentId))) throw new Error('Annotation parent id is not valid');
  const question = clip(input.question, ANNOTATION_LIMITS.question).trim(), answer = clip(input.answer, ANNOTATION_LIMITS.answer);
  if (!question) throw new Error('An annotation needs the question that was asked');
  if (!answer.trim()) throw new Error('An annotation needs the answer');
  const term = clip(input.term, ANNOTATION_LIMITS.term).replace(/\s+/g, ' ').trim(), label = clip(input.label, ANNOTATION_LIMITS.label).trim();
  const language = clip(input.language, ANNOTATION_LIMITS.language).trim();
  return { id: input.id, parentId: input.parentId ?? null, question, ...(term ? { term } : {}), ...(label ? { label } : {}), answer, ...(language ? { language } : {}) };
}

/**
 * Whether `nodes` can join the `kept` nodes of the same passage: every parent is kept or sent before its child, nobody is its own
 * ancestor, no level is deeper than the limit and the thread stays within its size. Returns the nodes in a parent-first order.
 */
export function checkThread(kept, nodes) {
  const byId = new Map(kept.map(node => [node.id, node]));
  for (const node of nodes) byId.set(node.id, { ...byId.get(node.id), ...node });
  if (byId.size > ANNOTATION_LIMITS.thread) return { ok: false, code: 'thread-full', message: `One passage keeps at most ${ANNOTATION_LIMITS.thread} questions and answers.` };
  const depthOf = (id, seen = new Set()) => {
    const node = byId.get(id);
    if (!node || seen.has(id)) return Infinity;
    return node.parentId === null || node.parentId === undefined ? 1 : 1 + depthOf(node.parentId, new Set([...seen, id]));
  };
  for (const node of nodes) {
    if (node.parentId && !byId.has(node.parentId)) return { ok: false, code: 'parent', message: 'The answer this one belongs to is not kept.' };
    if (depthOf(node.id) === Infinity) return { ok: false, code: 'cycle', message: 'An answer cannot belong to itself.' };
    if (depthOf(node.id) > ANNOTATION_LIMITS.depth) return { ok: false, code: 'depth', message: `Questions inside answers go at most ${ANNOTATION_LIMITS.depth} levels deep.` };
  }
  return { ok: true, nodes: [...nodes].sort((a, b) => depthOf(a.id) - depthOf(b.id)) };
}

/** True when kept and wanted say the same thing, so saving again writes nothing. */
export const sameNode = (a, b) => ['parentId', 'question', 'term', 'label', 'answer', 'language'].every(field => (a[field] ?? null) === (b[field] ?? null));

/** A stored item as the reader gets it; `resolved` says whether the passage is still where the item says (its words hash the same). */
export const viewOf = (item, resolved) => ({ id: item.id, key: item.key, parentId: item.parentId ?? null, question: item.question, ...(item.term ? { term: item.term } : {}),
  ...(item.label ? { label: item.label } : {}), answer: item.answer, ...(item.language ? { language: item.language } : {}),
  selection: { sourceId: item.sourceId, start: item.start, end: item.end, quote: item.quote, prefix: item.prefix || '', suffix: item.suffix || '', ...(item.page ? { page: item.page } : {}) },
  status: resolved ? 'resolved' : 'stale', at: item.at, updatedAt: item.updatedAt });
