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
      ? { ids, call: open.onImported, reference: false, notice: { text: open.line ? importDoneMessage(summary) : uiFormat('{0}。已勾选，可以直接生成题组。', [importDoneMessage(summary)]), tone: 'success' } }
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

/**
 * The dialog request of an import from the first-run line (its 添加资料 and 再加一份, 3.6 D4): the learner comes back to the line, not to 创建题组; the line's
 * third step then says what will be made from what is in, and its estimate. `onImported(ids)` puts the learner back on the library home. Anything that is not
 * a material (a JSON deck's draft, a PDF still converting in the background) takes the usual way.
 */
export const importForLine = (onImported) => ({ type: 'add', otherwise: 'usual', line: true, onImported });

/**
 * The first import of the tour's last step and of the line (`openFirstImport`): back to the line while it is up (importForLine, `back`), else, for a learner
 * whose line is gone (a deck of their own, the tour taken again from Settings), the old way on to 创建题组 with the file ticked (importForQuestions).
 */
export const importForFirstRun = (lineShown, { back, goGenerate }) => (lineShown ? importForLine(back) : importForQuestions(goGenerate));
