// Recovery only: writing here never counts as an answer or learning evidence.
export const draftKey = (root, kind, object) => `study-writing:v1:${JSON.stringify([root, kind, object])}`;

export function readDraft(key, storage = globalThis.localStorage) {
  try {
    const saved = JSON.parse(storage.getItem(key));
    return saved?.version === 1 && typeof saved.revision === 'string' ? saved : null;
  } catch { return null; }
}

export function writeDraft(key, value, storage = globalThis.localStorage) {
  const saved = { version: 1, revision: crypto.randomUUID(), value };
  storage.setItem(key, JSON.stringify(saved));
  return saved;
}

export function clearDraft(key, revision, storage = globalThis.localStorage) {
  if (revision === undefined || readDraft(key, storage)?.revision === revision) storage?.removeItem(key);
}
