/* 删除这组批注 and its 撤销, as host calls (ui/document-preview/DocumentLearning.jsx draws them). The thread is deleted AT ONCE, by the ids of the answers that were
   kept when the learner pressed 删除 (never "everything on this passage" later: an answer kept on the same passage meanwhile must survive), and 撤销 puts the very
   items the host removed back (materials.annotation.save { restore }, lib/contexts/materials/annotation-operations.js). Plain functions over `call`. */

/** Delete the kept answers `ids` of one passage (their follow-ups go with them). Without ids, the passage's selection (an old thread not listed yet). → { removed } */
export async function deleteKeptThread({ call, documentId, revision, ids = [], selection }) {
  const done = await call('materials.annotation.delete', { documentId, revision, ...(ids.length ? { ids } : { selection }) });
  return { removed: Array.isArray(done?.removed) ? done.removed : [] };
}

/** Put back what deleteKeptThread removed. Resolves true, or throws with the host's reason. */
export async function restoreKeptThread({ call, documentId, revision, removed }) {
  const back = await call('materials.annotation.save', { documentId, revision, restore: removed });
  if (back?.status !== 'saved') throw new Error(back?.message || 'The annotations could not be restored');
  return true;
}
