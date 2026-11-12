import React, { useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button } from '../components/index.js';

/* The two steps after a passage of 今日 「重读 N 段」 (#1018), beside its quote in the reader: 已重读 (keeps the time on the mark and goes on to the
   next passage) and 再练这一节 (the questions of the section being read, the same run as the reader's 做这几页的题). reread: { position, total, onDone }.
   onPractise: null when the section has no question to practise. */
export default function RereadBar({ reread, onPractise }) {
  const [working, setWorking] = useState(false);
  const done = async () => {
    if (working) return;
    setWorking(true);
    try { await reread.onDone(); } finally { setWorking(false); }
  };
  return (
    <div className="reader-reread" role="group" aria-label={ui('重读')}>
      {reread.total > 1 && <span className="reader-reread__count">{uiFormat('第 {0} / {1} 段', [reread.position, reread.total])}</span>}
      <Button variant="secondary" size="sm" icon="check" lock={working} data-reread="done" onClick={done}>{ui('已重读')}</Button>
      {onPractise && <Button variant="quiet" size="sm" data-reread="practise" onClick={onPractise}>{ui('再练这一节')}</Button>}
    </div>
  );
}
