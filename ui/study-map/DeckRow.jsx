import React from 'react';
import { ui, uiFormat } from '../i18n.js';
import { LEVEL_LABEL } from '../shared.js';
import { Badge, DisclosureToggle, Icon, Menu, foldLabel } from '../components/index.js';
import ArchivedDeckRow from '../ArchivedDeckRow.jsx';
import MasteryBar from './MasteryBar.jsx';
import { dotLevel, topicKey } from './map-model.js';
import { deckAnalysisPrompt, topicExplainPrompt } from '../agent-prompts/library.js';

/** One deck of the tree: its fold, selection, mastery, play button and ⋯ menu, and its topics when open. */
export default function DeckRow({ deck: d, progress: p, open, tree, runFor, busy, actions }) {
  if (d.archived) return <ArchivedDeckRow deck={d} busy={busy} onRestore={actions.restoreDeck} onRemove={actions.removeDeck} onManage={actions.manage} />;
  const { start, resume, manage, askInChat } = actions;
  const key = topicKey(d.id), whole = tree.selected.has(key), run = runFor([{ deckId: d.id }]);
  const choose = {
    new: () => start({ deckId: d.id, mode: 'new', fresh: true }),
    flashcard: () => start({ deckId: d.id, mode: 'flashcard' }),
    quiz: () => start({ deckId: d.id, mode: 'quiz' }),
    wrong: () => start({ deckId: d.id, mode: 'wrong' }),
    ask: () => askInChat(deckAnalysisPrompt({ deckTitle: d.title })),
    manage: () => manage(d.id),
  };
  const items = [
    { id: 'new', label: ui('从新题开始'), disabled: busy || !p?.counts?.new },
    { id: 'flashcard', label: ui('闪卡翻看'), disabled: busy || !d.available },
    { id: 'quiz', label: ui('测验'), disabled: busy || !d.quizCount },
    { id: 'wrong', label: uiFormat('待巩固重练 {0}', [d.wrong || 0]), disabled: busy || !d.wrong },
    { id: 'ask', label: ui('在对话中分析'), disabled: busy },
    { id: 'manage', label: ui('管理题组'), disabled: busy },
  ];
  return (
    <li className="map-deck">
      <div className={`map-row deck-row${whole ? ' map-row--selected' : ''}`}>
        <DisclosureToggle className="map-fold" open={open} label={foldLabel(open, d.title)} onToggle={() => tree.toggleOpen(d.id)} />
        <input type="checkbox" aria-label={uiFormat('选择题组 {0}', [d.title])} checked={whole} disabled={d.archived}
          onChange={(event) => tree.toggleSelect([key], event.target.checked)} />
        <span className={`map-dot lv-${p ? dotLevel(p) : 'new'}`} />
        <button className="map-name" onClick={() => tree.toggleOpen(d.id)}>
          <strong>{d.title}{d.format === 'case-study' && <Badge size="sm" tone="info" className="deck-case-mark" title={ui('案例分析题组：长案例 + 开放题，按评分标准批改')}>
            {d.caseBest ? uiFormat('案例 · 最好 {0}/{1}', [d.caseBest.total, d.caseBest.max]) : uiFormat('案例 · {0} 分', [d.caseMarks])}</Badge>}</strong>
          <small>
            {[uiFormat('{0} 题', [d.available]), p?.due ? uiFormat('{0} 题到期', [p.due]) : '',
              d.wrong ? uiFormat('{0} 题待巩固', [d.wrong]) : '',
              d.uncheckedAtPublish ? uiFormat('{0} 题未自动审阅', [d.uncheckedAtPublish]) : '',
              d.selfCited ? uiFormat('{0} 题仅有导入题目引用', [d.selfCited]) : '',
              d.archived ? ui('已归档') : ''].filter(Boolean).join(' · ')}
          </small>
        </button>
        {p && <MasteryBar node={p} />}
        <button className={`map-play${run ? ' is-run' : ''}`} disabled={busy || d.archived || !d.available}
          title={run ? uiFormat('继续 {0}/{1}', [run.index + 1, run.total]) : uiFormat('学习全部 {0} 题', [d.available])}
          aria-label={uiFormat('开始学习 {0}', [d.title])}
          onClick={() => (run ? resume(run.id) : start({ mode: 'path', scope: [{ deckId: d.id }] }))}>
          {run ? ui('继续') : <Icon name="play" size={14} />}
        </button>
        <Menu className="map-menu-wrap" label={ui('更多操作')} items={items} onSelect={(id) => choose[id]()} />
      </div>
      {open && p?.topics.length > 0 && (
        <ul className="map-topics">
          {p.topics.map((t) => {
            const k = topicKey(d.id, t.name), level = dotLevel(t), topicRun = runFor([{ deckId: d.id, topic: t.name }]);
            return (
              <li key={t.name} className={`map-row topic-row${whole || tree.selected.has(k) ? ' map-row--selected' : ''}`}>
                <input type="checkbox" aria-label={uiFormat('选择主题 {0}', [t.name])} checked={whole || tree.selected.has(k)}
                  disabled={whole || d.archived} onChange={(event) => tree.toggleSelect([k], event.target.checked)} />
                <span className={`map-dot lv-${level}`} title={LEVEL_LABEL[level]} />
                <span className="map-name">
                  <span>{t.name}</span>
                  <small>{uiFormat('{0} 题', [t.total])}{' · '}{t.due ? uiFormat('{0} 题到期', [t.due]) : LEVEL_LABEL[level]}</small>
                </span>
                <MasteryBar node={t} />
                <button className={`map-play${topicRun ? ' is-run' : ''}`} disabled={busy || d.archived} aria-label={uiFormat('学习主题 {0}', [t.name])}
                  title={topicRun ? uiFormat('继续 {0}/{1}', [topicRun.index + 1, topicRun.total]) : ui('学习这个主题')}
                  onClick={() => (topicRun ? resume(topicRun.id) : start({ mode: 'path', scope: [{ deckId: d.id, topic: t.name }] }))}>
                  {topicRun ? ui('继续') : <Icon name="play" size={14} />}
                </button>
                <button className="map-ask" title={ui('在对话中讲解这个主题')} aria-label={uiFormat('在对话中讲解 {0}', [t.name])}
                  onClick={() => askInChat(topicExplainPrompt({ topic: t.name, deckTitle: d.title, mastery: t.mastery, weak: t.counts.weak }))}>{ui('问')}</button>
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}
