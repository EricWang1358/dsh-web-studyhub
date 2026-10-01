import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ui, uiFormat } from "../i18n.js";
import { Button, IconButton, Icon } from "../components/index.js";
import { useTopDialog } from "../components/dialog-stack.js";
import { useInjectCss } from "../shared.js";
import { placePopover, spotlightBox } from "./geometry.js";
import { tourKeyAction } from "./steps.js";
import css from "./tour.css";

const ANCHOR_WAIT_MS = 4000;
const cx = (...names) => names.filter(Boolean).join(" ");
const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * One step's card: eyebrow and "3 / 17" progress, title, body, an optional
 * note (model missing / connected), and Back / Next / Skip. The final step
 * offers the first import and removing the sample instead of more touring.
 */
export function TourPopover({ step, index, total, model, sampleLoaded = true, busy = false, docked = false, side, style, popoverRef,
  onNext, onBack, onClose, onSkip, onLoadSample, onBrowse, onImport, onRemoveSample, onKeyDown }) {
  const titleId = useId(), bodyId = useId();
  const note = step.modelNote && model && !model.ready ? ui(step.modelNote)
    : step.readyNote && model?.ready && model.label ? uiFormat(step.readyNote, [model.label]) : "";
  const offerSample = step.id === "welcome" && !sampleLoaded && !!onLoadSample;
  const percent = `${Math.round(((index + 1) / Math.max(1, total)) * 100)}%`;
  return (
    <div ref={popoverRef} className={cx("tour-pop", docked && "tour-pop--docked", side && `tour-pop--${side}`)} style={style}
      role="dialog" aria-modal="false" aria-labelledby={titleId} aria-describedby={bodyId} tabIndex={-1} onKeyDown={onKeyDown}>
      <div className="tour-pop__head">
        <span className="tour-pop__eyebrow"><Icon name="sparkle" size={16} />{ui("功能导览")}</span>
        <span className="tour-pop__count">{index + 1} / {total}</span>
        <IconButton icon="close" size="sm" className="tour-pop__close" label={ui("暂停导览")} onClick={onClose} />
      </div>
      <div className="tour-pop__bar" role="progressbar" aria-label={ui("导览进度")} aria-valuemin={1} aria-valuemax={total} aria-valuenow={index + 1}>
        <span style={{ width: percent }} />
      </div>
      <h2 id={titleId} className="tour-pop__title">{ui(step.title)}</h2>
      <p id={bodyId} className="tour-pop__body">{ui(step.body)}</p>
      {note && <p className={cx("tour-pop__note", model?.ready ? "is-ready" : "is-missing")}>
        <Icon name={model?.ready ? "success" : "info"} size={16} />{note}</p>}
      {offerSample && <div className="tour-pop__choices">
        <Button variant="primary" icon="sparkle" busy={busy} onClick={onLoadSample}>{ui("载入示例并开始")}</Button>
        {onBrowse && <Button variant="quiet" disabled={busy} onClick={onBrowse}>{ui("只看界面")}</Button>}
      </div>}
      {step.final && <div className="tour-pop__choices">
        {onImport && <Button variant="primary" icon="upload" onClick={onImport}>{ui("导入我的第一份资料")}</Button>}
        {onRemoveSample && <Button variant="quiet" onClick={onRemoveSample}>{ui("移除示例数据")}</Button>}
      </div>}
      <div className="tour-pop__foot">
        {!step.final && <Button variant="link" size="sm" className="tour-pop__skip" onClick={onSkip}>{index === 0 ? ui("以后再说") : ui("跳过导览")}</Button>}
        <span className="tour-pop__spacer" />
        {index > 0 && <Button size="sm" icon="arrow-left" onClick={onBack}>{ui("上一步")}</Button>}
        {step.final
          ? <Button size="sm" onClick={onNext}>{ui("完成导览")}</Button>
          : !offerSample && <Button size="sm" variant="primary" iconEnd="arrow-right" onClick={onNext}>{ui("下一步")}</Button>}
      </div>
    </div>
  );
}

/** The anchor element of a step inside the study app, once it is rendered with a size. */
function findAnchor(root, anchors) {
  for (const anchor of anchors) {
    const element = root?.querySelector(`[data-tour="${anchor}"]`);
    const box = element?.isConnected ? element.getBoundingClientRect() : null;
    if (box && box.width > 0 && box.height > 0) return element;
  }
  return null;
}

const sameBox = (a, b) => !a === !b && (!a || ["left", "top", "width", "height"].every((key) => Math.abs(a[key] - b[key]) < 0.5));

/**
 * The running tour: switches to each step's page (onEnter does the switching
 * and preparing), waits up to four seconds for the step's anchor, scrolls it
 * into view, dims everything else inside the study container and places the
 * popover beside it. Without an anchor the popover is centred. While a dialog
 * is open the layer moves into it, because a modal dialog makes the page inert.
 */
export default function Tour({ steps, stepId, rootRef, model, sampleLoaded, busy, onEnter, onMove, onClose, onFinish,
  onLoadSample, onBrowse, onImport, onRemoveSample }) {
  useInjectCss(css, "study-tour");
  const step = steps.find((item) => item.id === stepId) || steps[0];
  const index = Math.max(0, steps.indexOf(step));
  const top = useTopDialog();
  const layerRef = useRef(null), popoverRef = useRef(null), targetRef = useRef(null);
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
    Promise.resolve().then(() => enter.current?.(step)).catch(() => {}).finally(() => { if (live) setEntered(step.id); });
    return () => { live = false; };
  }, [step?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Wait for the anchor; a step whose anchor never shows stays centred.
  useEffect(() => {
    if (entered !== step?.id || !anchors.length) return;
    let live = true, timer = 0;
    const started = Date.now();
    const look = () => {
      if (!live) return;
      const found = findAnchor(rootRef.current, anchors);
      if (found) {
        targetRef.current = found;
        const box = found.getBoundingClientRect(), view = layerRef.current?.getBoundingClientRect();
        const visible = view && box.top >= view.top + 8 && box.bottom <= view.bottom - 8;
        if (!visible) found.scrollIntoView({ block: box.height > (view?.height || 800) * 0.6 || (view?.width || 1000) <= 560 ? "start" : "center",
          inline: "nearest", behavior: reducedMotion() ? "auto" : "smooth" });
        setTarget(found);
        return;
      }
      if (Date.now() - started < ANCHOR_WAIT_MS) timer = setTimeout(look, 80);
    };
    look();
    return () => { live = false; clearTimeout(timer); };
  }, [entered, step?.id, anchorKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const measure = useCallback(() => {
    const layer = layerRef.current, popover = popoverRef.current;
    if (!layer || !popover) return;
    let element = targetRef.current;
    if (element && (!element.isConnected || !element.getBoundingClientRect().height)) {
      // The page re-rendered the anchor; follow the new element.
      element = findAnchor(rootRef.current, anchors);
      targetRef.current = element;
    }
    const view = layer.getBoundingClientRect();
    const bounds = { width: view.width, height: view.height };
    const box = element?.getBoundingClientRect();
    const relative = box ? { left: box.left - view.left, top: box.top - view.top, width: box.width, height: box.height } : null;
    const spot = spotlightBox(relative, bounds);
    const size = { width: popover.offsetWidth, height: popover.offsetHeight };
    const place = placePopover({ target: spot, popover: size, bounds, prefer: step?.placement });
    // The caret points at the middle of the spotlight's visible edge.
    const along = (start, length, offset, extent) => Math.round(Math.min(Math.max(start + length / 2 - offset, 22), extent - 22));
    const caret = !spot ? null : place.side === "bottom" || place.side === "top" ? along(spot.left, spot.width, place.left, size.width)
      : place.side === "right" || place.side === "left" ? along(spot.top, spot.height, place.top, size.height) : null;
    setLayout((previous) => previous && sameBox(previous.spot, spot) && previous.place.left === place.left && previous.place.top === place.top &&
      previous.place.side === place.side && previous.caret === caret ? previous : { spot, place, caret });
  }, [anchorKey, step?.placement]); // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => { measure(); }, [measure, target, step?.id, top, entered]);
  useEffect(() => {
    let frame = 0;
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); };
    const timer = setInterval(schedule, 300);
    window.addEventListener("resize", schedule);
    document.addEventListener("scroll", schedule, true);
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(schedule) : null;
    if (observer && popoverRef.current) observer.observe(popoverRef.current);
    if (observer && target) observer.observe(target);
    return () => {
      cancelAnimationFrame(frame);
      clearInterval(timer);
      window.removeEventListener("resize", schedule);
      document.removeEventListener("scroll", schedule, true);
      observer?.disconnect();
    };
  }, [measure, target]);

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
  const place = layout?.place;
  const centred = !anchors.length;
  const layer = (
    <div ref={layerRef} className={cx("tour-layer", centred && "is-centred", !layout && "is-measuring")}>
      {layout?.spot ? <div className="tour-spot" style={{ left: layout.spot.left, top: layout.spot.top, width: layout.spot.width, height: layout.spot.height }} />
        : centred && <div className="tour-shade" />}
      <TourPopover key={step.id} step={step} index={index} total={steps.length} model={model} sampleLoaded={sampleLoaded} busy={busy}
        popoverRef={popoverRef} docked={place?.docked} side={place?.side} onKeyDown={onKeyDown}
        style={place && !place.docked ? { left: place.left, top: place.top, ...(layout.caret != null ? { "--tour-caret": `${layout.caret}px` } : {}) }
          : undefined}
        onNext={next} onBack={() => onMove(-1)} onClose={() => onClose("close")} onSkip={() => onClose("skip")}
        onLoadSample={onLoadSample} onBrowse={onBrowse} onImport={onImport} onRemoveSample={onRemoveSample} />
      <p className="sr-only" role="status" aria-live="polite">{uiFormat("功能导览 · 第 {0} / {1} 步：{2}", [index + 1, steps.length, ui(step.title)])}</p>
    </div>
  );
  return top?.dialog ? createPortal(layer, top.dialog) : layer;
}
