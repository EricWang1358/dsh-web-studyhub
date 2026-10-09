import React from 'react';
import { ui } from '../i18n.js';
import { Button, Tooltip } from '../components/index.js';

/**
 * The way to the 总纲 page, one button wherever the home offers it (the course heading, the 学习目录 heading): a secondary
 * button with the list icon, never the primary one (the day's card keeps that), and the words on what it is on hover.
 */
export default function OutlineEntry({ onShowOutline, size = 'md' }) {
  return (
    <Tooltip layer content={ui('按资料的章节找题、挑题练')}>
      <Button size={size} icon="list" className="outline-entry" onClick={onShowOutline}>{ui('总纲')}</Button>
    </Tooltip>
  );
}
