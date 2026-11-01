import React, { useEffect, useRef, useState } from 'react';
import { ui, uiFormat } from '../../i18n.js';
import { IconButton, NumberInput } from '../../components/index.js';
import { clampPage } from '../page-scope.js';
import { ZOOMS } from '../peek/peek-logic.js';

/*
 * The page controls of the 原始 PDF view (issue #456): previous, the page number and next. They are the only way the reader knows which
 * page is shown, so the learning panel asks about the page they name, and the view moves with them. With `zoom` they also hold the
 * zoom of the page drawn in place (onZoom(+1 | -1 | 0: fit); the browser's viewer has its own). The number is applied on Enter or when the box is left; Escape puts the current page back.
 */

/** The page box's keys: Enter applies the number; Escape puts the current page back and stays in the box (it must not close the reader, like FindBar's). */
export function pageBoxKey(event, { apply, reset }) {
  if (event.key === 'Enter') { event.preventDefault(); apply(); return true; }
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); reset(); return true; }
  return false;
}

export default function PdfPageBar({ page, total, onPage, zoom, onZoom, children }) {
  const [draft, setDraft] = useState(String(page));
  const wanted = useRef(page);
  useEffect(() => { wanted.current = page; setDraft(String(page)); }, [page]);
  const step = delta => {
    const next = clampPage(wanted.current + delta, total);
    if (next === null || next === wanted.current) return;
    wanted.current = next;
    onPage(next);
  };
  const apply = () => {
    const next = clampPage(draft, total);
    if (next === null || next === page) setDraft(String(page)); else { wanted.current = next; onPage(next); }
  };
  return <nav className="reader-pdf-bar" data-tour="reader-pdf-bar" aria-label={ui('原始 PDF 翻页')}>
    <IconButton size="sm" icon="chevron-left" label={ui('上一页')} disabled={page <= 1} onClick={() => step(-1)} />
    <NumberInput inputMode="numeric" min={1} max={total || undefined} step={1} value={draft} className="reader-pdf-bar__input" aria-label={ui('页码')}
      onChange={event => setDraft(event.target.value)} onBlur={apply}
      onKeyDown={event => pageBoxKey(event, { apply, reset: () => setDraft(String(page)) })} />
    {total > 0 && <span className="reader-pdf-bar__total">{uiFormat('/ {0} 页', [total])}</span>}
    <IconButton size="sm" icon="chevron" label={ui('下一页')} disabled={!!total && page >= total} onClick={() => step(1)} />
    {zoom !== undefined && <span className="reader-pdf-bar__zooms">
      <IconButton size="sm" icon="minus" label={ui('缩小')} disabled={zoom <= ZOOMS[0]} onClick={() => onZoom(-1)} />
      <output className="reader-pdf-bar__zoom" aria-live="polite">{Math.round(zoom * 100)}%</output>
      <IconButton size="sm" icon="plus" label={ui('放大')} disabled={zoom >= ZOOMS.at(-1)} onClick={() => onZoom(1)} />
      <IconButton size="sm" icon="fit" label={ui('适合宽度')} onClick={() => onZoom(0)} />
    </span>}
    {children}
  </nav>;
}
