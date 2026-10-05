import { browserSession, readJSON, removeKey, writeJSON } from './storage.js';

const key = (root, teaching) => root && teaching?.id ? `study-teaching-draft:${root}:${teaching.id}` : null;

export function readTeachingDraft(root, teaching) {
  const draftKey = key(root, teaching);
  if (!draftKey || teaching.complete) return '';
  const saved = readJSON(draftKey, null, browserSession());
  return saved?.index === teaching.index && typeof saved.answer === 'string' ? saved.answer.slice(0, 10000) : '';
}

export function saveTeachingDraft(root, teaching, answer) {
  const draftKey = key(root, teaching);
  if (!draftKey) return;
  // Draft storage is optional; typing and submission still work when it refuses.
  if (answer && !teaching.complete) writeJSON(draftKey, { index: teaching.index, answer: answer.slice(0, 10000) }, browserSession());
  else removeKey(draftKey, browserSession());
}
