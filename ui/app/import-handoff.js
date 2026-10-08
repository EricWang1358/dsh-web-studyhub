import { ui } from '../i18n.js';
import { importDoneMessage } from '../ImportHub.jsx';

/* Where a finished import goes when the dialog was opened by a page that wants the result itself: the reference-question
   flow of 创建题组 (onReferenceImported, the notice about samples) or any caller with onImported(ids), such as 备考补习.
   Returns null when the usual outcome (importOutcome) applies. `ids` are source ids, the id space of the SourcePicker. */
export function importHandoff(open, summary) {
  const ids = summary?.sourceIds || [];
  if (open?.referenceQuestions && ids.length) {
    return { ids, call: open.onImported || open.onReferenceImported, reference: true,
      notice: { text: ui('参考样题已保存到资料库并选中。请确认样题范围，再开始生成。'), tone: 'success' } };
  }
  if (open?.onImported && summary?.done) {
    return { ids, call: ids.length ? open.onImported : undefined, reference: false, notice: { text: importDoneMessage(summary), tone: 'success' } };
  }
  return null;
}
