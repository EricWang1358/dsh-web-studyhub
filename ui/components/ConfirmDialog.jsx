import React, { useEffect, useRef, useState } from 'react';
import { ui, uiMessage } from '../i18n.js';
import Dialog from './Dialog.jsx';
import { Button } from './Button.jsx';
import { InlineMessage } from './Feedback.jsx';

/**
 * The one confirmation for a destructive, irreversible or leaving-the-screen
 * action. Cancel (quiet) comes first and holds the initial focus, the confirm
 * button comes last: `tone` 'danger' (default) or 'primary'.
 *
 * onConfirm may be async. While it runs the dialog stays open and busy (it
 * cannot be dismissed and a second click does nothing); if it throws, the
 * message appears inside the dialog and the learner can try again. When it
 * succeeds, onDone() runs (default: onClose). `busy` is for work the caller
 * already tracks, `blocked` disables only the confirm button.
 */
export default function ConfirmDialog({ title, description, children, tone = 'danger', confirmLabel, cancelLabel, icon, onConfirm, onDone, onClose,
  busy = false, blocked = false, size = 'sm', className }) {
  const cancel = useRef(null), flight = useRef(false), alive = useRef(true);
  const [working, setWorking] = useState(false), [error, setError] = useState('');
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const locked = busy || working;
  async function confirm() {
    if (locked || blocked || flight.current) return;
    flight.current = true;
    setWorking(true);
    setError('');
    try {
      await onConfirm?.();
      (onDone || onClose)?.('confirm');
    } catch (failure) {
      if (alive.current) setError(uiMessage(failure?.message) || ui('没有完成，请再试一次。'));
    } finally {
      flight.current = false;
      if (alive.current) setWorking(false);
    }
  }
  return (
    <Dialog size={size} title={title} description={description} busy={locked} initialFocus={cancel} className={className} onClose={onClose}
      footer={<>
        <Button ref={cancel} variant="quiet" disabled={locked} onClick={() => onClose?.('button')}>{cancelLabel || ui('取消')}</Button>
        <Button variant={tone === 'primary' ? 'primary' : 'danger'} icon={icon} busy={working} disabled={busy || blocked} onClick={confirm}>{confirmLabel}</Button>
      </>}>
      {children}
      {error && <InlineMessage tone="error">{error}</InlineMessage>}
    </Dialog>
  );
}
