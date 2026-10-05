import { useCallback, useEffect } from 'react';
import { ui } from '../i18n.js';
import { hasUnsavedDraft } from '../draft-editor.js';
import { browserSession, readJSON, removeKey, writeJSON } from '../storage.js';
import { topUpArgs, topUpNotice } from '../coverage/top-up.js';

/* The draft the learner is editing, and the copy of it this window keeps in sessionStorage so a reload offers it back
   (the 有本窗口暂存的编辑 banner). The draft itself is part of the library state; this is its editing verbs. */
const recoveryKey = (root) => `study-draft:${root}`;

export function useDrafts({ core, lib, nav, data }) {
  const { act, notify } = core;
  const { draft, draftLoaded, draftText, jsonMode } = lib.state;
  const { setDraft, setDraftLoaded, setDraftText, setJsonMode, setRecovery } = lib.set;
  const root = data?.root;
  useEffect(() => {
    if (!root) return;
    const saved = readJSON(recoveryKey(root), null, browserSession());
    // hasUnsavedDraft reads inside the stash, so anything that is not one (nothing stored, a damaged value) is simply nothing to offer.
    const keep = !!saved && typeof saved === 'object' && hasUnsavedDraft(saved);
    if (!keep) removeKey(recoveryKey(root), browserSession());
    setRecovery(keep ? saved : null);
  }, [root, setRecovery]);
  useEffect(() => {
    if (!root || !draft) return;
    const saved = { draft, draftText, jsonMode, draftLoaded };
    const keep = hasUnsavedDraft(saved);
    const ok = keep ? writeJSON(recoveryKey(root), saved, browserSession()) : removeKey(recoveryKey(root), browserSession());
    if (!ok) { notify({ text: ui('浏览器暂存不可用，请及时保存草稿。'), persistent: true }); return; }
    setRecovery(keep ? saved : null);
  }, [root, draft, draftText, jsonMode, draftLoaded, notify, setRecovery]);

  const openDraft = useCallback((next, { navigation = false } = {}) => {
    setDraft(structuredClone(next));
    setDraftLoaded(JSON.stringify(next));
    setDraftText(JSON.stringify(next, null, 2));
    setJsonMode(false);
    if (navigation) nav.navigate('draft'); else nav.setPage('draft');
  }, [nav, setDraft, setDraftLoaded, setDraftText, setJsonMode]);
  /* The one 补题 action (为没覆盖的部分补题), for the home card, the draft page and the 任务 console alike: it covers the sections that have no question, into the same draft. */
  const topUpDraft = useCallback((target, sectionIds) => act('generate', topUpArgs(target, sectionIds), (job) => notify(topUpNotice(target, job))), [act, notify]);
  const blankCard = useCallback(() => ({
    id: crypto.randomUUID(), kind: 'flashcard', topic: '', objective: '', prompt: '', answer: '', hint: '', explanation: '', misconception: '',
    citations: [{ sourceId: core.refs.dataRef.current?.sources[0]?.id || '', quote: '' }],
  }), [core.refs]);
  const patchCard = useCallback((index, key, value) => setDraft((current) => ({
    ...current, cards: current.cards.map((card, at) => (at === index ? { ...card, [key]: value } : card)),
  })), [setDraft]);
  const clearRecovery = useCallback(() => {
    if (root) removeKey(recoveryKey(root), browserSession());
    setRecovery(null);
    setDraft(null);
  }, [root, setRecovery, setDraft]);
  /** Put the stashed edit back and open it. */
  const restoreRecovery = useCallback((saved) => {
    setDraft(saved.draft);
    setDraftLoaded(saved.draftLoaded || JSON.stringify(core.refs.dataRef.current?.drafts.find((item) => item.id === saved.draft.id) || saved.draft));
    setDraftText(saved.draftText);
    setJsonMode(saved.jsonMode);
    nav.navigate('draft');
  }, [core.refs, nav, setDraft, setDraftLoaded, setDraftText, setJsonMode]);
  /** A new, empty flashcard deck to write by hand. */
  const createManual = useCallback(() => openDraft({ id: crypto.randomUUID(), title: ui('新建闪卡题组'), cards: [blankCard()] }, { navigation: true }), [openDraft, blankCard]);
  return { openDraft, topUpDraft, blankCard, patchCard, clearRecovery, restoreRecovery, createManual };
}
