import React, { useMemo, useRef, useState } from 'react';
import { ui } from '../../i18n.js';
import { useInjectCss } from '../../shared.js';
import { Button, Tooltip } from '../../components/index.js';
import { useStudy } from '../../study-context.jsx';
import { useLiveEffect } from '../../use-async.js';
import { citedPages, findFigurePage } from './figure-page.js';
import css from './practice.css';

/* 看原页图, next to 「引用与来源核对」 on a question whose answer is shown: when the page a citation points at has a figure and its original file is
   there, one click opens the reader at that page with the original page already up (the same 看原页 panel the reader's figure placeholder opens).
   The text keeps no pictures, so this is the way to the figure. Mount it only once the answer is shown; it reads from the backend once, on mount,
   and only for a question that cites a page of a PDF (ui/document-preview/practice/figure-page.js). */

/** The entry: nothing without a found page, else one small button. `found` is { source, quote, page }; onOpen(source, quote, page). */
export function FigurePageLinkView({ found, onOpen }) {
  if (!found) return null;
  return <Tooltip content={ui('这道题引用的那一页有图。文字版不保存图片，点它直接看原文件的这一页。')} placement="bottom-start">
    <Button size="sm" variant="quiet" icon="file" className="figure-page-link" data-tour="review-figure-page" onClick={() => onOpen(found.source, found.quote, found.page)}>{ui('看原页图')}</Button>
  </Tooltip>;
}

/** The question's entry, looked up when it mounts: `card` is the answer's card (its citations), `sources` the library's; the backend call is the study context's. */
export default function FigurePageLink({ card, sources, onOpen }) {
  useInjectCss(css, 'study-reading-loop');
  const { call } = useStudy();
  const pages = useMemo(() => citedPages(card, sources), [card, sources]);
  // The library snapshot is renewed while the learner reads: what was asked about is the cited pages, so only a change of those asks again.
  const key = pages.map(item => `${item.source.id}\u0000${item.quote}`).join('\u0001');
  const [state, setState] = useState({ key: '', found: null });
  const latest = useRef(null);
  latest.current = { pages, call };
  useLiveEffect(isLive => {
    if (key) findFigurePage(latest.current).then(found => { if (isLive()) setState({ key, found }); });
  }, [key]);
  return <FigurePageLinkView found={state.key === key ? state.found : null} onOpen={onOpen} />;
}
