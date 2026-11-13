import React from "react";
import { ui } from "../i18n.js";
import { CloseButton, IconButton } from "../components/index.js";
import { DocumentViewer } from "../workspace-views.jsx";
import { useSourceReader } from "../app/modals/source-reader.jsx";
import { useInjectCss } from "../shared.js";
import { COLUMN_MIN, QUESTION_MIN, columnWidth, dockReducer, openDock } from "./source-dock.js";
import css from "./source-split.css";

/* 对照栏 (#1012): the material beside the question on a wide practice page. It is the reader of the dialog (the same DocumentViewer with the same props,
   app/modals/source-reader.jsx), docked on the right of the page instead of over it, so the question stays on the left to be answered.
   - It follows the questions: the next question's place (ui/review/source-dock.js) is shown within the material on screen by a seek (nothing is loaded or
     mounted again); another material is mounted in its place. A link of the question (看原页, the page badge, a citation, a figure's page) does the same.
   - Its divider is dragged (or moved with ← / →) to make it wider or narrower; the width is kept for the next time. One click folds it to a rail on the right
     edge, and one click on the rail brings it back where it was (a place the questions moved to meanwhile is shown then).
   - Its keys are its own ([data-own-keys]: Ctrl+F, P, [ / ] … while the focus is in it); the practice page's keys are the question's (ui/review/session-logic.js
     keysElsewhere). Nothing here runs per scroll or per frame outside the reader; a drag writes the page's CSS width only, and keeps it once, when let go.
   Props: request ({ modal, nonce }: the last source link opened), followKey + place (the question on screen and its place), pageRef (the practice page, whose
   CSS variable --source-column sets the width), onWidth(px) (keep a width), onClose(). */
export default function SourceColumn({ request, followKey, place, pageRef, onWidth, onClose }) {
  useInjectCss(css, "study-source-split");
  const [state, dispatch] = React.useReducer(dockReducer, request.modal, openDock);
  // A link opened while docked is shown here (the first one opened the column).
  const seen = React.useRef(request);
  React.useEffect(() => {
    if (seen.current === request) return;
    seen.current = request;
    dispatch({ type: "open", modal: request.modal });
  }, [request]);
  // The next question: its place, never at the column's first drawing (it opened at the link's own place).
  const placeRef = React.useRef(place), followed = React.useRef(followKey);
  placeRef.current = place;
  React.useEffect(() => {
    if (followed.current === followKey) return;
    followed.current = followKey;
    dispatch({ type: "follow", place: placeRef.current });
  }, [followKey]);
  const { title, viewer } = useSourceReader({ modal: state.modal, onClose, column: true });
  const onSeekMissed = React.useCallback((seek) => dispatch({ type: "missed", seek }), []);
  const collapsed = state.collapsed;
  const asideRef = React.useRef(null);

  // The divider: the page's --source-column follows the pointer (one write per frame), and is kept when the pointer is let go.
  const handleRef = React.useRef(null);
  const widthNow = () => asideRef.current?.getBoundingClientRect().width || COLUMN_MIN;
  const pageWidth = () => pageRef.current?.getBoundingClientRect().width || 0;
  // What the divider says to a screen reader: the column's width now, and the most it can take (measured when the divider is drawn and moved, never per frame).
  const tellWidth = (px) => {
    const handle = handleRef.current;
    if (!handle) return;
    handle.setAttribute("aria-valuenow", String(Math.round(px)));
    handle.setAttribute("aria-valuemax", String(Math.max(COLUMN_MIN, Math.round(pageWidth() - QUESTION_MIN))));
  };
  const setWidth = (px) => pageRef.current?.style.setProperty("--source-column", `${Math.round(px)}px`);
  React.useLayoutEffect(() => { if (!collapsed) tellWidth(widthNow()); }, [collapsed]); // eslint-disable-line react-hooks/exhaustive-deps -- measured as the divider is drawn
  const onPointerDown = (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    // The width moves by what the pointer moved (to the left: wider), from the width it had when grabbed.
    const handle = event.currentTarget, from = widthNow(), startX = event.clientX, page = pageWidth();
    let frame = 0, last = from;
    handle.setPointerCapture?.(event.pointerId);
    asideRef.current.dataset.dragging = "true";
    const move = (moved) => {
      last = columnWidth(from + startX - moved.clientX, page);
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; setWidth(last); });
    };
    const end = () => {
      cancelAnimationFrame(frame);
      setWidth(last);
      last = widthNow(); // what the page made of it (the CSS keeps the question its room), once
      if (asideRef.current) delete asideRef.current.dataset.dragging;
      tellWidth(last);
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      onWidth(last);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  };
  const onHandleKey = (event) => {
    const step = event.key === "ArrowLeft" ? 32 : event.key === "ArrowRight" ? -32 : 0;
    if (!step) return;
    event.preventDefault();
    setWidth(columnWidth(widthNow() + step, pageWidth()));
    const next = widthNow();
    tellWidth(next);
    onWidth(next);
  };

  return (
    <aside ref={asideRef} className="source-column" data-own-keys="" data-collapsed={collapsed || undefined} aria-label={ui("对照资料")}>
      {collapsed ? (
        <button type="button" className="source-column__rail" aria-label={ui("展开对照资料")} onClick={() => dispatch({ type: "expand" })}>
          <span aria-hidden="true">{ui("资料")}</span>
        </button>
      ) : (
        <div ref={handleRef} className="source-column__handle" role="separator" aria-orientation="vertical" aria-label={ui("拖动调整资料栏宽度")} tabIndex={0}
          aria-valuemin={COLUMN_MIN} onPointerDown={onPointerDown} onKeyDown={onHandleKey} />
      )}
      <div className="source-column__body" hidden={collapsed}>
        <header className="source-column__head">
          <div className="source-column__title">{title}</div>
          <IconButton icon="chevron" size="sm" label={ui("收起资料栏")} onClick={() => dispatch({ type: "collapse" })} />
          <CloseButton label={ui("关闭资料栏")} onClick={onClose} />
        </header>
        {viewer && <DocumentViewer key={state.key} {...viewer} seek={state.seek} onSeekMissed={onSeekMissed} />}
      </div>
    </aside>
  );
}
