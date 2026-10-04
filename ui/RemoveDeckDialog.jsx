import React, { useRef, useState } from 'react';
import { Button, Dialog, InlineMessage } from './components/index.js';
import { ui, uiFormat } from './i18n.js';

export default function RemoveDeckDialog({ deck, busy, act, onClose, onRemoved }) {
  const cancelRef = useRef(null);
  const [error, setError] = useState('');
  const eligible = deck.archived && !deck.systemKind;
  async function confirm() {
    if (busy || !eligible) return;
    setError('');
    try {
      await act('deck.remove', { id: deck.id, confirm: true }, () => onRemoved(deck), { rethrow: true });
    } catch (failure) { setError(failure.message || String(failure)); }
  }
  return <Dialog size="sm" title={uiFormat('永久删除「{0}」？', [deck.title])}
    initialFocus={cancelRef} dismissible={!busy} onClose={onClose}
    footer={<>
      <Button ref={cancelRef} variant="quiet" disabled={busy} onClick={onClose}>{ui('取消')}</Button>
      <Button variant="danger" busy={busy} disabled={!eligible} onClick={confirm}>{ui('确认永久删除')}</Button>
    </>}>
    <p>{uiFormat('将永久删除这个题组及其中的 {0} 道题，无法撤销。原始资料和已有作答记录会保留。', [deck.count])}</p>
    {!eligible && <InlineMessage>{ui('请先归档题组，再永久删除。')}</InlineMessage>}
    {error && <InlineMessage>{error}</InlineMessage>}
  </Dialog>;
}
