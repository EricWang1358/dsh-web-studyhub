import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ActionFeedback from '../../ActionFeedback.jsx';
import { StudyServicesContext, useStudy } from '../../study-context.jsx';
import { useReviewSession } from '../../review/useReviewSession.js';
import InlineRun from '../../review/InlineRun.jsx';
import FlagDialog from './FlagDialog.jsx';
import ShortcutHelp from '../../ShortcutHelp.jsx';
import { useApp } from '../app-context.js';

/* The round of the reader's 本节题目 (#1013), answered in the reader: a second practice session of the app (useReviewSession with `embeddedIn`), so the
   question, its keys and every step are the practice page's, and the run is an ordinary run (review.start with the arguments of 做这几页的题). Nothing of
   the page under the reader moves: the session never navigates, and the app's own session (the practice page's) is not touched.

   What leaves the reader goes through one way: 去练习页继续 opens the same round on the practice page (its way back to the reading place is on the run).
   The question's own dialogs are this round's: ⚑ marks this question; a source link (看原文, a citation, a figure's page, the question's page) shows its own place in this reader (`onSeek(link)`, true when it is in it); any other
   dialog opens over the practice page with this round on it, as from the practice page itself.

   While the panel is not on screen (`shown` false: a narrow window's Esc hides it, the round staying as it was) the session is not on its page: no key
   reaches the round, nothing is polled, nothing advances by itself. ? shows the round's keys; one Esc closes that sheet before anything else. */

const PAGE = 'reader-run', HIDDEN = 'reader-run:hidden';
const NO_HOST = Object.freeze({});

/** started: the run review.start (or the move to the question clicked) answered; label: what is practised; onClose(); onSeek({ source, quote, peekPage }) -> boolean;
    shown: the panel holding the round is on screen. */
export default function ReaderRun({ started, label, onClose, onSeek, shown = true }) {
  const { core, nav, intents, set, data, host, settingsEntry } = useApp();
  const study = useStudy();
  const rootRef = useRef(null), late = useRef({});
  const readerNav = useMemo(() => ({ page: shown ? PAGE : HIDDEN, setPage: () => {}, show: nav.show }), [nav.show, shown]);
  const session = useReviewSession({ core, nav: readerNav, modalOpen: !shown, host: NO_HOST, rootRef, late, embeddedIn: PAGE });
  const { enterRun, shortcutHelp, actions: { closeShortcutHelp } } = session;
  const helpOpen = shown && shortcutHelp;
  useEffect(() => {
    if (!helpOpen) return undefined;
    // Before the reader's own Esc (it hides the panel on a narrow window, closes the reader on a wide one): the sheet is the top layer.
    const onKey = (event) => { if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); closeShortcutHelp(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [helpOpen, closeShortcutHelp]);
  useEffect(() => { enterRun(started); }, [started]); // eslint-disable-line react-hooks/exhaustive-deps -- each round handed in is entered once
  const runRef = useRef(null);
  runRef.current = session.run || started;
  // The practice page takes the round first; the reader gives way only to a round opened there (else the round stays here, with what went wrong).
  const continueThere = useCallback(async () => {
    const opened = await intents.openRun(runRef.current.id);
    if (opened) set.setModal(null);
    return !!opened;
  }, [intents, set]);
  const [flagging, setFlagging] = useState(false);
  const openModal = useCallback((modal) => {
    if (modal?.type === 'flag') { setFlagging(true); return; }
    if (modal?.type === 'source' && onSeek?.(modal)) return;
    continueThere().then(opened => { if (opened && modal) set.setModal(modal); });
  }, [continueThere, onSeek, set]);
  const services = useMemo(() => ({ ...study, openModal }), [study, openModal]);
  // The model settings open beside the reader when the host has them; otherwise the reader gives way to the Settings page (as SourceReaderDialog does).
  const links = useMemo(() => ({ onModelSettings: () => { if (!host.openModelSettings) set.setModal(null); settingsEntry.openModelSettings(); } }), [host, set, settingsEntry]);
  const feedback = core.error ? <ActionFeedback error={core.error} onCloseError={() => core.setError('')} /> : null;
  return (
    <StudyServicesContext.Provider value={services}>
      <InlineRun session={session} data={data} label={label} rootRef={rootRef} onClose={onClose} onContinue={continueThere} links={links} feedback={feedback} />
      {flagging && session.run?.card && <FlagDialog run={session.run} onClose={() => setFlagging(false)} />}
      {helpOpen && <ShortcutHelp page="review" onClose={closeShortcutHelp} />}
    </StudyServicesContext.Provider>
  );
}
