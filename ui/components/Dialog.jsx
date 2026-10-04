import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { ui } from '../i18n.js';
import css from './components.css';
import overlayCss from './overlays.css';
import { useComponentCss, cx } from './css.js';
import { IconButton } from './Button.jsx';
import { DialogToasts } from './Feedback.jsx';
import { guardFileDrag } from './FileDrop.jsx';
import { pushDialog, useTopDialog } from './dialog-stack.js';

const SIZES = new Set(['sm', 'md', 'lg', 'full']);

/** What Escape does: close, nothing (non-dismissible) or wait for the browser's close event. */
export function cancelDecision({ cancelable, dismissible }) {
  if (!dismissible) return 'block';
  return cancelable ? 'close' : 'defer';
}

/** A click closes from the backdrop only if it also started there (not a text selection dragged out). */
export const isBackdropClick = (event, dialog, downTarget) => event.target === dialog && downTarget === dialog;

/**
 * Every modal in StudyHub. A native <dialog> opened with showModal(): it sits
 * in the browser's top layer (above the DSH composer and any z-index), makes
 * the rest of the page inert, closes on Escape / the close button / a backdrop
 * click, and returns focus to whatever opened it. Mount it to open it and
 * unmount it to close it; onClose(reason) asks the owner to unmount it.
 * size: sm | md | lg | full. `footer` stays visible while the body scrolls.
 * `busy` (work is running) implies non-dismissible: the close button stays but
 * is marked aria-disabled, Escape and the backdrop do nothing, and the dialog
 * is aria-busy. `guardDrops` keeps a stray file drop on the dialog (its header
 * or margins) away from the browser and the host chat.
 */
export default function Dialog({ title, description, onClose, size = 'md', footer, children, dismissible = true, initialFocus,
  bodyLabel, closeLabel, busy = false, guardDrops = false, className, ...rest }) {
  useComponentCss(css);
  useComponentCss(overlayCss, 'study-overlays');
  const ref = useRef(null), pointerDown = useRef(null), closing = useRef(false), onCloseRef = useRef(onClose);
  const canDismiss = dismissible && !busy;
  const [entry] = useState(() => ({ dialog: null }));
  const top = useTopDialog();
  const titleId = useId(), descriptionId = useId();
  const kind = SIZES.has(size) ? size : 'md';
  useLayoutEffect(() => { onCloseRef.current = onClose; });
  useLayoutEffect(() => {
    const dialog = ref.current;
    const opener = document.activeElement;
    closing.current = false;
    entry.dialog = dialog;
    if (!dialog.open) {
      try { dialog.showModal(); } catch { dialog.setAttribute('open', ''); }
    }
    initialFocus?.current?.focus?.();
    const remove = pushDialog(entry);
    return () => {
      closing.current = true;
      remove();
      if (dialog.open) dialog.close();
      const active = document.activeElement;
      if (opener?.isConnected && typeof opener.focus === 'function' && (!active || active === document.body || dialog.contains(active)))
        opener.focus({ preventScroll: true });
    };
    // Opening is tied to mounting; the owner unmounts the dialog to close it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => (guardDrops && ref.current ? guardFileDrag(ref.current) : undefined), [guardDrops]);
  const requestClose = reason => { if (!closing.current && canDismiss) onCloseRef.current?.(reason); };
  return (
    <dialog ref={ref} className={cx('sh-dialog', `sh-dialog--${kind}`, className)} role="dialog" aria-modal="true"
      aria-labelledby={titleId} aria-describedby={description ? descriptionId : undefined} aria-busy={busy || undefined}
      onCancel={event => {
        const decision = cancelDecision({ cancelable: event.cancelable, dismissible: canDismiss });
        if (decision !== 'defer') event.preventDefault();
        if (decision === 'close') requestClose('escape');
      }}
      onClose={() => {
        // The browser closed it without asking (a forced Escape). Tell the
        // owner, and reopen if the owner keeps it mounted.
        if (closing.current) return;
        if (canDismiss) requestClose('escape');
        requestAnimationFrame(() => { const dialog = ref.current; if (!closing.current && dialog?.isConnected && !dialog.open) dialog.showModal(); });
      }}
      onPointerDown={event => { pointerDown.current = event.target; }}
      onClick={event => { if (canDismiss && isBackdropClick(event, ref.current, pointerDown.current)) requestClose('backdrop'); }}
      {...rest}>
      <header className="sh-dialog__header">
        <div className="sh-dialog__heading">
          <h2 id={titleId} className="sh-dialog__title" title={typeof title === 'string' ? title : undefined}>{title}</h2>
          {description && <p id={descriptionId} className="sh-dialog__description">{description}</p>}
        </div>
        {dismissible && <IconButton icon="close" className="sh-dialog__close" label={closeLabel || ui('关闭')} aria-disabled={busy || undefined}
          onClick={() => requestClose('button')} />}
      </header>
      <div className="sh-dialog__body" tabIndex={0} role="region" aria-label={bodyLabel || (typeof title === 'string' ? title : undefined)}>
        <div className="sh-dialog__content">{children}</div>
      </div>
      <div className="sh-dialog__toasts">{top === entry && entry.dialog && <DialogToasts dialog={entry.dialog} />}</div>
      {footer && <footer className="sh-dialog__footer">{footer}</footer>}
    </dialog>
  );
}
