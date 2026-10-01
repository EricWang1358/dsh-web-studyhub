import React, { useLayoutEffect, useRef } from 'react';
import { ui } from './i18n.js';

/** Native top-layer previews escape the host panel's clipping and composer. */
export default function ModalFrame({ title, fullscreen = false, onClose, children }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    if (!fullscreen) return;
    const dialog = ref.current;
    dialog.showModal();
    return () => { if (dialog.open) dialog.close(); };
  }, [fullscreen]);
  const content = <>
    <header className="modal-heading">
      <h2 title={title}>{title}</h2>
      <button type="button" aria-label={ui('关闭')} onClick={onClose}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="m6 6 12 12M18 6 6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </button>
    </header>
    <div className="modal-body" tabIndex={0} role="region" aria-label={fullscreen ? ui('资料内容') : title}>
      <div className="modal-content">{children}</div>
    </div>
  </>;
  if (fullscreen) return <dialog ref={ref} className="modal source-preview" aria-label={title}
    onCancel={event => { event.preventDefault(); onClose(); }}>{content}</dialog>;
  return <div className="modal-backdrop" onClick={event => {
    if (event.target === event.currentTarget) onClose();
  }}>
    <section className="modal" role="dialog" aria-modal="true" aria-label={title}>{content}</section>
  </div>;
}
