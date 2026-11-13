import React from "react";
import { reviewEntryKey } from "../async.js";
import { SPLIT_MIN, questionPlace, readColumnWidth, saveColumnWidth, sourcePlacement } from "./source-dock.js";
import SourceColumn, { roomOf } from "./SourceColumn.jsx";

/* The practice page's side of the 对照栏 (#1012). `services` is the page's study services with the one openModal every source link of the question goes
   through (看原页, the page badge and its O key, a citation, a figure's page, 看原文 of a wrong answer): sourcePlacement decides, once, whether the material
   docks beside the question or opens as the reader dialog (ui/review/source-dock.js). 去资料选页做题 is not a link of the question: it is the reader dialog
   with its guide to choosing pages, as before (ui/Review.jsx opens it with study.openModal). There is one reader at a time: the column goes when a reader dialog
   opens over the page, the round ends (its result page has no question) or an exam is on the page; when the page turns too narrow for both, the reader
   goes on as the dialog, at the column's place.
   pageRef: the practice page (measured for the room the question and the column share; carries the column's width); rail: the page draws its column of
   ticks (.has-rail); run: the session's run; sources: the library's; study: useStudy(); readerDialogOpen: a reader dialog is open over the page; modalOpen:
   any dialog is.
   Returns { services, column (the element or null), docked, style }. */
export function useSourceDock({ pageRef, rail, run, sources, study, readerDialogOpen, modalOpen }) {
  const wide = useRoomForSplit(pageRef, rail);
  const [request, setRequest] = React.useState(null);
  const [width, setWidth] = React.useState(() => readColumnWidth());
  const latest = React.useRef(null);
  latest.current = { wide, run };
  const fallback = study.openModal;
  const openModal = React.useCallback((modal) => {
    if (sourcePlacement({ modal, ...latest.current }) !== "column") { fallback(modal); return; }
    setRequest((previous) => ({ modal, nonce: (previous?.nonce || 0) + 1 }));
  }, [fallback]);
  const services = React.useMemo(() => ({ ...study, openModal }), [study, openModal]);
  const keep = React.useCallback((px) => { setWidth(px); saveColumnWidth(px); }, []);
  // What the column shows, kept by it (dockedPlace), for the dialog that takes over when the page turns narrow; nothing once the column is closed.
  const shown = React.useRef(null);
  const close = React.useCallback(() => { shown.current = null; setRequest(null); }, []);
  const blocked = readerDialogOpen || !run?.card || !!run.complete || run.mode === "exam";
  const gone = !wide || blocked;
  React.useEffect(() => {
    if (!gone) return;
    // Another dialog open over the page (报告问题, 资料) is never replaced by the reader: the app shows one modal at a time, and what was typed there would go.
    if (!blocked && !modalOpen && request && shown.current) fallback(shown.current);
    shown.current = null;
    setRequest(null);
  }, [gone]); // eslint-disable-line react-hooks/exhaustive-deps -- when the column has to go
  const docked = !!request && !gone;
  const cardSource = run?.cardSource;
  const place = React.useMemo(() => questionPlace(run, sources), [run?.mode, cardSource?.sourceId, cardSource?.documentSourceId, cardSource?.page, sources]); // eslint-disable-line react-hooks/exhaustive-deps -- the place is named by these
  const column = docked
    ? <SourceColumn request={request} followKey={reviewEntryKey(run)} place={place} pageRef={pageRef} shownRef={shown} onWidth={keep} onClose={close} />
    : null;
  return { services, column, docked, style: width ? { "--source-column": `${width}px` } : undefined };
}

/** Whether both the question (QUESTION_MIN) and the column (COLUMN_MIN) fit, measured before the first paint, when the page is resized and when its column
    of ticks comes or goes (state is set only when the answer changes). */
function useRoomForSplit(pageRef, rail) {
  const [fits, setFits] = React.useState(false);
  React.useLayoutEffect(() => {
    const page = pageRef.current;
    if (!page) return undefined;
    const measure = () => setFits(roomOf(page) >= SPLIT_MIN);
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(page);
    return () => observer.disconnect();
  }, [pageRef, rail]);
  return fits;
}
