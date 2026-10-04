import React from 'react';
import { splitStudyMath } from './study-media.js';
import StudyMath from './StudyMath.jsx';

/** A stored quote with its formulas drawn (inline, even a $$…$$ one) and the rest as plain text: nothing is rewritten. */
export default function MathText({ text }) {
  return splitStudyMath(text).map((piece, at) => typeof piece === 'string' ? piece : <StudyMath key={at} formula={{ ...piece, display: false }} />);
}
