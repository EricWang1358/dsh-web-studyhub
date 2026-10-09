import React, { useCallback } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Badge, Button } from '../components/index.js';
import Markdown from '../Markdown.jsx';
import { displayTitle } from '../../lib/document-title.js';

/* 复习全书 under an opened knowledge point of the 总纲 (course.outline's `open[key].notes`, lib/course-book-view.js), read-only: 考情 (only when the outline rests on
   sample papers), 知识梳理, 讲解, 例子, 补充 (what the materials do not say, marked) and the 角标. A 角标 in the text and a row of 出处 open the original at its quote
   (`onOpenSource(sourceId, quote)`, the reader). Formulas are KaTeX through the Markdown component. The full book page comes later; this is its first view. */

const citeText = item => uiFormat('{0}. 「{1}」', [item.n, item.quote]);

/** notes: { body?: { points, explain, example?, extra?, cites: [{ n, sourceId, quote, title }] }, empty?, exam?: { tested, note? } }; onOpenSource(sourceId, quote). */
export default function LeafNotes({ notes, onOpenSource }) {
  const body = notes?.body;
  const onCite = useCallback(n => {
    const cite = body?.cites.find(item => item.n === n);
    if (cite && onOpenSource) onOpenSource(cite.sourceId, cite.quote);
  }, [body, onOpenSource]);
  if (!notes) return null;
  const cite = onOpenSource ? onCite : undefined;
  return (
    <section className="outline-notes" aria-label={ui('复习全书')}>
      {notes.exam && <div className="outline-notes__part">
        <h4 className="outline-notes__head">{ui('考情')}</h4>
        <p className="outline-notes__exam">{notes.exam.tested ? ui('样卷考过。') : ui('样卷没有考到这一点。')}{notes.exam.note ? ` ${notes.exam.note}` : ''}</p>
      </div>}
      {notes.empty && <p className="outline-notes__none">{ui('这一点的资料里没有可读的文字，没有讲解。')}</p>}
      {body?.points.length > 0 && <div className="outline-notes__part">
        <h4 className="outline-notes__head">{ui('知识梳理')}</h4>
        <Markdown text={body.points.map(point => `- ${point}`).join('\n')} onCite={cite} />
      </div>}
      {body?.explain && <div className="outline-notes__part">
        <h4 className="outline-notes__head">{ui('讲解')}</h4>
        <Markdown text={body.explain} onCite={cite} />
      </div>}
      {body?.example && <div className="outline-notes__part">
        <h4 className="outline-notes__head">{ui('例子')}</h4>
        <Markdown text={body.example} onCite={cite} />
      </div>}
      {body?.extra?.length > 0 && <div className="outline-notes__part outline-notes__part--extra">
        <h4 className="outline-notes__head">{ui('补充')} <Badge size="sm">{ui('资料以外')}</Badge></h4>
        <Markdown text={body.extra.map(item => `- ${item}`).join('\n')} />
      </div>}
      {body?.cites.length > 0 && <ol className="outline-notes__cites" aria-label={ui('出处')}>
        {body.cites.map(item => <li key={item.n} className="outline-notes__cite">
          {onOpenSource ? <Button variant="link" size="sm" wrap icon="external" onClick={() => onOpenSource(item.sourceId, item.quote)}>{citeText(item)}</Button>
            : <span>{citeText(item)}</span>}
          {item.title && <small className="outline-notes__source">{displayTitle(item.title)}</small>}
        </li>)}
      </ol>}
    </section>
  );
}
