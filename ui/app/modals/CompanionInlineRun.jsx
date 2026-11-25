import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ui } from '../../i18n.js';
import { StudyServicesContext, useStudy } from '../../study-context.jsx';
import { useReviewSession } from '../../review/useReviewSession.js';
import InlineRun from '../../review/InlineRun.jsx';
import FlagDialog from './FlagDialog.jsx';
import ShortcutHelp from '../../ShortcutHelp.jsx';
import { qaToNoteArgs } from '../../review/question-note.js';
import { useApp } from '../app-context.js';

/** Builds the opt-in `{ Run, load }` controller handed into `CompanionViewer` from `AppModalHost`. */
export function useCompanionInlinePractice() {
  const { intents } = useApp();
  return useMemo(() => ({
    Run: CompanionInlineRun,
    load: (scope, then) => intents.practice(scope, { fresh: true, then }),
  }), [intents]);
}

const PAGE = 'companion-inline', HIDDEN = 'companion-inline:hidden';
const NO_HOST = Object.freeze({});

/**
 * In-place slide checkpoint rendered inside `CompanionViewer`'s drawer (`embeddedIn: 'companion-inline'`).
 * Blurs any focused stage iframe on mount, intercepts Escape before the outer `<Dialog>` closes the companion,
 * and stays inside the active companion when a card's link targets another slide of the same companion.
 */
export default function CompanionInlineRun({ started, label, companionId, onJumpSlide, onClose, shown = true }) {
  const { core, nav, intents, set, data, settingsEntry, learn } = useApp();
  const study = useStudy();
  const rootRef = useRef(null), late = useRef({});
  const [flagging, setFlagging] = useState(false);
  const compNav = useMemo(() => ({ page: shown ? PAGE : HIDDEN, setPage: () => {}, show: nav.show }), [nav.show, shown]);
  const session = useReviewSession({ core, nav: compNav, modalOpen: !shown || flagging, host: NO_HOST, rootRef, late, embeddedIn: PAGE });
  const { enterRun, shortcutHelp, actions: { closeShortcutHelp } } = session;
  const helpOpen = shown && shortcutHelp;
  useEffect(() => { if (!shown) closeShortcutHelp(); }, [shown, closeShortcutHelp]);
  useEffect(() => {
    enterRun(started);
    if (shown && typeof document !== 'undefined' && document.activeElement?.tagName === 'IFRAME') {
      document.activeElement.blur?.();
    }
  }, [started]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!helpOpen) return undefined;
    const onKey = (event) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault();
        event.stopPropagation();
        closeShortcutHelp();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [helpOpen, closeShortcutHelp]);
  useEffect(() => {
    if (!shown || helpOpen || flagging) return undefined;
    const onKey = (event) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (typeof document !== 'undefined' && document.querySelector('.sh-pop__popup:not([data-closed])')) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest?.('[role=dialog], dialog') && !target.closest('.sh-comp-viewer')) return;
      if (rootRef.current && target?.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"]') && rootRef.current.contains(target)) {
        // Inner Cloze/input blur may omit preventDefault; keep the round & outer dialog open on that Escape.
        event.preventDefault();
        return;
      }
      if (!rootRef.current || (!rootRef.current.contains(target) && target !== document.body && target !== document.documentElement)) return;
      event.preventDefault();
      event.stopPropagation();
      onClose?.();
    };
    window.addEventListener('keydown', onKey, false);
    return () => window.removeEventListener('keydown', onKey, false);
  }, [shown, helpOpen, flagging, onClose]);
  const runRef = useRef(null);
  runRef.current = session.run || started;
  const continueThere = useCallback(async () => {
    const opened = await intents.openRun(runRef.current.id);
    if (opened) set.setModal(null);
    return !!opened;
  }, [intents, set]);
  const openModal = useCallback((modal) => {
    if (modal?.type === 'flag') { setFlagging(true); return; }
    if (modal?.type === 'companion' && (modal.id || modal.companionId) === companionId) {
      if (modal.slide >= 1) onJumpSlide?.(modal.slide);
      return;
    }
    continueThere().then((opened) => { if (opened && modal) set.setModal(modal); });
  }, [companionId, continueThere, onJumpSlide, set]);
  const services = useMemo(() => ({ ...study, openModal }), [study, openModal]);
  const decks = data?.decks;
  const links = useMemo(() => ({
    onModelSettings: () => { if (!study?.host?.openModelSettings) set.setModal(null); settingsEntry.openModelSettings(); },
    onSaveQaToNote: (followupId) => core.act('note.qa.add', qaToNoteArgs(runRef.current, followupId, decks), undefined, { rethrow: true }),
    onOpenNote: (noteId) => { set.setModal(null); learn.openLearningTarget({ kind: 'note', id: noteId }); },
  }), [study?.host?.openModelSettings, settingsEntry, core, learn, decks, set]);
  return (
    <StudyServicesContext.Provider value={services}>
      <InlineRun session={session} data={data} label={label} rootRef={rootRef} backLabel={ui('回到解惑栏')} onClose={onClose} onOpenRun={continueThere} links={links} feedback={null} />
      {flagging && session.run?.card && <FlagDialog run={session.run} onClose={() => setFlagging(false)} onUpdated={(nextFlag) => session.patchRun?.((prev) => (prev?.card?.id === session.run?.card?.id ? { ...prev, card: { ...prev.card, flag: nextFlag || undefined } } : prev))} />}
      {helpOpen && <ShortcutHelp page="review" onClose={closeShortcutHelp} />}
    </StudyServicesContext.Provider>
  );
}
