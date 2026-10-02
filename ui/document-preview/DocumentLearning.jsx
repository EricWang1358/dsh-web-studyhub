import React, { useEffect, useState, useRef } from 'react';
import Markdown from '../Markdown.jsx';
import { ui } from '../i18n.js';
import { selectionRequest } from './selection.js';
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
    <summary><sup>[{group.number || index + 1}]</sup> {group.selection.quote} <small>· {group.links.length} {ui('道题')}</small></summary>
    {group.links.map(link => <article key={`${link.deckId}:${link.cardId}`}>
      <p><strong>{link.prompt || link.cardId}</strong>{link.status !== 'resolved' && <span className="warning"> · {ui(link.status === 'stale' ? '引用待核对' : '原文位置不可用')}</span>}</p>
      {link.answer && <p>{Array.isArray(link.answer) ? link.answer.join('、') : String(link.answer)}</p>}
      {link.explanation && <Markdown text={link.explanation} />}
      {onOpenCard && <button type="button" onClick={() => onOpenCard(link)}>{ui('打开题目与解析')}</button>}
    </article>)}
  </details>)}</div>;
}

/** One resolved selection feeds both grounded questions and reviewed, incremental publication. */
export default function DocumentLearning({ call, document, capture, data, onPublished, onOpenCard, isCurrent = () => true }) {
  const [resolution, setResolution] = useState(null), [resolving, setResolving] = useState(false);
  const [question, setQuestion] = useState(''), [answer, setAnswer] = useState('');
  const [deckId, setDeckId] = useState(''), [count, setCount] = useState(3), [kind, setKind] = useState('flashcard');
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [result, setResult] = useState(null);
  const [fallbackSnapshot, setFallbackSnapshot] = useState(null), [capabilities, setCapabilities] = useState(null), [bankDecks, setBankDecks] = useState(null), operation = useRef(null);
  const snapshot = data ?? fallbackSnapshot;
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
    setResolution(null); setError(''); setAnswer(''); setResult(null); operation.current = null;
    if (!request) return;
    setResolving(true);
    call('materials.selection.resolve', request).then(value => { if (current) setResolution(value); })
      .catch(e => { if (current) setError(e.message); }).finally(() => { if (current) setResolving(false); });
    return () => { current = false; };
  }, [call, document, capture]);
  const decks = (bankDecks ?? snapshot?.decks ?? []).filter(deck => !deck.archived);
  const available = (domain, operation) => (capabilities || []).find(item => item.id === domain)?.operations
    ?.some(item => item.name === operation && item.available !== false) === true;
  const resolved = resolution?.status === 'resolved', askReady = available('materials', 'selection.ask'),
    generateReady = available('generation', 'selection.supplement'), modelReady = askReady || generateReady;
  const ensureCurrent = () => {
    if (!isCurrent()) throw new Error(ui('预览页已切换，请在当前资料中重新选择文字。'));
  };
  async function ask(event) {
    event.preventDefault(); setBusy('ask'); setError('');
    try {
      ensureCurrent();
      const value = await call('materials.selection.ask', { selection: resolution.selection, question });
      ensureCurrent();
      if (value.status !== 'answered') { setResolution(value); setError(ui(statusLabels[value.status] || '这段文字暂时无法提问。')); }
      else setAnswer(value.answer);
    } catch (e) { setError(e.message); }
    finally { setBusy(''); }
  }
  async function publish(action = 'generation.selection.supplement') {
    setBusy('generate'); setError('');
    try {
      ensureCurrent();
      if (!operation.current) {
        const destination = await call('bank.deck.get', { id: deckId });
        const deck = destination.deck || destination;
        operation.current = { selection: resolution.selection, deckId, count: Number(count), kind,
          operationId: crypto.randomUUID(), expectedVersion: destination.version ?? deck.contentVersion ?? 0 };
      }
      let payload = action === 'generation.selection.supplement' ? operation.current : { operationId: operation.current.operationId };
      if (action === 'generation.selection.commit') {
        const destination = await call('bank.deck.get', { id: operation.current.deckId });
        payload = { ...payload, expectedVersion: destination.version ?? destination.deck?.contentVersion ?? 0 };
      }
      ensureCurrent();
      const value = await call(action, payload);
      ensureCurrent(); setResult(value);
      if (value.status === 'complete') await onPublished?.(value);
      else if (value.error) setError(typeof value.error === 'string' ? value.error : value.error.message);
    } catch (e) { setError(e.message); }
    finally { setBusy(''); }
  }
  if (!capture?.quote) return <p className="muted">{ui('选中原文中的一段文字，再提问或补充题目。')}</p>;
  return <section className="study-document-learning" aria-label={ui('选段学习')}>
    <blockquote>{capture.quote}</blockquote>
    {resolving && <p role="status">{ui('正在核实原文位置…')}</p>}
    {resolution && !resolved && <p className="warning" role="status">{ui(statusLabels[resolution.status] || '这段文字暂时无法使用。')}</p>}
    {error && <p className="warning" role="alert">{error}</p>}
    {resolved && <>
      <form onSubmit={ask}>
        <label>{ui('针对这段原文提问')}<textarea value={question} required rows={2} disabled={!!busy}
          onChange={event => setQuestion(event.target.value)} placeholder={ui('例如：这里的因果关系是什么？')} /></label>
        <button type="submit" disabled={!!busy || !askReady || !question.trim()}>{busy === 'ask' ? ui('正在回答…') : ui('依据原文回答')}</button>
      </form>
      {answer && <div className="study-grounded-answer"><Markdown text={answer} /></div>}
      {answer && <SaveAnswerAsCard key={answer} call={call} selection={resolution.selection} question={question} answer={answer} deckId={deckId} decks={decks}
        ready={available('generation', 'selection.saveAnswer')} onSaved={onPublished} onOpenCard={onOpenCard} isCurrent={isCurrent} />}
      <form onSubmit={event => { event.preventDefault(); publish(); }}>
        <label>{ui('补充到现有题组')}<select value={deckId} required disabled={!!busy || !!operation.current}
          onChange={event => setDeckId(event.target.value)}><option value="">{ui('选择题组')}</option>
          {decks.map(deck => <option key={deck.id} value={deck.id}>{deck.title}</option>)}
        </select></label>
        {!decks.length && <p className="muted">{ui('请先创建或导入一个题组，再从资料中补题。')}</p>}
        <div className="study-selection-options">
          <label>{ui('题型')}<select value={kind} disabled={!!busy || !!operation.current} onChange={event => setKind(event.target.value)}>
            <option value="flashcard">{ui('闪卡')}</option><option value="quiz">{ui('单选测验')}</option><option value="multi">{ui('多选测验')}</option><option value="open">{ui('开放问答')}</option><option value="cloze">{ui('填空卡')}</option>
          </select></label>
          <label>{ui('题数')}<input type="number" min="1" max="20" value={count} disabled={!!busy || !!operation.current} onChange={event => setCount(event.target.value)} /></label>
        </div>
        <p className="muted">{ui('生成后独立审核，通过的题目增量保存到所选题组，并与此段原文关联。')}</p>
        {!result && <button type="submit" className="primary" disabled={!!busy || !generateReady || !deckId}>
          {busy === 'generate' ? ui('正在生成与审核…') : operation.current ? ui('重试同一次补题') : ui('生成、审核并补充题目')}
        </button>}
      </form>
      {!modelReady && <p className="muted">{ui('连接模型后可提问和补题；原文与已有引用仍可浏览。')}</p>}
    </>}
    {result && <div className="study-selection-result" role="status">
      <strong>{ui(result.status === 'complete' ? '已补充到现有题组' : result.status === 'conflict' ? '题组已更新，已审核题目等待再次保存' : '候选题目尚未通过审核')}</strong>
      {(result.accepted || []).length > 0 && <p>{result.accepted.length} {ui('道题通过审核。')}</p>}
      {result.status === 'conflict' && <button disabled={!!busy} onClick={() => publish('generation.selection.commit')}>{ui('保留审核结果并重试保存')}</button>}
      {result.status === 'review-failed' && <button disabled={!!busy || !generateReady} onClick={() => publish('generation.selection.review')}>{ui('重新审核候选题目')}</button>}
      {[...(result.accepted || []), ...(result.rejected || []), ...(!result.accepted?.length && !result.rejected?.length ? result.candidates || [] : [])].map((candidate, index) => {
        const card = candidate.card || candidate;
        return <details key={card.id || index}><summary>{card.prompt || ui('候选题目')}</summary>
          <Markdown text={card.explanation || String(card.answer ?? '')} />
          {candidate.reason && <p className="warning">{candidate.reason}</p>}
          {result.status === 'complete' && onOpenCard && <button onClick={() => onOpenCard({ deckId: operation.current?.deckId, cardId: card.id })}>{ui('打开题目与解析')}</button>}
        </details>;
      })}
      {result.status === 'complete' && <button onClick={() => { operation.current = null; setResult(null); }}>{ui('继续从此选段补题')}</button>}
    </div>}
  </section>;
}
