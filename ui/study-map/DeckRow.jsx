import React from 'react';
import { ui, uiFormat } from '../i18n.js';
import { LEVEL_LABEL } from '../shared.js';
import { Badge, CheckboxInput, DisclosureToggle, Icon, Menu, foldLabel } from '../components/index.js';
import ArchivedDeckRow from '../ArchivedDeckRow.jsx';
import { archiveMenuItem } from '../archive-entries.js';
import MasteryBar from './MasteryBar.jsx';
import { dotLevel, topicKey } from './map-model.js';
import { HandOff } from '../hand-off/HandOff.jsx';
import { useHandOff } from '../hand-off/use-hand-off.js';
import { useStudy } from '../study-context.jsx';
import { useOptionalAppSelector } from '../app/app-context.js';
import PaceMeta from '../pace/PaceMeta.jsx';

/** The inside of a play slot: the ▶ of a row with no open run, 「继续 →」 of one with a run. A row without a run keeps the room of 「继续 →」 in an invisible twin, so every slot is as wide as
    its widest face in the language of the page (「Continue →」 is wider than 「继续 →」, and a fixed width cut it) and the bars of the rows still line up. */
function PlaySlot({ run }) {
  const resume = <>{ui('继续')}<Icon name="arrow-right" className="sh-icon--inline" /></>;
  return run
    ? <span className="map-play__face row-end">{resume}</span>
    : <><span className="map-play__face map-play__glyph"><Icon name="play" size={14} /></span><span className="map-play__face map-play__ghost row-end" aria-hidden="true">{resume}</span></>;
}

/** One deck of the tree: its fold, selection, mastery, play button and ⋯ menu (with 发给主会话), and its topics when open (each with a 发给主会话 icon). */
export default function DeckRow({ deck: d, progress: p, open, tree, runFor, actions, paceForecast: propPaceForecast }) {
  const { busy } = useStudy();
  const handOff = useHandOff();
  const storePaceForecast = useOptionalAppSelector((state) => state.data?.paceForecast);
  const paceForecast = propPaceForecast ?? storePaceForecast;
  if (d.archived) return <ArchivedDeckRow deck={d} onRestore={actions.restoreDeck} onRemove={actions.removeDeck} onManage={actions.manage} />;
  const deckPace = !d.systemKind ? paceForecast?.decks?.[d.id] ?? null : null;
  const { start, confirmStart, resume, manage, archiveDeck, openVoicePack, runsOn } = actions;
  // The ▶ is one small icon next to others, so it asks before it starts; 「继续 →」 resumes at once.
  const play = (ask, scope) => confirmStart(ask, () => start({ mode: 'path', scope }));
  const key = topicKey(d.id), whole = tree.selected.has(key), run = runFor([{ deckId: d.id }]);
  const choose = {
    new: () => start({ deckId: d.id, mode: 'new', fresh: true }),
    flashcard: () => start({ deckId: d.id, mode: 'flashcard' }),
    quiz: () => start({ deckId: d.id, mode: 'quiz' }),
    wrong: () => start({ deckId: d.id, mode: 'wrong' }),
    voicePack: () => openVoicePack?.({ deckId: d.id, deckTitle: d.title, course: d.course || d.folder || '' }),
    coachDebrief: () => handOff.send('coach.debrief', { deckTitle: d.title, course: d.course || d.folder || '' }),
    manage: () => manage(d.id),
    archive: () => archiveDeck(d),
  };
  // 归档 sits last, after 管理题组: archive-first stays (permanent delete is reachable only from the archive); this is the shorter way to it.
  const archive = archiveDeck ? archiveMenuItem(d, { busy, runs: runsOn?.(d.id) || 0 }) : null;
  const items = [
    { id: 'new', label: ui('从新题开始'), disabled: busy || !p?.counts?.new },
    { id: 'flashcard', label: ui('闪卡翻看'), disabled: busy || !d.available },
    { id: 'quiz', label: ui('测验'), disabled: busy || !d.quizCount },
    { id: 'wrong', label: uiFormat('待巩固重练 {0}', [d.wrong || 0]), disabled: busy || !d.wrong },
    ...(openVoicePack ? [{ id: 'voicePack', label: ui('语音带学包…'), disabled: busy || !d.available }] : []),
    { id: 'coachDebrief', label: ui('回传语音记录给主教练结算'), disabled: busy },
    { ...handOff.item('deck.ask', { deckTitle: d.title }), disabled: busy },
    { id: 'manage', label: ui('管理题组'), disabled: busy },
    ...(archive ? [archive] : []),
  ];
  return (
    <li className="map-deck" data-deck-id={d.id}>
      <div className={`map-row deck-row${whole ? ' map-row--selected' : ''}`}>
        <DisclosureToggle className="map-fold" open={open} label={foldLabel(open, d.title)} onToggle={() => tree.toggleOpen(d.id)} />
        <CheckboxInput className="map-row__check" aria-label={uiFormat('选择题组 {0}', [d.title])} checked={whole} disabled={d.archived}
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
          {deckPace && <PaceMeta variant="deck" inline hideMastered forecast={deckPace} pace={paceForecast?.pace} asOf={paceForecast?.asOf} />}
        </button>
        {p && <MasteryBar node={p} />}
        <button className={`map-play${run ? ' is-run' : ''}`} disabled={busy || d.archived || !d.available}
          title={run ? uiFormat('继续 {0}/{1}', [run.index + 1, run.total]) : uiFormat('学习全部 {0} 题', [d.available])}
          aria-label={run ? `${ui('继续')} ${d.title}` : uiFormat('开始学习 {0}', [d.title])}
          onClick={() => (run ? resume(run.id) : play({ kind: 'deck', name: d.title }, [{ deckId: d.id }]))}>
          <PlaySlot run={run} />
        </button>
        <Menu className="map-menu-wrap" label={ui('更多操作')} items={items} onSelect={(id) => choose[id]()} />
      </div>
      {open && p?.topics.length > 0 && (
        <ul className="map-topics">
          {p.topics.map((t) => {
            const k = topicKey(d.id, t.name), level = dotLevel(t), topicRun = runFor([{ deckId: d.id, topic: t.name }]);
            return (
              <li key={t.name} className={`map-row topic-row${whole || tree.selected.has(k) ? ' map-row--selected' : ''}`}>
                <CheckboxInput className="map-row__check" aria-label={uiFormat('选择主题 {0}', [t.name])} checked={whole || tree.selected.has(k)}
                  disabled={whole || d.archived} onChange={(event) => tree.toggleSelect([k], event.target.checked)} />
                <span className={`map-dot lv-${level}`} />
                <span className="map-name">
                  <span>{t.name}</span>
                  <small>{uiFormat('{0} 题', [t.total])}{' · '}{t.due ? uiFormat('{0} 题到期', [t.due]) : LEVEL_LABEL[level]}</small>
                </span>
                <MasteryBar node={t} />
                <button className={`map-play${topicRun ? ' is-run' : ''}`} disabled={busy || d.archived}
                  aria-label={topicRun ? `${ui('继续')} ${t.name}` : uiFormat('学习主题 {0}', [t.name])}
                  title={topicRun ? uiFormat('继续 {0}/{1}', [topicRun.index + 1, topicRun.total]) : ui('学习这个主题')}
                  onClick={() => (topicRun ? resume(topicRun.id) : play({ kind: 'topic', name: t.name }, [{ deckId: d.id, topic: t.name }]))}>
                  <PlaySlot run={topicRun} />
                </button>
                <HandOff id="topic.explain" shape="icon" what="让主会话讲解这个主题" anchorClassName="map-ask"
                  input={{ topic: t.name, deckTitle: d.title, mastery: t.mastery, weak: t.counts.weak }} />
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}
