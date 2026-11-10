import React from 'react';
import { uiFormat } from './i18n.js';
import { uiRich } from './i18n-rich.jsx';
import { Hint } from './components/index.js';
import { embeddedImagesAsAlt } from '../lib/study-image-markdown.js';

/* The near-duplicate notice of a draft question (#890): one line in the question's row, and the other question to read when the question is opened.
   A hint only: it blocks nothing, removes nothing and has no button. `match` is one entry of `draft.similar` (lib/contexts/authoring/similar-questions.js). */

/** A question as its row shows it: an embedded image is named, not drawn (the rule the near-duplicate check compares with). */
export const plainStem = embeddedImagesAsAlt;

/** Where the other question is. In the row (`clip`) only the deck's title is cut short, in a span of its own: 「相似」 and the number always show. */
const whereSimilar = ({ other }, clip = false) => (other.where === 'deck'
  ? uiRich('与{0}第 {1} 题相似', <span className={clip ? 'draft-card__similar-title' : undefined} data-similar-title>{uiFormat('《{0}》', [other.deckTitle])}</span>, other.n)
  : uiFormat('与本草稿第 {0} 题相似', [other.n]));

/** The one notice in a flagged question's row. */
export function SimilarTag({ match }) {
  if (!match) return null;
  return <small className="draft-card__similar" data-similar data-tour="draft-similar">{whereSimilar(match, true)}</small>;
}

/** At the top of an opened flagged question: how similar, and the other question's stem. */
export function SimilarDetail({ match }) {
  if (!match) return null;
  return (
    <div className="draft-similar" data-similar-detail>
      <Hint>{uiRich('{0} · 相似度 {1}%。只是提醒：两道题都会保留，改不改由你决定。', whereSimilar(match), Math.round(match.similarity * 100))}</Hint>
      <blockquote className="draft-similar__stem">{plainStem(match.other.prompt)}</blockquote>
    </div>
  );
}
