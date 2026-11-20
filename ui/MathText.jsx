import React from 'react';
import { splitStudyMath } from './study-media.js';
import StudyMath from './StudyMath.jsx';
import { stripFootnoteHtml } from '../lib/footnote-html.js';

/** A stored quote with its formulas drawn (inline, even a $$…$$ one) and the rest as plain text: nothing is rewritten, except that a converter's footnote
 * tags (lib/footnote-html.js), which a quote taken from a footnote carries as stored text, are not shown: the footnote's words are. */
const MathText = React.memo(function MathText({ text }) {
  const pieces = React.useMemo(
    () => splitStudyMath(stripFootnoteHtml(text, { dangling: true })).map((piece) => (
      typeof piece === 'string' ? piece : { ...piece, display: false }
    )),
    [text],
  );
  return pieces.map((piece, at) => (typeof piece === 'string' ? piece : <StudyMath key={at} formula={piece} />));
});

export default MathText;
