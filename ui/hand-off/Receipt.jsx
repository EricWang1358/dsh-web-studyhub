import React from 'react';
import { getUiLanguage } from '../i18n.js';
import { Icon } from '../components/index.js';
import { useInjectCss } from '../shared.js';
import css from './hand-off.css';

/* The seal of a 「发给主会话」 receipt (direction B 「盖章回执」, output/preview-3.6/handoff-design/; the critic's fixes in the 3.6 hand-off notes): one stamped mark
   per outcome, so the four outcomes tell apart from across the screen by the character, the ink and the words beside it. Chinese: the character (填 留 复 手,
   each one in its title too); any other language: the outcome's Phosphor Light glyph in the same frame. Decorative: the title and line beside it say it all. */

/** outcome -> the character of the Chinese seal and the glyph of the others. */
export const SEALS = Object.freeze({
  filled: { character: '填', glyph: 'success' },
  kept: { character: '留', glyph: 'note' },
  copied: { character: '复', glyph: 'clipboard' },
  shown: { character: '手', glyph: 'select-all' },
});

/** <Seal outcome size? />: 'md' on a receipt, 'lg' at the head of the full-text card. Remount it (a new key) to press it again. */
export function Seal({ outcome, size = 'md', className }) {
  useInjectCss(css, 'study-hand-off');
  const seal = SEALS[outcome] || SEALS.copied;
  const chinese = /^zh/i.test(getUiLanguage());
  return (
    <span className={['sh-seal', `sh-seal--${size}`, className].filter(Boolean).join(' ')} data-o={outcome} aria-hidden="true">
      {chinese ? <span className="sh-seal__char">{seal.character}</span> : <Icon name={seal.glyph} size={20} className="sh-seal__glyph" />}
    </span>
  );
}

export default Seal;
