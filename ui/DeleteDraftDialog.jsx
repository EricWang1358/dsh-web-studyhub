import React from 'react';
import { ConfirmDialog } from './components/index.js';
import { ui, uiFormat } from './i18n.js';
import { useStudy } from './study-context.jsx';

/* 删除草稿 from the draft page and from a 待发布 row: the one question for both (ui/DESIGN.md Confirmations). A draft holds questions the model already wrote
   (and that cost tokens) but that nobody published yet, so it is asked once, in this dialog, and never by swapping a button's label. It says what goes (the
   unpublished questions, for good), what stays (the materials they came from, every published deck) and, when something is working on the draft, that it
   stops. The deletion carries the draft's version: a draft changed elsewhere since it was shown is not deleted, and the dialog says why. `running`: a job
   works on the draft now. The write is the app's act() (useStudy). onDeleted() runs after the host deleted it. */
export default function DeleteDraftDialog({ draft, running = false, onClose, onDeleted }) {
  const { act } = useStudy();
  const count = Array.isArray(draft.cards) ? draft.cards.length : 0;
  async function confirm() {
    const done = await act('draft.delete', { id: draft.id, draftVersion: draft.draftVersion }, undefined, { rethrow: true });
    if (done === undefined) throw new Error(ui('另一个操作还在进行，请稍后重试。'));
  }
  return (
    <ConfirmDialog title={uiFormat('永久删除草稿「{0}」？', [draft.title || ui('未命名草稿')])} confirmLabel={ui('永久删除草稿')} cancelLabel={ui('保留')}
      onConfirm={confirm} onDone={() => onDeleted?.(draft)} onClose={onClose}>
      <p data-draft-delete="goes">{count === 1 ? ui('会删除：这份草稿里还没发布的 1 道题，删除后不能撤销。') : uiFormat('会删除：这份草稿里还没发布的 {0} 道题，删除后不能撤销。', [count])}</p>
      <p data-draft-delete="stays">{ui('会保留：出题用的资料，以及已经发布的题组。')}</p>
      {running && <p data-draft-delete="stops">{ui('正在为这份草稿工作的任务会停止。')}</p>}
    </ConfirmDialog>
  );
}
