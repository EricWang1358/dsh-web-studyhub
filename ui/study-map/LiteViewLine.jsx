import React from 'react';
import { ui } from '../i18n.js';
import { Button } from '../components/index.js';

/** The quiet line at the foot of the home while 简洁版 is on (ui/lite-view.js): what is going on, and the one click back to the full view. */
export default function LiteViewLine({ onFull }) {
  return (
    <p className="lite-view-line">
      <span>{ui('现在是简洁版，部分内容已收起。')}</span>
      <Button variant="link" size="sm" data-usage="home.lite-off" onClick={onFull}>{ui('切回完整版')}</Button>
    </p>
  );
}
