import React, { useEffect, useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button, NumberInput } from '../components/index.js';
import { PAGE_RANGE_MAX } from '../../lib/ask-prompt.js';
import { clampRangeEnd, pagesLabel } from './page-scope.js';
import { pageBoxKey } from './reader/PdfPageBar.jsx';

/* 连问后面几页 (#488): one page stays the main path; this is one quiet link beside the scope. It opens one box, the last page, applied on Enter or when it is left like the
   page box of PdfPageBar; turning the page ends the range (the viewer holds it for the page it was made on). The limit is said when it changed what was typed. */
export default function PageRange({ scope, total = 0, onRange }) {
  const [open, setOpen] = useState(false), [draft, setDraft] = useState(''), [note, setNote] = useState('');
  useEffect(() => { setOpen(false); setNote(''); }, [scope.page]);
  useEffect(() => { if (scope.to) setDraft(String(scope.to)); }, [scope.to]);
  if (!onRange || (!scope.to && total && total <= scope.page)) return null;
  const only = () => { setOpen(false); setNote(''); onRange(0); };
  if (!open && !scope.to) return <Button variant="link" size="sm" className="study-page-ask__range-open" onClick={() => { setDraft(String(scope.page + 1)); setOpen(true); }}>{ui('连问后面几页')}</Button>;
  const apply = () => {
    const end = clampRangeEnd(draft, scope.page, total);
    if (end === null) { setDraft(String(scope.to || scope.page + 1)); return; }
    setDraft(String(end.to));
    setNote(end.cut ? uiFormat('一次最多问 {0} 页，已改成第 {1} 页。', [PAGE_RANGE_MAX, pagesLabel({ page: scope.page, to: end.to })]) : '');
    onRange(end.to > scope.page ? end.to : 0);
  };
  return <div className="study-page-ask__range">
    <span>{ui('问到第几页')}</span>
    <NumberInput inputMode="numeric" min={scope.page} max={total || undefined} step={1} value={draft} className="reader-pdf-bar__input" aria-label={ui('问到第几页')}
      onChange={event => setDraft(event.target.value)} onBlur={apply} onKeyDown={event => pageBoxKey(event, { apply, reset: () => setDraft(String(scope.to || scope.page + 1)) })} />
    <Button variant="link" size="sm" onClick={only}>{ui('只问这一页')}</Button>
    {note && <span className="muted study-page-ask__range-note" role="status">{note}</span>}
  </div>;
}
