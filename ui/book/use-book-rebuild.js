import { useCallback } from 'react';
import { ui, errorMessage } from '../i18n.js';

/* The book page's three answers to a rebuilt outline (#461): 按这样放 (the ordinary open applies the moves), 放弃这次整理 and 撤销这次整理 (course.book.rebuild.undo,
   lib/course-book-rebuild.js: one rebuild, refused when the book changed since). */

/** What a refused undo says, in the learner's words; any other failure its own message. */
export function rebuildFailureText(failure) {
  if (failure?.code === 'course-book-rebuild-conflict') return ui('这次整理之后书或总纲又改过了，撤销会盖掉之后的内容，所以没有撤销。书没有改动；「未归位」里的内容可以手动放回。');
  if (failure?.code === 'course-book-rebuild-no-undo') return ui('没有留下这次整理之前的记录，没法撤销。书没有改动。');
  return errorMessage(failure);
}

/** -> { apply(), discard(outlineId), undo(outlineId) }: discard and undo throw what the dialog they run in should say; a refusal also reads the book again. */
export function useBookRebuild({ call, course, notify, setBook, reload }) {
  const apply = useCallback(async () => {
    try { setBook(await call('course.book.open', { course })); } catch (failure) { notify({ text: errorMessage(failure), tone: 'error' }); }
  }, [call, course, notify, setBook]);
  const back = useCallback(async (outlineId, said) => {
    try {
      setBook(await call('course.book.rebuild.undo', { course, outlineId }));
      notify({ text: said, tone: 'success' });
    } catch (failure) {
      reload();
      throw new Error(rebuildFailureText(failure));
    }
  }, [call, course, notify, reload, setBook]);
  const discard = useCallback(outlineId => back(outlineId, ui('已放弃这次整理，总纲回到了上一版，书没有改动。')), [back]);
  const undo = useCallback(outlineId => back(outlineId, ui('这次整理已撤销，笔记和总纲都回到了整理之前。想要新总纲，要再整理一次。')), [back]);
  return { apply, discard, undo };
}
