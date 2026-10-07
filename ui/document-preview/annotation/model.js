/* The reader's annotations, as plain data (the translation's translation/model.js is the pattern): the 阅读 / 批注 mode and how it is
   remembered, a kept thread turned back into the thread the panel works on, the nodes to keep, and the marks of annotated passages
   as links (so the reader marks them with the same [n] layer as the passages linked to questions). Pure, so it runs under node:test. */
import { passageKey } from '../../../lib/annotation.js';
import { browserStorage } from '../../storage.js';
import { childrenOf, nodeOf } from '../ask-thread.js';

export const ANNOTATION_MODES = ['read', 'annotate'];
export const ANNOTATION_MODE_KEY = 'study-reader-annotation';

const modeOf = value => (ANNOTATION_MODES.includes(value) ? value : 'read');
export function loadAnnotationMode(storage = browserStorage()) {
  try { return modeOf(JSON.parse(storage?.getItem(ANNOTATION_MODE_KEY) || 'null')?.mode); } catch { return 'read'; }
}
export function saveAnnotationMode(mode, storage = browserStorage()) {
  try { storage?.setItem(ANNOTATION_MODE_KEY, JSON.stringify({ mode: modeOf(mode) })); } catch { /* blocked storage: the choice still applies for this session */ }
}

/** The key of the passage a selection is (the backend's key for its thread). */
export const keyOfSelection = selection => (selection && Number.isInteger(selection.start) && Number.isInteger(selection.end) ? passageKey(selection) : '');

/** The kept items of one passage, parents before children (the order the panel adds them in). */
export function itemsOfPassage(items, selection) {
  const key = keyOfSelection(selection);
  if (!key) return [];
  const mine = (items || []).filter(item => item.key === key && item.status !== 'stale');
  const out = [], seen = new Set();
  const add = parent => { for (const item of mine.filter(entry => (entry.parentId ?? null) === parent && !seen.has(entry.id))) { seen.add(item.id); out.push(item); add(item.id); } };
  add(null);
  return out;
}

/** A kept thread as the panel's thread: every node answered, nothing waiting. */
export const threadFromItems = items => ({ nodes: items.map(item => ({ id: item.id, parentId: item.parentId ?? null, question: item.question, term: item.term || '', label: item.label || '',
  answer: item.answer, error: '', status: 'answered', language: item.language || '' })) });

/** The answered nodes to keep, parents first: the whole thread, or only `id` with the nodes above it. */
export function nodesToKeep(thread, id = '') {
  const wanted = id ? new Set(pathIds(thread, id)) : null, out = [];
  const add = parent => { for (const node of childrenOf(thread, parent)) if (node.status === 'answered' && (!wanted || wanted.has(node.id))) { out.push(node); add(node.id); } };
  add(null);
  return out.map(({ id: nodeId, parentId, question, term, label, answer, language }) => ({ id: nodeId, parentId, question, ...(term ? { term } : {}), ...(label ? { label } : {}), answer, ...(language ? { language } : {}) }));
}
const pathIds = (thread, id) => { const ids = []; for (let node = nodeOf(thread, id); node; node = nodeOf(thread, node.parentId)) ids.push(node.id); return ids; };

/** One link per annotated passage, shaped like the links of questions so the reader's marks and list take them without a second system. */
export function annotationLinks(items) {
  const threads = new Map();
  for (const item of items || []) {
    if (item.status === 'stale') continue;
    if (!threads.has(item.key)) threads.set(item.key, { first: item, nodes: [] });
    threads.get(item.key).nodes.push(item);
  }
  return [...threads.values()].map(({ first, nodes }) => {
    const root = nodes.find(item => (item.parentId ?? null) === null) || first;
    return { kind: 'annotation', annotationKey: first.key, deckId: '', cardId: `annotation:${first.key}`, prompt: root.label || root.question, answer: root.answer, nodes: nodes.length,
      selection: { ...first.selection }, status: 'resolved' };
  });
}

/** What the panel says about the kept notes of other revisions of the document. */
export const staleCount = stale => (stale || []).reduce((total, entry) => total + (entry.count || 0), 0);

