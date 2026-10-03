const key = (root, teaching) => root && teaching?.id ? `study-teaching-draft:${root}:${teaching.id}` : null;

export function readTeachingDraft(root, teaching) {
  const draftKey = key(root, teaching);
  if (!draftKey || teaching.complete) return '';
  try {
    const saved = JSON.parse(sessionStorage.getItem(draftKey) || 'null');
    return saved?.index === teaching.index && typeof saved.answer === 'string' ? saved.answer.slice(0, 10000) : '';
  } catch { return ''; }
}

export function saveTeachingDraft(root, teaching, answer) {
  const draftKey = key(root, teaching);
  if (!draftKey) return;
  try {
    if (answer && !teaching.complete) sessionStorage.setItem(draftKey, JSON.stringify({ index: teaching.index, answer: answer.slice(0, 10000) }));
    else sessionStorage.removeItem(draftKey);
  } catch { /* Draft storage is optional; typing and submission still work. */ }
}
