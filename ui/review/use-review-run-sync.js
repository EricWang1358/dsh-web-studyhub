import React from "react";
import { ui } from "../i18n.js";
import { reviewEntryKey } from "../async.js";
import { resolveBookSettings } from "../../lib/book-settings.js";
import { hasCourseBook, qaAddFailureText, useBookQa } from "../book/BookQaButton.jsx";
import { autoAddPlan, seeFollowups } from "../book/qa-auto.js";
import { AUTO_ADVANCE_MS, finishedTask } from "./session-logic.js";

/** Sync Q&A auto-add state and failures with the course book while practicing a question. */
export function useBookQaSync({ run, data, call }) {
  const savedQaToBook = resolveBookSettings(data?.settings?.book).qaToBook;
  const [qaToBookChoice, setQaToBookChoice] = React.useState(null);
  React.useEffect(() => {
    if (qaToBookChoice !== null && qaToBookChoice === savedQaToBook) setQaToBookChoice(null);
  }, [savedQaToBook, qaToBookChoice]);
  const qaToBook = qaToBookChoice ?? savedQaToBook;
  const setQaToBook = React.useCallback((mode) => {
    setQaToBookChoice(mode);
    call("settings.book.set", { patch: { qaToBook: mode } }).catch(() => setQaToBookChoice(null));
  }, [call]);

  const book = useBookQa();
  const bookDeck = data?.decks?.find((deck) => deck.id === run.deckId);
  const bookCourse = bookDeck?.course ?? bookDeck?.folder ?? "";
  const [bookNote, setBookNote] = React.useState("");
  const activeCardKeyRef = React.useRef("");
  const currentCardKey = `${run.id}:${run.index}:${run.card?.id || ""}`;
  activeCardKeyRef.current = currentCardKey;
  React.useEffect(() => { setBookNote(""); }, [currentCardKey]);
  const qaSeen = React.useRef(null);
  const qaTried = React.useRef(new Set());
  const allFollowups = run.solution?.followups ?? run.followups ?? [];
  const followupKey = allFollowups.map((item) => item.id).join("|");
  React.useEffect(() => {
    const seen = seeFollowups(qaSeen.current, reviewEntryKey(run), allFollowups.map((item) => item.id), !!(run.solution || run.followups));
    qaSeen.current = seen.state;
    const expectedKey = currentCardKey;
    for (const id of autoAddPlan({ mode: qaToBook, withBook: book.ready && hasCourseBook(book.courses, bookCourse), fresh: seen.fresh, tried: qaTried.current, added: book.ids })) {
      qaTried.current.add(id);
      book.add({ deckId: run.deckId, cardId: run.card.id, followupId: id })
        .then(() => { if (activeCardKeyRef.current === expectedKey) setBookNote(""); })
        .catch((failure) => {
          if (activeCardKeyRef.current !== expectedKey) return;
          setBookNote(failure?.code === "course-book-rebuild-pending"
            ? qaAddFailureText(failure)
            : failure?.message || ui("没能加入复习全书，可以点「加入复习全书」再试。"));
        });
    }
  }, [followupKey, run.id, run.index, !!(run.solution || run.followups)]); // eslint-disable-line react-hooks/exhaustive-deps -- keyed on the question and its Q&A ids

  return { book, bookCourse, qaToBook, setQaToBook, bookNote, allFollowups };
}

/** Track hover and text selection inside `.review-body` to pause auto-advance safely. */
export function useAutopilotPause({ session, coachProps, reviewBodyRef }) {
  const autoAdvanceMs = coachProps?.autoAdvance > 0 ? coachProps.autoAdvance : session.autoAdvanceActive ? AUTO_ADVANCE_MS : 0;
  const autoAdvanceActive = Boolean(session.autoAdvanceActive || autoAdvanceMs > 0);
  const autoAdvancePaused = Boolean(session.autoAdvancePaused);
  const setAutoAdvancePaused = session.setAutoAdvancePaused;
  const hoverPauseRef = React.useRef({ card: false, explanation: false });
  const selectionPauseRef = React.useRef(false);
  const markingPaused = !!session.markingTerms;
  const syncAutoPause = React.useCallback(() => {
    const paused = hoverPauseRef.current.card || hoverPauseRef.current.explanation || selectionPauseRef.current || markingPaused;
    setAutoAdvancePaused?.(paused);
  }, [markingPaused, setAutoAdvancePaused]);

  React.useEffect(() => {
    if (autoAdvanceActive) syncAutoPause();
  }, [autoAdvanceActive, markingPaused, syncAutoPause]);

  React.useEffect(() => {
    hoverPauseRef.current = { card: false, explanation: false };
    selectionPauseRef.current = false;
  }, [session.advanceKey]);

  React.useEffect(() => {
    if (!autoAdvanceActive || typeof document === "undefined") return undefined;
    const onSelectionChange = () => {
      const sel = window.getSelection?.();
      const text = sel?.toString?.().trim() || "";
      const body = reviewBodyRef.current;
      const inside = !!(text && body && ((sel?.anchorNode && body.contains(sel.anchorNode)) || (sel?.focusNode && body.contains(sel.focusNode))));
      if (selectionPauseRef.current !== inside) {
        selectionPauseRef.current = inside;
        syncAutoPause();
      }
    };
    document.addEventListener("selectionchange", onSelectionChange);
    return () => document.removeEventListener("selectionchange", onSelectionChange);
  }, [autoAdvanceActive, reviewBodyRef, syncAutoPause]);

  return { autoAdvanceMs, autoAdvanceActive, autoAdvancePaused, hoverPauseRef, syncAutoPause };
}

/** Trigger an immediate session poll when a background assist task on the active card completes. */
export function useAssistWatch({ session, assistTasks, cardId }) {
  const watchedRef = React.useRef("");
  const ended = finishedTask(watchedRef.current, assistTasks, cardId);
  const pollNow = session.pollNow || session.pollRun;
  React.useEffect(() => {
    watchedRef.current = ended.watch;
    if (ended.done) pollNow?.();
  }, [ended.watch, ended.done, pollNow]);
}

/** Synchronize persisted case-study highlights for the current review run. */
export function useCaseHighlights({ run, data, call }) {
  const caseDeck = run.card ? data?.decks?.find((deck) => deck.id === run.deckId && deck.format === "case-study") : null;
  const caseSource = caseDeck ? data?.sources?.find((source) => source.id === caseDeck.caseSourceId) : null;
  const [caseHighlights, setCaseHighlights] = React.useState(run.highlights || []);
  React.useEffect(() => { setCaseHighlights(run.highlights || []); }, [run.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const saveHighlights = React.useCallback((next) => {
    setCaseHighlights(next);
    Promise.resolve(call?.("review.highlights", { runId: run.id, highlights: next })).catch(() => {});
  }, [call, run.id]);
  return { caseSource, caseHighlights, saveHighlights };
}
