import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ui, uiFormat } from "../i18n.js";
import { AddSourceButton, Button, IconButton, Icon, ProgressBar } from "../components/index.js";
import { useTopDialog } from "../components/dialog-stack.js";
import { useInjectCss } from "../shared.js";
import { NARROW_WIDTH, driftedOut, inLayer, layerScale, placePopover, spotlightBox } from "./geometry.js";
import { ANCHOR_WAIT_MS, closedFolds, isPinned, locateAnchor, pageLead } from "./anchor.js";
import { chapterHeading, opensFromNav, tourKeyAction, tourNextChapter } from "./steps.js";
import css from "./tour.css";
import { usePolling } from '../use-polling.js';

const cx = (...names) => names.filter(Boolean).join(" ");
const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * One step's card: its chapter (the full tour's) and "3 / 8" progress, title, body, an optional
 * note (model missing / connected), and Back / Next / Skip, plus 跳到下一章
 * where `onNextChapter` is given. The final step
 * offers the first import, the full tour (only when this is the short one:
 * `onFullTour`) and removing the sample instead of more touring.
 */
export function TourPopover({ step, index, total, model, sampleLoaded = true, busy = false, docked = false, side, style, popoverRef,
  onNext, onBack, onClose, onSkip, onNextChapter, onLoadSample, onBrowse, onImport, onFullTour, onRemoveSample, onKeyDown }) {
  const titleId = useId(), bodyId = useId();
  const note = step.modelNote && model && !model.ready ? ui(step.modelNote)
    : step.readyNote && model?.ready && model.label ? uiFormat(step.readyNote, [model.label]) : "";
  const offerSample = step.id === "welcome" && !sampleLoaded && !!onLoadSample;
  return (
    <div ref={popoverRef} className={cx("tour-pop", "sh-paper-card", "sh-paper-card--snug", docked && "tour-pop--docked", side && `tour-pop--${side}`)} style={style}
      role="dialog" aria-modal="false" aria-labelledby={titleId} aria-describedby={bodyId} tabIndex={-1} onKeyDown={onKeyDown}>
      <div className="tour-pop__head">
        <span className="tour-pop__eyebrow"><Icon className="sh-icon--inline" name="sparkle" />{ui(chapterHeading(step.chapter) || "功能导览")}</span>
        <span className="tour-pop__count">{index + 1} / {total}</span>
        <IconButton icon="close" size="sm" className="tour-pop__close" label={ui("暂停导览")} onClick={onClose} />
      </div>
      <ProgressBar size="sm" className="tour-pop__meter" label={ui("导览进度")} value={index + 1} max={Math.max(1, total)} />
      <h2 id={titleId} className="tour-pop__title">{ui(step.title)}</h2>
      <p id={bodyId} className="tour-pop__body">{ui(step.body)}</p>
      {note && <p className={cx("tour-pop__note", model?.ready ? "is-ready" : "is-missing")}>
        <Icon className="tour-pop__note-icon sh-icon--inline" name={model?.ready ? "success" : "info"} />{note}</p>}
      {offerSample && <div className="tour-pop__choices">
        <Button variant="primary" icon="sparkle" busy={busy} onClick={onLoadSample}>{ui("载入示例并开始")}</Button>
        {onBrowse && <Button variant="quiet" lock={busy} onClick={onBrowse}>{ui("只看界面")}</Button>}
      </div>}
      {step.final && <div className="tour-pop__choices">
        {onImport && <AddSourceButton variant="primary" onClick={onImport} />}
        {onFullTour && <Button variant="quiet" onClick={onFullTour}>{ui("看完整导览")}</Button>}
        {onRemoveSample && <Button variant="quiet" onClick={onRemoveSample}>{ui("移除示例数据")}</Button>}
      </div>}
      <div className="tour-pop__foot">
        {!step.final && <Button variant="link" size="sm" className="tour-pop__skip" onClick={onSkip}>{index === 0 ? ui("以后再说") : ui("跳过导览")}</Button>}
        {onNextChapter && <Button variant="link" size="sm" className="tour-pop__chapter" onClick={onNextChapter}>{ui("跳到下一章")}</Button>}
        <div className="tour-pop__moves">
          {index > 0 && <Button size="sm" icon="arrow-left" onClick={onBack}>{ui("上一步")}</Button>}
          {step.final
            ? <Button size="sm" onClick={onNext}>{ui("完成导览")}</Button>
            : !offerSample && <Button size="sm" variant="primary" iconEnd="arrow-right" onClick={onNext}>{ui("下一步")}</Button>}
        </div>
      </div>
    </div>
  );
}

/* While the card is docked along the bottom of a narrow panel, the page gets that much room after its end (tour.css), so a control at the
   very end of a short page (创建题组's 生成 button) can still be scrolled above the card instead of staying underneath it. */
const DOCK_GAP = 24, DOCK_CEILING = 60, DOCK_MARGIN = 12, HEADROOM = 64;
// How often, and for how long after the anchor wait, a drifted anchor is scrolled to again; the learner's own scroll, press or key ends it.
const SETTLE_EVERY_MS = 500, SETTLE_FOR_MS = 2000;
const OWN_MOVES = ["wheel", "touchstart", "pointerdown", "keydown"];
function setDockRoom(root, height) {
  if (!root) return;
  if (height > 0) {
    const room = `${Math.ceil(height + DOCK_GAP)}px`;
    if (root.style.getPropertyValue("--tour-dock-room") !== room) root.style.setProperty("--tour-dock-room", room);
    if (!root.hasAttribute("data-tour-docked")) root.setAttribute("data-tour-docked", "");
  } else if (root.hasAttribute("data-tour-docked")) {
    root.style.removeProperty("--tour-dock-room");
    root.removeAttribute("data-tour-docked");
  }
}

function scrollRoom(element, delta) {
  if (!(Math.abs(delta) > 0.5)) return;
  const behavior = reducedMotion() ? "auto" : "smooth";
  for (let node = element?.parentElement; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
    const style = typeof getComputedStyle === "function" ? getComputedStyle(node) : null;
    if (style && /(auto|scroll|overlay)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 1) {
      node.scrollTo({ top: node.scrollTop + delta, behavior });
      return;
    }
  }
  if (element?.closest?.(".sidebar")) return;
  if (typeof window !== "undefined" && typeof window.scrollTo === "function") window.scrollTo({ top: window.scrollY + delta, behavior });
}

/* A target that sticks (创建题组's bar sticks to the bottom of the view while its place in the page is further down, #1183) moves only once the page has
   scrolled its place into the view: a scroll that brings it above the docked card is measured from that place, not from where it is drawn while stuck.
   The place is read by laying the sticky box out as static for one synchronous read (it keeps its room in the flow either way, so nothing else moves). */
function stuckShift(element) {
  if (typeof getComputedStyle !== "function") return 0;
  for (let node = element; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
    if (getComputedStyle(node).position !== "sticky") continue;
    const drawn = element.getBoundingClientRect().top;
    const value = node.style.getPropertyValue("position"), priority = node.style.getPropertyPriority("position");
    node.style.setProperty("position", "static", "important");
    const placed = element.getBoundingClientRect().top;
    if (value) node.style.setProperty("position", value, priority);
    else node.style.removeProperty("position");
    return placed - drawn;
  }
  return 0;
}

const sameBox = (a, b) => !a === !b && (!a || ["left", "top", "width", "height"].every((key) => Math.abs(a[key] - b[key]) < 0.5));

/**
 * The running tour: switches to each step's page (onEnter does the switching
 * and preparing), waits up to four seconds for the step's anchor, scrolls it
 * into view, dims everything else inside the study container and places the
 * popover beside it. Without an anchor the popover is centred. While a dialog
 * is open the layer moves into it, because a modal dialog makes the page inert.
 */
export default function Tour({ steps, stepId, rootRef, model, sampleLoaded, busy, onEnter, onMove, onJump, onClose, onFinish,
  onLoadSample, onBrowse, onImport, onFullTour, onRemoveSample }) {
  useInjectCss(css, "study-tour");
  const step = steps.find((item) => item.id === stepId) || steps[0];
  const index = Math.max(0, steps.indexOf(step));
  const top = useTopDialog();
  const layerRef = useRef(null), popoverRef = useRef(null), targetRef = useRef(null), dockSizesRef = useRef("");
  // The step whose target was scrolled to the top to make room for the card (at most once a step; the page keeps the room while the step lasts).
  const raisedRef = useRef("");
  const [entered, setEntered] = useState(null);
  const [target, setTarget] = useState(null);
  const [layout, setLayout] = useState(null);
  const enter = useRef(onEnter);
  enter.current = onEnter;
  const anchors = [step?.anchor].flat().filter(Boolean);
  const anchorKey = anchors.join(" ");

  // Switch page and prepare (open the lecture, start the practice round…).
  useEffect(() => {
    if (!step) return;
    let live = true;
    setEntered(null);
    setTarget(null);
    targetRef.current = null;
    dockSizesRef.current = "";
    raisedRef.current = "";
    Promise.resolve().then(() => enter.current?.(step)).catch(() => {}).finally(() => { if (live) setEntered(step.id); });
    return () => { live = false; };
  }, [step?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Scroll the anchor into view: above the docked card on a narrow panel, else only when it is not already whole in the view.
  const bringIntoView = (found) => {
    const box = found.getBoundingClientRect(), view = layerRef.current?.getBoundingClientRect();
    const scale = layerScale(view, layerRef.current), own = view ? inLayer(box, view, scale) : null;
    // On a narrow panel the card is docked along the bottom: scroll tall or low anchors above the card while keeping their top under the bar.
    if (view && view.width / scale <= NARROW_WIDTH) {
      const popH = popoverRef.current?.offsetHeight || view.height / scale * 0.45;
      const floor = view.height / scale - 12 - popH - DOCK_MARGIN;
      const top = own.top, bottom = own.top + own.height;
      if (top < DOCK_CEILING || bottom > floor) {
        setDockRoom(rootRef.current, popH);
        const desiredTop = Math.max(DOCK_CEILING, Math.min(96, floor - own.height));
        scrollRoom(found, top + stuckShift(found) / scale - desiredTop);
      }
      dockSizesRef.current = `${step?.id}:${Math.round(own.height)}:${Math.round(popH)}`;
    } else {
      const visible = view && box.top >= view.top + 8 && box.bottom <= view.bottom - 8;
      if (!visible) found.scrollIntoView({ block: box.height > (view?.height || 800) * 0.6 || (view?.width || 1000) <= 560 ? "start" : "center",
        inline: "nearest", behavior: reducedMotion() ? "auto" : "smooth" });
    }
  };

  // Wait for the anchor; a step whose anchor never shows stays centred.
  useEffect(() => {
    if (entered !== step?.id || !anchors.length) return;
    let live = true, timer = 0;
    const started = Date.now();
    const look = () => {
      if (!live) return;
      // A fold the page keeps shut is opened (as 找功能 does): its content has a size while shut, and a spotlight on it would light nothing.
      const found = locateAnchor(rootRef.current, anchors)?.element;
      if (found) {
        targetRef.current = found;
        bringIntoView(found);
        setTarget(found);
        timer = setTimeout(hold, SETTLE_EVERY_MS);
        return;
      }
      if (Date.now() - started < ANCHOR_WAIT_MS) timer = setTimeout(look, 80);
    };
    // A page still drawing (the Settings panes load one by one) can push the anchor away after the scroll: for a while it is brought back, until the learner moves.
    let moved = false;
    const own = () => { moved = true; };
    for (const type of OWN_MOVES) document.addEventListener(type, own, { capture: true, passive: true });
    const hold = () => {
      if (!live || moved || Date.now() - started >= ANCHOR_WAIT_MS + SETTLE_FOR_MS) return;
      const element = targetRef.current, view = layerRef.current?.getBoundingClientRect();
      if (element?.isConnected && view) {
        const scale = layerScale(view, layerRef.current), sheet = popoverRef.current;
        // Under the sheet along the bottom of a narrow panel is out of sight too: the room ends at the sheet.
        const height = sheet?.classList.contains("tour-pop--dock") ? inLayer(sheet.getBoundingClientRect(), view, scale).top - DOCK_MARGIN : view.height / scale;
        if (driftedOut(inLayer(element.getBoundingClientRect(), view, scale), { width: view.width / scale, height })) bringIntoView(element);
      }
      timer = setTimeout(hold, SETTLE_EVERY_MS);
    };
    look();
    return () => { live = false; clearTimeout(timer); for (const type of OWN_MOVES) document.removeEventListener(type, own, true); };
  }, [entered, step?.id, anchorKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const measure = useCallback(() => {
    const layer = layerRef.current, popover = popoverRef.current;
    if (!layer || !popover) return;
    let element = targetRef.current;
    if (element && (!element.isConnected || !element.getBoundingClientRect().height || closedFolds(element).length)) {
      // The page re-rendered the anchor (or shut the fold around it); follow the new element.
      element = locateAnchor(rootRef.current, anchors)?.element ?? null;
      targetRef.current = element;
    }
    const view = layer.getBoundingClientRect();
    // Rectangles are screen pixels; the layer is inside the app's CSS zoom (界面大小), so its left/top are its own pixels.
    const scale = layerScale(view, layer);
    const bounds = { width: view.width / scale, height: view.height / scale };
    const screen = element?.getBoundingClientRect();
    const box = screen ? inLayer(screen, view, scale) : null;
    const lit = spotlightBox(box, bounds);
    const size = { width: popover.offsetWidth, height: popover.offsetHeight };
    // What the card keeps off besides the lit area (#1712): the title of the page (or dialog) on screen, and the first block for a step from the sidebar.
    const lead = pageLead(layer.closest("dialog") || rootRef.current?.querySelector("main"));
    const avoid = [lead.title, step && opensFromNav(step) ? lead.block : null].flatMap((rect) => {
      const own = rect && inLayer(rect, view, scale);
      return own && own.top < bounds.height && own.top + own.height > 0 ? [own] : [];
    });
    const place = placePopover({ target: lit, popover: size, bounds, prefer: step?.placement, avoid, pinned: !!element && isPinned(element) });
    const spot = place.spot || lit;
    // No room around the target as it stands (a large 界面大小 leaves a small layer): its top goes under the top bar, with room after the page's end to get there.
    const raise = place.crowded && element && box && raisedRef.current !== step?.id && box.top > HEADROOM + 1;
    if (raise) raisedRef.current = step.id;
    setDockRoom(rootRef.current, place.docked || raisedRef.current === step?.id ? size.height : 0);
    if (raise) scrollRoom(element, stuckShift(element) / scale + box.top - HEADROOM);
    if (place.docked && element && box) {
      const sizeKey = `${step?.id}:${Math.round(box.height)}:${Math.round(size.height)}`;
      if (dockSizesRef.current && dockSizesRef.current.startsWith(`${step?.id}:`) && dockSizesRef.current !== sizeKey) {
        dockSizesRef.current = sizeKey;
        const top = box.top, bottom = box.top + box.height, floor = place.top - DOCK_MARGIN;
        if (bottom > floor && top > DOCK_CEILING) scrollRoom(element, stuckShift(element) / scale + Math.min(bottom - floor, top - DOCK_CEILING));
      } else if (!dockSizesRef.current) {
        dockSizesRef.current = sizeKey;
      }
    }
    // The caret points at the middle of the spotlight's visible edge.
    const along = (start, length, offset, extent) => Math.round(Math.min(Math.max(start + length / 2 - offset, 22), extent - 22));
    const caret = !spot ? null : place.side === "bottom" || place.side === "top" ? along(spot.left, spot.width, place.left, size.width)
      : place.side === "right" || place.side === "left" ? along(spot.top, spot.height, place.top, size.height) : null;
    setLayout((previous) => previous && sameBox(previous.spot, spot) && previous.place.left === place.left && previous.place.top === place.top &&
      previous.place.side === place.side && previous.caret === caret ? previous : { spot, place, caret });
  }, [anchorKey, step?.placement]); // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => { measure(); }, [measure, target, step?.id, top, entered]);
  useEffect(() => () => setDockRoom(rootRef.current, 0), [rootRef]);
  useEffect(() => {
    let frame = 0;
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); };
    window.addEventListener("resize", schedule);
    document.addEventListener("scroll", schedule, true);
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(schedule) : null;
    if (observer && popoverRef.current) observer.observe(popoverRef.current);
    if (observer && target) observer.observe(target);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedule);
      document.removeEventListener("scroll", schedule, true);
      observer?.disconnect();
    };
  }, [measure, target]);
  // What the observers cannot see (a layout that settles late) is caught by a slow re-measure, not while the page is hidden.
  usePolling(() => { requestAnimationFrame(measure); }, { intervalMs: 300 });

  // Focus moves to the step's card once it has a place.
  const focused = useRef("");
  useEffect(() => {
    if (!layout || focused.current === step?.id) return;
    focused.current = step.id;
    // Retry for a few frames: the card may still be settling (a reduced-motion
    // stylesheet can turn every change into a short transition) or a page
    // switch can move focus once more.
    let tries = 0;
    const focus = () => {
      const card = popoverRef.current;
      if (!card?.isConnected) return;
      if (!card.contains(document.activeElement)) card.focus({ preventScroll: true });
      if (!card.contains(document.activeElement) && ++tries < 8) requestAnimationFrame(focus);
    };
    focus();
  }, [layout, step?.id]);

  // Esc pauses the tour from anywhere in the study app except text fields and dialogs.
  useEffect(() => {
    const onKey = (event) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const active = document.activeElement;
      if (active && active !== document.body && !rootRef.current?.contains(active)) return;
      if (active?.closest?.("input, textarea, select, [contenteditable], dialog")) return;
      event.preventDefault();
      onClose("escape");
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, rootRef]);

  if (!step) return null;
  const last = index === steps.length - 1;
  const next = () => (last ? onFinish() : onMove(1));
  const onKeyDown = (event) => {
    const action = tourKeyAction(event);
    if (!action || event.target.closest?.("input, textarea, select")) return;
    event.preventDefault();
    event.stopPropagation();
    if (action === "next" && !(step.id === "welcome" && !sampleLoaded)) next();
    else if (action === "back" && index > 0) onMove(-1);
    else if (action === "close") onClose("escape");
  };
  // 跳到下一章: only where `onJump` is given (the full tour), and not before the welcome step's sample is chosen.
  const nextChapter = onJump && !(step.id === "welcome" && !sampleLoaded) ? tourNextChapter(steps, step.id) : null;
  // It leaves out the rest of this chapter; the tour's card stays where the learner is looking.
  const skipChapter = () => onJump(nextChapter);
  const place = layout?.place;
  const centred = !anchors.length;
  const layer = (
    <div ref={layerRef} className={cx("tour-layer", centred && "is-centred", !layout && "is-measuring")}>
      {layout?.spot ? <div className="tour-spot" style={{ left: 0, top: 0, width: layout.spot.width, height: layout.spot.height, transform: `translate(${layout.spot.left}px, ${layout.spot.top}px)` }} />
        : centred && <div className="tour-shade" />}
      <TourPopover key={step.id} step={step} index={index} total={steps.length} model={model} sampleLoaded={sampleLoaded} busy={busy}
        popoverRef={popoverRef} docked={place?.docked} side={place?.side} onKeyDown={onKeyDown}
        style={place && !place.docked ? { left: 0, top: 0, transform: `translate(${place.left}px, ${place.top}px)`, ...(layout.caret != null ? { "--tour-caret": `${layout.caret}px` } : {}) }
          : place?.side === "dock-lifted" ? { top: place.top } : undefined}
        onNext={next} onBack={() => onMove(-1)} onClose={() => onClose("close")} onSkip={() => onClose("skip")}
        onNextChapter={nextChapter ? skipChapter : undefined}
        onLoadSample={onLoadSample} onBrowse={onBrowse} onImport={onImport} onFullTour={onFullTour} onRemoveSample={onRemoveSample} />
      <p className="sh-visually-hidden" role="status" aria-live="polite">{uiFormat("功能导览 · 第 {0} / {1} 步：{2}", [index + 1, steps.length, ui(step.title)])}</p>
    </div>
  );
  return top?.dialog ? createPortal(layer, top.dialog) : layer;
}
