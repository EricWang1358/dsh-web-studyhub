import React, { useCallback, useState } from 'react';
import { ui, errorMessage } from '../i18n.js';
import { Button, InlineMessage, Switch, Tooltip } from '../components/index.js';
import { useStudy } from '../study-context.jsx';
import { useLiveEffect } from '../use-async.js';

/* 「加入复习全书」 (M3, docs/plans/review-book.md) on a follow-up of a question: one button, the same on the practice page and in a point's 本节问答. It
   calls book.qa.add / book.qa.remove (lib/course-book-qa.js); the card keeps its follow-up either way. Added, it reads 已加入 · 撤回. */

/** What the books hold (book.qa.list): { ids: Set of follow-up ids, courses: Set of courses with a book, ready }, and add / remove that keep it current. */
export function useBookQa() {
  const { call } = useStudy();
  const [state, setState] = useState({ ids: new Set(), courses: new Set(), ready: false });
  useLiveEffect(isLive => {
    call('book.qa.list', {}).then(answer => { if (isLive()) setState({ ids: new Set(answer.followupIds), courses: new Set(answer.courses || []), ready: true }); }, () => {});
  }, [call]);
  const mark = useCallback((id, on) => setState(current => { const ids = new Set(current.ids); if (on) ids.add(id); else ids.delete(id); return { ...current, ids }; }), []);
  const add = useCallback(async ref => { await call('book.qa.add', ref); mark(ref.followupId, true); }, [call, mark]);
  const remove = useCallback(async followupId => { await call('book.qa.remove', { followupId }); mark(followupId, false); }, [call, mark]);
  return { ...state, add, remove };
}

/** refOf: { deckId, cardId, followupId }; book: useBookQa(); onChanged() after an add or a remove (the book page reads the book again). */
export default function BookQaButton({ refOf, book, onChanged }) {
  const [working, setWorking] = useState(false), [error, setError] = useState('');
  const added = book.ids.has(refOf.followupId);
  const run = async () => {
    setWorking(true); setError('');
    try { if (added) await book.remove(refOf.followupId); else await book.add(refOf); onChanged?.(); } catch (failure) { setError(errorMessage(failure)); } finally { setWorking(false); }
  };
  return (
    <span className="book-qa-button">
      <Button variant="link" size="sm" icon={added ? 'check' : 'book'} className="book-qa-button__go" data-book-qa={added ? 'added' : 'add'} disabled={working} onClick={run}>
        {added ? ui('已加入 · 撤回') : ui('加入复习全书')}</Button>
      {error && <InlineMessage tone="error">{error}</InlineMessage>}
    </span>
  );
}

/** The small 自动加入复习全书 switch beside the buttons (the setting of 设置 › 练习, settings.book.qaToBook): mode 'manual' | 'auto'; onChange(mode). */
export function BookQaAuto({ mode, onChange, disabled = false }) {
  return (
    <Tooltip layer content={ui('打开后，之后在这里得到的追问和「帮我弄懂」的回答会自动放进这门课的复习全书；关着时点每条问答旁的「加入复习全书」。已经加进去的不受影响，随时可以撤回。')}>
      <span className="book-qa-auto" tabIndex={-1}>
        <Switch name="qaToBook" label={ui('自动加入复习全书')} checked={mode === 'auto'} disabled={disabled} onChange={on => onChange(on ? 'auto' : 'manual')} />
      </span>
    </Tooltip>
  );
}
