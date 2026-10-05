import React from 'react';
import { ui, uiFormat } from './i18n.js';
import { formatDateTime } from './format.js';

/* The line under a practice answer: what happened to the question and when it comes back. The word follows the SAME level function as every mastery view
   (lib/mastery.js cardLevel, which the host puts on the feedback as `level`; ui/mastery-terms.js says what each level means): after one correct answer a question is
   学习中 (its interval is not yet 6 days), so the line says 答对了, and only a question whose level really is 已掌握 is called that. */

const date = (value) => (value ? formatDateTime(value, 'stamp') : ui('现在'));

/** 「答对了」 / 「✓ 已掌握」 / 「↻ 将继续巩固」: what the answer did, by the level the question has now. */
export function nextDueWord(feedback = {}) {
  if (!feedback.correct) return ui('↻ 将继续巩固');
  return feedback.level === 'mastered' ? ui('✓ 已掌握') : ui('答对了');
}

export function NextDue({ feedback }) {
  if (!feedback) return null;
  return (
    <p className={`next-due${feedback.correct ? '' : ' retry'}`} data-level={feedback.level || undefined}>
      {uiFormat('{0} · 下次复习 {1}', [nextDueWord(feedback), date(feedback.nextDue)])}
      {feedback.retryQueued && <span>{' · '}{ui('已追加到本轮队尾，稍后再练一次')}</span>}
    </p>
  );
}

export default NextDue;
