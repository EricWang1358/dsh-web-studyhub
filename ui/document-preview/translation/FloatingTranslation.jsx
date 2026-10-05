import React from 'react';
import { ui } from '../../i18n.js';
import { CloseButton, Popover } from '../../components/index.js';

/**
 * The card a selection's translation appears in when the selection has no
 * paragraph to attach to (the 原文 view). It is a Popover anchored at the end
 * of the selection (`anchorRef` is the element useRangeAnchor places there): focus
 * moves into it, Escape closes it before anything else (the reader stays open
 * for a second Escape), a press outside the card closes it, and the close
 * control is the shared CloseButton. `children` is the translation block.
 */
export default function FloatingTranslation({ anchorRef, onClose, children }) {
  return (
    <div className="tr-float" ref={anchorRef}>
      <Popover open label={ui('译文')} placement="bottom-start" boundsSelector=".study-document-viewer" className="tr-float__host" panelClassName="tr-float__panel"
        onOpenChange={(open) => { if (!open) onClose(); }}
        trigger={({ ref }) => <span ref={ref} className="tr-float__anchor" aria-hidden="true" />}>
        {children}
        <CloseButton className="tr-float__close" onClick={onClose} />
      </Popover>
    </div>
  );
}
