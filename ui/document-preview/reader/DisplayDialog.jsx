import React from 'react';
import { ui } from '../../i18n.js';
import { Dialog } from '../../components/index.js';
import { useInjectCss } from '../../shared.js';
import { DisplayControls } from '../../reading-settings/ReadingSettings.jsx';
import readingCss from '../../reading-settings/reading.css';

/** 「更多」 › 显示设置…: the reader's reading controls (size, width, typeface, background, underline, and the bilingual row) in a dialog, since the toolbar has no Aa button. */
export default function DisplayDialog({ settings, onChange, onReset, underline = true, extra = null, onClose }) {
  useInjectCss(readingCss, 'study-reading');
  return <Dialog title={ui('显示设置')} size="sm" onClose={onClose}>
    <DisplayControls settings={settings} onChange={onChange} onReset={onReset} underline={underline} extra={extra} />
  </Dialog>;
}
