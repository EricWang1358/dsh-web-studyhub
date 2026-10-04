import React from 'react';
import { ui } from '../../i18n.js';
import { lineBreakPieces, headingMark } from './text-sections.js';
import { isFigurePlaceholder } from '../peek/peek-logic.js';
import { splitStudyMath } from '../../study-media.js';
import StudyMath from '../../StudyMath.jsx';

/**
 * $…$ / $$…$$ / \(…\) / \[…\] drawn as formulas. The source stays in the text (visually hidden, and what a copy
 * gives), so selection, find, the link underlines and translation count the same characters as before; the
 * drawing beside it is a data-study-marker that they all skip. `join` also marks the CJK line joins of prose.
 */
function withFormulas(text, join) {
  return splitStudyMath(text).flatMap((piece, at) => typeof piece === 'string'
    ? (join ? lineBreakPieces(piece) : [piece]).map((part, index) => typeof part === 'string' ? part : <span key={`${at}.${index}`} className="reader-join">{'\n'}</span>)
    : [<span key={at} className={`reader-math${piece.display ? ' reader-math--display' : ''}`}>
      <span className="reader-math__source" aria-hidden="true">{piece.raw}</span>
      <span className="reader-math__view" data-study-marker="true"><StudyMath formula={piece} /></span>
    </span>]);
}

/**
 * Text sources set for reading. Each section keeps the markers the selection tools use:
 * data-study-page / data-study-source on a page, data-study-text around the paragraphs.
 * A transcript part's 【】 stay in the text (hidden, not removed), so a passage captured in
 * the plain 原文 view still finds its context here.
 */
export default function ReadingSections({ sections, labelOf, onPeek }) {
  return sections.map(section => {
    const label = labelOf(section), paged = section.kind === 'page';
    return <section key={section.id} className={`reader-section reader-section--${section.kind}`} data-outline-id={section.id}
      {...(paged ? { 'data-study-page': section.page, 'data-study-source': section.sourceId } : {})}>
      {(label || (!paged && section.title)) && <header className="reader-section__head">
        {label && <span className="reader-section__label">{label}</span>}
        {paged && onPeek && <button type="button" className="reader-peek" data-peek-page={section.page} title={ui('看原页')} onClick={event => onPeek(section.page, { figure: false, trigger: event.currentTarget })}>{ui('看原页')}</button>}
        {!paged && section.title && <h3 className="reader-section__title">
          <span className="reader-bracket" aria-hidden="true">【</span>{section.title}<span className="reader-bracket" aria-hidden="true">】</span></h3>}
      </header>}
      <div className="reader-prose" data-study-text="true">
        {section.paragraphs.map((paragraph, index) => paged && onPeek && isFigurePlaceholder(paragraph.text)
          ? <p key={index} className="reader-p reader-p--figure">{paragraph.text}<span className="reader-peek-mark" data-study-marker="true"><button type="button" className="reader-peek" data-peek-page={section.page} data-peek-figure="true" title={ui('看原页')}
            onClick={event => onPeek(section.page, { figure: true, trigger: event.currentTarget })}>{ui('看原页')}</button></span></p>
          : paragraph.kind === 'heading'
          ? <h4 key={index} className="reader-p reader-p--heading">{headingMark(paragraph.text) && <span className="reader-bracket" aria-hidden="true">{headingMark(paragraph.text)}</span>}
            {withFormulas(paragraph.text.slice(headingMark(paragraph.text).length))}</h4>
          : <p key={index} className={`reader-p reader-p--${paragraph.kind}`}>{paragraph.kind === 'layout'
            ? paragraph.text : withFormulas(paragraph.text, paragraph.kind === 'prose')}</p>)}
      </div>
    </section>;
  });
}
