import { ui, uiFormat, getUiLanguage } from "./i18n.js";
import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import Icon from "./components/Icon.jsx";
import { Button, IconButton, TabPanel, Tabs } from "./components/index.js";
import { skeletonSpine, spineCounts, readSpineOpen, writeSpineOpen } from "./skeleton-spine.js";
import { ReadingBlock, ReadingSettingsButton } from "./reading-settings/ReadingSettings.jsx";

/* 脉络：一条学习主线。一行站点条（编号圆点 + 短标题）加一个"当前站"详情：
   站点条随时标出走到第几站，详情里读到这一站的说明和全部要点（一个字都不截断）。
   折叠时只剩一行摘要和一个可前后切换的当前站小条，课文不会被它挤到屏幕下面。
   "展开全部"把每一站的要点竖着列出来，需要通览时一次看完。 */

function Branch({ items, onPractice }) {
  if (!items.length) return null;
  return (
    <ul className="spine-branch">
      {items.map((item) => (
        <li key={item.id} className={"spine-point d" + Math.min(item.depth, 3)}>
          <div className="spine-point-body">
            <strong>{item.term}</strong>
            {item.meaning && <span className="spine-meaning">{item.meaning}</span>}
            {item.contrasts.length > 0 && (
              <span className="spine-contrast">{ui("对比 · ")}{item.contrasts.join("、")}</span>
            )}
            {onPractice && item.subtreeCards.length > 0 && (
              <Button variant="link" size="sm" className="spine-practice" onClick={() => onPractice(item.subtreeCards)}>{ui("练 ")}{item.subtreeCards.length}{ui(" 题")}</Button>
            )}
          </div>
          <Branch items={item.children} onPractice={onPractice} />
        </li>
      ))}
    </ul>
  );
}

/** A station's own description, its practice link and every point under it. */
function StationBody({ station, onPractice }) {
  return (
    <>
      {station.meaning && <p className="spine-station-meaning">{station.meaning}</p>}
      {onPractice && station.subtreeCards.length > 0 && (
        <Button variant="link" size="sm" className="spine-practice spine-station-practice" onClick={() => onPractice(station.subtreeCards)}>{ui("学这一站 · ")}{station.subtreeCards.length}{ui(" 题 →")}</Button>
      )}
      <Branch items={station.children} onPractice={onPractice} />
    </>
  );
}

/** "5 站 · 8 个要点" as one string (no empty text nodes between the numbers). */
function countLabel(stations, points) {
  const text = uiFormat("{0} 站 · {1} 个要点", [stations, points]);
  return getUiLanguage() === "en" ? text.replace(/\b1 stations\b/, "1 station").replace(/\b1 key points\b/, "1 key point") : text;
}

const reducedMotion = () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/* `stepKind` makes the spine collapsible and remembers its fold per browser and per step type (open by default only where
   the skeleton is the subject, folded to one line in lessons). Without it (the 知识骨架 page) it is simply open. `heading`
   is the folded line's label; `children` (an overview) sit above the strip when open. */
export default function SkeletonSpine({ skeleton, onPractice, stepKind, heading, className, children }) {
  const stations = useMemo(() => skeletonSpine(skeleton), [skeleton]);
  const { points } = useMemo(() => spineCounts(stations), [stations]);
  const uid = useId();
  const collapsible = stepKind !== undefined;
  const stored = useMemo(() => (collapsible ? readSpineOpen(stepKind) : true), [collapsible, stepKind]);
  const [folds, setFolds] = useState({});
  const [current, setCurrent] = useState(0);
  const [all, setAll] = useState(false);
  const [edges, setEdges] = useState({ start: false, end: false });
  const strip = useRef(null);
  const count = stations.length;
  const open = !collapsible || (folds[stepKind] ?? stored);
  const index = Math.min(current, Math.max(0, count - 1));

  const measureEdges = () => {
    const el = strip.current;
    if (!el) return;
    const next = { start: el.scrollLeft > 2, end: el.scrollLeft + el.clientWidth < el.scrollWidth - 2 };
    setEdges((prev) => (prev.start === next.start && prev.end === next.end ? prev : next));
  };
  // Keep the current tab inside the strip, and tell the strip's edges whether more stations hide beyond them.
  useEffect(() => {
    const box = strip.current, tab = box?.querySelector('[aria-selected="true"]');
    if (!box || !tab) return;
    const pad = 36;
    const left = tab.offsetLeft, right = left + tab.offsetWidth;
    let target = null;
    if (left < box.scrollLeft + pad) target = Math.max(0, left - pad);
    else if (right > box.scrollLeft + box.clientWidth - pad) target = right - box.clientWidth + pad;
    if (target !== null) box.scrollTo({ left: target, behavior: reducedMotion() ? "auto" : "smooth" });
    measureEdges();
  }, [index, open, all]);
  useEffect(() => {
    const box = strip.current;
    if (!box || typeof ResizeObserver === "undefined") return undefined;
    const watch = new ResizeObserver(measureEdges);
    watch.observe(box);
    return () => watch.disconnect();
  }, [open, all]);

  if (!count) return null;
  const station = stations[index];
  const bodyId = `${uid}-body`;
  const select = (to) => setCurrent(Math.max(0, Math.min(count - 1, to)));
  const toggle = () => {
    const next = !open;
    setFolds((prev) => ({ ...prev, [stepKind]: next }));
    writeSpineOpen(stepKind, next);
  };
  const arrow = (dir, className, label) => (
    <IconButton icon={dir < 0 ? "chevron-left" : "chevron"} size="sm" className={className} label={label} disabled={dir < 0 ? index === 0 : index === count - 1} onClick={() => select(index + dir)} />
  );

  return (
    <section className={"spine" + (open ? " is-open" : " is-folded") + (className ? " " + className : "")} aria-label={uiFormat("学习脉络：{0}", [skeleton.title])}>
      <div className="spine-bar">
        {collapsible ? (
          <Button variant="quiet" wrap align="start" className="spine-toggle" aria-expanded={open} aria-controls={bodyId} onClick={toggle}
            icon={<Icon name="chevron" size={16} className="spine-chevron" />}>
            <span className="spine-label">
              <span className="spine-heading">{heading || ui("学习脉络")}</span>
              <span className="spine-count">{countLabel(count, points)}</span>
            </span>
          </Button>
        ) : (
          <span className="spine-count">{countLabel(count, points)}</span>
        )}
        {open && count > 1 && (
          <span className="spine-bar-tools">
            <span className="spine-pos" aria-live="polite">{uiFormat("{0} / {1}", [index + 1, count])}</span>
            <Button variant="link" size="sm" className="spine-all-toggle" aria-expanded={all} onClick={() => setAll((value) => !value)}>{all ? ui("只看一站") : ui("展开全部")}</Button>
          </span>
        )}
        {open && <ReadingSettingsButton className="spine-reading" />}
        {!open && count > 1 && (
          <span className="spine-chip" role="group" aria-label={ui("当前站")}>
            {arrow(-1, "spine-arrow spine-chip-prev", ui("上一站"))}
            <span className="spine-chip-text" title={station.term} aria-live="polite">{`${index + 1} / ${count} · ${station.term}`}</span>
            {arrow(1, "spine-arrow spine-chip-next", ui("下一站"))}
          </span>
        )}
      </div>
      {open && (
        <div className="spine-body" id={bodyId}>
          {children}
          {all ? (
            <ol className="spine-all">
              {stations.map((item, i) => (
                <li key={item.id} className="spine-station" aria-current={i === index ? "step" : undefined}>
                  <details open>
                    <summary>
                      <span className="spine-marker" aria-hidden="true">{item.step}</span>
                      <span className="spine-all-title">{item.term}</span>
                    </summary>
                    <ReadingBlock className="spine-all-body"><StationBody station={item} onPractice={onPractice} /></ReadingBlock>
                  </details>
                </li>
              ))}
            </ol>
          ) : (
            <>
              <div className="spine-nav">
                {count > 1 && arrow(-1, "spine-arrow spine-prev", ui("上一站"))}
                <div className="spine-strip" ref={strip} data-start={edges.start ? "1" : undefined} data-end={edges.end ? "1" : undefined} onScroll={measureEdges}>
                  <Tabs id={uid} className="spine-track" itemClassName="spine-tab" label={ui("学习站点")} wrap={false} value={index} onChange={select}
                    items={stations.map((item, i) => ({
                      value: i, ariaLabel: `${item.step}. ${item.term}`, tooltip: item.term,
                      content: <>
                        <span className="spine-marker" aria-hidden="true">{item.step}</span>
                        <span className="spine-tab-title" aria-hidden="true">{item.term}</span>
                      </>,
                    }))} />
                </div>
                {count > 1 && arrow(1, "spine-arrow spine-next", ui("下一站"))}
              </div>
              <TabPanel as={ReadingBlock} id={uid} value={index} selected={index} className="spine-detail" tabIndex={undefined}>
                <h4 className="spine-detail-title">{station.term}</h4>
                <StationBody station={station} onPractice={onPractice} />
              </TabPanel>
            </>
          )}
        </div>
      )}
    </section>
  );
}
