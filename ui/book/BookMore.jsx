import React from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button, Menu } from '../components/index.js';

/* 「⋯ 更多」 of the book bar (复习全书, docs/review-book.md "More"): everything that is not reading, in one menu of four small groups, so the page has no standing
   mode switch. A one-line hint only where a rule is hidden (not what an item is for). The old views (编辑, 翻看, 速查页) open from here and come back with 「完成 · 回到阅读」.
   这个知识点: 编辑这个知识点… / 给这个知识点出题 / 复制编号 / 收起或展开这个知识点的 AI 段落. 阅读: 整章连着读 (a check) / 翻看 / 收起或展开整本书的 AI 段落.
   整本书: 速查页… / 导出… / 发给主会话…. 期末一周: 今天读哪几节 / 出一套模拟卷… / 设置考试日期 / 前往设置. */

/** The menu's items (pure, for the tests): `state` says what the page has now. unplaced: the step shown is 未归位 (no code the book tools match, no
    questions of its own, no AI blocks: only 编辑这个知识点… in its group). */
export function moreItems({ unplaced = false, pointFold = null, scroll = false, bookFold = null, pages = null, pageLimit = null, today = false, mockScope = 0, dateHint = null,
  settings = false }) {
  const pagesHint = pages === null ? undefined : pageLimit ? uiFormat('约 {0} 页 / 上限 {1} 页', [pages, pageLimit]) : uiFormat('约 {0} 页', [pages]);
  return [
    { heading: true, label: ui('这个知识点') },
    { id: 'edit', label: ui('编辑这个知识点…') },
    !unplaced && { id: 'create', label: ui('给这个知识点出题') },
    !unplaced && { id: 'code', label: ui('复制编号') },
    !unplaced && pointFold && { id: 'fold-point', label: pointFold.folded ? ui('展开这个知识点的 AI 段落') : ui('收起这个知识点的 AI 段落') },
    { heading: true, label: ui('阅读') },
    { id: 'scroll', label: ui('整章连着读'), checked: scroll, hint: ui('← → 仍按知识点走') },
    { id: 'flip', label: ui('翻看'), hint: ui('易错点多的在前') },
    bookFold && { id: 'fold-book', label: bookFold.folded ? ui('展开整本书的 AI 段落') : ui('收起整本书的 AI 段落'), hint: ui('只记在这个浏览器里') },
    { heading: true, label: ui('整本书') },
    { id: 'lookup', label: ui('速查页…') },
    { id: 'export', label: ui('导出…'), hint: pagesHint },
    { id: 'chat', label: ui('发给主会话…'), hint: ui('只填进输入框，不自动发送') },
    { heading: true, label: ui('期末一周') },
    today && { id: 'today', label: ui('今天读哪几节') },
    { id: 'mock', label: ui('出一套模拟卷…'), hint: mockScope ? uiFormat('今天的 {0} 个知识点', [mockScope]) : ui('整本书') },
    dateHint?.kind === 'none' && settings && { id: 'exam-date', label: ui('设置考试日期') },
    settings && { id: 'settings', label: ui('前往设置'), hint: dateHint?.kind === 'later' ? uiFormat('期末一周在考前 {0} 天开始', [dateHint.window]) : undefined },
  ].filter(Boolean);
}

/** state: as moreItems; onSelect(id). */
export default function BookMore({ onSelect, ...state }) {
  return (
    <Menu label={ui('更多')} items={moreItems(state)} onSelect={onSelect} className="book-more"
      trigger={({ props, ref }) => <Button ref={ref} size="sm" variant="quiet" icon="more" className="book-bar__btn book-bar__more" aria-label={ui('更多')} {...props}>
        <span className="book-bar__word" aria-hidden="true">{ui('更多')}</span></Button>} />
  );
}
