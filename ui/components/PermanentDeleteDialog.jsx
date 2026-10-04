import React from 'react';
import ConfirmDialog from './ConfirmDialog.jsx';
import { ui, uiFormat } from '../i18n.js';

/** The irreversible deletion of a source or a deck: ConfirmDialog with the wording that says so; callers supply the operation and its consequences. */
export default function PermanentDeleteDialog({ title, busy, blocked = false, onConfirm, onDeleted, onClose, children }) {
  return <ConfirmDialog title={uiFormat('永久删除「{0}」？', [title])} confirmLabel={ui('确认永久删除')}
    busy={busy} blocked={blocked} onConfirm={onConfirm} onDone={onDeleted} onClose={onClose}>
    {children}
  </ConfirmDialog>;
}
