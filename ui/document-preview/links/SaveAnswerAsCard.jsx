import React, { useState } from 'react';
import { Button, InlineMessage } from '../../components/index.js';
import { ui, uiFormat } from '../../i18n.js';

/** "已存为闪卡 · 打开这道题": the result of saving, with the jump to the saved (or already existing) card. */
export function QaSavedLine({ result, onOpenCard }) {
  return <p className="study-qa-saved" role="status">
    <span>{result.status === 'duplicate' ? ui('这道题已经存过') : ui('已存为闪卡')}</span>
    {result.cardId && onOpenCard && <>
      {' · '}
      <button type="button" className="study-qa-saved__open" onClick={() => onOpenCard({ deckId: result.deckId, cardId: result.cardId })}>{ui('打开这道题')}</button>
    </>}
  </p>;
}

/**
 * Under a grounded answer: save the question and the answer as ONE flashcard linked to the passage. The front is
 * the passage with the learner's question, the back the answer exactly as shown; the model is not asked again.
 * `deckId` is the deck picked in the learning panel; without one the course's 原文问答 deck is used. One
 * operation id per answer makes a second click or a retry harmless.
 */
export default function SaveAnswerAsCard({ call, selection, question, answer, deckId = '', decks = [], ready = true, onSaved, onOpenCard, isCurrent = () => true }) {
  // The question as it was asked: the box may be edited after the answer arrived.
  const [asked] = useState(question), [operationId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [result, setResult] = useState(null);
  const deckTitle = decks.find(deck => deck.id === deckId)?.title;
  async function save() {
    if (busy) return;
    setBusy(true); setError('');
    try {
      if (!isCurrent()) throw new Error(ui('预览页已切换，请在当前资料中重新选择文字。'));
      let expectedVersion;
      if (deckId) {
        const destination = await call('bank.deck.get', { id: deckId });
        expectedVersion = destination.version ?? destination.deck?.contentVersion ?? 0;
      }
      const value = await call('generation.selection.saveAnswer', { selection, question: asked, answer, operationId,
        ...(deckId ? { deckId, expectedVersion } : {}) });
      if (!isCurrent()) return;
      if (value.status === 'complete' || value.status === 'duplicate') {
        setResult(value);
        if (value.status === 'complete') await onSaved?.(value);
      } else setError(value.status === 'conflict' ? ui('题组已更新，请再点一次保存。') : (value.error || ui('暂时无法保存为闪卡。')));
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  return <div className="study-qa-save">
    {result ? <QaSavedLine result={result} onOpenCard={onOpenCard} /> : <>
      <Button size="sm" busy={busy} disabled={!ready} onClick={save}
        title={ready ? undefined : ui('需要先启用出题组件，才能存成闪卡。')}>{busy ? ui('正在保存…') : error ? ui('重试保存') : ui('存成闪卡')}</Button>
      <small className="muted">{deckId && deckTitle ? uiFormat('将保存到「{0}」', [deckTitle]) : ui('将保存到本课程的「原文问答」题组')}</small>
    </>}
    {error && <InlineMessage tone="error">{error}</InlineMessage>}
  </div>;
}
