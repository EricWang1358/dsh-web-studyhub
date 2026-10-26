import React from 'react';
import { InlineMessage } from './components/index.js';
import PermanentDeleteDialog from './components/PermanentDeleteDialog.jsx';
import { ui, uiFormat } from './i18n.js';

export default function RemoveDeckDialog({ deck, busy, act, onClose, onRemoved }) {
  const eligible = deck.archived && !deck.systemKind;
  async function confirm() {
    const result = await act('deck.remove', { id: deck.id, confirm: true }, undefined, { rethrow: true });
    if (result === undefined) throw new Error(ui('上一个操作还没结束，这次点击没有生效。等它结束后再点一次。'));
  }
  return <PermanentDeleteDialog title={deck.title} busy={busy} blocked={!eligible}
    onConfirm={confirm} onDeleted={() => onRemoved(deck)} onClose={onClose}>
    <p>{uiFormat('将永久删除这个题组及其中的 {0} 道题，无法撤销。原始资料和已有作答记录会保留。', [deck.count])}</p>
    {!eligible && <InlineMessage>{ui('这个题组需要先归档，才能永久删除。')}</InlineMessage>}
  </PermanentDeleteDialog>;
}
