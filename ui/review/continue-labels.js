import { ui, uiFormat } from '../i18n.js';

/* The words of the results page's 继续学习 decision (continueDestination in ./session-logic.js stays free of the catalogue so the
   native-ESM unit tests can load it). */

/** The button's words: they name where it goes. */
export function continueLabel(destination) {
  switch (destination?.kind) {
    case 'original': return ui('回到原题 →');
    case 'scope': return ui('继续这个范围 →');
    case 'plan': return uiFormat('下一步：{0} →', [destination.title]);
    default: return destination?.reason === 'continuing' || !destination?.reason ? ui('继续学习 →') : ui('回到学习路径 →');
  }
}

/** One line to say when the decision is not the obvious one: the round that was to be returned to is gone. */
export const continueNote = (destination) => (destination?.reason === 'original-gone' ? ui('原来的那一轮已经结束或不存在了，回到学习路径继续。') : '');
