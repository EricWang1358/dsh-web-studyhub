import React, { memo } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button, Disclosure } from '../components/index.js';

/* A point's 术语卡 (#710), folded under its explanation like 要点清单: each card its number (K001…, given when the book is viewed), its name and other name,
   one plain line, the 考场原句 (exam pitch, in the sample papers' language) and its relations by kind. A relation whose concept has a card is a link that
   goes to that card (`onCard(hid, code)`); any other stays a name. Nothing is shown for a point without cards. */

const KINDS = ['related', 'opposite', 'parallel', 'part'];
const kindLabel = kind => ({ related: ui('相关概念'), opposite: ui('对立概念'), parallel: ui('并列概念'), part: ui('子概念') })[kind];

function Relations({ card, onCard }) {
  return KINDS.map(kind => {
    const list = (card.relations || []).filter(relation => relation.kind === kind);
    if (!list.length) return null;
    return (
      <p key={kind} className="book-card__line book-card__rel" data-relation={kind}>
        <span className="book-card__label">{kindLabel(kind)}</span>
        {list.map((relation, at) => <React.Fragment key={`${relation.code ?? ''}|${relation.name}`}>
          {at > 0 && <span className="book-card__sep" aria-hidden="true">·</span>}
          {relation.code
            ? <Button variant="link" size="sm" wrap className="book-card__link" data-term-link={relation.code} onClick={() => onCard(relation.hid, relation.code)}>
              {relation.name} <span className="book-card__code">{relation.code}</span></Button>
            : <span>{relation.name}</span>}
        </React.Fragment>)}
      </p>
    );
  });
}

/** cards: a point's numbered cards (lib/course-book-card-numbers.js); onCard(hid, code) goes to a card. */
export default memo(function TermCards({ cards, onCard }) {
  if (!cards?.length) return null;
  const range = cards.length > 1 ? `${cards[0].code}–${cards[cards.length - 1].code}` : cards[0].code;
  return (
    <Disclosure className="book-point__fold book-cards" data-book-part="cards" summary={uiFormat('术语卡 {0}', [range])}>
      <ol className="book-cards__list">
        {cards.map(card => <li key={card.code} className="book-card" data-term-card={card.code}>
          <p className="book-card__head">
            <span className="book-card__code">{card.code}</span>
            <strong className="book-card__name">{card.name}</strong>
            {card.alt && <span className="book-card__alt">{card.alt}</span>}
          </p>
          {card.plain && <p className="book-card__line">{card.plain}</p>}
          {card.pitch && <p className="book-card__line book-card__pitch"><span className="book-card__label">{ui('考场原句')}</span> <span>{card.pitch}</span></p>}
          <Relations card={card} onCard={onCard} />
        </li>)}
      </ol>
    </Disclosure>
  );
});
