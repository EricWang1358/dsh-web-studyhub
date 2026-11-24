import { useCallback, useEffect } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { hasUnsavedDraft } from '../draft-editor.js';
import { browserSession, readJSON, removeKey, writeJSON } from '../storage.js';
import { topUpArgs, topUpNotice } from '../coverage/top-up.js';
import { freshRoundCount } from '../../lib/practice-settings.js';

/* The draft the learner is editing, and the copy of it this window keeps in sessionStorage so a reload offers it back
   (the 有本窗口暂存的编辑 banner). The draft itself is part of the library state; this is its editing verbs. */
const recoveryKey = (root) => `study-draft:${root}`;

/** Read the per-draft recovery map (backwards compatible with legacy single-slot entries). */
export function readRecoveryMap(root, storage = browserSession()) {
  if (!root) return {};
  const raw = readJSON(recoveryKey(root), null, storage);
  if (!raw || typeof raw !== 'object') return {};
  if (raw.version === 2 && raw.byId && typeof raw.byId === 'object') {
    const clean = {};
    for (const [id, entry] of Object.entries(raw.byId)) {
      if (entry && typeof entry === 'object' && hasUnsavedDraft(entry)) clean[id] = entry;
    }
    return clean;
  }
  if (raw.draft?.id && hasUnsavedDraft(raw)) return { [raw.draft.id]: raw };
  return {};
}

function writeRecoveryMap(root, map, activeId, storage = browserSession()) {
  const ids = Object.keys(map);
  if (!ids.length) return removeKey(recoveryKey(root), storage);
  const resolvedActive = activeId && map[activeId] ? activeId : ids[ids.length - 1];
  return writeJSON(recoveryKey(root), { version: 2, activeId: resolvedActive, byId: map }, storage);
}

/** Store or update one draft's unsaved stash without overwriting other drafts' stashes. */
export function putDraftStash(root, saved, storage = browserSession()) {
  const id = saved?.draft?.id;
  if (!root || !id) return true;
  const map = readRecoveryMap(root, storage);
  if (hasUnsavedDraft(saved)) map[id] = saved;
  else delete map[id];
  return writeRecoveryMap(root, map, id, storage);
}

/** Remove only the named draft's stash, leaving other drafts' stashes intact. */
export function dropDraftStash(root, draftId, storage = browserSession()) {
  if (!root || !draftId) return true;
  const map = readRecoveryMap(root, storage);
  if (!Object.hasOwn(map, draftId)) return true;
  delete map[draftId];
  return writeRecoveryMap(root, map, null, storage);
}

/** Pick the latest remaining recovery entry across stashed drafts (preferring activeId). */
export function latestRecovery(root, storage = browserSession()) {
  if (!root) return null;
  const raw = readJSON(recoveryKey(root), null, storage);
  const map = readRecoveryMap(root, storage);
  if (raw?.version === 2 && raw.activeId && map[raw.activeId]) return map[raw.activeId];
  const entries = Object.values(map);
  return entries.length ? entries[entries.length - 1] : null;
}

/** Return the stashed unsaved copy of `target` if one exists in this tab's recovery map. */
export function pickRecoveryFor(root, target, storage = browserSession()) {
  if (!root || !target?.id) return null;
  const entry = readRecoveryMap(root, storage)[target.id];
  return entry && hasUnsavedDraft(entry) ? entry : null;
}

/**
 * 发布并开始练, the one quick publication: save the draft as it is on the page (`save`, default; the finished card has nothing to save), publish it with draft.publish.quick (into `intoDeck` when the
 * draft is the next part of a deck), and start the new questions of the deck; with no new question to start the learner is told and lands on the library. The draft page's 发布并开始练 and the finished
 * card's 发布并开始练 both call this, so there is one sequence and one set of words. `call`/`act` are the app's (ui/study-context.jsx), `toast` the app's toast; the follow-up work runs even if the
 * learner has left the page (afterNavigation), and only its UI effects are skipped then.
 */
export async function publishAndPractice({ call, act, toast, draft, intoDeck, save = true, openDraft, clearRecovery, enterRun, setPage, practice }) {
  const publishArgs = (target) => ({ id: target.id, draftVersion: target.draftVersion, ...(intoDeck ? { mergeTargetId: intoDeck } : {}) });
  const practise = async (published, { isCurrent = () => true } = {}) => {
    // Always clear the published draft's recovery stash so navigating away never leaves a dead recovery banner.
    clearRecovery?.();
    // If the learner already navigated away while publishing, do not spawn a ghost 0-answered practice run.
    if (!isCurrent()) return;
    try {
      // As many new questions as one round (设置 › 练习, #1009): `practice` is the library's saved practice settings.
      const run = await call('review.start', { deckId: published.id, mode: 'new', count: freshRoundCount(practice), ordered: true, fresh: true });
      if (isCurrent()) {
        enterRun?.(run);
        toast?.success(uiFormat('已发布，开始学习本轮 {0} 道新题。', [run.total]));
      }
    } catch {
      if (isCurrent()) {
        setPage?.('library');
        toast?.success(ui('题组已发布。这次没能自动开始练习，可以在学习库里开始。'));
      }
    }
  };
  if (!save) return act('draft.publish.quick', publishArgs(draft), practise, { afterNavigation: true });
  return act('draft.save', { deck: draft }, async (saved, context = {}) => {
    if ((context.isCurrent ?? (() => true))()) openDraft?.(saved, { skipStash: true });
    await practise(await call('draft.publish.quick', publishArgs(saved)), context);
  }, { afterNavigation: true });
}

export function useDrafts({ core, lib, nav, data, session }) {
  const { act, notify } = core;
  const { draft, draftLoaded, draftText, jsonMode, recovery } = lib.state;
  const { setDraft, setDraftLoaded, setDraftText, setJsonMode, setRecovery } = lib.set;
  const root = data?.root;
  useEffect(() => {
    if (!root) return;
    const saved = latestRecovery(root, browserSession());
    if (!saved) removeKey(recoveryKey(root), browserSession());
    setRecovery(saved);
  }, [root, setRecovery]);
  useEffect(() => {
    if (!root || !draft) return;
    const saved = { draft, draftText, jsonMode, draftLoaded };
    const ok = putDraftStash(root, saved, browserSession());
    if (!ok) { notify({ text: ui('浏览器暂存不可用，请及时保存草稿。'), persistent: true }); return; }
    setRecovery(hasUnsavedDraft(saved) ? saved : latestRecovery(root, browserSession()));
  }, [root, draft, draftText, jsonMode, draftLoaded, notify, setRecovery]);

  const openDraft = useCallback((next, { navigation = false, skipStash = false } = {}) => {
    if (skipStash && root && next?.id) {
      dropDraftStash(root, next.id, browserSession());
      setRecovery(latestRecovery(root, browserSession()));
    }
    // Re-opening a draft that already has unsaved edits in this tab restores those edits instead of wiping them.
    const stashed = !skipStash ? pickRecoveryFor(root, next, browserSession()) : null;
    if (stashed) {
      setDraft(structuredClone(stashed.draft));
      setDraftLoaded(stashed.draftLoaded || JSON.stringify(next));
      setDraftText(stashed.draftText);
      setJsonMode(!!stashed.jsonMode);
    } else {
      setDraft(structuredClone(next));
      setDraftLoaded(JSON.stringify(next));
      setDraftText(JSON.stringify(next, null, 2));
      setJsonMode(false);
    }
    if (navigation) nav.navigate('draft'); else nav.setPage('draft');
  }, [root, nav, setDraft, setDraftLoaded, setDraftText, setJsonMode, setRecovery]);
  /* The one 补题 action (为没覆盖的部分补题), for the home card, the draft page and the 任务 console alike: it covers the sections that have no question, into the same draft. */
  const topUpDraft = useCallback((target, sectionIds, options) => act('generate', topUpArgs(target, sectionIds, options), (job) => notify((options?.notice ?? topUpNotice)(target, job))), [act, notify]);
  const blankCard = useCallback(() => ({
    id: crypto.randomUUID(), kind: 'flashcard', topic: '', objective: '', prompt: '', answer: '', hint: '', explanation: '', misconception: '',
    citations: [{ sourceId: core.refs.dataRef.current?.sources[0]?.id || '', quote: '' }],
  }), [core.refs]);
  const patchCard = useCallback((index, key, value) => setDraft((current) => ({
    ...current, cards: current.cards.map((card, at) => (at === index ? { ...card, [key]: value } : card)),
  })), [setDraft]);
  const clearRecovery = useCallback((targetId) => {
    const idToDrop = typeof targetId === 'string' && targetId ? targetId : (draft?.id || recovery?.draft?.id);
    if (root && idToDrop) dropDraftStash(root, idToDrop, browserSession());
    else if (root) removeKey(recoveryKey(root), browserSession());
    setRecovery(root ? latestRecovery(root, browserSession()) : null);
    if (!idToDrop || draft?.id === idToDrop) setDraft(null);
  }, [root, draft?.id, recovery?.draft?.id, setRecovery, setDraft]);
  /** A draft deleted from elsewhere (a 待发布 row): the page's copy and the browser stash go when they are that draft's. */
  const forgetDraft = useCallback((id) => {
    if (!id) return;
    if (root) dropDraftStash(root, id, browserSession());
    setRecovery(root ? latestRecovery(root, browserSession()) : null);
    if (draft?.id === id) setDraft(null);
  }, [root, draft?.id, setRecovery, setDraft]);
  /** 发布并开始练 from the finished card of a run: the quick publication of the draft as it is (nothing to save), then the new questions. The stash of the page is dropped only when it is this draft's. */
  const publishDraft = useCallback((target, { intoDeck } = {}) => publishAndPractice({ call: core.call, act: core.act, toast: core.toast, draft: target, intoDeck, save: false,
    practice: core.refs.dataRef.current?.settings?.practice,
    clearRecovery: () => forgetDraft(target.id), enterRun: session?.enterRun, setPage: nav.navigate }), [core, session, nav, forgetDraft]);
  /** Put the stashed edit back and open it. */
  const restoreRecovery = useCallback((saved) => {
    setDraft(saved.draft);
    setDraftLoaded(saved.draftLoaded || JSON.stringify(core.refs.dataRef.current?.drafts.find((item) => item.id === saved.draft.id) || saved.draft));
    setDraftText(saved.draftText);
    setJsonMode(saved.jsonMode);
    nav.navigate('draft');
  }, [core.refs, nav, setDraft, setDraftLoaded, setDraftText, setJsonMode]);
  /** A new, empty flashcard deck to write by hand. */
  const createManual = useCallback(() => openDraft({ id: crypto.randomUUID(), title: ui('新建闪卡题组'), cards: [blankCard()] }, { navigation: true, skipStash: true }), [openDraft, blankCard]);
  return { openDraft, topUpDraft, publishAndPractice: publishDraft, blankCard, patchCard, clearRecovery, forgetDraft, restoreRecovery, createManual };
}
