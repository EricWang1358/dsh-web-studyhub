import React from 'react';
import { ui } from '../i18n.js';
import { LEVEL_LABEL } from '../shared.js';
import { BAR_ORDER } from './map-model.js';

/** The segmented mastery bar and its percentage for a deck, topic or roll-up. */
export default function MasteryBar({ node }) {
  const total = BAR_ORDER.reduce((n, level) => n + node.counts[level], 0);
  const label = BAR_ORDER.filter((level) => node.counts[level]).map((level) => `${LEVEL_LABEL[level]} ${node.counts[level]}`).join(' · ') || ui('暂无题目');
  let seen = 0;
  return (
    <span className="mastery" title={label}>
      <span className={total > 0 ? 'mastery-bar' : 'mastery-bar empty'} aria-hidden="true">
        {BAR_ORDER.map((level) => {
          if (!node.counts[level]) return null;
          // Stagger each segment so the bar fills left-to-right on mount.
          const delay = `${seen * 90}ms`;
          seen += 1;
          return <span key={level} className={`lv-${level}`} style={{ flexGrow: node.counts[level], animationDelay: delay }} />;
        })}
      </span>
      <span className={total > 0 && node.mastery > 0 ? 'mastery-value' : 'mastery-value zero'}>{total > 0 ? `${node.mastery}%` : '—'}</span>
    </span>
  );
}
