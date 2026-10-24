import React, { useEffect, useState } from 'react';
import { ui, uiFormat } from '../../i18n.js';
import { IconButton, NumberInput } from '../../components/index.js';
import { clampPage } from '../page-scope.js';

/*
 * The page controls of the 原始 PDF view (issue #456): previous, the page number and next. They are the only way the reader knows which
 * page is shown (scrolling inside the PDF frame cannot be observed), so the learning panel asks about the page they name, and the frame
 * moves with them (#page=). The number is applied on Enter or when the box is left; Escape puts the current page back.
 */
export default function PdfPageBar({ page, total, onPage }) {
  const [draft, setDraft] = useState(String(page));
  useEffect(() => { setDraft(String(page)); }, [page]);
  const apply = () => {
    const next = clampPage(draft, total);
    if (next === null || next === page) setDraft(String(page)); else onPage(next);
  };
  return <nav className="reader-pdf-bar" aria-label={ui('原始 PDF 翻页')}>
    <IconButton size="sm" icon="chevron-left" label={ui('上一页')} disabled={page <= 1} onClick={() => onPage(page - 1)} />
    <NumberInput inputMode="numeric" min={1} max={total || undefined} step={1} value={draft} className="reader-pdf-bar__input" aria-label={ui('页码')}
      onChange={event => setDraft(event.target.value)} onBlur={apply}
      onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); apply(); } else if (event.key === 'Escape') setDraft(String(page)); }} />
    {total > 0 && <span className="reader-pdf-bar__total">{uiFormat('/ {0} 页', [total])}</span>}
    <IconButton size="sm" icon="chevron" label={ui('下一页')} disabled={!!total && page >= total} onClick={() => onPage(page + 1)} />
  </nav>;
}
