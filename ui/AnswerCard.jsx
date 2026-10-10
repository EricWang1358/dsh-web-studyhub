import React, { useCallback, useState } from 'react';
import { ui, uiFormat, errorMessage } from './i18n.js';
import { useInjectCss } from './shared.js';
import Markdown from './Markdown.jsx';
import { Badge, Button, InlineMessage, Spinner } from './components/index.js';
import ModelSetupGate from './ModelSetupGate.jsx';
import { modelReadiness } from './generation-status.js';
import { useStudy } from './study-context.jsx';
import { usePolling } from './use-polling.js';
import { isActiveJob } from '../lib/job-status.js';
import { useBookQa } from './book/BookQaButton.jsx';
import css from './answer-card.css';

/* 分析题答案卡 (复习全书 M5, lib/answer-card.js) in the feedback of a case question: the ONE full answer card in its parts, each quote and concept marked
   未核实 when the program could not find it word for word, the marks map, and the card's state (已核对 / 部分未核对 / 被改过) with 「已核对 ≠ 答案正确」.
   It replaces the plain reference answer when the question has one; without one the reference answer shows as before, with 「生成答题卡」 (a visible
   task, the shared model gate) under it. 「加入复习全书」 puts the card into the course's book (book.qa.add { answerCard: true }). */

const STATE = {
  verified: () => ({ tone: 'success', label: ui('已核对') }),
  partial: () => ({ tone: 'warning', label: ui('部分未核对') }),
  edited: () => ({ tone: 'warning', label: ui('被改过') }),
};
const marks = value => (Number.isInteger(value) ? String(value) : String(Math.round((Number(value) || 0) * 10) / 10));

function Unverified({ item }) {
  return item?.verified === false ? <Badge size="sm" tone="warning" className="answer-card__unverified">{ui('未核实')}</Badge> : null;
}
function Part({ label, children, id }) {
  return <section className="answer-card__part" data-answer-part={id}><h4 className="answer-card__label">{label}</h4>{children}</section>;
}

/** card: solution.answerCard (with its `state`); actions: what goes under it (加入复习全书, 重新生成). */
export function AnswerCardView({ card, actions = null }) {
  useInjectCss(css, 'study-answer-card');
  if (!card) return null;
  const state = (STATE[card.state] || STATE.partial)();
  const quotes = card.checks?.quotes, coverage = card.checks?.coverage, invented = card.checks?.inventedNumbers || [], review = card.checks?.review;
  const justification = card.justification || {};
  return (
    <section className="answer-card sh-paper-card sh-paper-card--snug" aria-label={ui('答题卡')} data-answer-card={card.state || 'partial'}>
      <header className="answer-card__head">
        <div className="answer-card__title">
          <strong>{ui('答题卡')}</strong>
          {card.questionType?.label && <Badge size="sm">{card.questionType.label}</Badge>}
          <Badge size="sm" tone={state.tone} className="answer-card__state">{state.label}</Badge>
        </div>
        <p className="answer-card__notice">{ui('已核对 ≠ 答案正确：程序逐字核对了引文、算了评分点覆盖、找了来路不明的数字，并做了一次独立复核；对不对还要你自己判断。')}</p>
        {card.state === 'edited' && <p className="answer-card__notice">{ui('这道题（题干、分值、评分标准或参考答案）在答题卡生成后改过，答题卡可能已经对不上。')}</p>}
        {quotes && coverage && <p className="answer-card__checks">{uiFormat('引文 {0}/{1} 已在原文找到 · 评分点 {2}/{3}', [quotes.verified, quotes.total, coverage.covered, coverage.total])}
          {review?.ran === false ? ` · ${ui('独立复核没有完成')}` : review?.repaired ? ` · ${ui('发现的问题已修改一次（修改后没有再复核）')}` : ''}</p>}
        {invented.length > 0 && <InlineMessage tone="warning">{uiFormat('这些数字在题干、假设和概念里都找不到，可能是编出来的：{0}', [invented.join('、')])}</InlineMessage>}
      </header>
      {card.signals?.length > 0 && <Part id="signals" label={ui('识别信号')}>
        <ul>{card.signals.map((item, at) => <li key={at}><strong>{item.word}</strong> <q>{item.quote}</q> <Unverified item={item} /></li>)}</ul>
      </Part>}
      {card.facts?.length > 0 && <Part id="facts" label={ui('题干事实')}>
        <ul>{card.facts.map((item, at) => <li key={at}>{item.text}{item.quote && <> <q className="answer-card__quote">{item.quote}</q></>} <Unverified item={item} /></li>)}</ul>
      </Part>}
      {card.concepts?.length > 0 && <Part id="concepts" label={ui('概念')}>
        <ul>{card.concepts.map((item, at) => <li key={at}>
          <strong>{item.name}</strong>{item.where?.title && <small className="answer-card__where">{uiFormat('（资料：{0}）', [item.where.title])}</small>}
          <blockquote className="answer-card__definition">{item.quote}</blockquote> <Unverified item={item} />
        </li>)}</ul>
      </Part>}
      {card.assumptions?.length > 0 && <Part id="assumptions" label={ui('假设')}><ul>{card.assumptions.map((item, at) => <li key={at}>{item}</li>)}</ul></Part>}
      {card.steps?.length > 0 && <Part id="steps" label={ui('推理链')}><ol>{card.steps.map((item, at) => <li key={at}><Markdown text={item} /></li>)}</ol></Part>}
      {card.conclusion && <Part id="conclusion" label={ui('结论')}><Markdown text={card.conclusion} /></Part>}
      {justification.goal && <Part id="goal" label={ui('为什么满足目标')}><Markdown text={justification.goal} /></Part>}
      {(justification.cost || justification.failure) && <Part id="cost" label={ui('代价与失败处理')}>
        {justification.cost && <Markdown text={justification.cost} />}{justification.failure && <Markdown text={justification.failure} />}
      </Part>}
      {justification.verify && <Part id="verify" label={ui('如何验证')}><Markdown text={justification.verify} /></Part>}
      {card.pitfalls?.length > 0 && <Part id="pitfalls" label={ui('易错检查')}><ul>{card.pitfalls.map((item, at) => <li key={at}>{item}</li>)}</ul></Part>}
      {card.marksMap?.length > 0 && <Part id="marks" label={ui('评分点对照')}>
        <div className="answer-card__table">
          <table>
            <thead><tr><th scope="col">{ui('评分点')}</th><th scope="col">{ui('分值')}</th><th scope="col">{ui('对应的句子')}</th></tr></thead>
            <tbody>{card.marksMap.map(item => <tr key={item.point} className={item.found ? '' : 'is-missing'}>
              <td>{item.label ? `${item.label} · ${item.point}` : item.point}</td><td>{marks(item.marks)}</td>
              <td>{item.found ? item.sentence : <Badge size="sm" tone="warning">{ui('没有句子对应')}</Badge>}</td>
            </tr>)}</tbody>
          </table>
        </div>
      </Part>}
      {actions && <div className="answer-card__actions">{actions}</div>}
    </section>
  );
}

/** 加入复习全书 / 已加入 · 撤回 of an answer card; only where the course has a book. */
function BookButton({ deckId, cardId, book }) {
  const [working, setWorking] = useState(false), [error, setError] = useState('');
  if (!book.ready || !book.courses.size) return null;
  const added = book.cards.has(cardId);
  const run = async () => {
    setWorking(true); setError('');
    try { if (added) await book.removeCard(cardId); else await book.addCard({ deckId, cardId }); } catch (failure) { setError(errorMessage(failure)); } finally { setWorking(false); }
  };
  return (
    <span className="answer-card__book">
      <Button variant="link" size="sm" icon={added ? 'check' : 'book'} data-answer-card-book={added ? 'added' : 'add'} disabled={working} onClick={run}>
        {added ? ui('已加入 · 撤回') : ui('加入复习全书')}</Button>
      {error && <InlineMessage tone="error">{error}</InlineMessage>}
    </span>
  );
}

/**
 * The answer of a graded case question: the answer card when it has one, else the reference answer with 「生成答题卡」. run: the review projection
 * (run.solution after the reveal); data: the snapshot (the model gate); onSetupModel() opens the model settings.
 */
export default function AnswerCardSection({ run, data, onSetupModel }) {
  useInjectCss(css, 'study-answer-card');
  const { call, notify } = useStudy();
  const book = useBookQa();
  const model = modelReadiness(data);
  const card = run.solution?.answerCard, deckId = run.deckId, cardId = run.card?.id;
  const [task, setTask] = useState(null);
  const start = useCallback(async again => {
    setTask({ status: 'starting' });
    try {
      const started = await call('generation.answerCard.build', { deckId, cardId, ...(again ? { again: true } : {}) });
      setTask({ status: 'running', jobId: started.jobId });
      notify?.({ text: ui('已开始生成答题卡：写好后出现在这里；任务页可以看进度。'), tone: 'success' });
    } catch (failure) { setTask({ status: 'failed', message: errorMessage(failure) }); }
  }, [call, notify, deckId, cardId]);
  // The task is looked at now and then until it ends; the practice page reads the question again by itself, the card then in place.
  usePolling(async () => {
    if (task?.status !== 'running') return;
    let job;
    try { job = await call('job.status', { jobId: task.jobId }); } catch { return; }
    const status = job?.status ?? job?.contract?.status;
    if (!status || isActiveJob({ status })) return;
    setTask(status === 'failed' ? { status: 'failed', message: job?.error?.message || job?.contract?.error?.message || ui('答题卡没有写成，可以在任务页重试。') } : null);
  }, { intervalMs: 1500, enabled: task?.status === 'running' });
  const running = task?.status === 'running' || task?.status === 'starting';
  const generate = again => (model.ready
    ? <Button size="sm" variant={again ? 'quiet' : 'secondary'} icon="sparkle" busy={running} disabled={running} data-answer-card-generate={again ? 'again' : 'new'}
      onClick={() => start(again)}>{again ? ui('重新生成答题卡') : ui('生成答题卡')}</Button>
    : <ModelSetupGate variant="compact" feature="answerCard" model={model} onOpenSettings={onSetupModel} />);
  const status = <>
    {running && <p className="answer-card__running" role="status"><Spinner size="sm" />{ui('正在生成答题卡：写、逐字核对、独立复核，需要两三次模型调用。可以先去做别的题。')}</p>}
    {task?.status === 'failed' && <InlineMessage tone="error">{task.message}</InlineMessage>}
  </>;
  if (card) return (
    <div className="answer-card-section">
      <AnswerCardView card={card} actions={<>
        <BookButton deckId={deckId} cardId={cardId} book={book} />
        {card.state === 'edited' && generate(true)}
      </>} />
      {status}
      {run.solution?.answer && <details className="rubric-my-answer"><summary>{ui('原来的参考答案')}</summary><Markdown text={run.solution.answer} /></details>}
    </div>
  );
  return (
    <div className="answer-card-section">
      {run.solution?.answer && <details className="rubric-my-answer" open><summary>{ui('参考答案（批改后揭晓）')}</summary><Markdown text={run.solution.answer} /></details>}
      <div className="answer-card__offer">
        <p className="answer-card__hint">{ui('答题卡把这道题拆成题型信号、题干事实、概念原文、假设、推理链、结论和评分点对照，每处引文都逐字核对。')}</p>
        {generate(false)}
      </div>
      {status}
    </div>
  );
}
