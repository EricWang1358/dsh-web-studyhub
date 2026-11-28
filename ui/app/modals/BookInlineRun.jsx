import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ui } from '../../i18n.js';
import { StudyServicesContext, useStudy } from '../../study-context.jsx';
import { useReviewSession } from '../../review/useReviewSession.js';
import InlineRun from '../../review/InlineRun.jsx';
import FlagDialog from './FlagDialog.jsx';
import ShortcutHelp from '../../ShortcutHelp.jsx';
import { qaToNoteArgs } from '../../review/question-note.js';
import { useApp } from '../app-context.js';

const PAGE = 'book-inline', HIDDEN = 'book-inline:hidden';
const NO_HOST = Object.freeze({});

/**
 * In-place checkpoint round rendered directly inside a Review Book point (`PointBody`),
 * using the app's real `useReviewSession({ embeddedIn: 'book-inline' })` + `InlineRun`.
 * Keeps a calm veil over the point's own explanation prose while the learner is answering
 * (`data-book-inline-answering`) and lifts as soon as the card is revealed, answered, or completed.
 */
export default function BookInlineRun({ started, origin = null, label, onClose, shown = true }) {
  const { core, nav, intents, lib, set, data, settingsEntry, learn } = useApp();
  const study = useStudy();
  const rootRef = useRef(null), late = useRef({});
  const [flagging, setFlagging] = useState(false);
  const bookNav = useMemo(() => ({ page: shown ? PAGE : HIDDEN, setPage: () => {}, show: nav.show }), [nav.show, shown]);
  const session = useReviewSession({ core, nav: bookNav, modalOpen: !shown || !!lib?.modal || !!lib?.startConfirm || flagging, host: NO_HOST, rootRef, late, embeddedIn: PAGE });
  const { enterRun, shortcutHelp, actions: { closeShortcutHelp } } = session;
  const helpOpen = shown && shortcutHelp;
  useEffect(() => { if (!shown) closeShortcutHelp(); }, [shown, closeShortcutHelp]);
  const shownWas = useRef(shown);
  useEffect(() => {
    if (shown && !shownWas.current && session.run) rootRef.current?.focus?.({ preventScroll: true });
    shownWas.current = shown;
  }, [shown]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { enterRun(started); }, [started]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!helpOpen) return undefined;
    const onKey = (event) => { if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); closeShortcutHelp(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [helpOpen, closeShortcutHelp]);
  const runRef = useRef(null);
  runRef.current = session.run || started;
  const continueThere = useCallback(async () => {
    const opened = await intents.openRun(runRef.current.id);
    if (opened && origin) learn.rememberContext(origin);
    return !!opened;
  }, [intents, learn, origin]);
  const openModal = useCallback((modal) => {
    if (modal?.type === 'flag') { setFlagging(true); return; }
    if (modal?.type === 'source') { set.setModal({ ...modal, back: true }); return; }
    continueThere().then((opened) => { if (opened && modal) set.setModal(modal); });
  }, [continueThere, set]);
  const services = useMemo(() => ({ ...study, openModal }), [study, openModal]);
  const decks = data?.decks;
  const links = useMemo(() => ({
    onModelSettings: () => { settingsEntry.openModelSettings(); },
    onSaveQaToNote: (followupId) => core.act('note.qa.add', qaToNoteArgs(runRef.current, followupId, decks), undefined, { rethrow: true }),
    onOpenNote: (noteId) => { learn.openLearningTarget({ kind: 'note', id: noteId }); },
  }), [settingsEntry, core, learn, decks]);
  const activeRun = session.run || started;
  const answering = Boolean(shown && activeRun && !activeRun.complete && !session.showBack && !activeRun.revealed && !activeRun.feedback);
  return (
    <div className="book-point__inline-run" data-book-inline-answering={answering ? '' : undefined}>
      <StudyServicesContext.Provider value={services}>
        <InlineRun session={session} data={data} label={label} rootRef={rootRef} backLabel={ui('收起自测')} onClose={onClose} onOpenRun={continueThere} links={links} feedback={null} />
        {flagging && session.run?.card && <FlagDialog run={session.run} onClose={() => setFlagging(false)} onUpdated={(nextFlag) => session.patchRun?.((prev) => (prev?.card?.id === session.run?.card?.id ? { ...prev, card: { ...prev.card, flag: nextFlag || undefined } } : prev))} />}
        {helpOpen && <ShortcutHelp page="review" onClose={closeShortcutHelp} />}
      </StudyServicesContext.Provider>
    </div>
  );
}
