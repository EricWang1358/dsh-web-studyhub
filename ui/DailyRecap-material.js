/** Stable content identity makes repeated clicks, reopening, and retries reuse one saved material. */
export async function noteMaterial(note) {
  const text = String(note.markdown || '').trim(), title = String(note.title || '').trim();
  if (!text || !title) throw new Error('请先生成或填写正文。');
  const bytes = new TextEncoder().encode(JSON.stringify([note.id, title, text]));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  const fingerprint = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return { id: `note-material-${fingerprint}`, title, text, courses: note.daily?.course ? [note.daily.course] : note.courses || [] };
}

export async function existingNoteMaterial(call, material) {
  try { return await call('source.get', { id: material.id, limit: 1 }); }
  catch (error) { if (error.code === 'not-found') return null; throw error; }
}
