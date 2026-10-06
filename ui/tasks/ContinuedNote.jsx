import React from 'react';
import { ui } from '../i18n.js';
import { Button } from '../components/index.js';
import { useApp } from '../app/app-context.js';

/* A failed or stopped run that was continued (接着做) stays in the list as it ended: its numbers do not move and its buttons are gone. This is where it says so, in the row of 即时控制, with the way to the
   task that continued it (lib/job-contract.js `continuedBy`; the one place that knows is the executor, which marks the record when the continuation starts). */
export default function ContinuedNote({ contract }) {
  const { nav } = useApp();
  return (
    <div className="tc-controls" role="note" aria-label={ui('接着做过了')} data-continued="true">
      <span className="tc-controls__title">{ui('接着做过了')}</span>
      <span className="tc-controls__idle">{ui('这次已经接着做了：数字停在当时的样子，新的进度在接着做的那个任务里。')}</span>
      {nav?.show?.task && <Button size="sm" variant="quiet" onClick={() => nav.show.task(contract.continuedBy)}>{ui('看接着做的任务')}</Button>}
    </div>
  );
}
