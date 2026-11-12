import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ActionFeedback from '../../ActionFeedback.jsx';
import { StudyServicesContext, useStudy } from '../../study-context.jsx';
import { useReviewSession } from '../../review/useReviewSession.js';
import InlineRun from '../../review/InlineRun.jsx';
import FlagDialog from './FlagDialog.jsx';
import { useApp } from '../app-context.js';

/* The round of the reader's 本节题目 (#1013), answered in the reader: a second practice session of the app (useReviewSession with `embeddedIn`), so the
   question, its keys and every step are the practice page's, and the run is an ordinary run (review.start with the arguments of 做这几页的题). Nothing of
   the page under the reader moves: the session never navigates, and the app's own session (the practice page's) is not touched.

   What leaves the reader goes through one way: 去练习页继续 opens the same round on the practice page (its way back to the reading place is on the run).
   The question's own dialogs are this round's: ⚑ marks this question; 看原文 shows its passage in this reader (`onSeek(run)`, true when it could); any other
   dialog opens over the practice page with this round on it, as from the practice page itself. */

const PAGE = 'reader-run';
const NO_HOST = Object.freeze({});

/** started: the run review.start (or the move to the question clicked) answered; label: what is practised; onClose(); onSeek(run) -> boolean. */
export default function ReaderRun({ started, label, onClose, onSeek }) {
  const { core, nav, intents, set, data, host, settingsEntry } = useApp();
  const study = useStudy();
  const rootRef = useRef(null), late = useRef({});
  const readerNav = useMemo(() => ({ page: PAGE, setPage: () => {}, show: nav.show }), [nav.show]);
  const session = useReviewSession({ core, nav: readerNav, modalOpen: false, host: NO_HOST, rootRef, late, embeddedIn: PAGE });
  const { enterRun } = session;
  useEffect(() => { enterRun(started); }, [started]); // eslint-disable-line react-hooks/exhaustive-deps -- each round handed in is entered once
  const runRef = useRef(null);
  runRef.current = session.run || started;
  const continueThere = useCallback(() => { const runId = runRef.current.id; set.setModal(null); intents.openRun(runId); }, [intents, set]);
  const [flagging, setFlagging] = useState(false);
  const openModal = useCallback((modal) => {
    if (modal?.type === 'flag') { setFlagging(true); return; }
    if (modal?.type === 'source' && onSeek?.(runRef.current)) return;
    continueThere();
    if (modal) set.setModal(modal);
  }, [continueThere, onSeek, set]);
  const services = useMemo(() => ({ ...study, openModal }), [study, openModal]);
  // The model settings open beside the reader when the host has them; otherwise the reader gives way to the Settings page (as SourceReaderDialog does).
  const links = useMemo(() => ({ onModelSettings: () => { if (!host.openModelSettings) set.setModal(null); settingsEntry.openModelSettings(); } }), [host, set, settingsEntry]);
  const feedback = core.error ? <ActionFeedback error={core.error} onCloseError={() => core.setError('')} /> : null;
  return (
    <StudyServicesContext.Provider value={services}>
      <InlineRun session={session} data={data} label={label} rootRef={rootRef} onClose={onClose} onContinue={continueThere} links={links} feedback={feedback} />
      {flagging && session.run?.card && <FlagDialog run={session.run} onClose={() => setFlagging(false)} />}
    </StudyServicesContext.Provider>
  );
}
