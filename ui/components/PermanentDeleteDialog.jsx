import React, { useRef, useState } from 'react';
import Dialog from './Dialog.jsx';
import { Button } from './Button.jsx';
import { InlineMessage } from './Feedback.jsx';
import { ui, uiFormat } from '../i18n.js';

/** Shared irreversible confirmation; callers supply the operation and its consequences. */
export default function PermanentDeleteDialog({ title, busy, blocked = false, onConfirm, onDeleted, onClose, children }) {
  const cancelRef = useRef(null), inFlight = useRef(false);
  const [working, setWorking] = useState(false), [error, setError] = useState('');
  const locked = busy || working;
  async function confirm() {
    if (locked || blocked || inFlight.current) return;
    inFlight.current = true;
    setWorking(true);
    setError('');
    try {
      await onConfirm();
      onDeleted();
    } catch (failure) {
      setError(failure?.message || String(failure));
    } finally {
      inFlight.current = false;
      setWorking(false);
    }
  }
  return <Dialog size="sm" title={uiFormat('永久删除「{0}」？', [title])}
    initialFocus={cancelRef} dismissible={!locked} onClose={onClose}
    footer={<>
      <Button ref={cancelRef} variant="quiet" disabled={locked} onClick={onClose}>{ui('取消')}</Button>
      <Button variant="danger" busy={working} disabled={busy || blocked} onClick={confirm}>{ui('确认永久删除')}</Button>
    </>}>
    {children}
    {error && <InlineMessage>{error}</InlineMessage>}
  </Dialog>;
}
