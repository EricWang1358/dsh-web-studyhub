import { ui } from '../i18n.js';

/* 重新检查 on the first-run line and in Settings › 学习库与模型: it reads the library again. Both places say what came of it: the model is still not usable, or the
   library could not be read at all (then the click would otherwise just stop its spinner). */

/** Run the re-check: 'still' when the library was read again, 'failed' when reading it threw. */
export async function runRecheck(recheck) {
  try { await recheck(); return 'still'; } catch { return 'failed'; }
}

/** The line under the steps after a re-check (outcome: 'still' | 'failed'). */
export const recheckSentence = (outcome) => (outcome === 'failed'
  ? ui('没能重新检查。再点一次「重新检查」试试。')
  : ui('已重新检查，还没有读到可用的模型。在 DSH 里配好后，再点一次「重新检查」。'));
