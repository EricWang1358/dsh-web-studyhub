import { useCallback, useEffect } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { hasUnsavedDraft } from '../draft-editor.js';
import { browserSession, readJSON, removeKey, writeJSON } from '../storage.js';

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
  /* The one 补题 action, for the home card and the draft page alike: it generates only the missing questions into the same draft. */
  const continueDraft = useCallback((target) => act('generate', { resumeDraftId: target.id, draftVersion: target.draftVersion }, (job) =>
    notify(uiFormat('已开始补齐「{0}」剩余 {1} 题；通过检查后会保存到同一份草稿。', [target.title, job.missing]))), [act, notify]);
  /* 用未覆盖的资料补题: the same continuation, asked for `count` more questions from `sourceIds`, added to the same draft. */
  const addFromSources = useCallback((target, sourceIds, count) => act('generate', { resumeDraftId: target.id, draftVersion: target.draftVersion, extraSourceIds: sourceIds, count }, () =>
    notify(uiFormat('已开始为「{0}」补题：用未覆盖的资料追加约 {1} 题；通过检查后会保存到同一份草稿。', [target.title, count]))), [act, notify]);
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
  return { openDraft, continueDraft, addFromSources, blankCard, patchCard, clearRecovery, restoreRecovery, createManual };
}
