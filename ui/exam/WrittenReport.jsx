import React, { useEffect, useMemo, useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { plainPrompt, useInjectCss } from '../shared.js';
import { Badge, Button, ErrorState, PageHeader, ProgressBar, Switch, Tooltip } from '../components/index.js';
import { formatDuration } from '../format.js';
import { examPostmortemBridge } from '../../lib/practice-settings.js';
import { fixedOptionsOf } from '../../lib/card-kinds.js';
import { fixedOptionLabel } from '../option-label.js';
import OptionMark from '../OptionMark.jsx';
import AnswerState from '../review/AnswerState.jsx';
import ChoiceFeedback from '../ChoiceFeedback.jsx';
import CitationDisclosure from '../CitationDisclosure.jsx';
import Markdown from '../Markdown.jsx';
import ResultBreakdown from '../ResultBreakdown.jsx';
import { ReadingBlock, ReadingSettingsButton } from '../reading-settings/ReadingSettings.jsx';
import { buildExamPostmortem } from './exam-postmortem.js';
import { kindName, scoreChange } from './exam-written.js';
import reportCss from './written-report.css';

/* The written exam's report: the score and where it went, the weak topics, what to do next, and the details
   (by topic, deck and kind, the wrong and the skipped questions). Props come from Exam.jsx; nothing is fetched here. */

function BarRow({ label, row, soft }) {
  const allRowCorrect = (row.total || 0) > 0 && row.correct === row.total;
  return (
    <div className="exam-bar-row">
      <span className="exam-bar-label">{label}</span>
      <ProgressBar label={label} value={row.correct} max={row.total || 1} tone={soft ? 'neutral' : (allRowCorrect ? 'success' : 'accent')} />
      <span className="exam-bar-value">{row.correct}/{row.total}</span>
    </div>
  );
}

function QuestionQaDetail({ item, sources = null, onOpenSource = null }) {
  const hasOptions = Array.isArray(item.options) && item.options.length > 0;
  const hasCitations = Boolean(onOpenSource && ((Array.isArray(item.citations) && item.citations.length > 0) || (Array.isArray(item.selections) && item.selections.length > 0)));
  const hasDetail = Boolean(hasOptions || item.answer || item.explanation || item.misconception || hasCitations);
  if (!hasDetail) return null;
  const isMulti = Boolean(item.multiple || item.kind === 'multi');
  const verdict = Boolean(fixedOptionsOf(item.kind));
  const selected = Array.isArray(item.selected) ? item.selected : [];
  const selectedSet = new Set(selected);
  const cardShape = { kind: item.kind, multiple: isMulti, options: item.options || [] };
  return (
    <details className="exam-wrong-qa" data-exam-qa-detail="">
      <summary>{ui('查看答案与解析')}</summary>
      <div className="exam-wrong-qa__body">
        <div className="exam-wrong-qa__prompt"><Markdown text={item.prompt} links={false} /></div>
        {hasOptions && (
          <>
            <div className="exam-wrong-qa__feedback">
              <ChoiceFeedback card={cardShape} options={item.options} feedback={{ selected }} solution={{ options: item.options }} multiple={isMulti} />
            </div>
            <div className="exam-wrong-qa__options">
              {item.options.map((option, idx) => {
                const picked = selectedSet.has(option.id);
                return (
                  <div key={option.id} className={'exam-wrong-qa__option ' + (option.correct ? 'is-correct' : picked ? 'is-incorrect' : 'is-dim')}>
                    <span className="exam-wrong-qa__mark" aria-hidden={verdict || undefined}><OptionMark card={cardShape} option={option} index={idx} /></span>
                    <div className="exam-wrong-qa__option-body">
                      {verdict ? <span className="exam-wrong-qa__verdict">{fixedOptionLabel(cardShape, option)}</span> : <Markdown text={option.text} links={false} className="md-compact" />}
                      <AnswerState correct={option.correct} picked={picked} multiple={isMulti} />
                      {option.explanation && <Markdown text={option.explanation} links={false} className="md-compact exam-wrong-qa__option-note" />}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
        {!hasOptions && item.answer && (
          <div className="exam-wrong-qa__ref">
            <h4>{ui('参考答案')}</h4>
            <Markdown text={item.answer} links={false} />
          </div>
        )}
        {(item.explanation || item.misconception) && (
          <div className="exam-wrong-qa__explanation">
            {item.explanation && <><h4>{ui('理解这道题')}</h4><Markdown text={item.explanation} links={false} /></>}
            {item.misconception && <><h4>{ui('容易混淆的地方')}</h4><Markdown text={item.misconception} links={false} /></>}
          </div>
        )}
        {hasCitations && (
          <CitationDisclosure card={item} sources={sources || []} onOpenSource={(source, quote) => { if (source?.id) onOpenSource(source.id, quote); }} />
        )}
      </div>
    </details>
  );
}

function QuestionList({ title, items, empty, sources = null, citationsByCard = null, lock = false, disabled = false, onOpenSource = null, onPracticeItem = null, onCiteSource = null }) {
  if (!items) return null;
  return (
    <div className="exam-wrong">
      <div className="eyebrow">{title}</div>
      {items.length ? (
        <ul>{items.map((item, index) => {
          const cite = citationsByCard?.get(`${item.deckId}:${item.cardId}`) || null;
          const showActions = Boolean((cite && onOpenSource) || onPracticeItem);
          const hasQa = Boolean((Array.isArray(item.options) && item.options.length > 0) || item.answer || item.explanation || item.misconception || (onCiteSource && ((Array.isArray(item.citations) && item.citations.length > 0) || (Array.isArray(item.selections) && item.selections.length > 0))));
          return (
            <li key={`${item.deckId}:${item.cardId}:${index}`} className={'exam-wrong-row' + (hasQa ? ' exam-wrong-row--qa' : '')} data-has-actions={showActions ? 'true' : undefined} data-has-qa={hasQa ? 'true' : undefined}>
              <Badge tone="info">{item.topic || ui('未分类')}</Badge>
              <Tooltip layer content={plainPrompt(item.prompt)} anchorClassName="exam-wrong-prompt-tip">
                <span className="exam-wrong-prompt" tabIndex={0}>{plainPrompt(item.prompt)}</span>
              </Tooltip>
              <Badge>{kindName(item.kind)}</Badge>
              {showActions && (
                <span className="exam-wrong-actions">
                  {cite && onOpenSource && (
                    <Button variant="quiet" size="sm" iconEnd="arrow-right" onClick={() => onOpenSource(cite.sourceId, cite.quote)}>
                      {ui('打开出处')}
                    </Button>
                  )}
                  {onPracticeItem && (
                    <Button variant="quiet" size="sm" iconEnd="arrow-right" lock={lock} disabled={disabled}
                      onClick={() => onPracticeItem([{ deckId: item.deckId, cardId: item.cardId }])}>
                      {ui('去练这道题')}
                    </Button>
                  )}
                </span>
              )}
              {hasQa && <QuestionQaDetail item={item} sources={sources} onOpenSource={onCiteSource} />}
            </li>
          );
        })}</ul>
      ) : <p className="muted">{empty}</p>}
    </div>
  );
}

/** The name of a topic row: the deck is named only when the same topic name also stands in another deck. */
const topicLabel = (report, row) => (report.byTopic.filter((other) => other.topic === row.topic).length > 1 ? `${row.deckTitle} · ` : '') + (row.topic || ui('未分类'));

export default function WrittenReport({ report, busy, pathNote, error, practiceSettings = null, decks = null, sources = null, onQueueWeak, onPracticeTopic, onPracticeScope = null, onOpenSource = null, onTogglePostmortem = null, onExit, onAgain }) {
  useInjectCss(reportCss, 'study-written-report');
  const weakTopicRows = (report.byTopic || [])
    .filter((topic) => topic.total > topic.correct)
    .sort((a, b) => (b.total - b.correct) - (a.total - a.correct))
    .slice(0, 3);
  const totalCount = Number(report.total) || 0;
  const correctCount = Number(report.correct) || 0;
  const allCorrect = totalCount > 0 && correctCount === totalCount;
  const scoreDelta = report.comparison && Number.isFinite(report.comparison.scorePct)
    ? Math.round(report.scorePct ?? 0) - Math.round(report.comparison.scorePct)
    : 0;
  const settingBridgeOn = examPostmortemBridge(practiceSettings);
  const [bridgeOverride, setBridgeOverride] = useState(null);
  const [togglingBridge, setTogglingBridge] = useState(false);
  useEffect(() => { setBridgeOverride(null); }, [settingBridgeOn]);
  const bridgeOn = bridgeOverride ?? settingBridgeOn;
  const handleToggleBridge = async (next) => {
    if (typeof onTogglePostmortem !== 'function' || togglingBridge) return;
    setBridgeOverride(next);
    setTogglingBridge(true);
    try {
      const ok = await onTogglePostmortem(next);
      if (ok === false) setBridgeOverride(null);
    } catch {
      setBridgeOverride(null);
    } finally {
      setTogglingBridge(false);
    }
  };
  const hasMissedOrSkipped = (report.wrong?.length || 0) > 0 || (report.skipped?.length || 0) > 0;
  // What went wrong comes first (#1687): practising the wrong and unanswered questions is the one filled button when it can start now; else going back is.
  const practiseFirst = report.weakScope?.length > 0 && !pathNote;
  const unansweredCount = Array.isArray(report.skipped) ? report.skipped.length : (Number(report.unanswered) || 0);
  const postmortem = useMemo(
    () => (bridgeOn ? buildExamPostmortem(report, { decks, sources }) : null),
    [bridgeOn, report, decks, sources],
  );
  return (
    <ReadingBlock className="exam-report">
      <PageHeader title={ui('考试报告')} actions={<ReadingSettingsButton className="exam-reading" />}
        description={report.examRole ? uiFormat('{0} · 已判分并计入复习计划。', [report.examRole]) : ui('已判分并计入复习计划。')} />
      <div className="result-hero sh-paper-card sh-paper-card--roomy" data-all-correct={allCorrect ? 'true' : undefined}>
        <div className="result-headline">
          <strong>{Math.round(report.scorePct ?? 0)}%</strong>
          <span>{uiFormat('本次笔试得分 · {0}/{1} 题', [report.correct ?? 0, report.total ?? 0])}</span>
          {(allCorrect || scoreDelta > 0) && (
            <div className="result-hero__badges">
              {allCorrect && <span className="result-hero__badge" data-testid="exam-all-correct">{ui('本次全部答对')}</span>}
              {scoreDelta > 0 && <span className="result-hero__badge" data-testid="exam-score-up">{uiFormat('较上次 +{0}%', [scoreDelta])}</span>}
            </div>
          )}
          <small>{uiFormat('用时：{0}', [formatDuration(report.durationMs || 0)])}</small>
        </div>
        <ResultBreakdown total={report.total ?? 0} answered={report.answered ?? 0} correct={report.correct ?? 0} correctLabel={ui('答对')} />
        {bridgeOn && postmortem?.answeredAccuracyPct !== null && unansweredCount > 0 && (
          <p className="muted small exam-attempted-note" data-exam-postmortem-pacing="">
            {uiFormat('已作答部分正确率 {0}%（{1}/{2}）· 未作答 {3} 题', [
              postmortem.answeredAccuracyPct,
              report.correct ?? 0,
              report.answered ?? 0,
              unansweredCount,
            ])}
          </p>
        )}
      </div>
      {report.comparison && <p className="muted">{uiFormat('同范围、题数及题型构成的上次考试为 {0}%；这次{1}。两次抽到的题目可能不同，仅供参考。', [report.comparison.scorePct, scoreChange(report.comparison)])}</p>}

      <div className="result-weak" data-all-correct={allCorrect && !weakTopicRows.length ? 'true' : undefined}>
        <h2>{allCorrect && !weakTopicRows.length ? ui('全部主题均已达标') : ui('下次先练这些主题')}</h2>
        {weakTopicRows.length ? <ol>{weakTopicRows.map((topic) => <li key={`${topic.deckId}:${topic.topic}`}>
          {topicLabel(report, topic)} <span className="muted">· {uiFormat('{0}/{1} 题答错或未答', [topic.total - topic.correct, topic.total])}</span>
          {onPracticeTopic && <Button variant="link" size="sm" iconEnd="arrow-right" className="exam-topic-practice" disabled={!!pathNote} lock={busy}
            onClick={() => onPracticeTopic(topic)}>{ui('练这个主题')}</Button>}
        </li>)}</ol> : <p className="muted result-weak__empty">{ui('本次已答题全部答对。')}</p>}
        {report.weakScope?.length > 0 && <Button className="exam-weak-queue" variant={practiseFirst ? 'primary' : 'secondary'} iconEnd="arrow-right" busy={busy} disabled={!!pathNote} onClick={onQueueWeak}>{uiFormat('练习答错与未答的 {0} 道', [report.weakScope.length])}</Button>}
        {bridgeOn && postmortem?.wrongScope.length > 0 && postmortem?.skippedScope.length > 0 && onPracticeScope && (
          <div className="exam-weak-split" data-exam-weak-split="">
            <Button size="sm" variant="secondary" iconEnd="arrow-right" lock={busy} disabled={!!pathNote}
              onClick={() => onPracticeScope(postmortem.wrongScope)}>{uiFormat('只练答错（{0}）', [postmortem.wrongScope.length])}</Button>
            <Button size="sm" variant="secondary" iconEnd="arrow-right" lock={busy} disabled={!!pathNote}
              onClick={() => onPracticeScope(postmortem.skippedScope)}>{uiFormat('补做未答（{0}）', [postmortem.skippedScope.length])}</Button>
          </div>
        )}
        {typeof onTogglePostmortem === 'function' && hasMissedOrSkipped && (
          // A display switch looks like one and shows whether it is on (#1707); the same words either way.
          <div className="exam-postmortem-toggle" data-exam-postmortem-toggle="">
            <Switch label={ui('拆分答错与未答')} hint={ui('显示已作答正确率、分练答错/未答与原出处（不消耗模型）')}
              checked={bridgeOn} disabled={togglingBridge} onChange={handleToggleBridge} />
          </div>
        )}
        {pathNote && <p className="muted exam-path-note">{pathNote}</p>}
      </div>

      <div className="exam-report-actions">
        <Button icon="arrow-left" variant={practiseFirst ? 'secondary' : 'primary'} onClick={onExit}>{ui('回学习库')}</Button>
        <Button onClick={onAgain}>{ui('再考一次')}</Button>
      </div>

      <details className="result-details"><summary>{ui('查看详细成绩与错题')}</summary>
        <div className="exam-bars">
          <div className="eyebrow">{ui('按主题分布')}</div>
          {report.byTopic?.length
            ? report.byTopic.map((topic) => <BarRow key={`${topic.deckId}:${topic.topic}`} row={topic}
              label={(report.byTopic.filter((row) => row.topic === topic.topic).length > 1 ? `${topic.deckTitle} · ` : '') + (topic.topic || ui('未分类'))} />)
            : <p className="muted">{ui('暂无主题分布。')}</p>}
        </div>
        {report.byDeck?.length > 0 && <div className="exam-bars">
          <div className="eyebrow">{ui('按题组分布')}</div>
          {report.byDeck.map((deck) => <BarRow key={deck.deckId} soft row={deck} label={deck.title} />)}
        </div>}
        {report.byKind?.length > 0 && <div className="exam-bars">
          <div className="eyebrow">{ui('按题型分布')}</div>
          {report.byKind.map((row) => <BarRow key={row.kind} soft row={row} label={kindName(row.kind)} />)}
        </div>}
        <QuestionList title={uiFormat('答错 · {0}', [report.wrong?.length || 0])} items={report.wrong || []} empty={ui('已答的题目没有答错。')}
          sources={sources} citationsByCard={postmortem?.citationsByCard} lock={busy} disabled={!!pathNote}
          onOpenSource={bridgeOn ? onOpenSource : null} onPracticeItem={bridgeOn ? onPracticeScope : null} onCiteSource={onOpenSource} />
        {report.skipped?.length > 0 && <QuestionList title={uiFormat('未答 · {0}', [report.skipped.length])} items={report.skipped}
          sources={sources} citationsByCard={postmortem?.citationsByCard} lock={busy} disabled={!!pathNote}
          onOpenSource={bridgeOn ? onOpenSource : null} onPracticeItem={bridgeOn ? onPracticeScope : null} onCiteSource={onOpenSource} />}
      </details>
      {error && <ErrorState error={error} />}
    </ReadingBlock>
  );
}
