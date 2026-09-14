import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import css from "./graph.css";
import { useInjectCss, LEVEL_LABEL, LEVELS } from "./shared.js";
import {
  layoutStructure,
  layoutPath,
  pathColumns,
  fitScale,
  clampScale,
  bez,
  idTail,
  ZOOM_MIN,
  ZOOM_MAX,
} from "./graph-layout.js";

/* Knowledge graph / study path, rendered as a sideways fork: decks on the
   left, topics fanning right, each topic branching into its card leaves.
   Data comes from call("graph", {scope, mode}); layout lives in
   ui/graph-layout.js (column-packed, so the sheet grows sideways instead of
   becoming a ribbon). The panel view scrolls the whole drawing; 「大画布」
   promotes the section to a real browser fullscreen canvas with zoom, pan and
   fit, which is the only way to see a library's whole structure at once.
   CSS is injected once with a <style data-study-graph> marker. */

const levelOf = (node) => {
  if (node && LEVELS.includes(node.level)) return node.level;
  // Deck/topic nodes carry mastery instead of a level: derive the bucket.
  if (!node || !node.total) return "new";
  const m = node.mastery || 0;
  return m >= 80 ? "mastered" : m >= 60 ? "familiar" : m >= 30 ? "learning" : "weak";
};
const metaOf = (node) => {
  const bits = [];
  if (node?.mastery != null) bits.push(`掌握 ${node.mastery}%`);
  if (node?.due) bits.push(`${node.due} 待复习`);
  if (!bits.length && node?.total != null) bits.push(`${node.total} 题`);
  return bits.join(" · ");
};
const fitLabel = (t, max) => {
  const s = String(t ?? "");
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
};
const ZOOM_STEP = 1.25;

/* ── component ────────────────────────────────────────────────────────── */
export default function Graph({
  call,
  busy,
  scope,
  onClose,
  onStudyCard,
  canvasWanted,
  onCanvasHandled,
}) {
  useInjectCss(css, "study-graph");
  const [mode, setMode] = useState("structure");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [full, setFull] = useState(false);
  const [scale, setScale] = useState(1);
  const [viewport, setViewport] = useState({ w: 0, h: 0 });
  const seq = useRef(0);
  const canvasRef = useRef(null);
  const viewRef = useRef(null);
  const scaleRef = useRef(1);
  const dragRef = useRef(null);
  const suppressClick = useRef(false);
  const autoTried = useRef(false);
  const lastFit = useRef("");
  const fittedScale = useRef(1);
  const scopeKey = JSON.stringify(scope || []);

  const load = useCallback(async () => {
    const n = ++seq.current;
    setLoading(true);
    setError("");
    try {
      const d = await call("graph", { scope: scope || [], mode });
      if (seq.current !== n) return; // a newer request superseded this one
      setData(d);
    } catch (e) {
      if (seq.current !== n) return;
      setError(e?.message || String(e));
      setData(null);
    } finally {
      if (seq.current === n) setLoading(false);
    }
  }, [call, mode, scopeKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    load();
  }, [load]);

  /* The drawing is measured, not guessed: the viewport size drives both the
     path row length and the fit scale. */
  useEffect(() => {
    const el = viewRef.current;
    if (!el) return;
    const measure = () => setViewport({ w: el.clientWidth, h: el.clientHeight });
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const sync = () => setFull(document.fullscreenElement === canvasRef.current);
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);

  useEffect(() => {
    canvasRef.current?.focus?.({ preventScroll: true });
  }, []);

  const layout = useMemo(() => {
    if (!data || !Array.isArray(data.nodes)) return null;
    return (data.mode || mode) === "path"
      ? layoutPath(data.nodes, data.edges || [], pathColumns(viewport.w))
      : layoutStructure(data.nodes, data.edges || [], {
          viewportW: viewport.w,
          viewportH: viewport.h,
        });
  }, [data, mode, viewport.w, viewport.h]);

  const fitView = useCallback(() => {
    const el = viewRef.current;
    if (!el || !layout) return;
    const next = fitScale(layout.width, layout.height, el.clientWidth, el.clientHeight, 28);
    scaleRef.current = next;
    fittedScale.current = next;
    setScale(next);
    // Content that still overflows (a clamped minimum scale) starts centred.
    requestAnimationFrame(() => {
      el.scrollLeft = Math.max(0, (layout.width * next - el.clientWidth) / 2);
      el.scrollTop = Math.max(0, (layout.height * next - el.clientHeight) / 2);
    });
  }, [layout]);

  /* Fit once per drawing, mode and fullscreen transition, and again when the
     viewport settles after a resize — but never after the reader zoomed in
     themselves, so their scale and place survive. */
  useEffect(() => {
    if (!layout || !viewport.w || !viewport.h) return;
    const key = `${full ? "canvas" : "panel"}:${data?.mode || mode}:${layout.width}x${layout.height}`;
    const untouched = Math.abs(scale - fittedScale.current) < 1e-6;
    if (lastFit.current === key && !untouched) return;
    lastFit.current = key;
    fitView();
  }, [layout, viewport.w, viewport.h, full, mode, data, scale, fitView]);

  const applyZoom = useCallback((value, focus) => {
    const el = viewRef.current;
    const next = clampScale(value);
    if (!el || next === scaleRef.current) return;
    const rect = el.getBoundingClientRect();
    const cx = focus ? focus.x - rect.left : el.clientWidth / 2;
    const cy = focus ? focus.y - rect.top : el.clientHeight / 2;
    const anchorX = el.scrollLeft + cx;
    const anchorY = el.scrollTop + cy;
    const k = next / scaleRef.current;
    scaleRef.current = next;
    setScale(next);
    requestAnimationFrame(() => {
      el.scrollLeft = anchorX * k - cx;
      el.scrollTop = anchorY * k - cy;
    });
  }, []);

  /* Ctrl/⌘+wheel zooms around the pointer; a plain wheel keeps scrolling, so
     the canvas behaves like the rest of the page until asked to scale. */
  useEffect(() => {
    const el = viewRef.current;
    if (!el) return;
    const onWheel = (ev) => {
      if (!(ev.ctrlKey || ev.metaKey)) return;
      ev.preventDefault();
      applyZoom(scaleRef.current * (ev.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP), {
        x: ev.clientX,
        y: ev.clientY,
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [applyZoom]);

  const enterCanvas = useCallback(async () => {
    const el = canvasRef.current;
    if (!el) return false;
    setNotice("");
    if (document.fullscreenElement === el) return true;
    if (!el.requestFullscreen) {
      setNotice("当前浏览器不支持全屏画布，用 Ctrl/⌘+滚轮缩放查看。");
      return false;
    }
    try {
      await el.requestFullscreen();
      return true;
    } catch {
      setNotice("浏览器没有进入全屏，可继续在面板中查看，或再次点「大画布」。");
      return false;
    }
  }, []);

  const toggleCanvas = useCallback(async () => {
    if (document.fullscreenElement === canvasRef.current) {
      await document.exitFullscreen?.();
      return;
    }
    await enterCanvas();
  }, [enterCanvas]);

  /* Opened from the study map: the click that navigated here is the user
     gesture that lets the canvas take the screen, so try it once on mount and
     hand the intent back either way. A refusal degrades to the panel view. */
  useEffect(() => {
    if (!canvasWanted || autoTried.current) return;
    autoTried.current = true;
    enterCanvas().finally(() => onCanvasHandled?.());
  }, [canvasWanted, enterCanvas, onCanvasHandled]);

  const onKeyDown = (ev) => {
    if (ev.key === "Escape") {
      // In fullscreen the browser owns Escape and leaves the canvas itself.
      if (document.fullscreenElement === canvasRef.current) return;
      ev.stopPropagation();
      onClose?.();
      return;
    }
    if (ev.target !== ev.currentTarget && ev.target?.closest?.("button")) return;
    if (ev.key === "+" || ev.key === "=") {
      ev.preventDefault();
      applyZoom(scaleRef.current * ZOOM_STEP);
    } else if (ev.key === "-" || ev.key === "_") {
      ev.preventDefault();
      applyZoom(scaleRef.current / ZOOM_STEP);
    } else if (ev.key === "0") {
      ev.preventDefault();
      fitView();
    }
  };

  /* Drag anywhere (including over a node) pans the sheet; a press that never
     moves stays a click, so opening a card is unaffected. */
  const onPointerDown = (ev) => {
    if (ev.button !== 0) return;
    const el = viewRef.current;
    if (!el) return;
    dragRef.current = {
      id: ev.pointerId,
      x: ev.clientX,
      y: ev.clientY,
      left: el.scrollLeft,
      top: el.scrollTop,
      moved: false,
    };
  };
  const onPointerMove = (ev) => {
    const d = dragRef.current;
    const el = viewRef.current;
    if (!d || !el) return;
    const dx = ev.clientX - d.x;
    const dy = ev.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    if (!d.moved) {
      d.moved = true;
      el.classList.add("is-panning");
      el.setPointerCapture?.(d.id);
    }
    el.scrollLeft = d.left - dx;
    el.scrollTop = d.top - dy;
  };
  const endDrag = () => {
    const d = dragRef.current;
    dragRef.current = null;
    const el = viewRef.current;
    if (el) {
      el.classList.remove("is-panning");
      try {
        if (d) el.releasePointerCapture?.(d.id);
      } catch {}
    }
    if (d?.moved) suppressClick.current = true;
  };
  const onClickCapture = (ev) => {
    if (!suppressClick.current) return;
    suppressClick.current = false;
    ev.preventDefault();
    ev.stopPropagation();
  };

  const study = useCallback(
    (node) => {
      const tail = idTail(node?.id);
      if (tail && onStudyCard) onStudyCard({ deckId: tail[0], cardId: tail[1] });
    },
    [onStudyCard],
  );
  const clickable = !!onStudyCard && !loading && !error;

  const renderNode = (p) => {
    const n = p.node;
    if (p.kind === "deck") {
      const meta = metaOf(n);
      return (
        <g key={p.key} transform={`translate(${p.x} ${p.y - p.h / 2})`}>
          <rect className={`gn-node gn-deck gn-${levelOf(n)}`} width={p.w} height={p.h} rx={12} />
          <text className="gn-label gn-deck-label" x={12} y={20}>
            {fitLabel(n.label, 15)}
          </text>
          <text className="gn-meta" x={12} y={37}>
            {fitLabel(meta, 22)}
          </text>
          <title>{[n.label, meta].filter(Boolean).join(" · ")}</title>
        </g>
      );
    }
    if (p.kind === "topic" || p.kind === "ghost") {
      const tail = idTail(n.id);
      const label = n.ghost ? n.label : n.label || tail?.[1] || "未命名主题";
      const meta = n.ghost ? "" : metaOf(n);
      return (
        <g key={p.key} transform={`translate(${p.x} ${p.y - p.h / 2})`}>
          <rect
            className={`gn-node gn-topic ${n.ghost ? "gn-ghost" : `gn-${levelOf(n)}`}`}
            width={p.w}
            height={p.h}
            rx={9}
          />
          <text className={`gn-label${n.ghost ? " gn-ghost-label" : ""}`} x={10} y={14}>
            {fitLabel(label, 14)}
          </text>
          <text className="gn-meta" x={10} y={28}>
            {fitLabel(meta, 18)}
          </text>
          <title>{[label, meta].filter(Boolean).join(" · ")}</title>
        </g>
      );
    }
    // card (structure) / pcard (path): clickable leaf
    const lvl = `gn-${levelOf(n)}`;
    const fullText = n.objective || n.prompt || n.label || "";
    const cap =
      p.kind === "pcard"
        ? fitLabel([n.deckTitle, n.topic].filter(Boolean).join(" › "), 15) ||
          LEVEL_LABEL[levelOf(n)]
        : null;
    return (
      <g
        key={p.key}
        transform={`translate(${p.x} ${p.y - p.h / 2})`}
        className={clickable ? "gn-clickable" : undefined}
        role={clickable ? "button" : undefined}
        tabIndex={clickable ? 0 : undefined}
        aria-label={fullText}
        onClick={clickable ? () => study(n) : undefined}
        onKeyDown={
          clickable
            ? (ev) => {
                if (ev.key === "Enter" || ev.key === " ") {
                  ev.preventDefault();
                  ev.stopPropagation();
                  study(n);
                }
              }
            : undefined
        }
      >
        <rect
          className={`gn-node ${p.kind === "pcard" ? "gn-topic" : "gn-card"} ${lvl}`}
          width={p.w}
          height={p.h}
          rx={p.kind === "pcard" ? 14 : p.h / 2}
        />
        {p.kind === "pcard" ? (
          <>
            <text className="gn-label" x={12} y={20}>
              {fitLabel(`${p.step}. ${n.label || ""}`, 14)}
            </text>
            <text className="gn-meta" x={12} y={36}>
              {cap}
            </text>
          </>
        ) : (
          <text className="gn-label gn-card-label" x={12} y={p.h / 2 + 4}>
            {fitLabel(n.label, 19)}
          </text>
        )}
        <title>
          {p.kind === "pcard"
            ? [`${p.step}. ${fullText}`, cap].filter(Boolean).join("\n")
            : fullText}
        </title>
      </g>
    );
  };

  const scopeCount = (data?.scope || scope || []).length;
  const scopeLabel = scopeCount
    ? `已选 ${scopeCount} 项范围`
    : "全部题组（未归档）";
  const nodeCount = layout?.placed.length || 0;

  return (
    <section
      className={"graph" + (full ? " graph-canvas" : "")}
      ref={canvasRef}
      tabIndex={-1}
      aria-busy={busy || loading}
      aria-label="知识图谱画布"
      onKeyDown={onKeyDown}
    >
      <div className="graph-toolbar">
        <div className="graph-modes" role="group" aria-label="视图模式">
          <button
            className={"graph-mode" + (mode === "structure" ? " active" : "")}
            aria-pressed={mode === "structure"}
            disabled={busy}
            onClick={() => setMode("structure")}
          >
            知识结构
          </button>
          <button
            className={"graph-mode" + (mode === "path" ? " active" : "")}
            aria-pressed={mode === "path"}
            disabled={busy}
            onClick={() => setMode("path")}
          >
            学习路径
          </button>
        </div>
        <div className="graph-zoom" role="group" aria-label="缩放">
          <button
            type="button"
            disabled={!layout}
            title="缩小（-）"
            aria-label="缩小"
            onClick={() => applyZoom(scaleRef.current / ZOOM_STEP)}
          >
            −
          </button>
          <span className="graph-zoom-value">{Math.round(scale * 100)}%</span>
          <button
            type="button"
            disabled={!layout}
            title="放大（+）"
            aria-label="放大"
            onClick={() => applyZoom(scaleRef.current * ZOOM_STEP)}
          >
            ＋
          </button>
          <button
            type="button"
            className="graph-fit"
            disabled={!layout}
            title="缩放到刚好看到整张图（0）"
            onClick={fitView}
          >
            适应窗口
          </button>
        </div>
        <div className="graph-actions">
          <button
            type="button"
            className={full ? "" : "primary"}
            title={
              full
                ? "回到面板中查看（Esc）"
                : "用整个屏幕看这张图，可缩放、拖拽"
            }
            onClick={toggleCanvas}
          >
            {full ? "退出大画布" : "大画布"}
          </button>
          <button type="button" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>

      <div className="graph-toolbar graph-toolbar-sub">
        <span className="graph-scope">
          {scopeLabel}
          {nodeCount ? ` · ${nodeCount} 个节点` : ""}
          {layout?.columns ? ` · ${layout.columns} 列` : ""}
        </span>
        <div className="graph-legend" aria-label="图例">
          {LEVELS.map((l) => (
            <span key={l} className="graph-legend-item">
              <i className={`graph-swatch gn-${l}`} />
              {LEVEL_LABEL[l]}
            </span>
          ))}
          <span className="graph-legend-item">
            <svg className="graph-line-demo" width="26" height="8" aria-hidden="true">
              <line x1="1" y1="4" x2="25" y2="4" className="gn-prereq" />
            </svg>
            前置（虚线箭头）
          </span>
        </div>
      </div>

      {notice && <div className="graph-notice">{notice}</div>}
      {!!data?.truncated && (
        <div className="graph-truncated">
          题目超过 400 张，画布只画前 400 张；在目录里选定范围可查看全部。
        </div>
      )}

      <div
        className="graph-viewport"
        ref={viewRef}
        data-full={full ? "1" : undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
        onClickCapture={onClickCapture}
      >
        {loading ? (
          <div className="graph-state">正在生成图谱…</div>
        ) : error ? (
          <div className="graph-state graph-error">
            <div>图谱加载失败：{error}</div>
            <button onClick={load}>重试</button>
          </div>
        ) : !layout || !layout.placed.length ? (
          <div className="graph-state">当前范围内没有可展示的题目。</div>
        ) : (
          <div
            className="graph-plane"
            style={{ width: layout.width * scale, height: layout.height * scale }}
          >
            <svg
              className="graph-svg"
              width={layout.width}
              height={layout.height}
              viewBox={`0 0 ${layout.width} ${layout.height}`}
              style={{ transform: `scale(${scale})` }}
              role="img"
              aria-label={mode === "path" ? "学习路径图" : "知识结构图"}
            >
              <defs>
                <marker
                  id="gn-arrow-prereq"
                  viewBox="0 0 8 8"
                  refX="7"
                  refY="3"
                  markerWidth="8"
                  markerHeight="8"
                  orient="auto"
                >
                  <path d="M0,0 L7,3 L0,6 Z" className="gn-arrow gn-arrow-prereq" />
                </marker>
                <marker
                  id="gn-arrow-order"
                  viewBox="0 0 8 8"
                  refX="7"
                  refY="3"
                  markerWidth="8"
                  markerHeight="8"
                  orient="auto"
                >
                  <path d="M0,0 L7,3 L0,6 Z" className="gn-arrow gn-arrow-order" />
                </marker>
              </defs>

              {(data.mode || mode) === "path" ? (
                <>
                  {layout.orderPaths.map((d, i) => (
                    <path key={`o${i}`} className="gn-order" markerEnd="url(#gn-arrow-order)" d={d} />
                  ))}
                  {layout.prereqEdges.map((e, i) => {
                    const a = layout.posOf.get(e.from);
                    const b = layout.posOf.get(e.to);
                    return (
                      <path
                        key={`p${i}`}
                        className="gn-prereq"
                        markerEnd="url(#gn-arrow-prereq)"
                        d={bez(a.x + a.w, a.y, b.x, b.y)}
                      >
                        <title>前置关系</title>
                      </path>
                    );
                  })}
                </>
              ) : (
                <>
                  {layout.treeEdges.map((e, i) => {
                    const a = layout.posOf.get(e.from);
                    const b = layout.posOf.get(e.to);
                    return <path key={`t${i}`} className="gn-tree" d={bez(a.x + a.w, a.y, b.x, b.y)} />;
                  })}
                  {layout.prereqEdges.map((e, i) => {
                    const a = layout.posOf.get(e.from);
                    const b = layout.posOf.get(e.to);
                    return (
                      <path
                        key={`p${i}`}
                        className="gn-prereq"
                        markerEnd="url(#gn-arrow-prereq)"
                        d={bez(a.x + a.w, a.y, b.x, b.y)}
                      >
                        <title>前置关系</title>
                      </path>
                    );
                  })}
                </>
              )}

              {layout.placed.map(renderNode)}
            </svg>
          </div>
        )}
      </div>

      <div className="graph-hint">
        {full
          ? "滚轮滚动 · Ctrl/⌘+滚轮缩放 · 拖拽平移 · Esc 退出大画布"
          : `拖拽或滚动查看 · Ctrl/⌘+滚轮缩放 · 缩放范围 ${Math.round(ZOOM_MIN * 100)}–${Math.round(ZOOM_MAX * 100)}%`}
      </div>
    </section>
  );
}
