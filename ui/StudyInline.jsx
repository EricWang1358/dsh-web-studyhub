import React from 'react';
import { plainPrompt } from './shared.js';
import { splitStudyMath } from './study-media.js';
import StudyMath from './StudyMath.jsx';

/** One run of study text with its formulas drawn, for lines Markdown's blocks do not fit (a clamped row, a list item): the stored text is not
 * changed, a cloze blank shows as a blank, and a $$…$$ formula is drawn inline here so a one-line row stays one line. */
export default React.memo(function StudyInline({ text }) {
  const pieces = React.useMemo(() => splitStudyMath(plainPrompt(text)), [text]);
  return pieces.map((piece, at) => (typeof piece === 'string' ? <React.Fragment key={at}>{piece}</React.Fragment> : <StudyMath key={at} formula={{ ...piece, display: false }} />));
});
