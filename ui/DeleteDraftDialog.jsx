import React from 'react';
import { ConfirmDialog, InlineMessage } from './components/index.js';
import { ui, uiFormat } from './i18n.js';
import { useStudy } from './study-context.jsx';
import { isActiveJob } from './job-visibility.js';
import { JOB_TYPES } from '../lib/job-status.js';
import { draftPartTitle, partTargets } from './DraftPart.jsx';

/* 删除草稿 from the draft page and from a 待发布 row: the one question for both (ui/DESIGN.md Confirmations). A draft holds questions the model already wrote
   (and that cost tokens) but that nobody published yet, so it is asked once, in this dialog, and never by swapping a button's label. The trigger says 删除; the
   dialog says 永久删除, because this one cannot be taken back.
   What it says is what the host does (lib/contexts/bank/operations.js draft.delete, lib/runtime/builtins.js):
   - a new draft: its unpublished questions go; the materials stay;
   - an edit of a published deck (deck.edit, a repair, a merge into a deck: lib/bank-import.js `retained`): only the unpublished changes go; the deck and its
     published questions stay;
   - a job that writes the draft (a generation, a repair) is stopped by the deletion; a publication check that is running makes the host REFUSE it, so the
     confirm waits (disabled, with the reason) instead of promising that anything stops.
   The deletion carries the draft's version: a draft changed elsewhere since it was shown is not deleted, and the dialog says why. onDeleted() runs after the host
   deleted it. `data`: the snapshot (jobs, decks) the facts are read from. */
export function draftDeleteFacts(draft, data = {}) {
  const jobs = (data.jobs || []).filter((job) => job.draftId === draft.id && isActiveJob(job));
  const publishing = jobs.some((job) => job.type === JOB_TYPES.DRAFT_PUBLISH);
  const working = jobs.some((job) => job.type !== JOB_TYPES.DRAFT_PUBLISH);
  const retainedId = draft.editingDeckId || draft.editorial?.repairOfDeckId || draft.mergeTargetId || '';
  const deck = retainedId ? (data.decks || []).find((item) => item.id === retainedId) || null : null;
  const name = draftPartTitle(partTargets(draft, data)) || draft.title || ui('未命名草稿');
  const count = Array.isArray(draft.cards) ? draft.cards.length : 0;
  return { name, count, publishing, working, retained: !!retainedId, deckTitle: deck?.title || draft.title || '', deckCount: deck ? (deck.count ?? deck.cards?.length ?? 0) : null };
}

export default function DeleteDraftDialog({ draft, data, onClose, onDeleted }) {
  const { act } = useStudy();
  const facts = draftDeleteFacts(draft, data);
  async function confirm() {
    const done = await act('draft.delete', { id: draft.id, draftVersion: draft.draftVersion }, undefined, { rethrow: true });
    if (done === undefined) throw new Error(ui('另一个操作还在进行，请稍后重试。'));
  }
  const goes = facts.retained ? uiFormat('会删除：对「{0}」还没发布的修改，删除后不能撤销。', [facts.deckTitle])
    : facts.count === 1 ? ui('会删除：这份草稿里还没发布的 1 道题，删除后不能撤销。') : uiFormat('会删除：这份草稿里还没发布的 {0} 道题，删除后不能撤销。', [facts.count]);
  const stays = !facts.retained ? ui('会保留：出题用的资料，以及已经发布的题组。')
    : facts.deckCount === null ? uiFormat('会保留：题组「{0}」和它已发布的题，以及出题用的资料。', [facts.deckTitle])
      : uiFormat('会保留：题组「{0}」和它已发布的 {1} 道题，以及出题用的资料。', [facts.deckTitle, facts.deckCount]);
  return (
    <ConfirmDialog title={uiFormat('永久删除草稿「{0}」？', [facts.name])} confirmLabel={ui('永久删除草稿')} cancelLabel={ui('保留')} blocked={facts.publishing}
      onConfirm={confirm} onDone={() => onDeleted?.(draft)} onClose={onClose}>
      <p data-draft-delete="goes">{goes}</p>
      <p data-draft-delete="stays">{stays}</p>
      {facts.working && !facts.publishing && <p data-draft-delete="stops">{ui('正在为这份草稿工作的任务会停止。')}</p>}
      {facts.publishing && <InlineMessage tone="info" data-draft-delete="waits">{ui('这份草稿正在后台做发布检查，检查结束后才能删除。')}</InlineMessage>}
    </ConfirmDialog>
  );
}
