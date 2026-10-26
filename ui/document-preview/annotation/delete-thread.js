import { ui, uiFormat } from '../../i18n.js';
import { ANNOTATION_LIMITS } from '../../../lib/annotation.js';

/* 删除这组批注 and its 撤销, as host calls (ui/document-preview/DocumentLearning.jsx draws them). The thread is deleted AT ONCE, by the ids of the answers that were
   kept when the learner pressed 删除 (never "everything on this passage" later: an answer kept on the same passage meanwhile must survive), and 撤销 puts the very
   items the host removed back (materials.annotation.save { restore }, lib/contexts/materials/annotation-operations.js). Plain functions over `call`. */

/** Delete the kept answers `ids` of one passage (their follow-ups go with them). Without ids, the passage's selection (an old thread not listed yet). → { removed } */
export async function deleteKeptThread({ call, documentId, revision, ids = [], selection }) {
  const done = await call('materials.annotation.delete', { documentId, revision, ...(ids.length ? { ids } : { selection }) });
  return { removed: Array.isArray(done?.removed) ? done.removed : [] };
}

/* Why the host would not take the thread back, in the learner's words: the passage meanwhile got so many new answers that the old ones no longer fit beside
   them (a passage keeps at most ANNOTATION_LIMITS.thread), or the document is full. */
const refusalText = (message = '', status = '') => {
  if (status === 'full') return uiFormat('这份资料的批注已经存满（最多 {0} 条），原来那组批注没能放回。', [ANNOTATION_LIMITS.items]);
  if (/does not fit its thread|at most \d+ questions and answers/i.test(message)) return uiFormat('这段原文上的问答已经到了上限（最多 {0} 条），原来那组批注没能放回。', [ANNOTATION_LIMITS.thread]);
  return '';
};

/** Put back what deleteKeptThread removed. Resolves true, or throws with the reason in the learner's language when the host refuses. */
export async function restoreKeptThread({ call, documentId, revision, removed }) {
  let back;
  try { back = await call('materials.annotation.save', { documentId, revision, restore: removed }); }
  catch (error) { throw new Error(refusalText(error?.message) || error?.message || ui('出了点问题，请重试。')); }
  if (back?.status !== 'saved') throw new Error(refusalText(back?.message, back?.status) || back?.message || ui('出了点问题，请重试。'));
  return true;
}
