import React from 'react';
import css from './fields.css';
import { useComponentCss, cx } from './css.js';

/**
 * The shell of one settings section: a fieldset with its legend as the title, an optional lead and the tour anchor. Every settings
 * page uses it, so titles, leads and spacing cannot drift. Extra attributes (disabled, data-experimental, ref) go to the fieldset.
 */
export const SettingsSection = React.forwardRef(function SettingsSection({ title, lead, tour, className, children, ...rest }, ref) {
  useComponentCss(css, 'study-fields');
  return (
    <fieldset ref={ref} className={cx('settings-section', className)} data-tour={tour} {...rest}>
      <legend className="settings-section__title">{title}</legend>
      {lead && <p className="settings-section__lead">{lead}</p>}
      {children}
    </fieldset>
  );
});

export default SettingsSection;
