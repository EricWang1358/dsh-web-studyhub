import React from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Badge, Button } from '../components/index.js';
import { useInjectCss } from '../shared.js';
import FindBar from '../document-preview/reader/FindBar.jsx';
import readerCss from '../document-preview/reader/reader.css';
import css from './book-find.css';

/* 在书里找 at the top of the 目录 (复习全书, docs/review-book.md "Find in the book"): the reader's own search bar (ui/document-preview/reader/FindBar.jsx: the same
   words and keys, Ctrl+F or `/`, Enter / Shift+Enter, Esc), over the whole book in memory (ui/book/use-book-find.js). While something is typed, the 目录 shows the
   matches instead of its groups: a typed print code (H12) as a jump first, then each match with its point and a few words around it. */

/** How many matches the list shows (Enter goes through all of them). */
const SHOWN = 50;

/** find: ui/book/use-book-find.js; onPick(index) shows a match, onJump() goes to the typed code's heading, onStep(delta) the next or previous match (Enter,
    Shift+Enter), onClose() ends the search (Esc, ×); each closes the slide-over on a narrow page. */
export default function BookFind({ find, onPick, onJump, onStep = find.step, onClose = find.close }) {
  useInjectCss(readerCss, 'study-reader');
  useInjectCss(css, 'study-book-find');
  const { hits, total, index, jump, searching } = find;
  return (
    <div className="book-find" data-searching={find.query.trim() ? '' : undefined}>
      <FindBar className="book-find__bar" label={ui('在书里找')} placeholder={ui('在书里找（Ctrl+F 或 /）')} query={find.query} onQuery={find.setQuery} total={total}
        index={Math.max(0, index)} onStep={onStep} onClose={onClose} inputRef={find.inputRef} countTip={ui('在整本书里数：也算没打开的知识点和收起的 AI 段落')}
        nothing={jump ? '' : undefined} />
      {searching && <div className="book-find__results" data-book-find="">
        {jump && <Button variant="quiet" size="sm" wrap className="book-find__jump" onClick={onJump}>{uiFormat('跳到 {0} · {1}', [jump.code, jump.title])}</Button>}
        {hits.length > 0 && <ol className="book-find__list" aria-label={ui('找到的地方')}>
          {hits.slice(0, SHOWN).map((hit, at) => (
            <li key={`${hit.hid}-${at}`}>
              <Button variant="quiet" size="sm" wrap className="book-find__hit" aria-current={at === index ? 'true' : undefined} onClick={() => onPick(at)}>
                <span className="book-find__title">{hit.number ? `${hit.number} ` : ''}{hit.title}{hit.block && <Badge size="sm">AI</Badge>}</span>
                <span className="book-find__words">{hit.before && '…'}{hit.before}<mark className="book-find__match">{hit.match}</mark>{hit.after}{hit.after && '…'}</span>
              </Button>
            </li>
          ))}
        </ol>}
        {total > SHOWN && <p className="book-find__more">{uiFormat('还有 {0} 处：按 Enter 一个个看', [total - SHOWN])}</p>}
      </div>}
    </div>
  );
}
