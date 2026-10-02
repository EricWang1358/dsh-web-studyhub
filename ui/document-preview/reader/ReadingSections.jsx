import React from 'react';
import { lineBreakPieces } from './text-sections.js';

/**
 * Text sources set for reading. Each section keeps the markers the selection tools use:
 * data-study-page / data-study-source on a page, data-study-text around the paragraphs.
 * A transcript part's 【】 stay in the text (hidden, not removed), so a passage captured in
 * the plain 原文 view still finds its context here.
 */
export default function ReadingSections({ sections, labelOf }) {
  return sections.map(section => {
    const label = labelOf(section), paged = section.kind === 'page';
    return <section key={section.id} className={`reader-section reader-section--${section.kind}`} data-outline-id={section.id}
      {...(paged ? { 'data-study-page': section.page, 'data-study-source': section.sourceId } : {})}>
      {(label || (!paged && section.title)) && <header className="reader-section__head">
        {label && <span className="reader-section__label">{label}</span>}
        {!paged && section.title && <h3 className="reader-section__title">
          <span className="reader-bracket" aria-hidden="true">【</span>{section.title}<span className="reader-bracket" aria-hidden="true">】</span></h3>}
      </header>}
      <div className="reader-prose" data-study-text="true">
        {section.paragraphs.map((paragraph, index) => paragraph.kind === 'heading'
          ? <h4 key={index} className="reader-p reader-p--heading">{paragraph.text}</h4>
          : <p key={index} className={`reader-p reader-p--${paragraph.kind}`}>{paragraph.kind === 'prose'
            ? lineBreakPieces(paragraph.text).map((piece, at) => typeof piece === 'string' ? piece : <span key={at} className="reader-join">{'\n'}</span>)
            : paragraph.text}</p>)}
      </div>
    </section>;
  });
}
