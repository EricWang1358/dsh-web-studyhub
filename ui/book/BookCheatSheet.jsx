import React, { useCallback, useRef, useState } from 'react';
import { ui, errorMessage } from '../i18n.js';
import { Button, Hint, LoadingState } from '../components/index.js';
import { useStudy } from '../study-context.jsx';
import { useInjectCss } from '../shared.js';
import { useLiveEffect } from '../use-async.js';
import { cheatSheetPage, downloadCheatSheet } from './cheat-sheet-file.js';
import css from './book-cheat.css';

/* 速查表 of the review book (#710 S5), reached from 「⋯ 更多」 › 速查表: the same one page the print and the saved .html are (ui/book/cheat-sheet-html.js), shown
   in a frame so that nothing of the app is around it when it is printed and the page is not made twice. A point's code in it opens the book there (the page
   marks its codes `data-go`; the frame has no script, the app listens). 打印 prints the frame; 下载 saves the page through the book export's download. */

/** book: course.book.open's answer; onGo(hid) opens the book at that point. */
export default function BookCheatSheet({ book, onGo }) {
  useInjectCss(css, 'study-book-cheat');
  const { notify } = useStudy();
  const frame = useRef(null), go = useRef(onGo);
  go.current = onGo;
  const [page, setPage] = useState({ html: null, error: null });
  useLiveEffect(isLive => {
    cheatSheetPage(book, { links: true }).then(
      next => { if (isLive()) setPage({ html: next?.html ?? '', error: null }); },
      error => { if (isLive()) setPage({ html: null, error }); });
  }, [book]);
  const listen = useCallback(() => {
    const doc = frame.current?.contentDocument;
    doc?.addEventListener('click', event => {
      const link = event.target?.closest?.('a');
      const hid = link?.getAttribute('data-go'), anchor = link?.getAttribute('href')?.startsWith('#') ? link.getAttribute('href').slice(1) : '';
      if (hid) { event.preventDefault(); go.current(hid); }
      // A bare #link in a srcdoc frame would load the app's own address into it: scroll in the sheet instead.
      else if (anchor) { event.preventDefault(); doc.getElementById(anchor)?.scrollIntoView(); }
    });
  }, []);
  const print = () => { const view = frame.current?.contentWindow; if (view) { view.focus(); view.print(); } };
  const save = async () => {
    try { await downloadCheatSheet(book); } catch (failure) { notify({ text: errorMessage(failure), tone: 'error' }); }
  };
  return (
    <div className="book-cheat">
      <div className="book-cheat__tools">
        <p className="book-cheat__lead">{ui('答题模板、易混对照、公式和术语卡排在一起，每条都标着书里的哪一节。')}</p>
        <Button size="sm" variant="secondary" icon="file" disabled={!page.html} onClick={print}>{ui('打印 / 存为 PDF')}</Button>
        <Button size="sm" variant="secondary" icon="download" disabled={!page.html} onClick={save}>{ui('下载 .html')}</Button>
      </div>
      {page.error ? <Hint tone="error">{errorMessage(page.error)}</Hint> : page.html === null ? <LoadingState inline label={ui('正在排速查表…')} />
        : <iframe ref={frame} className="book-cheat__frame" title={ui('速查表')} srcDoc={page.html} sandbox="allow-same-origin allow-modals" onLoad={listen} />}
    </div>
  );
}
