import React from 'react';
import { ui } from '../../i18n.js';
import { lineBreakPieces } from './text-sections.js';
import { isFigurePlaceholder } from '../peek/peek-logic.js';

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
          ? <h4 key={index} className="reader-p reader-p--heading">{paragraph.text}</h4>
          : <p key={index} className={`reader-p reader-p--${paragraph.kind}`}>{paragraph.kind === 'prose'
            ? lineBreakPieces(paragraph.text).map((piece, at) => typeof piece === 'string' ? piece : <span key={at} className="reader-join">{'\n'}</span>)
            : paragraph.text}</p>)}
      </div>
    </section>;
  });
}
