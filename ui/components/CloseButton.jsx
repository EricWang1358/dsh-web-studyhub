import React, { forwardRef } from 'react';
import { ui } from '../i18n.js';
import { IconButton } from './Button.jsx';

/** The close control for every overlay header and panel: a small icon button named 关闭 (override `label` to say what closes). */
export const CloseButton = forwardRef(function CloseButton({ label, size = 'sm', ...rest }, ref) {
  return <IconButton ref={ref} icon="close" size={size} label={label || ui('关闭')} {...rest} />;
});

export default CloseButton;
