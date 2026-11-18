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

/** The counts of a readout as short phrases, zero counts left out: 已掌握 3 · 还不会 2 · 还没有题 1. The topics still being learned are the rest, so the line stays short enough for a phone. */
export function summaryParts(progress) {
  const parts = [
    progress.done > 0 && uiFormat('已掌握 {0}', [progress.done]),
    progress.weak > 0 && uiFormat('还不会 {0}', [progress.weak]),
    progress.none > 0 && uiFormat('还没有题 {0}', [progress.none]),
  ].filter(Boolean);
  // Every topic still being learned: say that, so the line never ends at its colon.
  return parts.length ? parts : [uiFormat('学习中 {0}', [progress.total])];
}

/** The words of the home line as pieces that must not be broken: the head ("7 focus topics:" / 「重点 7 条：」) and each count with its words ("2 not yet ·"), with `gap`, the
    space (en) or nothing (zh) between the head and the first count. Joined as head + gap + parts.join(' ') they read as the one sentence of the template, so the line may wrap
    only between pieces, never inside "1 without" / "a question". The head comes from the same template as the whole line, so its singular form and its words stay in one place. */
export function summaryPieces(progress) {
  const template = '重点 {0} 条：{1}', mark = '\uE000', whole = uiFormat(template, [progress.total, mark]);
  const head = uiFormat(template, [progress.total, '']).trimEnd(), gap = whole.slice(head.length, whole.indexOf(mark));
  const parts = summaryParts(progress);
  return { head, gap, parts: parts.map((part, index) => (index < parts.length - 1 ? `${part} ·` : part)) };
}

/** What one topic holds: its questions and how many are mastered ("还没有题" for a topic without a question). */
export function topicCounts(topic) {
  if (!topic.cards) return ui('还没有题');
  return topic.cards === 1 ? uiFormat('1 题 · 已掌握 {0}', [topic.counts.mastered]) : uiFormat('{0} 题 · 已掌握 {1}', [topic.cards, topic.counts.mastered]);
}
