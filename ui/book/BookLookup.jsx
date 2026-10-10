import React, { memo } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button } from '../components/index.js';

/* 「查找」 of the review book (M6, docs/plans/review-book.md): the lookup pages the printed book starts with (lib/course-book-lookup.js bookLookup), live
   from the book: 目录 with the stable codes, 按题型 (the 速查表: steps and formulas, the common mistakes and the cost to state), 按概念, 易错点. A code
   opens the book at its heading. Generated, never edited here. */

function Code({ hid, code, onGo }) {
  return <Button variant="link" size="sm" className="book-lookup__code" data-book-code={hid} onClick={() => onGo(hid)}>{code}</Button>;
}
const Codes = ({ hids, places, onGo }) => hids.map(hid => <Code key={hid} hid={hid} code={places.get(hid)?.code ?? hid} onGo={onGo} />);

function Part({ id, title, children }) {
  return (
    <section className="book-lookup__part" aria-labelledby={`book-lookup-${id}`}>
      <h2 id={`book-lookup-${id}`} className="book-lookup__title">{title}</h2>
      {children}
    </section>
  );
}

/** lookup: bookLookup's answer; onGo(hid) opens the book there. */
export default memo(function BookLookup({ lookup, onGo }) {
  const places = new Map(lookup.places.map(place => [place.hid, place]));
  return (
    <div className="book-lookup">
      <Part id="toc" title={ui('目录')}>
        <ol className="book-lookup__toc">
          {lookup.toc.map(entry => <li key={entry.id} className="book-lookup__entry" data-level={Math.min(4, entry.level)}>
            <Code hid={entry.id} code={entry.code} onGo={onGo} /> <span>{entry.title}</span>
          </li>)}
        </ol>
      </Part>
      <Part id="types" title={ui('按题型')}>
        {lookup.types.length ? <>
          <p className="book-lookup__order"><strong>{ui('答题顺序')}</strong> {lookup.answerOrder.join(' → ')}</p>
          {lookup.types.map(type => <article key={type.id} className="book-lookup__type" data-type={type.id}>
            <h3 className="book-lookup__label">{type.label}</h3>
            {type.signals.length > 0 && <p className="book-lookup__muted">{uiFormat('题干信号：{0}', [type.signals.join(' · ')])}</p>}
            <div className="book-lookup__cols">
              <div className="book-lookup__col">
                <h4 className="book-lookup__head">{ui('检查顺序 · 公式')}</h4>
                <ol className="book-lookup__list">{type.steps.map(step => <li key={step}>{step}</li>)}</ol>
                {type.formulas.length > 0 && <ul className="book-lookup__formulas">{type.formulas.map(formula => <li key={formula}><code>{formula}</code></li>)}</ul>}
              </div>
              <div className="book-lookup__col">
                <h4 className="book-lookup__head">{ui('最常见错误 · 必须交代的代价')}</h4>
                <ul className="book-lookup__list">{type.mistakes.map(item => <li key={item}>{item}</li>)}</ul>
                {type.costs.length > 0 && <p className="book-lookup__muted">{uiFormat('代价：{0}', [type.costs.join(' · ')])}</p>}
              </div>
            </div>
            {type.places.length > 0 && <p className="book-lookup__where">{ui('在哪里')} <Codes hids={type.places} places={places} onGo={onGo} /></p>}
            {type.cards.length > 0 && <ul className="book-lookup__cards">{type.cards.map(card => <li key={`${card.deckId}|${card.cardId}`}>
              {card.hid && <Code hid={card.hid} code={places.get(card.hid)?.code ?? card.hid} onGo={onGo} />} {card.prompt}
            </li>)}</ul>}
          </article>)}
        </> : <p className="book-lookup__none">{ui('还没有分析题答案卡。答题卡加入复习全书后，这里按题型列出检查顺序、公式和最常见的错误。')}</p>}
      </Part>
      <Part id="concepts" title={ui('按概念')}>
        {lookup.concepts.length ? <ul className="book-lookup__concepts">{lookup.concepts.map(item => <li key={item.term}>
          <strong>{item.term}</strong> <Codes hids={item.places} places={places} onGo={onGo} />
        </li>)}</ul> : <p className="book-lookup__none">{ui('还没有概念。笔记里写成「**术语**：定义」或 [[术语]] 的词，和答题卡的概念，会列在这里。')}</p>}
      </Part>
      <Part id="mistakes" title={ui('易错点（按知识点）')}>
        {lookup.mistakes.length ? <ul className="book-lookup__mistakes">{lookup.mistakes.map(place => <li key={place.hid}>
          <p className="book-lookup__place"><Code hid={place.hid} code={place.code} onGo={onGo} /> {`${place.number} ${place.title}`.trim()}</p>
          <ul className="book-lookup__list">{place.items.map(item => <li key={`${item.kind}|${item.text}`}>{uiFormat(item.kind === 'asked' ? '问过：{0}' : '易错：{0}', [item.text])}</li>)}</ul>
        </li>)}</ul> : <p className="book-lookup__none">{ui('还没有易错点。加入复习全书的追问和答题卡的易错检查会列在这里。')}</p>}
      </Part>
    </div>
  );
});
