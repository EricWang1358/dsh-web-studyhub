import { getUiLanguage } from '../i18n.js';
import { nameData, say } from './say.js';

/** Post-session voice/external-chat debrief handed to the Head Coach + 4 specialist TAs (skill study-coach-team). */
export function coachDebriefPrompt({ course = '', deckTitle = '' } = {}, language = getUiLanguage()) {
  const scopeLabel = deckTitle || course;
  const ask = scopeLabel
    ? say(language, '我刚在外部语音/对话里学完了 {0}，下面贴上聊天记录，请主教练带 4 位助教帮我做学完回馈结算。', [nameData(scopeLabel)])
    : say(language, '我刚在外部语音/对话里学完了一批内容，下面贴上聊天记录，请主教练带 4 位助教帮我做学完回馈结算。');
  return {
    ask,
    notes: [
      say(language, '分工：1) 把卡壳点的大白话解释提前写进题目 QA（card.followup.add）；2) 核查讲到但题库没涉及的缺口（supplement / capture）；3) 理顺前置题与学习顺序（card.link.batch）；4) 按原话证据同步掌握度（card.review.batch）并挑 5–12 道高质量课后验收题推到面板（panel.open）。'),
      say(language, '确认：除非我明确说「直接执行」，先给我看一屏精简变更表再落库。'),
    ],
    tail: 'transcript',
  };
}
