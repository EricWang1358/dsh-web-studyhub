import React, { useState } from 'react';
import { ui } from '../i18n.js';
import { Badge, Button, Disclosure, ErrorState, LoadingState } from '../components/index.js';
import { useStudy } from '../study-context.jsx';
import { useLiveEffect } from '../use-async.js';
import { plainPrompt, useInjectCss } from '../shared.js';
import css from './qa-list.css';
import Markdown from '../Markdown.jsx';
import BookQaButton, { useBookQa } from './BookQaButton.jsx';

/* 本节问答 of a knowledge point (course.outline.qa, lib/course-outline-qa.js): the 追问 kept on its questions, the reader's 批注 inside its places and the
   问答卡, one folded item each (the question; open it for the answer). An item opens its question (practice) or the reader at its passage; a 追问 can be put
   into the book (「加入复习全书」, M3) or taken out. */

const KIND = { card: () => ui('追问'), passage: () => ui('批注'), 'qa-card': () => ui('问答卡') };

/**
 * The items of course.outline.qa as one list: the book's 本节问答 and the reader's 追问 of a section (#1013) show them alike. onCard(ref) opens a question,
 * onSource(sourceId, quote) a passage; `book` (useBookQa) adds 「加入复习全书」 to a 追问, when the page has a book; `cardLabel` names what onCard does there.
 */
export function QaList({ items, onCard, onSource, book = null, onBookChanged, cardLabel }) {
  useInjectCss(css, 'study-qa-list');
  return (
    <ul className="book-qa" aria-label={ui('本节问答')}>
      {items.map((item, at) => (
        <li key={`${item.kind}-${at}`} className="book-qa__item">
          <Disclosure summary={<span className="book-qa__question"><Badge size="sm">{(KIND[item.kind] || KIND.card)()}</Badge> {plainPrompt(item.question)}</span>}>
            <Markdown text={item.answer} />
            {item.kind === 'passage'
              ? onSource && <Button variant="link" size="sm" icon="external" onClick={() => onSource(item.openRef.sourceId, item.openRef.quote)}>{ui('看原文')}</Button>
              : <Button variant="link" size="sm" icon="play" onClick={() => onCard(item.openRef)}>{cardLabel || ui('去练这道题')}</Button>}
            {item.kind === 'card' && item.followupId && book?.ready && <BookQaButton refOf={{ ...item.openRef, followupId: item.followupId }} book={book} onChanged={onBookChanged} />}
          </Disclosure>
        </li>
      ))}
    </ul>
  );
}

/** course, nodeKey (the 总纲's bk: key); onCard(ref), onSource(sourceId, quote); onBookChanged() after a Q&A went into the book or out. */
export default function BookQa({ course, nodeKey, onCard, onSource, onBookChanged }) {
  const { call } = useStudy();
  const book = useBookQa();
  const [state, setState] = useState({ items: null, error: null, ticket: 0 });
  useLiveEffect(isLive => {
    call('course.outline.qa', { course, keys: [nodeKey] }).then(answer => { if (isLive()) setState(current => ({ ...current, items: answer.items, error: null })); },
      error => { if (isLive()) setState(current => ({ ...current, error })); });
  }, [call, course, nodeKey, state.ticket]);
  if (state.error) return <ErrorState error={state.error} title={ui('没能读取这一节的问答')} onRetry={() => setState(current => ({ ...current, error: null, ticket: current.ticket + 1 }))} />;
  if (!state.items) return <LoadingState inline label={ui('正在读取本节问答…')} />;
  if (!state.items.length) return <p className="book-qa__none">{ui('这一节还没有问答。')}</p>;
  return <QaList items={state.items} onCard={onCard} onSource={onSource} book={book} onBookChanged={onBookChanged} />;
}
