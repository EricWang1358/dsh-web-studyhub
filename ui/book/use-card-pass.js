import { useState } from 'react';
import { errorMessage, ui, uiFormat } from '../i18n.js';
import { useLiveEffect } from '../use-async.js';

/* 补术语卡 on the book page (#710 S6): 「⋯ 更多」 › 整本书 offers it while some points have no 术语卡 (a book written before cards existed). The size comes from the
   build itself (generation.courseBook.build { cards: true, estimate: true }: the same batches the task will ask, no call), and the item's Tooltip says it in
   call counts, never prices. Pressing it starts the card pass alone: no explanation, quote or coverage changes. */

/** The words of the item's Tooltip: what it does and about how many calls it takes. */
export const cardPassTip = ({ points, calls }) => uiFormat('还有 {0} 个知识点没有术语卡。只读已经写好的讲解来补，讲解、引文和覆盖都不改；约 {1} 次模型调用，用了多少在任务页看。',
  [points, calls]);

/** What the page says once 补术语卡 was pressed. */
export const cardPassWords = result => (result?.status === 'nothing' ? ui('每个知识点都有术语卡了，没有要补的。')
  : result?.alreadyRunning ? ui('复习全书已经在生成，没有术语卡的知识点会一起补上；进度在任务页。') : ui('已开始补术语卡，进度在任务页。'));

/** The size of the card pass of the book being read: { points, calls } | null (unknown, or a build is running). Asked again when the book or the build changes. */
export function useCardPass({ call, course, book, building }) {
  const [size, setSize] = useState(null);
  useLiveEffect(isLive => {
    if (book?.status !== 'ok' || !book.notes || building) { setSize(null); return; }
    call('generation.courseBook.build', { course, cards: true, estimate: true })
      .then(next => { if (isLive()) setSize(next?.status === 'estimate' ? { points: next.points, calls: next.calls } : null); }, () => { if (isLive()) setSize(null); });
  }, [call, course, book?.revision, book?.status, book?.notes, building]);
  return size;
}

/** 补术语卡 pressed: the card pass as one task (act() asked to rethrow says nothing itself, so a refusal is said here). */
export async function startCardPass({ act, course, notify }) {
  try {
    await act('generation.courseBook.build', { course, cards: true }, result => notify({ text: cardPassWords(result), tone: result?.status === 'nothing' ? 'info' : 'success' }),
      { rethrow: true });
  } catch (failure) { notify({ text: errorMessage(failure), tone: 'error' }); }
}
