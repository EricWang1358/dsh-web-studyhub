import { browserStorage, readJSON, removeKey } from './storage.js';

// Recovery only: writing here never counts as an answer or learning evidence.
export const draftKey = (root, kind, object) => `study-writing:v1:${JSON.stringify([root, kind, object])}`;

export function readDraft(key, storage = browserStorage()) {
  const saved = readJSON(key, null, storage);
  return saved?.version === 1 && typeof saved.revision === 'string' ? saved : null;
}

export function writeDraft(key, value, storage = browserStorage()) {
  const saved = { version: 1, revision: crypto.randomUUID(), value };
  storage.setItem(key, JSON.stringify(saved)); // a refusal is the caller's to see (a full storage must not look like a saved draft)
  return saved;
}

export function clearDraft(key, revision, storage = browserStorage()) {
  if (revision === undefined || readDraft(key, storage)?.revision === revision) removeKey(key, storage);
}
