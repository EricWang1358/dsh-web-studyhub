import { ui, uiFormat } from '../i18n.js';

/* How the practice page says where the learner is in the round (#660). The numbers come from the round model (lib/round-position.js, on the run as `position`):
   the total is the questions the round started with and never grows; a question asked again after a wrong answer is a re-ask (再练), counted by itself. */

/** The run's position, or the plain one for a run that carries none (a mock exam, a run from an older host): index and total as they are. */
export const positionOf = (run) => run?.position || { total: run?.total ?? 0, at: (run?.index ?? 0) + 1, retries: 0, retryAt: 0, last: !!run && run.index === run.total - 1 };

/** `{ main, note }`: 「2 / 4」 and, while a re-ask waits, 「稍后再练 1 题」; on the re-ask itself 「再练 1 / 1」. */
export function roundWords(position) {
  if (position.retryAt > 0) return { main: uiFormat('再练 {0} / {1}', [position.retryAt, position.retries]), note: '' };
  return {
    main: `${position.at} / ${position.total}`,
    note: position.retries > 0 ? uiFormat('稍后再练 {0} 题', [position.retries]) : '',
  };
}

/** What a tick of the question rail says (hover, keyboard focus and screen readers read this one sentence): the number, the topic, what happened, the mastery colour in words. */
export function tickWords(item, levelWord) {
  const place = item.retry ? ui('再练') : uiFormat('第 {0} 题', [item.number ?? item.index + 1]);
  const state = item.answered ? (item.passed === false ? ui('答错了') : ui('答对了')) : ui('还没做');
  return [place, item.topic, state, uiFormat('掌握程度：{0}', [levelWord])].filter(Boolean).join(' · ');
}
