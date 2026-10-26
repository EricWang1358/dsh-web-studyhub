import React from 'react';
import { plainPrompt } from './shared.js';
import { splitStudyMath } from './study-media.js';
import StudyMath from './StudyMath.jsx';

/** One run of study text with its formulas drawn, for lines Markdown's blocks do not fit (a clamped row, a list item): the stored text is not
 * changed, a cloze blank shows as a blank, and a $$…$$ formula is drawn inline here so a one-line row stays one line. A \begin{align}…\end{align} block
 * can only be drawn as a display equation, so on a one-line row it stays text, on one line. */
export default React.memo(function StudyInline({ text }) {
  const pieces = React.useMemo(() => splitStudyMath(plainPrompt(text)), [text]);
  return pieces.map((piece, at) => {
    if (typeof piece === 'string') return <React.Fragment key={at}>{piece}</React.Fragment>;
    if (piece.raw.startsWith('\\begin{')) return <React.Fragment key={at}>{piece.raw.replace(/\s+/g, ' ')}</React.Fragment>;
    return <StudyMath key={at} formula={{ ...piece, display: false }} />;
  });
});
