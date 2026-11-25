import React, { useId, useState } from 'react';
import { ui } from '../../i18n.js';
import { Button, Dialog, Field, TextArea } from '../../components/index.js';
import { useStudy } from '../../study-context.jsx';

/** 标记这道题: a reason for the card, kept as a reminder. Existing flags load into the box and can be updated or cleared explicitly. */
export default function FlagDialog({ run, onClose, onUpdated }) {
  const { act, busy, notify } = useStudy();
  const existing = typeof run?.card?.flag === 'string' ? run.card.flag : '';
  const [reason, setReason] = useState(existing);
  const form = useId();
  const trimmed = reason.trim();
  const submitFlag = (nextReason) => {
    act('card.flag', { deckId: run.deckId, cardId: run.card.id, reason: nextReason }, () => {
      onUpdated?.(nextReason);
      onClose();
      notify(nextReason ? ui('题目已标记，下轮优先复习') : ui('题目标记已清除'));
    });
  };
  const save = (event) => {
    event.preventDefault();
    if (!trimmed) return;
    submitFlag(trimmed);
  };
  return (
    <Dialog title={ui('标记这道题')} size="md" busy={busy} onClose={onClose}
      footer={<>
        {existing && <Button variant="secondary" lock={busy} onClick={() => submitFlag('')}>{ui('清除标记')}</Button>}
        <Button type="submit" form={form} variant="primary" disabled={!trimmed} busy={busy}>{ui('保存标记')}</Button>
      </>}>
      <form id={form} onSubmit={save}>
        <Field width="full" label={ui('问题或需要回顾的地方')} hint={existing ? ui('修改后点「保存标记」更新，或点「清除标记」移除。') : ui('写下需要核对或回顾的原因。')}>
          <TextArea value={reason} maxLength={1000} autoFocus onChange={(event) => setReason(event.target.value)} placeholder={ui('例如：干扰项似乎也成立，需要核对原文')} />
        </Field>
      </form>
    </Dialog>
  );
}
