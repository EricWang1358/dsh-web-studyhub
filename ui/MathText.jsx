import React from 'react';
import { splitStudyMath } from './study-media.js';
import StudyMath from './StudyMath.jsx';
import { stripFootnoteHtml } from '../lib/footnote-html.js';

/** A stored quote with its formulas drawn (inline, even a $$…$$ one) and the rest as plain text: nothing is rewritten, except that a converter's footnote
 * tags (lib/footnote-html.js), which a quote taken from a footnote carries as stored text, are not shown: the footnote's words are. */
export default function MathText({ text }) {
  return splitStudyMath(stripFootnoteHtml(text, { dangling: true })).map((piece, at) => typeof piece === 'string' ? piece : <StudyMath key={at} formula={{ ...piece, display: false }} />);
}
