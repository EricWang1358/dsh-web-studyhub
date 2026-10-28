/* Today's review load, counted by lib/ the way the dashboard counts it (lib/insights.js studyStats: 到期待复习 is cards
   that are scheduled, not new and due now, in active courses), so the SessionStart line, studyhub_status and the panel
   say one number. Reads the library through lib/store.js; writes nothing. */
import { importLib } from './lib-root.mjs';

/** { due, cards, decks } of the library at `root`. */
export async function dueSummary(root, now = new Date()) {
  const [{ Store }, { studyStats }] = await Promise.all([importLib('store.js'), importLib('insights.js')]);
  const state = await new Store(root).read();
  const totals = studyStats(state, {}, now).totals;
  const decks = (state.decks || []).filter((deck) => !deck.archived && !deck.systemKind).length;
  return { due: totals.due ?? 0, cards: totals.cards ?? 0, decks };
}

/** The line for a summary (Chinese, then English: it goes into the assistant's context, which answers in the learner's language), or '' when there is no library yet. */
export function dueLine({ due, cards, decks }) {
  if (!cards) return '';
  const zh = `[StudyHub] 学习库：${decks} 个题组，${cards} 题。${due > 0 ? `今天有 ${due} 题到期待复习。` : '今天没有到期待复习的题，可以学新内容。'}打开学习面板：输入 /studyhub，或在右侧栏的「添加标签页」菜单里点 StudyHub 学习中枢。`;
  const en = `Library: ${decks} decks, ${cards} cards; ${due > 0 ? `${due} due for review today` : 'nothing due for review today'}. Open the panel with /studyhub.`;
  return `${zh} ${en}`;
}
