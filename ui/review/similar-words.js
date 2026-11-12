import { ui, uiFormat } from "../i18n.js";
import { formatList } from "../format.js";

/* The one sentence said where 答错 → 讲解 → 同类题答对 happened for a question (#1015): the round's result page and the wrong book's opened row. The facts
   come from the runs (lib/recommend.js similarWins); nothing is stored for them. */

const MAX_TOPICS = 3;

/** One question (the wrong book's row). */
export const similarWinLine = () => ui("这道题：答错 → 讲解 → 同类题答对。再答对一次原题，它就离开错题本。");

/** The questions of a finished round (run.similarWins: [{ topic }]), named by their topics, at most three. */
export function similarWinsText(wins = []) {
  const topics = [...new Set(wins.map((win) => win.topic).filter(Boolean))].slice(0, MAX_TOPICS);
  if (!topics.length) return wins.length ? ui("这一轮有题做到了：答错 → 讲解 → 同类题答对。") : "";
  return uiFormat("「{0}」：答错 → 讲解 → 同类题答对", [formatList(topics)]);
}
