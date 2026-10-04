import React from 'react';
import { Button } from './components/index.js';
import { ui, uiFormat } from './i18n.js';

/** Archived decks are managed here; study controls belong to the active list. */
export default function ArchivedDeckRow({ deck, busy, onRestore, onRemove, onManage }) {
  return <li className="map-deck archived-deck">
    <div className="archived-deck__info">
      <strong>{deck.title}</strong>
      <small>{uiFormat('{0} 题', [deck.count])}{ui(' · 已归档')}</small>
    </div>
    <div className="archived-deck__actions">
      {!deck.systemKind && <Button variant="secondary" disabled={busy} onClick={() => onRestore(deck.id)}>{ui('恢复题组')}</Button>}
      <Button variant="quiet" disabled={busy} onClick={() => onManage(deck.id)}>{ui('管理题组')}</Button>
      {!deck.systemKind && <Button variant="danger" disabled={busy} onClick={() => onRemove(deck.id)}>{ui('永久删除')}</Button>}
    </div>
  </li>;
}
