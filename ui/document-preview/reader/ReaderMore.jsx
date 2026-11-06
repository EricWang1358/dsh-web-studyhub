import React from 'react';
import { ui } from '../../i18n.js';
import { Button, Menu } from '../../components/index.js';

/**
 * 「更多」 of the reader's toolbar: a menu of what the toolbar does not show (reader/more-items.js). The word shows beside the dots where there is room.
 * `attention`: something is waiting inside (a passage was selected while the study tools are shut): a small dot on the button, as the tools button used to carry.
 */
export default function ReaderMore({ items, attention = false }) {
  const label = ui('更多');
  return <Menu label={label} items={items} className="reader-more" data-tour="reader-more"
    trigger={({ props, ref }) => <Button ref={ref} size="sm" variant="quiet" icon="more" className="reader-more__button reader-toolbar__action reader-toolbar__icon-btn" aria-label={label}
      data-attention={attention ? 'true' : undefined} {...props}><span className="reader-more__label">{label}</span></Button>} />;
}
