import { ui, uiFormat } from '../i18n.js';
import { importDoneMessage } from '../ImportHub.jsx';

/* Where a finished import goes when the dialog was opened by a page that wants the result itself: the reference-question
   flow of 创建题组 (onReferenceImported, the notice about samples) or any caller with onImported(ids), such as 备考补习.
   Returns null when the usual outcome (importOutcome) applies. `ids` are source ids, the id space of the SourcePicker.
   A caller that sets `otherwise: 'usual'` takes the ids when there are some and leaves everything else (a draft deck, a conversion
   that runs in the background) to the usual outcome. */
export function importHandoff(open, summary) {
  const ids = summary?.sourceIds || [];
  if (open?.referenceQuestions && ids.length) {
    return { ids, call: open.onImported || open.onReferenceImported, reference: true,
      notice: { text: ui('参考样题已保存到资料库并选中。请确认样题范围，再开始生成。'), tone: 'success' } };
  }
  if (open?.onImported && summary?.done) {
    if (open.otherwise === 'usual') return ids.length
      ? { ids, call: open.onImported, reference: false, notice: { text: uiFormat('{0}。已勾选，可以直接生成题组。', [importDoneMessage(summary)]), tone: 'success' } }
      : null;
    return { ids, call: ids.length ? open.onImported : undefined, reference: false, notice: { text: importDoneMessage(summary), tone: 'success' } };
  }
  return null;
}

/**
 * The dialog request of a first import (the Welcome page, the home page's first step): the file is imported and the learner lands on 创建题组 with it
 * ticked, instead of on 资料 with a toast to press. `goGenerate` is the app's own intent (ui/app/use-intents.js); `remember` keeps the way back.
 */
export const importForQuestions = (goGenerate, extra = {}) => ({ type: 'add', ...extra, otherwise: 'usual',
  onImported: (ids) => goGenerate({ sourceIds: ids, remember: true }) });
