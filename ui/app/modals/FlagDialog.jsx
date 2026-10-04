import React, { useId, useState } from 'react';
import { ui } from '../../i18n.js';
import { Button, Dialog } from '../../components/index.js';
import { useStudy } from '../../study-context.jsx';

/** 标记这道题: a reason for the card, kept as a reminder (an empty reason clears the flag). The save is the dialog footer's one primary action. */
export default function FlagDialog({ run, onClose }) {
  const { act, busy, notify } = useStudy();
  const [reason, setReason] = useState('');
  const form = useId();
  const save = (event) => {
    event.preventDefault();
    act('card.flag', { deckId: run.deckId, cardId: run.card.id, reason }, () => {
      onClose();
      notify(reason ? ui('题目已标记，下轮优先复习') : ui('题目标记已清除'));
    });
  };
  return (
    <Dialog title={ui('标记这道题')} size="md" busy={busy} onClose={onClose}
      footer={<Button type="submit" form={form} variant="primary" busy={busy}>{ui('保存标记')}</Button>}>
      <form id={form} onSubmit={save}>
        <label>{ui('问题或需要回顾的地方')}
          <textarea value={reason} maxLength={1000} autoFocus onChange={(event) => setReason(event.target.value)} placeholder={ui('例如：干扰项似乎也成立，需要核对原文')} />
        </label>
        <p className="muted">{ui('保留空白并保存可清除标记。')}</p>
      </form>
    </Dialog>
  );
}
