/* What the 创建题组 page does with a big selection (WP28): pure, so Generate.jsx
   and its tests share it. The backend makes the same decision when it runs
   (lib/contexts/generation/retrieval-operations.js narrowSelection); this tells
   the learner before they press the button. */
import { LARGE_DOCUMENT_LIMITS, RETRIEVE_ABOVE_CHARS, selectionChars } from '../lib/large-documents.js';

import { ui, uiFormat } from './i18n.js';

/** Whether a retrieval provider is chosen and present (retrieval.status `effective`). */
export const retrievalReady = status => !!status?.effective && status.effective !== 'builtin';

const MAX_LISTED_PAGES = 12;

/**
 * What a generation job did with retrieval (job.retrieval), in words: { text, error? }, or null when it did not run.
 * `used` are the pages sent to the model, in reading order.
 */
export function retrievalSummary(retrieval) {
  if (!retrieval) return null;
  if (retrieval.error) return { error: true, text: uiFormat('检索没有用上：{0}。已使用你选的全部资料。', [ui(retrieval.error)]) };
  const used = retrieval.used || [];
  const listed = used.slice(0, MAX_LISTED_PAGES).map(page => page.page ?? page.title).join(ui('、')) + (used.length > MAX_LISTED_PAGES ? '…' : '');
  return { error: false, text: uiFormat('用检索挑出了相关页面：第 {0} 页（所选 {1} 份，实际发给 AI {2} 份）。', [listed, retrieval.selected ?? used.length, used.length])
    + (retrieval.truncated ? ui(' 相关页面很多，只取了最相关的部分。') : '') };
}

/**
 * { chars, tooBig, willRetrieve, needsTopic, blocked, reason }:
 * tooBig - over what one generation accepts (600,000 characters);
 * willRetrieve - a provider is chosen and the selection is large enough to be narrowed;
 * needsTopic - it would be narrowed but the topic ("这次想练什么？") is empty and the selection does not fit;
 * blocked - generating now would be refused; reason - 'selection' when the selection is too big.
 */
export function generateAdvice({ sources = [], selectedIds = [], focus = '', retrieval = null } = {}) {
  const chars = selectionChars(sources, selectedIds);
  const tooBig = chars > LARGE_DOCUMENT_LIMITS.selectionChars;
  const ready = retrievalReady(retrieval);
  const willRetrieve = ready && chars > RETRIEVE_ABOVE_CHARS;
  const hasTopic = String(focus ?? '').trim().length > 0;
  const needsTopic = tooBig && ready && !hasTopic;
  return { chars, tooBig, willRetrieve, needsTopic, blocked: tooBig && (!ready || !hasTopic), reason: tooBig ? 'selection' : null };
}
