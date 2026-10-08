import { useCallback, useEffect } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { hasUnsavedDraft } from '../draft-editor.js';
import { browserSession, readJSON, removeKey, writeJSON } from '../storage.js';
import { topUpArgs, topUpNotice } from '../coverage/top-up.js';

/* The draft the learner is editing, and the copy of it this window keeps in sessionStorage so a reload offers it back
   (the 有本窗口暂存的编辑 banner). The draft itself is part of the library state; this is its editing verbs. */
const recoveryKey = (root) => `study-draft:${root}`;

/**
 * 发布并练习, the one quick publication: save the draft as it is on the page (`save`, default; the finished card has nothing to save), publish it with draft.publish.quick (into `intoDeck` when the
 * draft is the next part of a deck), and start the new questions of the deck; with no new question to start the learner is told and lands on the library. The draft page's 保存并发布 and the finished
 * card's 发布并练习 both call this, so there is one sequence and one set of words. `call`/`act` are the app's (ui/study-context.jsx), `toast` the app's toast; the follow-up work runs even if the
 * learner has left the page (afterNavigation), and only its UI effects are skipped then.
 */
export async function publishAndPractice({ call, act, toast, draft, intoDeck, save = true, openDraft, clearRecovery, enterRun, setPage }) {
  const publishArgs = (target) => ({ id: target.id, draftVersion: target.draftVersion, ...(intoDeck ? { mergeTargetId: intoDeck } : {}) });
  const practise = async (published, { isCurrent = () => true } = {}) => {
    if (isCurrent()) clearRecovery?.();
    try {
      const run = await call('review.start', { deckId: published.id, mode: 'new', count: 10, ordered: true, fresh: true });
      if (isCurrent()) {
        enterRun?.(run);
        toast?.success(uiFormat('已发布，开始学习本轮 {0} 道新题。', [run.total]));
      }
    } catch {
      if (isCurrent()) {
        setPage?.('library');
        toast?.success(ui('题组已发布；当前没有可开始的新题。'));
      }
    }
  };
  if (!save) return act('draft.publish.quick', publishArgs(draft), practise, { afterNavigation: true });
  return act('draft.save', { deck: draft }, async (saved, context = {}) => {
    if ((context.isCurrent ?? (() => true))()) openDraft?.(saved);
    await practise(await call('draft.publish.quick', publishArgs(saved)), context);
  }, { afterNavigation: true });
}

export function useDrafts({ core, lib, nav, data, session }) {
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
  /** 发布并练习 from the finished card of a run: the quick publication of the draft as it is (nothing to save), then the new questions. The stash of the page is dropped only when it is this draft's. */
  const publishDraft = useCallback((target, { intoDeck } = {}) => publishAndPractice({ call: core.call, act: core.act, toast: core.toast, draft: target, intoDeck, save: false,
    clearRecovery: () => { if (draft?.id === target.id) clearRecovery(); }, enterRun: session?.enterRun, setPage: nav.navigate }), [core, session, nav, draft, clearRecovery]);
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
  return { openDraft, topUpDraft, publishAndPractice: publishDraft, blankCard, patchCard, clearRecovery, restoreRecovery, createManual };
}
