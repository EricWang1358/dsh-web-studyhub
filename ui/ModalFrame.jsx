import React from 'react';
import { ui } from './i18n.js';
import Dialog from './components/Dialog.jsx';

/** App's modal wrapper, kept for its props. Both sizes are native top-layer
 * dialogs now, so the DSH composer and panel clipping can never cover them. */
export default function ModalFrame({ title, fullscreen = false, onClose, children }) {
  return (
    <Dialog title={title} onClose={onClose} guardDrops size={fullscreen ? 'full' : 'md'} className={fullscreen ? 'source-preview' : undefined}
      bodyLabel={fullscreen ? ui('资料内容') : title}>
      {children}
    </Dialog>
  );
}
