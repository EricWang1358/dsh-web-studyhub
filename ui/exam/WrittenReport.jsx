import React from 'react';
import { ui, uiFormat } from '../i18n.js';
import { plainPrompt } from '../shared.js';
import { Badge, Button, ErrorState, PageHeader } from '../components/index.js';
import { formatDuration } from '../format.js';
import ResultBreakdown from '../ResultBreakdown.jsx';
import { ReadingBlock, ReadingSettingsButton } from '../reading-settings/ReadingSettings.jsx';
import { kindName, scoreChange } from './exam-written.js';

/* The written exam's report: the score and where it went, the weak topics, what to do next, and the details
   (by topic, deck and kind, the wrong and the skipped questions). Props come from Exam.jsx; nothing is fetched here. */

const percentOf = (row) => `${row.total ? Math.round((row.correct / row.total) * 100) : 0}%`;

function BarRow({ label, row, soft }) {
  return (
    <div className="exam-bar-row">
      <span className="exam-bar-label">{label}</span>
      <span className="exam-bar-track"><span className={'exam-bar-fill' + (soft ? ' soft' : '')} style={{ width: percentOf(row) }} /></span>
      <span className="exam-bar-value">{row.correct}/{row.total}</span>
    </div>
  );
}

function QuestionList({ title, items, empty }) {
  if (!items) return null;
  return (
    <div className="exam-wrong">
      <div className="eyebrow">{title}</div>
      {items.length ? (
        <ul>{items.map((item) => (
          <li key={item.deckId + ':' + item.cardId} className="exam-wrong-row">
            <Badge tone="info">{item.topic || ui('未分类')}</Badge>
            <span className="exam-wrong-prompt" title={plainPrompt(item.prompt)}>{plainPrompt(item.prompt)}</span>
            <Badge>{kindName(item.kind)}</Badge>
          </li>
        ))}</ul>
      ) : <p className="muted">{empty}</p>}
    </div>
  );
}

export default function WrittenReport({ report, busy, pathNote, error, onQueueWeak, onExit, onAgain }) {
  const weakTopicRows = (report.byTopic || [])
    .filter((topic) => topic.total > topic.correct)
    .sort((a, b) => (b.total - b.correct) - (a.total - a.correct))
    .slice(0, 3);
  return (
    <ReadingBlock className="exam-report">
      <PageHeader title={ui('考试报告')} actions={<ReadingSettingsButton className="exam-reading" />}
        description={report.examRole ? uiFormat('{0} · 已判分并计入复习计划。', [report.examRole]) : ui('已判分并计入复习计划。')} />
      <div className="result-hero">
        <div className="result-headline">
          <strong>{Math.round(report.scorePct ?? 0)}%</strong>
          <span>{uiFormat('本次笔试得分 · {0}/{1} 题', [report.correct ?? 0, report.total ?? 0])}</span>
          <small>{uiFormat('用时：{0}', [formatDuration(report.durationMs || 0)])}</small>
        </div>
        <ResultBreakdown total={report.total ?? 0} answered={report.answered ?? 0} correct={report.correct ?? 0} correctLabel={ui('答对')} />
      </div>
      {report.comparison && <p className="muted">{uiFormat('同范围、题数及题型构成的上次考试为 {0}%；这次{1}。两次抽到的题目可能不同，仅供参考。', [report.comparison.scorePct, scoreChange(report.comparison)])}</p>}

      <div className="result-weak">
        <h2>{ui('下次先练这些主题')}</h2>
        {weakTopicRows.length ? <ol>{weakTopicRows.map((topic) => <li key={`${topic.deckId}:${topic.topic}`}>
          {topic.topic || ui('未分类')} <span className="muted">· {uiFormat('{0}/{1} 题答错或未答', [topic.total - topic.correct, topic.total])}</span>
        </li>)}</ol> : <p className="muted">{ui('本次已答题全部答对。')}</p>}
        {report.weakScope?.length > 0 && <Button busy={busy} disabled={!!pathNote} onClick={onQueueWeak}>{uiFormat('练习答错与未答的 {0} 道 →', [report.weakScope.length])}</Button>}
        {pathNote && <p className="muted exam-path-note">{pathNote}</p>}
      </div>

      <div className="exam-report-actions">
        <Button variant="primary" onClick={onExit}>{ui('回学习库')}</Button>
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
        <QuestionList title={uiFormat('答错 · {0}', [report.wrong?.length || 0])} items={report.wrong || []} empty={ui('已答的题目没有答错。')} />
        {report.skipped?.length > 0 && <QuestionList title={uiFormat('未答 · {0}', [report.skipped.length])} items={report.skipped} />}
      </details>
      {error && <ErrorState error={error} />}
    </ReadingBlock>
  );
}
