import { useCallback } from 'react';
import { ui, errorMessage } from '../i18n.js';

/* The book page's three answers to a rebuilt outline (#461, course.book.rebuild, lib/course-book-rebuild.js): 按这样放 (`apply`), 放弃这次整理 and 撤销这次整理 (`undo`: one rebuild,
   refused when the book changed since or while a build of the course runs). */

/** What a refused undo says, in the learner's words; any other failure its own message. */
export function rebuildFailureText(failure) {
  if (failure?.code === 'course-book-rebuild-conflict') return ui('这次整理之后书或总纲又改过了，撤销会盖掉之后的内容，所以没有撤销。书没有改动；「未归位」里的内容可以手动放回。');
  if (failure?.code === 'course-book-rebuild-job-running') return ui('这门课正在整理总纲或更新全书，等它结束再撤销。这次没有改动。');
  if (failure?.code === 'course-book-rebuild-no-undo') return ui('没有留下这次整理之前的记录，没法撤销。书没有改动。');
  return errorMessage(failure);
}

/** -> { apply(outlineId), discard(outlineId), undo(outlineId) }: discard and undo throw what the dialog they run in should say; a refusal also reads the book again. */
export function useBookRebuild({ call, course, notify, setBook, reload }) {
  const apply = useCallback(async outlineId => {
    try { setBook(await call('course.book.rebuild', { course, action: 'apply', outlineId })); } catch (failure) { notify({ text: rebuildFailureText(failure), tone: 'error' }); reload(); }
  }, [call, course, notify, reload, setBook]);
  const back = useCallback(async (outlineId, said) => {
    try {
      setBook(await call('course.book.rebuild', { course, action: 'undo', outlineId }));
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
