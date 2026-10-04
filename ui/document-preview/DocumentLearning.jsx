import React, { useCallback, useEffect, useState, useRef } from 'react';
import Markdown from '../Markdown.jsx';
import { ui, uiFormat, uiLanguageName } from '../i18n.js';
import { TokenEstimate } from '../TokenUsage.jsx';
import MathText from '../MathText.jsx';
import { Badge, Button, InlineMessage, useToast } from '../components/index.js';
import { selectionRequest } from './selection.js';
import { SelectionJobList } from './SelectionJobs.jsx';
import { blockingJob, deckName, isActive, mergeJobs, startErrorText, startedNotice, upsertJob } from './selection-job.js';
import SaveAnswerAsCard from './links/SaveAnswerAsCard.jsx';

const statusLabels = {
  ambiguous: '原文中有多处相同文字，请缩小选区或加入前后文后重新选择。',
  stale: '资料已更新，这段引用需要在当前原文中重新选择。',
  missing: '无法在已保存的资料中核实这段文字，请重新选择。',
  unavailable: '当前未安装所需能力，或没有可用模型。',
};

export function PassageLinks({ groups = [], onOpenCard }) {
  if (!groups.length) return <p className="muted">{ui('这份资料还没有关联题目。选中文字即可补充到现有题组。')}</p>;
  return <div className="study-passage-links">{groups.map((group, index) => <details key={JSON.stringify(group.selection)}>
    <summary><sup>[{group.number || index + 1}]</sup> <MathText text={group.selection.quote} /> <small>{uiFormat('· {0} 道题', [group.links.length])}</small></summary>
    {group.links.map(link => <article key={`${link.deckId}:${link.cardId}`}>
      <p><strong>{link.prompt || link.cardId}</strong>{link.status !== 'resolved' && <> <Badge tone="warning" size="sm">{ui(link.status === 'stale' ? '引用待核对' : '原文位置不可用')}</Badge></>}</p>
      {link.answer && <p>{Array.isArray(link.answer) ? link.answer.join('、') : String(link.answer)}</p>}
      {link.explanation && <Markdown text={link.explanation} />}
      {onOpenCard && <Button size="sm" onClick={() => onOpenCard(link)}>{ui('打开题目与解析')}</Button>}
    </article>)}
  </details>)}</div>;
}

/**
 * What the panel shows, from plain props: the selected passage, the ask form, the supplement form and the jobs started from
 * this material. Nothing here waits: asking is only blocked while it is itself answering, and the supplement form stays
 * editable while a job runs (the same passage and deck is refused, another one is fine).
 */
export function LearningPanel({ capture, resolution, resolving = false, error = '', question = '', answer = '', asking = false, deckId = '', count = 3, kind = 'flashcard',
  decks = [], askReady = false, generateReady = false, modelReady = false, starting = false, jobs = [], now = Date.now(), call, sectionRef,
  onQuestion, onAsk, onDeck, onCount, onKind, onStart, saveReady = false, onSaved, isCurrent, ...jobHandlers }) {
  const resolved = resolution?.status === 'resolved';
  const blocking = resolved && deckId ? blockingJob(jobs, resolution.selection, deckId) : null;
  const list = <SelectionJobList jobs={jobs} now={now} {...jobHandlers} />;
  // The jobs come first: progress is what the learner looks for after pressing the button, and it must not scroll away below the forms.
  if (!capture?.quote) return <section className="study-document-learning" aria-label={ui('选段学习')} ref={sectionRef}>
    {list}
    <p className="muted">{ui('选中原文中的一段文字，再提问或补充题目。')}</p>
  </section>;
  return <section className="study-document-learning" aria-label={ui('选段学习')} ref={sectionRef}>
    {list}
    <blockquote><MathText text={capture.quote} /></blockquote>
    {resolving && <p role="status">{ui('正在核实原文位置…')}</p>}
    {resolution && !resolved && <InlineMessage tone="warning">{ui(statusLabels[resolution.status] || '这段文字暂时无法使用。')}</InlineMessage>}
    {error && <InlineMessage tone="error">{error}</InlineMessage>}
    {resolved && <>
      <form onSubmit={onAsk}>
        <label>{ui('针对这段原文提问')}<textarea value={question} required rows={2} disabled={asking}
          onChange={event => onQuestion?.(event.target.value)} placeholder={ui('例如：这里的因果关系是什么？')} /></label>
        <Button type="submit" busy={asking} busyLabel={ui('正在回答…')} disabled={!askReady || !question.trim()}>{ui('依据原文回答')}</Button>
      </form>
      {answer && <div className="study-grounded-answer"><Markdown text={answer} /></div>}
      {answer && <SaveAnswerAsCard key={answer} call={call} selection={resolution.selection} question={question} answer={answer} deckId={deckId} decks={decks}
        ready={saveReady} onSaved={onSaved} onOpenCard={jobHandlers.onOpenCard} isCurrent={isCurrent} />}
      <form onSubmit={onStart}>
        <label>{ui('补充到现有题组')}<select value={deckId} required onChange={event => onDeck?.(event.target.value)}><option value="">{ui('选择题组')}</option>
          {decks.map(deck => <option key={deck.id} value={deck.id}>{deck.title}</option>)}
        </select></label>
        {!decks.length && <p className="muted">{ui('请先创建或导入一个题组，再从资料中补题。')}</p>}
        <div className="study-selection-options">
          <label>{ui('题型')}<select value={kind} onChange={event => onKind?.(event.target.value)}>
            <option value="flashcard">{ui('闪卡')}</option><option value="quiz">{ui('单选测验')}</option><option value="multi">{ui('多选测验')}</option><option value="open">{ui('开放问答')}</option><option value="cloze">{ui('填空卡')}</option>
          </select></label>
          <label>{ui('题数')}<input type="number" min="1" max="20" value={count} onChange={event => onCount?.(event.target.value)} /></label>
        </div>
        <p className="muted">{ui('生成后独立审核，通过的题目增量保存到所选题组，并与此段原文关联。')}</p>
        {generateReady && deckId && typeof call === 'function' && <TokenEstimate enabled
          request={{ feature: 'selection', selection: resolution.selection, deckId, count: Number(count) || 1, kind, language: uiLanguageName() }} />}
        {blocking && <p className="muted" role="status">{ui('这段原文补到这个题组的任务正在进行，请等它完成，或先停止它。')}</p>}
        <Button type="submit" variant="primary" busy={starting} busyLabel={ui('正在启动…')} disabled={!generateReady || !deckId || !!blocking}>{ui('生成、审核并补充题目')}</Button>
      </form>
      {!modelReady && <p className="muted">{ui('连接模型后可提问和补题；原文与已有引用仍可浏览。')}</p>}
    </>}
  </section>;
}

/** One resolved selection feeds both grounded questions and reviewed, incremental publication (a background job). */
export default function DocumentLearning({ call, document, capture, data, onPublished, onOpenCard, onOpenDeck, onPractice, onStarted, isCurrent = () => true }) {
  const toast = useToast();
  const [resolution, setResolution] = useState(null), [resolving, setResolving] = useState(false);
  const [question, setQuestion] = useState(''), [answer, setAnswer] = useState('');
  const [deckId, setDeckId] = useState(''), [count, setCount] = useState(3), [kind, setKind] = useState('flashcard');
  const [asking, setAsking] = useState(false), [starting, setStarting] = useState(false), [error, setError] = useState('');
  const [jobs, setJobs] = useState([]), [dismissed, setDismissed] = useState(() => new Set()), [now, setNow] = useState(Date.now);
  const [fallbackSnapshot, setFallbackSnapshot] = useState(null), [capabilities, setCapabilities] = useState(null), [bankDecks, setBankDecks] = useState(null);
  const sectionRef = useRef(null), [reveal, setReveal] = useState('');
  const jobsRef = useRef(jobs), noticeRef = useRef(null), publishedRef = useRef(onPublished);
  jobsRef.current = jobs; noticeRef.current = notice => toast.show({ tone: notice.tone, message: notice.text }); publishedRef.current = onPublished;
  const snapshot = data ?? fallbackSnapshot;
  const documentId = document?.documentId || document?.id;
  useEffect(() => {
    let current = true;
    Promise.allSettled([call('runtime.capabilities'), call('bank.decks.list'), data ? Promise.resolve(data) : call('snapshot')]).then(([capability, bank, state]) => {
      if (!current) return;
      setCapabilities(capability.status === 'fulfilled' ? capability.value : []);
      if (bank.status === 'fulfilled') setBankDecks(bank.value.decks || []);
      if (!data && state.status === 'fulfilled') setFallbackSnapshot(state.value);
    });
    return () => { current = false; };
  }, [call, data]);
  useEffect(() => {
    let current = true;
    const request = selectionRequest(document, capture);
    setResolution(null); setError(''); setAnswer('');
    if (!request) return;
    setResolving(true);
    call('materials.selection.resolve', request).then(value => { if (current) setResolution(value); })
      .catch(e => { if (current) setError(e.message); }).finally(() => { if (current) setResolving(false); });
    return () => { current = false; };
  }, [call, document, capture]);
  const decks = (bankDecks ?? snapshot?.decks ?? []).filter(deck => !deck.archived);
  const available = (domain, operation) => (capabilities || []).find(item => item.id === domain)?.operations
    ?.some(item => item.name === operation && item.available !== false) === true;
  const askReady = available('materials', 'selection.ask'), generateReady = available('generation', 'selection.start'), modelReady = askReady || generateReady;
  const listed = available('generation', 'selection.jobs');
  const ensureCurrent = () => {
    if (!isCurrent()) throw new Error(ui('预览页已切换，请在当前资料中重新选择文字。'));
  };

  // Supplements still running (or just finished) when the reader was closed come back with it.
  useEffect(() => {
    if (!listed || !documentId) return undefined;
    let current = true;
    call('generation.selection.jobs', { documentId }).then(found => {
      if (!current) return;
      const recent = (found.jobs || []).filter(job => isActive(job) || Date.now() - Date.parse(job.finishedAt || 0) < 10 * 60 * 1000);
      setJobs(list => mergeJobs(list, recent));
    }).catch(() => {});
    return () => { current = false; };
  }, [call, listed, documentId]);

  // A job just started is shown where the learner is looking: the panel scrolls to its card, which sits above the forms.
  useEffect(() => {
    if (!reveal) return;
    const card = [...(sectionRef.current?.querySelectorAll('[data-operation]') || [])].find(node => node.dataset.operation === reveal);
    if (!card) return;
    card.scrollIntoView?.({ block: 'nearest' });
    setReveal('');
  }, [reveal, jobs]);
  const anyActive = jobs.some(isActive);
  useEffect(() => {
    if (!anyActive) return undefined;
    let stopped = false, pending = false;
    const poll = async () => {
      if (pending || stopped) return;
      pending = true;
      try {
        for (const job of jobsRef.current.filter(isActive)) {
          const { job: next } = await call('generation.selection.status', { operationId: job.operationId });
          if (stopped) return;
          setJobs(list => upsertJob(list, next));
          if (!isActive(next) && next.status === 'complete') await publishedRef.current?.(next);
        }
      } catch { /* the next poll tries again; the job itself is not affected */ }
      finally { pending = false; }
    };
    const poller = setInterval(poll, 1500), clock = setInterval(() => setNow(Date.now()), 1000);
    return () => { stopped = true; clearInterval(poller); clearInterval(clock); };
  }, [anyActive, call]);
  // Closing the reader leaves a running job running; say so.
  useEffect(() => () => {
    if (jobsRef.current.some(isActive)) noticeRef.current?.({ text: ui('后台继续生成，完成后进信箱。'), tone: 'info' });
  }, []);

  async function ask(event) {
    event.preventDefault(); setAsking(true); setError('');
    try {
      ensureCurrent();
      const value = await call('materials.selection.ask', { selection: resolution.selection, question });
      ensureCurrent();
      if (value.status !== 'answered') { setResolution(value); setError(ui(statusLabels[value.status] || '这段文字暂时无法提问。')); }
      else setAnswer(value.answer);
    } catch (e) { setError(e.message); }
    finally { setAsking(false); }
  }
  /** Start (or, with the same operationId, continue) one supplement; the host answers with the job at once. */
  const begin = useCallback(async operation => {
    const destination = await call('bank.deck.get', { id: operation.deckId });
    const deck = destination.deck || destination;
    const started = await call('generation.selection.start', { ...operation, expectedVersion: destination.version ?? deck.contentVersion ?? 0 });
    if (started?.available === false) throw new Error(started.reason === 'model_unavailable' ? 'model_unavailable' : 'unavailable');
    setJobs(list => upsertJob(list, started.job));
    return { started, deck };
  }, [call]);
  async function start(event) {
    event.preventDefault(); setError('');
    if (blockingJob(jobsRef.current, resolution.selection, deckId)) { setError(ui('这段原文补到这个题组的任务正在进行，请等它完成，或先停止它。')); return; }
    setStarting(true);
    try {
      ensureCurrent();
      const { started, deck } = await begin({ selection: resolution.selection, deckId, count: Number(count), kind, operationId: crypto.randomUUID() });
      setReveal(started.operationId);
      await onStarted?.(started);
      noticeRef.current?.(startedNotice(started, deck.title || deckName(started.job)));
    } catch (e) { setError(startErrorText(e.message)); }
    finally { setStarting(false); }
  }
  /** Retry under the same operationId: it keeps what the job already saved and never writes twice. */
  async function retry(job) {
    setError('');
    try {
      await begin({ selection: job.selection, deckId: job.deckId, count: job.requestedTotal ?? job.count, kind: job.kind, operationId: job.operationId });
    } catch (e) { setError(startErrorText(e.message)); }
  }
  async function cancel(job) {
    setError('');
    try {
      await call('job.cancel', { jobId: job.id });
      setJobs(list => upsertJob(list, { ...job, status: 'cancelling', stageCode: 'cancelling' }));
    } catch (e) { setError(e.message); }
  }
  const shown = jobs.filter(job => !dismissed.has(job.operationId));
  return <LearningPanel capture={capture} resolution={resolution} resolving={resolving} error={error} question={question} answer={answer} asking={asking}
    deckId={deckId} count={count} kind={kind} decks={decks} askReady={askReady} generateReady={generateReady} modelReady={modelReady}
    starting={starting} jobs={shown} now={now} call={call} sectionRef={sectionRef} canPractice={typeof onPractice === 'function'}
    saveReady={available('generation', 'selection.saveAnswer')} onSaved={onPublished} isCurrent={isCurrent}
    onQuestion={setQuestion} onAsk={ask} onDeck={setDeckId} onCount={setCount} onKind={setKind} onStart={start}
    onCancel={cancel} onRetry={retry} onDismiss={job => setDismissed(current => new Set(current).add(job.operationId))}
    onPractice={onPractice} onOpenDeck={onOpenDeck} onOpenCard={onOpenCard} />;
}
