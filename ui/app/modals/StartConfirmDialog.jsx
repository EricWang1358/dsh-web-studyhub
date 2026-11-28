import React, { useEffect } from 'react';
import { ui, uiFormat } from '../../i18n.js';
import ConfirmDialog from '../../components/ConfirmDialog.jsx';
import { useStudy } from '../../study-context.jsx';
import { resumableRunForStart } from '../use-intents.js';

/* The question before a start (intents.confirmStart, ui/app/use-intents.js). No question count: review.start pulls unlearned prerequisites into the
   round, which the snapshot does not tell, so a row's number is not always what its round holds. A dialog left over from another library is closed. */
const START_TITLES = {
  deck: (name) => uiFormat('开始练「{0}」？', [name]),
  topic: (name) => uiFormat('开始练主题「{0}」？', [name]),
  today: () => ui('开始今日学习？'),
};

export default function StartConfirmDialog({ confirm, onClose, data }) {
  const { busy } = useStudy();
  const root = data?.root;
  const stale = confirm.root !== root;
  useEffect(() => { if (stale) onClose(); }, [stale, onClose]);
  if (stale) return null;
  const resumable = resumableRunForStart(confirm.ask, data);
  const title = resumable ? ui('继续未完成的练习？') : START_TITLES[confirm.ask.kind](confirm.ask.name);
  const confirmLabel = resumable ? ui('继续学习') : ui('开始练习');
  const body = resumable
    ? <p>{ui('刚有了一组未完成的练习，确认后会接着这组练，不会新开一轮。')}</p>
    : confirm.ask.kind === 'today' ? <p>{ui('现在没有没做完的练习。')}</p> : null;
  // The start is not awaited: the dialog closes at once and the round opens as it does from any start button. While another write runs the start would be dropped, so it waits.
  return (
    <ConfirmDialog className="confirm-start" tone="primary" title={title} confirmLabel={confirmLabel} blocked={busy}
      onConfirm={() => { confirm.start(); }} onClose={onClose}>
      {body}
    </ConfirmDialog>
  );
}
