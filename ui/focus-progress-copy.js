import { ui, uiFormat } from './i18n.js';

/* The words for 重点 × 掌握度 (lib/focus-progress.js), said once for the home line and the course settings list: a focus topic is 还不会 when it has a
   weak question (薄弱, ui/mastery-terms.js), 还没有题 when it has no question, 已掌握 when its mastery is 80% or more with no weak question (the dashboard's
   "done" line, lib/mastery.js), and 学习中 otherwise. */

/** The status of one topic as a label. */
export function statusLabel(status) {
  if (status === 'weak') return ui('还不会');
  if (status === 'none') return ui('还没有题');
  if (status === 'done') return ui('已掌握');
  return ui('学习中');
}

/** Badge tone of a status: only the topics that need the learner's attention are coloured. */
export const statusTone = (status) => (status === 'weak' ? 'warning' : status === 'done' ? 'success' : 'neutral');

/** The counts of a readout as short phrases, zero counts left out: 已掌握 3 · 还不会 2 · 还没有题 1 · 学习中 2. */
export function summaryParts(progress) {
  const learning = progress.total - progress.done - progress.weak - progress.none;
  return [
    progress.done > 0 && uiFormat('已掌握 {0}', [progress.done]),
    progress.weak > 0 && uiFormat('还不会 {0}', [progress.weak]),
    progress.none > 0 && uiFormat('还没有题 {0}', [progress.none]),
    learning > 0 && uiFormat('学习中 {0}', [learning]),
  ].filter(Boolean);
}

/** What one topic holds: its questions and how many are mastered ("还没有题" for a topic without a question). */
export function topicCounts(topic) {
  if (!topic.cards) return ui('还没有题');
  return topic.cards === 1 ? uiFormat('1 题 · 已掌握 {0}', [topic.counts.mastered]) : uiFormat('{0} 题 · 已掌握 {1}', [topic.cards, topic.counts.mastered]);
}
