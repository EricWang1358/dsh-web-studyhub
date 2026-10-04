import React from 'react';
import { ui } from '../i18n.js';
import { ConfirmDialog } from '../components/index.js';
import BIcon from './icons.jsx';

/** The one question for deleting a board card: from the card's ⋯ menu, from the editor and from the archive (`purge`). */
export default function DeleteCardDialog({ card, purge = false, onConfirm, onClose }) {
  return (
    <ConfirmDialog title={purge ? ui('永久删除这张卡片？') : ui('删除这张卡片？')}
      description={purge ? ui('它会从归档里消失，无法恢复。') : ui('删除后会立刻提示，可撤销。')}
      confirmLabel={ui('确认删除')} cancelLabel={ui('保留')} icon={<BIcon name="trash" />} onConfirm={onConfirm} onClose={onClose}>
      <p className="sh-confirm-dialog__title">{card.title}</p>
    </ConfirmDialog>
  );
}
