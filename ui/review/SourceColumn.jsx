import React from "react";
import { ui } from "../i18n.js";
import { Button, CloseButton, IconButton } from "../components/index.js";
import { DocumentViewer } from "../workspace-views.jsx";
import { useSourceReader } from "../app/modals/source-reader.jsx";
import { useInjectCss } from "../shared.js";
import { COLUMN_MIN, QUESTION_MIN, columnWidth, dockReducer, dockedPlace, openDock, questionRoom } from "./source-dock.js";
import css from "./source-split.css";

// The column's reader is drawn again only when its props change (they are steady: ui/app/modals/source-reader.jsx), not with every render of the page.
const ColumnReader = React.memo(DocumentViewer);

/** The room the question and the column share on the practice page now (questionRoom: its width, less its padding, its column of ticks and their gaps). */
export function roomOf(page) {
  if (!page) return 0;
  const style = getComputedStyle(page), ticks = page.classList.contains("has-rail") ? page.querySelector(":scope > .review-navigator") : null;
  return questionRoom({ width: page.clientWidth, paddingLeft: parseFloat(style.paddingLeft) || 0, paddingRight: parseFloat(style.paddingRight) || 0,
    rail: ticks?.offsetWidth || 0, gap: parseFloat(style.columnGap) || 0 });
}

/* 对照栏 (#1012): the material beside the question on a wide practice page. It is the reader of the dialog (the same DocumentViewer with the same props,
   app/modals/source-reader.jsx), docked on the right of the page instead of over it, so the question stays on the left to be answered.
   - It follows the questions: the next question's place (ui/review/source-dock.js) is shown within the material on screen by a seek (nothing is loaded or
     mounted again); another material is mounted in its place. A link of the question (看原页, the page badge, a citation, a figure's page) does the same.
   - Its divider is dragged (or moved with ← / →, Home / End) to make it wider or narrower; the width is kept for the next time. While dragged only a guide
     line moves (the reader is laid out again once, when it is let go). One click folds the column to a rail on the right edge, and one click on the rail
     brings it back where it was (a place the questions moved to meanwhile is shown then).
   - Its keys are its own ([data-own-keys]: Ctrl+F, P, [ / ] … while the focus is in it); the practice page's keys are the question's (ui/review/session-logic.js
     keysElsewhere). Esc in it (when nothing of the reader takes it) gives the focus back to the question.
   Props: request ({ modal, nonce }: the last source link opened), followKey + place (the question on screen and its place), pageRef (the practice page, whose
   CSS variable --source-column sets the width), shownRef (kept up to date with the reader modal of what the column shows: dockedPlace), onWidth(px) (keep
   a width), onClose(). */
export default function SourceColumn({ request, followKey, place, pageRef, shownRef, onWidth, onClose }) {
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
  React.useEffect(() => { if (shownRef) shownRef.current = dockedPlace(state); }, [state, shownRef]);
  const { title, viewer } = useSourceReader({ modal: state.modal, onClose, column: true });
  const onSeekMissed = React.useCallback((seek) => dispatch({ type: "missed", seek }), []);
  const collapsed = state.collapsed;
  const asideRef = React.useRef(null);

  const handleRef = React.useRef(null);
  const widthNow = () => asideRef.current?.getBoundingClientRect().width || COLUMN_MIN;
  const roomNow = () => roomOf(pageRef.current);
  // What the divider says to a screen reader: the column's width now, and the most it can take (measured when the divider is drawn and let go, never per frame).
  const tellWidth = (px) => {
    const handle = handleRef.current;
    if (!handle) return;
    handle.setAttribute("aria-valuenow", String(Math.round(px)));
    handle.setAttribute("aria-valuemax", String(Math.max(COLUMN_MIN, Math.round(roomNow() - QUESTION_MIN))));
  };
  // A width for the column: written on the page (its grid track), measured as the page made it, kept.
  const applyWidth = (px) => {
    pageRef.current?.style.setProperty("--source-column", `${Math.round(px)}px`);
    const next = widthNow();
    tellWidth(next);
    onWidth(next);
  };
  React.useLayoutEffect(() => { if (!collapsed) tellWidth(widthNow()); }, [collapsed]); // eslint-disable-line react-hooks/exhaustive-deps -- measured as the divider is drawn
  // Folded, the page's last track is the rail's (ui/review/session.css [data-source-folded]); written on the page as its width is, so the page does not render for it.
  React.useLayoutEffect(() => {
    const page = pageRef.current;
    page?.toggleAttribute("data-source-folded", collapsed);
    return () => page?.removeAttribute("data-source-folded");
  }, [collapsed, pageRef]);

  // The divider while dragged: only it moves (a transform, one per frame: no layout), and the column takes the width once, when it is let go.
  const dragging = React.useRef(null);
  React.useEffect(() => () => dragging.current?.stop(), []);
  const onPointerDown = (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    // The width moves by what the pointer moved (to the left: wider), from the width it had when grabbed.
    const handle = event.currentTarget, from = widthNow(), startX = event.clientX, room = roomNow();
    let frame = 0, wanted = from;
    handle.setPointerCapture?.(event.pointerId);
    asideRef.current.dataset.dragging = "true";
    const move = (moved) => {
      wanted = columnWidth(from + startX - moved.clientX, room);
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; handle.style.transform = `translateX(${Math.round(from - wanted)}px)`; });
    };
    const stop = () => {
      cancelAnimationFrame(frame);
      handle.style.transform = "";
      if (asideRef.current) delete asideRef.current.dataset.dragging;
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      dragging.current = null;
    };
    const end = () => { stop(); applyWidth(wanted); };
    dragging.current = { stop };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  };
  const onHandleKey = (event) => {
    const room = roomNow();
    const to = event.key === "ArrowLeft" ? widthNow() + 32 : event.key === "ArrowRight" ? widthNow() - 32
      : event.key === "Home" ? COLUMN_MIN : event.key === "End" ? room - QUESTION_MIN : null;
    if (to === null) return;
    event.preventDefault();
    event.stopPropagation();
    applyWidth(columnWidth(to, room));
  };
  // Esc that nothing of the reader took (its find, menus, panels stop it): back to the question, the column stays.
  const onKeyDown = (event) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    const question = pageRef.current?.querySelector(".review-body .question-card");
    if (!question) return;
    event.preventDefault();
    question.focus({ preventScroll: true });
  };

  return (
    <aside ref={asideRef} className="source-column" data-own-keys="" data-collapsed={collapsed || undefined} aria-label={ui("对照资料")} onKeyDown={onKeyDown}>
      {collapsed ? (
        <Button variant="quiet" className="source-column__rail" aria-label={ui("展开对照资料")} onClick={() => dispatch({ type: "expand" })}>
          <span aria-hidden="true">{ui("资料")}</span>
        </Button>
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
        {viewer && <ColumnReader key={state.key} {...viewer} seek={state.seek} onSeekMissed={onSeekMissed} />}
      </div>
    </aside>
  );
}
