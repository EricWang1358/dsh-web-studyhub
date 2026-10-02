import { ui, uiFormat } from '../i18n.js';
import { checkTitle } from '../../lib/document-title.js';

/* 资料重命名 on the screen: the same checks as the host (lib/document-title.js), plain messages in either language, and the one
   call both entry points make (the 资料 row and the reader's header). A rename changes the name only: the text, the pages, the
   citations and the questions stay as they are, and the file name is kept as the original. */

const PROBLEMS = {
  empty: () => ui('请输入名称'),
  'too-long': () => ui('名称最多 200 个字符'),
  control: () => ui('名称里不能有控制字符'),
  dots: () => ui('名称不能只有点号'),
};

/** The plain sentence for a checkTitle code. */
export const titleProblem = code => (PROBLEMS[code] || PROBLEMS.empty)();

/** What typing `value` would do to a document now called `current`: { ok, title?, unchanged?, problem? }. */
export function validateTitle(value, current) {
  const checked = checkTitle(value);
  if (!checked.ok) return { ok: false, problem: titleProblem(checked.code) };
  return { ok: true, title: checked.title, unchanged: checked.title === current };
}

/** Enter saves, Escape cancels; anything else is typing. */
export const fieldKeyAction = event => event.key === 'Enter' && !event.isComposing ? 'save' : event.key === 'Escape' ? 'cancel' : null;

/** F2 starts editing a title (the same key a file manager uses). */
export const startsEditing = event => event.key === 'F2' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;

/** A host or network error as one plain sentence. */
export function explainRename(error) {
  const text = typeof error === 'string' ? error : String(error?.message ?? '');
  if (/changed since|stale/i.test(text)) return ui('这份资料的名称刚刚被改过，请关闭后重新打开再试。');
  if (/not found/i.test(text)) return ui('找不到这份资料，它可能已被移除。');
  if (/title/i.test(text) && /required|at most|control|dots/i.test(text)) return titleProblem(/at most/.test(text) ? 'too-long' : /control/.test(text) ? 'control' : /dots/.test(text) ? 'dots' : 'empty');
  return text || ui('没能改名，请重试。');
}

/** "原名：lecture.pdf" (the tooltip and the row's small line); '' when the document was never renamed. */
export const originalNote = item => item?.renamedFrom ? uiFormat('原名：{0}', [item.renamedFrom]) : '';

/** The host arguments for renaming (or restoring) the document a 资料 item stands for. */
export const renameArgs = (item, { title, restore = false } = {}) => ({
  ...(item.documentId ? { documentId: item.documentId } : { sourceId: item.sourceIds[0] }),
  expectedTitle: item.title, ...(restore ? { restore: true } : { title }) });

/**
 * Rename (or restore) through the page's refreshing action runner, so the 资料 page, the picker and the reader see the new name at
 * once. Throws a plain Error when it did not happen; resolves the host result.
 */
export async function renameDocument({ act, call }, item, options) {
  const args = renameArgs(item, options);
  if (!act) return call('materials.document.rename', args);
  const result = await act('materials.document.rename', args, undefined, { rethrow: true });
  if (result === undefined) throw new Error(ui('另一个操作还在进行，请稍后重试。'));
  return result;
}
