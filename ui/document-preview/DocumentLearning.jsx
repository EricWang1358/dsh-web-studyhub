import React, { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import Markdown from '../Markdown.jsx';
import { ui, uiFormat, uiLanguageName } from '../i18n.js';
import { TokenEstimate } from '../TokenUsage.jsx';
import MathText from '../MathText.jsx';
import { Badge, Button, Combobox, Disclosure, InlineMessage, SegmentedControl, Select, Tooltip, useNow, useToast } from '../components/index.js';
import { joinMeta } from '../format.js';
import { kinds } from '../shared.js';
import { usePolling } from '../use-polling.js';
import { selectionRequest } from './selection.js';
import { SelectionJobList } from './SelectionJobs.jsx';
import { blockingJob, deckName, isActive, mergeJobs, startErrorText, startedNotice, upsertJob } from './selection-job.js';
import AskThread, { refusal } from './AskThread.jsx';
import { itemsOfPassage, keyOfSelection, nodesToKeep, threadFromItems } from './annotation/model.js';
import { addNode, answerNode, emptyThread, failNode, nodeOf, planAsk, retryNode, revealNode, threadFor, toggleNode } from './ask-thread.js';
import { createThreadMemory } from './thread-memory.js';
import { recallDeck, rememberDeck, suggestDeck, supplementDefaults } from './supplement-defaults.js';
import ReaderModelGate, { useReaderServices } from './ReaderModelGate.jsx';
import { deckChoices, deckEntries } from '../deck-picker-entries.js';
import { JOB_STATUS } from '../../lib/job-status.js';

const noop = () => {};
/** The key a passage's unsaved thread is held under: where it is and what it says (a text that changed under the same offsets is another passage). */
const heldKey = selection => (keyOfSelection(selection) ? `${keyOfSelection(selection)}|${selection.quote || ''}` : '');
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

/** The passage the learner selected: a few lines, and a toggle for the rest (a long selection used to be cut off with no way to read it). */
function PassageQuote({ quote }) {
  const [open, setOpen] = useState(false);
  const long = quote.length > 160 || quote.split('\n').length > 3;
  return <div className="study-passage" data-open={open || undefined}>
    <blockquote id="study-passage-quote" className="study-passage__quote"><MathText text={quote} /></blockquote>
    {long && <Button variant="link" size="sm" aria-expanded={open} aria-controls="study-passage-quote" onClick={() => setOpen(value => !value)}>{open ? ui('收起') : ui('展开')}</Button>}
  </div>;
}

/**
 * First-level questions in one click: a chip asks at once, like the follow-up chips under an answer (typing a question of one's own still takes the box and the button).
 * The chip's name stays with the thread as the first step of its path; hovering or focusing a chip says the exact question it sends.
 */
function QuickIntents({ onAsk, onQuiz, disabled = false }) {
  const chip = (label, question) => <Tooltip layer group="ask-help" content={<span className="ask-tip"><span>{uiFormat('点击即发送：「{0}」', [question])}</span></span>}>
    <Button size="sm" disabled={disabled} onClick={() => onAsk(question, label)}>{label}</Button>
  </Tooltip>;
  return <div className="ask-quick" role="group" aria-label={ui('快捷提问')}>
    {chip(ui('没听懂'), ui('这段我没听懂，请按原文顺序讲一下。'))}
    {chip(ui('举个例子'), ui('请依据这段原文举一个例子。'))}
    {chip(ui('为什么'), ui('为什么会这样？请依据这段原文回答。'))}
    {chip(ui('和什么有区别'), ui('这里的内容和什么容易混淆？有什么区别？'))}
    <Tooltip layer group="ask-help" content={<span className="ask-tip"><span>{ui('跳到下面的「补充到现有题组」。')}</span><span>{ui('不会自动出题。')}</span></span>}>
      <Button size="sm" onClick={onQuiz}>{ui('出题考我')}</Button>
    </Tooltip>
  </div>;
}

/** 阅读 / 批注: whether the answers of this panel are kept. The words on hover and focus say what each mode does to them. */
export function ModeSwitch({ mode, onMode }) {
  return <Tooltip layer group="ask-help" content={<span className="ask-tip"><span>{ui('阅读：回答只在阅读器打开期间保留，关闭阅读器就会丢失。')}</span><span>{ui('批注：每条回答都和这段原文一起保存，再选中这段时会回来。')}</span></span>}>
    <SegmentedControl size="sm" label={ui('阅读与批注')} value={mode} onChange={onMode}
      options={[{ value: 'read', label: ui('阅读') }, { value: 'annotate', label: ui('批注') }]} />
  </Tooltip>;
}

/**
 * What the panel shows, from plain props: the selected passage, the ask form, the supplement form and the jobs started from
 * this material. Nothing here waits: asking is only blocked while it is itself answering, and the supplement form stays
 * editable while a job runs (the same passage and deck is refused, another one is fine).
 */
export function LearningPanel({ capture, resolution, resolving = false, error = '', question = '', thread = emptyThread(), notice = '', noticeWhy = '', mode = 'read', onMode, annotateReady = false, savedIds, keepBusy = false, keepError = '', onKeep, onDeleteThread, deckId = '', deckNote = '', count = 10, kind = 'quiz',
  decks = [], askReady = false, generateReady = false, modelReady = false, starting = false, jobs = [], now = Date.now(), call, sectionRef,
  onQuestion, onAsk, onQuick, onAskInside, onRetryNode, onToggleNode, onDeck, onCount, onKind, onStart, saveReady = false, onSaved, isCurrent, ...jobHandlers }) {
  const resolved = resolution?.status === 'resolved';
  const asking = thread.nodes.some(node => node.parentId === null && node.status === 'asking');
  const area = useRef(null), supplement = useRef(null);
  const { openSettings } = useReaderServices();
  const blocking = resolved && deckId ? blockingJob(jobs, resolution.selection, deckId) : null;
  const list = <SelectionJobList jobs={jobs} now={now} {...jobHandlers} />;
  // The jobs come first: progress is what the learner looks for after pressing the button, and it must not scroll away below the forms.
  const modeSwitch = annotateReady && onMode ? <ModeSwitch mode={mode} onMode={onMode} /> : null;
  if (!capture?.quote) return <section className="study-document-learning" aria-label={ui('选段学习')} ref={sectionRef}>
    {list}
    {modeSwitch}
    <p className="muted">{ui('选中原文中的一段文字，再提问或补充题目。')}</p>
  </section>;
  return <section className="study-document-learning" aria-label={ui('选段学习')} ref={sectionRef}>
    {list}
    {modeSwitch}
    <PassageQuote key={capture.quote} quote={capture.quote} />
    {resolving && <p role="status">{ui('正在核实原文位置…')}</p>}
    {resolution && !resolved && <InlineMessage tone="warning">{ui(statusLabels[resolution.status] || '这段文字暂时无法使用。')}</InlineMessage>}
    {error && <InlineMessage tone="error">{error}</InlineMessage>}
    {resolved && <>
      {!modelReady && <ReaderModelGate feature="passage" />}
      <form onSubmit={onAsk}>
        <label>{ui('针对这段原文提问')}<textarea ref={area} value={question} required rows={2} disabled={asking}
          onChange={event => onQuestion?.(event.target.value, '')} placeholder={ui('例如：这里的因果关系是什么？')} /></label>
        <QuickIntents disabled={!askReady || asking} onAsk={(text, label) => onQuick?.(text, label)} onQuiz={() => {
          supplement.current?.scrollIntoView?.({ block: 'nearest' });
          supplement.current?.querySelector('input, button, select')?.focus();
        }} />
        <Button type="submit" busy={asking} busyLabel={ui('正在回答…')} disabled={!askReady || !question.trim()}>{ui('依据原文回答')}</Button>
      </form>
      {modeSwitch && <p className="muted ask-note">{mode === 'annotate' ? ui('批注模式：每条回答都会和这段原文一起保存。') : ui('阅读模式：问答只在阅读器打开时保留。要留下来，点「存为批注」或切到批注。')}</p>}
      <AskThread thread={thread} notice={notice} noticeWhy={noticeWhy} mode={mode} savedIds={savedIds} keepBusy={keepBusy} keepError={keepError}
        onKeep={annotateReady ? onKeep : undefined} onDelete={onDeleteThread} onAsk={onAskInside || noop} onRetry={onRetryNode || noop} onToggle={onToggleNode || noop}
        save={{ call, selection: resolution.selection, deckId, decks, ready: saveReady, onSaved, onOpenCard: jobHandlers.onOpenCard, isCurrent }} />
      <form ref={supplement} onSubmit={onStart}>
        <label>{ui('补充到现有题组')}<Combobox value={deckId} required onChange={value => onDeck?.(value)} placeholder={ui('选择题组')} label={ui('补充到现有题组')} searchPlaceholder={ui('搜索题组')}
          emptyText={query => uiFormat('没有叫「{0}」的题组', [query])}
          options={deckEntries(decks)} /></label>
        {!decks.length && <p className="muted">{ui('请先创建或导入一个题组，再从资料中补题。')}</p>}
        {deckNote && deckId && <p className="muted study-selection-reason" role="status">{deckNote}</p>}
        {/* The kind and the number are the ones of 设置 › 出题偏好, said here and changeable for this run; the settings themselves are not touched. */}
        <Disclosure className="study-selection-more" summary={ui('更多设置')} meta={joinMeta([kinds[kind], uiFormat('{0} 题', [Number(count) || 1])])}>
          <div className="study-selection-options">
            <label>{ui('题型')}<Select value={kind} onChange={value => onKind?.(value)} options={[
              { value: 'flashcard', label: ui('闪卡') }, { value: 'quiz', label: ui('单选测验') }, { value: 'multi', label: ui('多选测验') },
              { value: 'open', label: ui('开放问答') }, { value: 'cloze', label: ui('填空卡') }]} /></label>
            <label>{ui('题数')}<input type="number" min="1" max="20" value={count} onChange={event => onCount?.(event.target.value)} /></label>
          </div>
          <p className="muted">{ui('题型和题数取自设置里的出题偏好；在这里改，不会改动设置。')}
            {openSettings && <> <Button variant="link" size="sm" onClick={() => openSettings('settings-generation')}>{ui('前往设置')}</Button></>}</p>
        </Disclosure>
        <p className="muted">{ui('生成后独立审核，通过的题目增量保存到所选题组，并与此段原文关联。')}</p>
        {generateReady && deckId && typeof call === 'function' && <TokenEstimate enabled
          request={{ feature: 'selection', selection: resolution.selection, deckId, count: Number(count) || 1, kind, language: uiLanguageName() }} />}
        {blocking && <p className="muted" role="status">{ui('这段原文补到这个题组的任务正在进行，请等它完成，或先停止它。')}</p>}
        <Button type="submit" variant="primary" busy={starting} busyLabel={ui('正在启动…')} disabled={!generateReady || !deckId || !!blocking}>{ui('生成、审核并补充题目')}</Button>
      </form>
    </>}
  </section>;
}

/** One resolved selection feeds both grounded questions and reviewed, incremental publication (a background job). */
export default function DocumentLearning({ call, document, capture, data, annotation, usedBy, onPublished, onOpenCard, onOpenDeck, onPractice, onStarted, isCurrent = () => true }) {
  const toast = useToast();
  const [resolution, setResolution] = useState(null), [resolving, setResolving] = useState(false);
  const [question, setQuestion] = useState(''), [questionLabel, setQuestionLabel] = useState(''), [thread, setThread] = useState(emptyThread), [refused, setRefused] = useState(''), [refusedWhy, setRefusedWhy] = useState(''), [keepBusy, setKeepBusy] = useState(false), [keepError, setKeepError] = useState(''), [savedLocal, setSavedLocal] = useState(() => new Set()), [focusId, setFocusId] = useState('');
  // The thread of this selection lives here only: planning a click reads the latest one, even before React has rendered the last change.
  const threadRef = useRef(thread);
  const commit = next => { threadRef.current = next; setThread(next); };
  // What 阅读 mode did not keep, held per passage while the reader is open (thread-memory.js).
  const memory = useRef(null);
  if (!memory.current) memory.current = createThreadMemory();
  // The inline refusal of the thread (what it cannot ask, and why): it sits in the thread, not in a toast, and a new selection or question clears it.
  const say = (text = '', why = '') => { setRefused(text); setRefusedWhy(why); };
  // The top-up form starts filled in: a deck guessed from the material (or the last one used), the kind and the number of 设置 › 出题偏好. What the learner picks is held here (null: not picked yet).
  const [pickedDeck, setPickedDeck] = useState(null), [pickedCount, setPickedCount] = useState(null), [pickedKind, setPickedKind] = useState(null);
  const [lastDeck, setLastDeck] = useState(recallDeck);
  const [starting, setStarting] = useState(false), [error, setError] = useState('');
  const [jobs, setJobs] = useState([]), [dismissed, setDismissed] = useState(() => new Set());
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
    setResolution(null); setError(''); commit(emptyThread()); say(); setSavedLocal(new Set()); setKeepError('');
    if (!request) return;
    setResolving(true);
    call('materials.selection.resolve', request).then(value => { if (current) setResolution(value); })
      .catch(e => { if (current) setError(e.message); }).finally(() => { if (current) setResolving(false); });
    return () => { current = false; };
  }, [call, document, capture]);
  const decks = deckChoices(bankDecks ?? snapshot?.decks ?? [], snapshot).filter(deck => !deck.archived);
  const guess = suggestDeck({ usedBy, decks, last: lastDeck }), deckId = pickedDeck ?? guess.deckId;
  const deckNote = pickedDeck === null && guess.reason ? (guess.reason === 'material' ? ui('已选这份资料唯一的题组。') : ui('已选你上次补题用的题组。')) : '';
  const defaults = supplementDefaults(snapshot?.settings?.generation), kind = pickedKind ?? defaults.kind, count = pickedCount ?? defaults.count;
  const available = (domain, operation) => (capabilities || []).find(item => item.id === domain)?.operations
    ?.some(item => item.name === operation && item.available !== false) === true;
  const askReady = available('materials', 'selection.ask'), generateReady = available('generation', 'selection.start'), modelReady = askReady || generateReady;
  const listed = available('generation', 'selection.jobs');
  // 阅读 / 批注 (the translation's pattern: the mode is the reader's, the keeping is the materials context's).
  const annotateReady = !!annotation && available('materials', 'annotation.save');
  const mode = annotateReady && annotation.mode === 'annotate' ? 'annotate' : 'read';
  const modeRef = useRef(mode); modeRef.current = mode;
  const savedIds = useMemo(() => new Set([...(annotation?.items || []).map(item => item.id), ...savedLocal]), [annotation?.items, savedLocal]);
  const ensureCurrent = () => {
    if (!isCurrent()) throw new Error(ui('预览页已切换，请在当前资料中重新选择文字。'));
  };
  // A new selection starts a new thread, but an answer that was paid for is not lost: the thread of this passage is held (also while its question is waiting) and comes back when the passage is selected again.
  const passageKey = resolution?.status === 'resolved' ? heldKey(resolution.selection) : '';
  useEffect(() => {
    if (!passageKey || modeRef.current === 'annotate' || threadRef.current.nodes.length) return;
    const held = memory.current.recall(passageKey);
    if (held) { commit(held.thread); setSavedLocal(held.saved); }
  }, [passageKey]);
  useEffect(() => { memory.current.remember(passageKey, thread, savedLocal); }, [passageKey, thread, savedLocal]);

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
  const now = useNow(1000, { enabled: anyActive });
  // The running jobs are asked about one at a time (not while the page is hidden); a failed round is just tried again by the next one.
  usePolling(async () => {
    try {
      for (const job of jobsRef.current.filter(isActive)) {
        const { job: next } = await call('generation.selection.status', { operationId: job.operationId });
        setJobs(list => upsertJob(list, next));
        if (!isActive(next) && next.status === 'complete') await publishedRef.current?.(next);
      }
    } catch { /* the job itself is not affected */ }
  }, { intervalMs: 1500, enabled: anyActive });
  // Closing the reader leaves a running job running; say so.
  useEffect(() => () => {
    if (jobsRef.current.some(isActive)) noticeRef.current?.({ text: ui('后台继续生成，完成后进信箱。'), tone: 'info' });
  }, []);

  /** Ask the model for one node of the thread; a thread that was dropped meanwhile (another selection) is left alone. */
  async function run(id, { question: asked, term = '', context = [] }) {
    const selection = resolution.selection, held = heldKey(selection);
    // The answer lands in the thread on screen; when the learner has moved to another passage meanwhile, in the thread held for this one.
    const settle = change => { if (nodeOf(threadRef.current, id)) commit(change(threadRef.current)); else memory.current.settle(held, id, change); };
    try {
      ensureCurrent();
      const value = await call('materials.selection.ask', { selection, question: asked, language: uiLanguageName(), terms: true,
        ...(term ? { term } : {}), ...(context.length ? { thread: context } : {}) });
      ensureCurrent();
      if (value.status !== 'answered') {
        if (nodeOf(threadRef.current, id)) setResolution(value);
        settle(current => failNode(current, id, ui(statusLabels[value.status] || '这段文字暂时无法提问。')));
      } else {
        settle(current => answerNode(current, id, value.answer));
        // In 批注 mode an answer is kept as it arrives, with the answers above it.
        if (modeRef.current === 'annotate' && nodeOf(threadRef.current, id)) latest.current.keep(id);
      }
    } catch (e) { settle(current => failNode(current, id, e.message)); }
  }
  /** Keep the answered nodes (the whole thread, or one with the nodes above it) as annotations of this passage. */
  async function keep(id = '') {
    const nodes = nodesToKeep(threadRef.current, id);
    if (!nodes.length || !resolution?.selection || !annotateReady) return;
    setKeepBusy(true); setKeepError('');
    try {
      ensureCurrent();
      const saved = await call('materials.annotation.save', { documentId, revision: document.revision, selection: resolution.selection,
        nodes: nodes.map(node => ({ ...node, language: uiLanguageName() })) });
      if (saved.status !== 'saved') setKeepError(saved.message || ui('暂时无法保存为批注。'));
      else { setSavedLocal(current => new Set([...current, ...nodes.map(node => node.id)])); await annotation.onChanged?.(); }
    } catch (e) { setKeepError(e.message); }
    finally { setKeepBusy(false); }
  }
  async function deleteThread() {
    await call('materials.annotation.delete', { documentId, revision: document.revision, selection: resolution.selection });
    memory.current.forget(passageKey);
    commit(emptyThread()); setSavedLocal(new Set());
    await annotation.onChanged?.();
  }
  // Selecting a passage that was kept (批注 mode) brings its thread back, and a term asked before is found, not asked again.
  useEffect(() => {
    if (mode !== 'annotate' || resolution?.status !== 'resolved' || threadRef.current.nodes.length) return;
    const kept = itemsOfPassage(annotation?.items, resolution.selection);
    if (kept.length) commit(threadFromItems(kept));
  }, [mode, resolution, annotation?.items]);
  /**
   * A new first-level question: the box's own, or a chip's (which asks at once, and does not touch what the learner typed). It joins the answers already on this passage, so a
   * second chip does not make the first answer (paid for) disappear; only a thread that has reached its limit is started again.
   */
  function askFirst(text, label = '') {
    const current = threadRef.current;
    if (!resolution || !text.trim() || current.nodes.some(node => node.parentId === null && node.status === 'asking')) return undefined;
    setError(''); say();
    const id = crypto.randomUUID(), base = current.nodes.length && planAsk(current, { parentId: null }).action === 'ask' ? current : emptyThread();
    commit(addNode(base, { id, parentId: null, question: text, label }));
    setFocusId(id); // the answer comes in under the chips and the form: bring it into view
    return run(id, { question: text });
  }
  function ask(event) {
    event.preventDefault();
    return askFirst(question, questionLabel);
  }
  /** A click on a term, a quick follow-up or the box under an answer: a child of `parentId`. Only the refusal or the jump needs no model. */
  function askInside({ parentId, term = '', question: typed = '' }) {
    const current = threadRef.current, plan = planAsk(current, { parentId, term });
    if (plan.action === 'open') { commit(revealNode(current, plan.node.id)); setFocusId(plan.node.id); return; }
    if (plan.action === 'refuse') { const why = refusal(plan.reason); say(why.text, why.why); return; }
    const text = term ? uiFormat('「{0}」是什么意思？', [term]) : typed;
    if (!text.trim()) return;
    const id = crypto.randomUUID(), context = threadFor(current, parentId);
    say();
    commit(addNode(current, { id, parentId, question: text, term }));
    run(id, { question: text, term, context });
  }
  function retryNodeAsk(id) {
    const current = threadRef.current, node = nodeOf(current, id);
    if (!node || node.status !== 'failed') return;
    commit(retryNode(current, id)); say();
    run(id, { question: node.question, term: node.term, context: threadFor(current, node.parentId) });
  }
  // The handlers the markers call must keep one identity, or every render would parse the answers again.
  const latest = useRef({}); latest.current = { askInside, retryNodeAsk, keep };
  const onAskInside = useCallback(args => latest.current.askInside(args), []), onRetryNode = useCallback(id => latest.current.retryNodeAsk(id), []);
  const onToggleNode = useCallback(id => commit(toggleNode(threadRef.current, id)), []);
  // A jump to an answer that already exists: scroll to it and put the focus there.
  useEffect(() => {
    if (!focusId) return;
    const node = [...(sectionRef.current?.querySelectorAll('[data-ask-node]') || [])].find(item => item.dataset.askNode === focusId);
    node?.scrollIntoView?.({ block: 'nearest' }); node?.focus?.({ preventScroll: true });
    setFocusId('');
  }, [focusId, thread]);
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
      rememberDeck(deckId); setLastDeck(deckId);
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
      setJobs(list => upsertJob(list, { ...job, status: JOB_STATUS.CANCELLING, stageCode: JOB_STATUS.CANCELLING }));
    } catch (e) { setError(e.message); }
  }
  const shown = jobs.filter(job => !dismissed.has(job.operationId));
  return <LearningPanel capture={capture} resolution={resolution} resolving={resolving} error={error} question={question} thread={thread} notice={refused} noticeWhy={refusedWhy}
    mode={mode} onMode={annotation?.onMode} annotateReady={annotateReady} savedIds={savedIds} keepBusy={keepBusy} keepError={keepError} onKeep={keep} onDeleteThread={deleteThread}
    onAskInside={onAskInside} onRetryNode={onRetryNode} onToggleNode={onToggleNode} onQuick={askFirst}
    deckId={deckId} deckNote={deckNote} count={count} kind={kind} decks={decks} askReady={askReady} generateReady={generateReady} modelReady={modelReady}
    starting={starting} jobs={shown} now={now} call={call} sectionRef={sectionRef} canPractice={typeof onPractice === 'function'}
    saveReady={available('generation', 'selection.saveAnswer')} onSaved={onPublished} isCurrent={isCurrent}
    onQuestion={(text, label = '') => { setQuestion(text); setQuestionLabel(label); }} onAsk={ask} onDeck={setPickedDeck} onCount={setPickedCount} onKind={setPickedKind} onStart={start}
    onCancel={cancel} onRetry={retry} onDismiss={job => setDismissed(current => new Set(current).add(job.operationId))}
    onPractice={onPractice} onOpenDeck={onOpenDeck} onOpenCard={onOpenCard} />;
}
