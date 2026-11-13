import React from "react";
import { reviewEntryKey } from "../async.js";
import { useNarrow } from "../use-narrow.js";
import { SPLIT_MIN, questionPlace, readColumnWidth, saveColumnWidth, sourcePlacement } from "./source-dock.js";
import SourceColumn from "./SourceColumn.jsx";

/* The practice page's side of the 对照栏 (#1012). `services` is the page's study services with the one openModal every source link of the question goes
   through (看原页, the page badge and its O key, a citation, a figure's page, 看原文 of a wrong answer, 去资料选页做题): sourcePlacement decides, once, whether
   the material docks beside the question or opens as the reader dialog (ui/review/source-dock.js). There is one reader at a time: the column goes when
   the page turns narrow, a reader dialog opens over the page, the round ends (its result page has no question), or an exam is on the page.
   pageRef: the practice page (measured for its width; carries the column's width); run: the session's run; sources: the library's; study: useStudy();
   readerDialogOpen: a reader dialog is open over the page. Returns { services, column (the element or null), docked, style }. */
export function useSourceDock({ pageRef, run, sources, study, readerDialogOpen }) {
  const wide = !useNarrow(pageRef, SPLIT_MIN);
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
  const close = React.useCallback(() => setRequest(null), []);
  const gone = !wide || readerDialogOpen || !run?.card || !!run.complete || run.mode === "exam";
  React.useEffect(() => { if (gone) setRequest(null); }, [gone]);
  const docked = !!request && !gone;
  const cardSource = run?.cardSource;
  const place = React.useMemo(() => questionPlace(run, sources), [run?.mode, cardSource?.sourceId, cardSource?.documentSourceId, cardSource?.page, sources]); // eslint-disable-line react-hooks/exhaustive-deps -- the place is named by these
  const column = docked
    ? <SourceColumn request={request} followKey={reviewEntryKey(run)} place={place} pageRef={pageRef} onWidth={keep} onClose={close} />
    : null;
  return { services, column, docked, style: width ? { "--source-column": `${width}px` } : undefined };
}
