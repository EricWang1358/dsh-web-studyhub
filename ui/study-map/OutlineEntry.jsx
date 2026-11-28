import React from 'react';
import { ui } from '../i18n.js';
import { Button, Tooltip } from '../components/index.js';

/**
 * The way to the 总纲 page, one button on the home, beside the course title (#1695): a secondary
 * button that ends in →, as every control that takes the learner to another page does (no icon in front: #1073 round 10), never the
 * primary one (the day's card keeps that), and the words on what it is on hover.
 */
export default function OutlineEntry({ onShowOutline }) {
  return (
    <Tooltip layer content={ui('按资料的章节找题、挑题练')}>
      <Button iconEnd="arrow-right" className="outline-entry" onClick={onShowOutline}>{ui('总纲')}</Button>
    </Tooltip>
  );
}
