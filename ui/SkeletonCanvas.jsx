import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Markdown from "./Markdown.jsx";
import { CLASS, SEQ, classComponents, visibleClasses, routeClassEdge, layoutClasses, layoutFocus, layoutSequence } from "./skeleton-diagrams.js";

/* 知识骨架的两张可交互图：UML 类图（概念结构）+ UML 时序图（动态链路）。
   两张图都能拖动平移、Ctrl/⌘+滚轮或按钮缩放；类图里的概念框可以拖开摆位
   （记在本机），悬停高亮关联，点选看释义、属性、关系和关联题；时序图可以
   逐步播放，当前一步高亮、后面的步骤变淡，参与者可以跳到对应概念。 */

// SVG marker ids must be unique per diagram; a ref-held counter works on any React.
let markerSeq = 0;
const useMarkerPrefix = (name) => {
  const ref = useRef("");
  if (!ref.current) ref.current = `${name}${++markerSeq}`;
  return ref.current;
};
const ZOOM_MIN = 0.02,
  ZOOM_MAX = 2.5;
const clamp = (k) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, k));
const RELATION_TEXT = { "part-of": "属于", causes: "导致", contrasts: "对比", prerequisite: "是…的前置", "example-of": "是…的例子", related: "相关" };
// The same relation read from the other end, e.g. A 导致 B shows on B as 起因 A.
const RELATION_IN = { "part-of": "包含", causes: "起因", contrasts: "对比", prerequisite: "之后可学", "example-of": "例子", related: "相关" };
const LEGEND = [
  ["generalization", "泛化：是一种"],
  ["composition", "组成：是…的一部分"],
  ["dependency", "依赖：导致 / 前置"],
  ["realization", "实现：是…的例子"],
  ["association", "关联：对比 / 相关"],
];

function usePanZoom(width, height, { maxFit = 1.2, insetRight = 0, minInitial = 0.9, anchorX = 0, anchorY = 0, vertical = false } = {}) {
  const viewRef = useRef(null),
    drag = useRef(null);
  const [view, setView] = useState({ k: 1, x: 0, y: 0 });
  const [viewport, setViewport] = useState({ w: 0, h: 0 });
  const fit = useCallback((initial = false, bounds = { w: width, h: height }) => {
    const el = viewRef.current;
    if (!el || !width || !height) return;
    // insetRight keeps the drawing clear of an overlay panel on the right.
    const inset = el.clientWidth < 600 ? 0 : Math.min(insetRight, el.clientWidth * 0.6),
      room = el.clientWidth - inset;
    const fitK = Math.min(maxFit, (room - 32) / bounds.w, (el.clientHeight - 32) / bounds.h);
    const k = clamp(Math.max(initial === true ? minInitial : 0, fitK));
    const cropped = initial === true && k > fitK;
    setView({ k,
      x: cropped ? (vertical || room < 600 ? room / 2 : Math.min(room / 4, 160)) - anchorX * k : (room - bounds.w * k) / 2,
      y: cropped ? (vertical ? Math.min(80, el.clientHeight / 4) : el.clientHeight / 2) - anchorY * k : (el.clientHeight - bounds.h * k) / 2,
    });
  }, [width, height, maxFit, insetRight, minInitial, anchorX, anchorY, vertical]);
  useLayoutEffect(() => {
    fit(true);
    const el = viewRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      setViewport((v) => v.w === el.clientWidth && v.h === el.clientHeight ? v : { w: el.clientWidth, h: el.clientHeight });
      if (el.clientWidth && el.clientHeight) fit(true);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [fit]);
  const zoomAt = useCallback((factor, clientX, clientY) => {
    const el = viewRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const cx = clientX === undefined ? el.clientWidth / 2 : clientX - rect.left,
      cy = clientY === undefined ? el.clientHeight / 2 : clientY - rect.top;
    setView((v) => {
      const k = clamp(v.k * factor);
      return { k, x: cx - ((cx - v.x) * k) / v.k, y: cy - ((cy - v.y) * k) / v.k };
    });
  }, []);
  const readable = useCallback(() => {
    setView((v) => {
      const cx = (viewRef.current?.clientWidth || 0) / 2, cy = (viewRef.current?.clientHeight || 0) / 2;
      return { k: 1, x: cx - (cx - v.x) / v.k, y: cy - (cy - v.y) / v.k };
    });
  }, []);
  const moveTo = useCallback((x, y) => {
    const el = viewRef.current;
    if (el) setView((v) => ({ ...v, x: el.clientWidth / 2 - x * v.k, y: el.clientHeight / 2 - y * v.k }));
  }, []);
  useEffect(() => {
    const el = viewRef.current;
    if (!el) return undefined;
    // Ctrl/⌘+wheel zooms; a plain wheel keeps scrolling the page.
    const onWheel = (ev) => {
      if (!(ev.ctrlKey || ev.metaKey)) return;
      ev.preventDefault();
      zoomAt(ev.deltaY < 0 ? 1.15 : 1 / 1.15, ev.clientX, ev.clientY);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt]);
  const panHandlers = {
    onPointerDown: (ev) => {
      if (ev.button !== 0 || ev.target.closest("button, a, input")) return;
      drag.current = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, view };
      ev.currentTarget.setPointerCapture?.(ev.pointerId);
      ev.currentTarget.classList.add("is-panning");
    },
    onPointerMove: (ev) => {
      const d = drag.current;
      if (!d || d.id !== ev.pointerId) return;
      setView({ ...d.view, x: d.view.x + ev.clientX - d.x, y: d.view.y + ev.clientY - d.y });
    },
    onPointerUp: (ev) => {
      if (drag.current?.id !== ev.pointerId) return;
      drag.current = null;
      ev.currentTarget.classList.remove("is-panning");
    },
  };
  panHandlers.onPointerCancel = panHandlers.onPointerUp;
  panHandlers.onKeyDown = (ev) => {
    if (ev.target !== ev.currentTarget) return;
    const delta = { ArrowLeft: [60, 0], ArrowRight: [-60, 0], ArrowUp: [0, 60], ArrowDown: [0, -60] }[ev.key];
    if (delta) { ev.preventDefault(); setView((v) => ({ ...v, x: v.x + delta[0], y: v.y + delta[1] })); }
    else if (ev.key === "+" || ev.key === "=") { ev.preventDefault(); zoomAt(1.2); }
    else if (ev.key === "-") { ev.preventDefault(); zoomAt(1 / 1.2); }
    else if (ev.key === "0") { ev.preventDefault(); fit(); }
  };
  return { viewRef, view, viewport, fit, zoomAt, readable, moveTo, panHandlers };
}

function useCanvasFullscreen() {
  const ref = useRef(null);
  const [expanded, setExpanded] = useState(false);
  const [native, setNative] = useState(false);
  useEffect(() => {
    const sync = () => setNative(document.fullscreenElement === ref.current);
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!expanded || !el?.showPopover) return;
    // A manual popover enters the top layer even when the plugin host uses
    // contain:paint / overflow:hidden and disallows the Fullscreen API.
    el.setAttribute("popover", "manual");
    el.showPopover();
    return () => { el.hidePopover(); el.removeAttribute("popover"); };
  }, [expanded]);
  const toggle = async () => {
    if (document.fullscreenElement === ref.current) { await document.exitFullscreen(); return; }
    if (expanded) { setExpanded(false); return; }
    try {
      if (!ref.current?.requestFullscreen) throw new Error("unsupported");
      await ref.current.requestFullscreen();
    } catch { setExpanded(true); }
  };
  return { ref, expanded, full: expanded || native, toggle, close: () => setExpanded(false) };
}

function ZoomBar({ zoomAt, fit, percent, children }) {
  return (
    <div className="skc-toolbar">
      <button type="button" onClick={() => zoomAt(1 / 1.2)} aria-label="缩小">−</button>
      {percent != null && <output className="skc-zoom-value" aria-label="当前缩放">{percent}%</output>}
      <button type="button" onClick={() => zoomAt(1.2)} aria-label="放大">＋</button>
      <button type="button" onClick={fit}>适应</button>
      {children}
    </div>
  );
}

function Markers({ prefix }) {
  return (
    <defs>
      <marker id={`${prefix}-tri`} viewBox="0 0 12 12" refX="11" refY="6" markerWidth="12" markerHeight="12" orient="auto-start-reverse">
        <path d="M1 1 L11 6 L1 11 Z" className="skc-mark-hollow" />
      </marker>
      <marker id={`${prefix}-diamond`} viewBox="0 0 16 10" refX="15" refY="5" markerWidth="16" markerHeight="10" orient="auto-start-reverse">
        <path d="M1 5 L8 1 L15 5 L8 9 Z" className="skc-mark-solid" />
      </marker>
      <marker id={`${prefix}-open`} viewBox="0 0 12 12" refX="11" refY="6" markerWidth="10" markerHeight="10" orient="auto-start-reverse">
        <path d="M1 1 L11 6 L1 11" className="skc-mark-line" />
      </marker>
      <marker id={`${prefix}-solid`} viewBox="0 0 12 12" refX="11" refY="6" markerWidth="10" markerHeight="10" orient="auto-start-reverse">
        <path d="M1 1 L11 6 L1 11 Z" className="skc-mark-solid" />
      </marker>
    </defs>
  );
}
const MARKER_OF = { generalization: "tri", realization: "tri", composition: "diamond", dependency: "open" };

const MinimapNodes = React.memo(function MinimapNodes({ boxes }) {
  return [...boxes.values()].map((b) => <rect key={b.id} x={b.x} y={b.y} width={b.w} height={b.h} />);
});

const storageKey = (id) => `study-skeleton-layout:${id}`;
function loadPositions(id) {
  try {
    const raw = JSON.parse(localStorage.getItem(storageKey(id)) || "{}");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    return Object.fromEntries(Object.entries(raw).filter(([, p]) => p && Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= 0 && p.y >= 0));
  } catch {
    return {};
  }
}

function useStoredPositions(key) {
  const [snapshot, setSnapshot] = useState(() => ({ key, positions: loadPositions(key) }));
  const positions = useMemo(() => snapshot.key === key ? snapshot.positions : loadPositions(key), [snapshot, key]);
  const update = useCallback((next) => setSnapshot((previous) => {
    const before = previous.key === key ? previous.positions : loadPositions(key);
    return { key, positions: typeof next === "function" ? next(before) : next };
  }), [key]);
  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        if (Object.keys(positions).length) localStorage.setItem(storageKey(key), JSON.stringify(positions));
        else localStorage.removeItem(storageKey(key));
      } catch { /* private mode: layout just is not remembered */ }
    }, 250);
    return () => clearTimeout(timer);
  }, [key, positions]);
  return [positions, update];
}

const FRESH_MS = 30 * 60 * 1000;
const EXTEND_INTENTS = [
  ["contrast", "和另一个概念对比", "对比对象，例如 BASE、Active/Passive…"],
  ["enrich", "补充/修正这个概念", "想补什么或哪里不对…"],
  ["cards", "为它补题", "想练到什么，例如计算题、场景判断…"],
];

/** The ask-the-conversation box inside a concept's detail panel. */
function ExtendBox({ node, onAsk }) {
  const [intent, setIntent] = useState("contrast"),
    [value, setValue] = useState(""),
    [sent, setSent] = useState(false);
  useEffect(() => {
    setValue("");
    setSent(false);
  }, [node.id]);
  const placeholder = EXTEND_INTENTS.find(([id]) => id === intent)[2];
  return (
    <div className="skc-extend">
      <h5>在对话中扩展</h5>
      <div className="skc-extend-intents" role="group" aria-label="想做什么">
        {EXTEND_INTENTS.map(([id, label]) => (
          <button key={id} type="button" className={intent === id ? "on" : ""} aria-pressed={intent === id} onClick={() => setIntent(id)}>
            {label}
          </button>
        ))}
      </div>
      <form
        onSubmit={(ev) => {
          ev.preventDefault();
          if (intent === "contrast" && !value.trim()) return;
          onAsk({ nodeId: node.id, term: node.term, intent, text: value.trim() });
          setSent(true);
        }}
      >
        <input value={value} onChange={(ev) => setValue(ev.target.value)} placeholder={placeholder} aria-label={placeholder} />
        <button type="submit" disabled={intent === "contrast" && !value.trim()}>发到对话</button>
      </form>
      {sent && <small className="muted">已交给对话；改好后图会自动刷新并高亮变化。</small>}
    </div>
  );
}

export function ClassCanvas({ skeleton, onPractice, selected, onSelect, onAsk, fresh }) {
  /* Focus view: a big skeleton gets unreadable, so selecting a concept shows
     only it and its direct neighbours, laid out around it. Clicking a
     neighbour walks on; 返回 retraces; 显示全图 (or Esc) goes back to the
     whole diagram. Drags in focus view are temporary; the full layout's are
     remembered on this device. */
  const [focusMode, setFocusMode] = useState(false);
  const [direction, setDirection] = useState("auto");
  const [narrow, setNarrow] = useState(false);
  const [spacing, setSpacing] = useState(1);
  const [showAttributes, setShowAttributes] = useState(() => skeleton.nodes.length <= 12);
  const fullscreen = useCanvasFullscreen();
  const canvasRef = fullscreen.ref;
  useLayoutEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const measure = () => setNarrow(el.clientWidth < 600);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [canvasRef]);
  const flowDirection = direction === "auto" ? (narrow ? "down" : "right") : direction;
  const [componentId, setComponentId] = useState("");
  const [query, setQuery] = useState("");
  const components = useMemo(() => classComponents(skeleton), [skeleton]);
  const component = components.find((group) => group.id === componentId);
  const visibleSkeleton = component || skeleton;
  const focused = focusMode && selected && skeleton.nodes.some((n) => n.id === selected) ? selected : null;
  const fullLayout = useMemo(() => layoutClasses(visibleSkeleton, { direction: flowDirection, spacing, compact: !showAttributes, aspect: narrow ? 0.65 : 1.6 }), [visibleSkeleton, flowDirection, spacing, narrow, showAttributes]);
  const focusLayout = useMemo(() => (focused ? layoutFocus(skeleton, focused, { narrow, compact: !showAttributes }) : null), [skeleton, focused, narrow, showAttributes]);
  const layout = focusLayout || fullLayout;
  const layoutKey = flowDirection === "right" && spacing === 1 && showAttributes ? skeleton.id : `${skeleton.id}:${flowDirection}:${spacing}:${showAttributes}`;
  const [savedPositions, setSavedPositions] = useStoredPositions(layoutKey);
  const [focusPositions, setFocusPositions] = useState({});
  const persistentLayout = !focused && !component;
  const positions = persistentLayout ? savedPositions : focusPositions;
  const setPositions = persistentLayout ? setSavedPositions : setFocusPositions;
  const [hover, setHover] = useState(null);
  const [dragging, setDragging] = useState(false);
  // Closing the detail panel keeps the focus view; clicking the focus reopens it.
  const [detailHidden, setDetailHidden] = useState(false);
  const markerPrefix = useMarkerPrefix("skc");
  const detailOpen = !!selected && !detailHidden;
  const nodeDrag = useRef(null);
  const dragFrame = useRef(null);
  const pendingPosition = useRef(null);
  const flushPosition = () => {
    const pending = pendingPosition.current;
    pendingPosition.current = null;
    if (pending) setPositions((p) => ({ ...p, [pending.id]: pending.position }));
  };
  useEffect(() => () => cancelAnimationFrame(dragFrame.current), []);

  // A trail of focused concepts so 返回 can retrace a walk through neighbours.
  const trail = useRef([]),
    previous = useRef(selected),
    goingBack = useRef(false);
  useEffect(() => {
    if (goingBack.current) goingBack.current = false;
    else if (previous.current && selected && previous.current !== selected) trail.current = [...trail.current, previous.current].slice(-30);
    if (!selected) trail.current = [];
    previous.current = selected;
    setDetailHidden(false);
    setFocusPositions({});
    setHover(null);
  }, [selected, componentId, flowDirection, spacing]);
  const goBack = () => {
    const last = trail.current[trail.current.length - 1];
    if (!last) return;
    trail.current = trail.current.slice(0, -1);
    goingBack.current = true;
    onSelect(last);
  };

  const boxes = useMemo(
    () => new Map(layout.boxes.map((b) => [b.id, positions[b.id] ? { ...b, x: positions[b.id].x, y: positions[b.id].y } : b])),
    [layout, positions],
  );
  const world = useMemo(() => {
    let w = layout.width,
      h = layout.height;
    for (const b of boxes.values()) {
      w = Math.max(w, b.x + b.w + CLASS.margin);
      h = Math.max(h, b.y + b.h + CLASS.margin);
    }
    return { w, h };
  }, [layout, boxes]);
  // Moving a node expands the fit bounds, but does not refit during the drag.
  const anchor = layout.boxes.find((b) => b.id === selected) || layout.boxes[0];
  const { viewRef, view, viewport, fit, zoomAt, readable, moveTo, panHandlers } = usePanZoom(layout.width, layout.height, {
    insetRight: detailOpen ? 310 : 0, anchorX: anchor ? anchor.x + anchor.w / 2 : 0, anchorY: anchor ? anchor.y + anchor.h / 2 : 0, vertical: !focused && flowDirection === "down",
  });
  const fitDrawing = () => fit(false, world);
  const edges = useMemo(
    () =>
      layout.edges.map((e) => routeClassEdge(e, boxes)),
    [layout, boxes],
  );
  const focus = hover || selected;
  const retainedNode = dragging ? nodeDrag.current?.node : selected;
  const visible = useMemo(() => visibleClasses(boxes, edges, view, viewport, retainedNode), [boxes, edges, view, viewport, retainedNode]);
  const neighbours = useMemo(() => {
    if (!focus) return null;
    const set = new Set([focus]);
    for (const e of edges) if (e.from === focus || e.to === focus) set.add(e.from).add(e.to);
    return set;
  }, [focus, edges]);

  const boxHandlers = (b) => ({
    onPointerDown: (ev) => {
      if (ev.button !== 0) return;
      ev.stopPropagation();
      nodeDrag.current = { id: ev.pointerId, node: b.id, x: ev.clientX, y: ev.clientY, bx: b.x, by: b.y, moved: false, focus: focused };
      ev.currentTarget.setPointerCapture?.(ev.pointerId);
    },
    onPointerMove: (ev) => {
      const d = nodeDrag.current;
      if (!d || d.id !== ev.pointerId) return;
      const dx = (ev.clientX - d.x) / view.k,
        dy = (ev.clientY - d.y) / view.k;
      if (!d.moved && Math.hypot(dx, dy) < 3) return;
      if (!d.moved) setDragging(true);
      d.moved = true;
      pendingPosition.current = { id: d.node, position: { x: Math.max(0, d.bx + dx), y: Math.max(0, d.by + dy) } };
      if (dragFrame.current === null) dragFrame.current = requestAnimationFrame(() => {
        dragFrame.current = null;
        flushPosition();
      });
    },
    onPointerUp: (ev) => {
      const d = nodeDrag.current;
      if (!d || d.id !== ev.pointerId) return;
      nodeDrag.current = null;
      cancelAnimationFrame(dragFrame.current);
      dragFrame.current = null;
      flushPosition();
      setDragging(false);
      if (d.moved) return;
      // In focus view a neighbour becomes the new focus; the focus itself stays put.
      if (focused) {
        if (d.node !== focused) onSelect(d.node);
        else setDetailHidden((hidden) => !hidden);
      } else onSelect(selected === d.node ? null : d.node);
    },
    onPointerCancel: () => {
      nodeDrag.current = null;
      cancelAnimationFrame(dragFrame.current);
      dragFrame.current = null;
      pendingPosition.current = null;
      setDragging(false);
    },
    onKeyDown: (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        onSelect(selected === b.id ? null : b.id);
      }
    },
  });

  const node = selected ? skeleton.nodes.find((n) => n.id === selected) : null;
  const term = (id) => skeleton.nodes.find((n) => n.id === id)?.term || id;
  const nodeRelations = node
    ? [
        ...(node.parent ? [{ key: "parent", text: "是一种", other: node.parent }] : []),
        ...skeleton.nodes.filter((n) => n.parent === node.id).map((n) => ({ key: "child-" + n.id, text: "细分为", other: n.id })),
        ...skeleton.relations.flatMap((r, i) =>
          r.from === node.id
            ? [{ key: "r" + i, text: RELATION_TEXT[r.type], other: r.to, note: r.note }]
            : r.to === node.id
              ? [{ key: "r" + i, text: RELATION_IN[r.type], other: r.from, note: r.note }]
              : [],
        ),
      ]
    : [];
  const inSequences = node ? (skeleton.sequences || []).filter((q) => q.participants.some((p) => p.node === node.id)).map((q) => q.title) : [];

  return (
    <div
      className={`skc${narrow ? " skc-narrow" : ""}${!showAttributes ? " skc-compact" : ""}${fullscreen.expanded ? " skc-expanded" : ""}`}
      ref={fullscreen.ref}
      onKeyDown={(ev) => {
        if (ev.key === "Escape" && fullscreen.expanded) { ev.stopPropagation(); fullscreen.close(); return; }
        if (ev.key === "Escape" && selected) {
          ev.stopPropagation();
          onSelect(null);
        }
      }}
    >
      <ZoomBar zoomAt={zoomAt} fit={fitDrawing} percent={Math.round(view.k * 100)}>
        <button type="button" onClick={fullscreen.toggle}>{fullscreen.full ? "退出全屏" : "全屏查看"}</button>
        <details className="skc-layout-menu">
        <summary>布局</summary>
        <div>
        <button type="button" onClick={readable} title="按原始字号阅读，可拖动画布">原始大小</button>
        <label className="skc-attributes-toggle"><input type="checkbox" checked={showAttributes} onChange={(ev) => { setShowAttributes(ev.target.checked); setFocusPositions({}); }} />显示属性</label>
        <select aria-label="布局方向" value={direction} onChange={(ev) => { setDirection(ev.target.value); setFocusMode(false); setFocusPositions({}); }}>
          <option value="auto">自适应方向</option><option value="right">从左到右</option><option value="down">从上到下</option>
        </select>
        <select aria-label="布局间距" value={spacing} onChange={(ev) => { setSpacing(Number(ev.target.value)); setFocusMode(false); setFocusPositions({}); }}>
          <option value="1">标准间距</option><option value="1.6">宽松间距</option>
        </select>
        {!!Object.keys(positions).length && <button type="button" onClick={() => setPositions({})} title="恢复自动排版">
          重置布局
        </button>}
        </div>
        </details>
        {selected && (
          <>
            <span className="skc-sep" />
            {!!trail.current.length && <button type="button" onClick={goBack} title="回到上一个聚焦的概念">
              ← 返回
            </button>}
            <button
              type="button"
              className={focusMode ? "on" : ""}
              aria-pressed={focusMode}
              onClick={() => setFocusMode((v) => !v)}
              title={focusMode ? "显示全部概念，保留选中" : "只看选中概念和它的直接邻居"}
            >
              {focusMode ? "显示全图" : "只看邻居"}
            </button>
            {focusLayout && (
              <span className="skc-focus-chip">
                聚焦「{node?.term}」· {focusLayout.neighbours} 个邻居
              </span>
            )}
          </>
        )}
        <span className="skc-hint">
          {focused ? "点邻居继续走 · Esc 返回" : "拖动平移 · 用 ＋ / − 缩放"}
        </span>
      </ZoomBar>
      <div className="skc-search">
        <input aria-label="查找概念" placeholder="查找概念…" value={query} onChange={(ev) => setQuery(ev.target.value)} />
        {components.length > 1 && <select aria-label="概念分组" value={component?.id || ""} onChange={(ev) => { setComponentId(ev.target.value); setFocusMode(false); onSelect(null); }}>
          <option value="">全部 {components.length} 组</option>
          {components.map((group) => <option key={group.id} value={group.id}>{group.title} · {group.nodes.length} 个概念</option>)}
        </select>}
      </div>
      {query.trim() && <div className="skc-results" aria-label="概念搜索结果">
        {skeleton.nodes.filter((n) => `${n.term} ${n.meaning}`.toLowerCase().includes(query.trim().toLowerCase())).slice(0, 30).map((n) => (
          <button key={n.id} type="button" onClick={() => { setQuery(""); setComponentId(""); setFocusMode(true); onSelect(n.id); }}>{n.term}</button>
        ))}
        {!skeleton.nodes.some((n) => `${n.term} ${n.meaning}`.toLowerCase().includes(query.trim().toLowerCase())) && <span className="muted">没有匹配的概念</span>}
      </div>}
      {!skeleton.nodes.length && <p className="muted" role="status">还没有概念</p>}
      <div className="skc-body">
        <div className="skc-view" ref={viewRef} tabIndex={0} aria-label="概念画布，方向键平移，加减号缩放，0 适应" {...panHandlers} onKeyDown={(ev) => {
          if (ev.target === ev.currentTarget && ev.key === "0") { ev.preventDefault(); fitDrawing(); }
          else panHandlers.onKeyDown(ev);
        }}>
          <div
            className={"skc-world" + (dragging ? " is-dragging" : "")}
            style={{ width: world.w, height: world.h, transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}
          >
            <svg className="skc-edges" width={world.w} height={world.h} aria-hidden="true">
              <Markers prefix={markerPrefix} />
              {!focused && !Object.keys(positions).length && layout.components?.length > 1 && layout.components.map((group) => (
                <g key={group.id}>
                  <rect className="skc-component" x={group.x} y={group.y} width={group.w} height={group.h} rx={16} />
                  <text className="skc-component-title" x={group.x + 24} y={group.y + 26}>{group.title} · {group.count}</text>
                </g>
              ))}
              {visible.edges.map((e, i) => {
                const lit = !neighbours || (neighbours.has(e.from) && neighbours.has(e.to) && (e.from === focus || e.to === focus));
                const marker = MARKER_OF[e.kind];
                return (
                  <g key={i} className={`skc-edge k-${e.kind}${lit ? "" : " dim"}${neighbours && lit ? " lit" : ""}${fresh?.relations.has(`${e.from}>${e.to}>${e.type}`) ? " fresh" : ""}`}>
                    {e.d ? <path d={e.d} markerEnd={marker ? `url(#${markerPrefix}-${marker})` : undefined} /> : <line x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2} markerEnd={marker ? `url(#${markerPrefix}-${marker})` : undefined} />}
                    {(e.label || e.note) && (
                      <text x={e.labelX ?? (e.x1 + e.x2) / 2} y={(e.labelY ?? (e.y1 + e.y2) / 2) - 6} textAnchor="middle">
                        {e.label}
                        {e.note && <title>{e.note}</title>}
                      </text>
                    )}
                  </g>
                );
              })}
            </svg>
            {visible.boxes.map((b) => (
              <button
                key={b.id}
                type="button"
                className={
                  "skc-class" +
                  (selected === b.id ? " selected" : "") +
                  (neighbours && !neighbours.has(b.id) ? " dim" : "") +
                  (b.node.cards.length ? "" : " no-cards") +
                  (fresh?.nodes.has(b.id) ? " fresh" : "")
                }
                style={{ left: b.x, top: b.y, width: b.w, minHeight: b.h }}
                aria-pressed={selected === b.id}
                title={b.node.meaning}
                onMouseEnter={() => setHover(b.id)}
                onMouseLeave={() => setHover(null)}
                onFocus={() => setHover(b.id)}
                onBlur={() => setHover(null)}
                {...boxHandlers(b)}
              >
                <span className="skc-class-name">{b.node.term}</span>
                {showAttributes && (b.node.attributes?.length ? (
                  <span className="skc-class-attrs">
                    {b.node.attributes.map((a, i) => (
                      <span key={i}>+ {a}</span>
                    ))}
                  </span>
                ) : (
                  <span className="skc-class-attrs empty" />
                ))}
                {b.node.cards.length > 0 && <span className="skc-class-count">{b.node.cards.length} 题</span>}
              </button>
            ))}
          </div>
          {layout.boxes.length > 12 && <button type="button" className="skc-minimap" aria-label="小地图：点击定位" onClick={(ev) => {
            const rect = ev.currentTarget.querySelector("svg").getBoundingClientRect();
            moveTo(ev.detail ? (ev.clientX - rect.left) / rect.width * world.w : world.w / 2,
              ev.detail ? (ev.clientY - rect.top) / rect.height * world.h : world.h / 2);
          }}>
            <svg viewBox={`0 0 ${world.w} ${world.h}`} preserveAspectRatio="none" aria-hidden="true">
              <MinimapNodes boxes={boxes} />
              <rect className="skc-minimap-window" x={-view.x / view.k} y={-view.y / view.k} width={viewport.w / view.k} height={viewport.h / view.k} />
            </svg>
          </button>}
        </div>
        {node && !detailHidden && (
          <aside className="skc-detail" aria-label={`概念：${node.term}`}>
            <div className="skc-detail-head">
              <strong>{node.term}</strong>
              <button type="button" className="skc-close" aria-label="收起详情" title="收起详情（再点这个概念可展开）" onClick={() => setDetailHidden(true)}>×</button>
            </div>
            <p>{node.meaning}</p>
            {node.attributes?.length > 0 && (
              <ul className="skc-attrs">
                {node.attributes.map((a, i) => (
                  <li key={i}>{a}</li>
                ))}
              </ul>
            )}
            {nodeRelations.length > 0 && (
              <>
                <h5>关系</h5>
                <ul className="skc-rels">
                  {nodeRelations.map((r) => (
                    <li key={r.key}>
                      <span className="skc-rel-type">{r.text}</span>
                      <button type="button" className="skc-link" onClick={() => onSelect(r.other)}>{term(r.other)}</button>
                      {r.note && <small>{r.note}</small>}
                    </li>
                  ))}
                </ul>
              </>
            )}
            {inSequences.length > 0 && (
              <>
                <h5>出现在时序</h5>
                <p className="small muted">{inSequences.join("、")}</p>
              </>
            )}
            {onAsk && <ExtendBox node={node} onAsk={onAsk} />}
            {node.cards.length > 0 && (
              <button type="button" className="primary skc-practice" onClick={() => onPractice(node.cards)}>
                练关联的 {node.cards.length} 题
              </button>
            )}
          </aside>
        )}
      </div>
      <ul className="skc-legend" aria-label="图例">
        {LEGEND.map(([kind, label]) => (
          <li key={kind} className={`k-${kind}`}>
            <i aria-hidden="true" />
            {label}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function SequenceCanvas({ sequence, nodes, onSelectNode }) {
  const fullscreen = useCanvasFullscreen();
  const layout = useMemo(() => layoutSequence(sequence), [sequence]);
  const [current, setCurrent] = useState(0),
    [playing, setPlaying] = useState(false);
  const markerPrefix = useMarkerPrefix("sqc");
  const { viewRef, view, fit, zoomAt, panHandlers } = usePanZoom(layout.width, layout.height, { maxFit: 1 });
  const total = layout.steps.length;

  useEffect(() => {
    setCurrent(0);
    setPlaying(false);
  }, [sequence]);
  useEffect(() => {
    if (!playing) return undefined;
    const t = setInterval(() => {
      setCurrent((c) => {
        if (c >= total) {
          setPlaying(false);
          return c;
        }
        return c + 1;
      });
    }, 1600);
    return () => clearInterval(t);
  }, [playing, total]);

  const step = current ? layout.steps[current - 1] : null;
  const label = (id) => sequence.participants.find((p) => p.id === id)?.label || id;
  const involved = step ? new Set([step.from, step.to]) : null;
  const onKeyDown = (ev) => {
    if (ev.key === "ArrowRight") {
      ev.preventDefault();
      ev.stopPropagation();
      setPlaying(false);
      setCurrent((c) => Math.min(total, c + 1));
    } else if (ev.key === "ArrowLeft") {
      ev.preventDefault();
      ev.stopPropagation();
      setPlaying(false);
      setCurrent((c) => Math.max(0, c - 1));
    }
  };

  return (
    <div ref={fullscreen.ref} className={`skc sqc${fullscreen.expanded ? " skc-expanded" : ""}`} onKeyDown={(ev) => {
      if (ev.key === "Escape" && fullscreen.expanded) { fullscreen.close(); return; }
      onKeyDown(ev);
    }}>
      <ZoomBar zoomAt={zoomAt} fit={fit} percent={Math.round(view.k * 100)}>
        <button type="button" onClick={fullscreen.toggle}>{fullscreen.full ? "退出全屏" : "全屏查看"}</button>
        <span className="skc-sep" />
        <button type="button" disabled={!current} onClick={() => { setPlaying(false); setCurrent((c) => Math.max(0, c - 1)); }} aria-label="上一步">
          ◀
        </button>
        <button
          type="button"
          className={playing ? "on" : ""}
          disabled={!total}
          onClick={() => {
            if (playing) return setPlaying(false);
            if (current >= total) setCurrent(0);
            setPlaying(true);
          }}
        >
          {playing ? "暂停" : current >= total && total ? "重播" : "播放"}
        </button>
        <button type="button" disabled={current >= total} onClick={() => { setPlaying(false); setCurrent((c) => Math.min(total, c + 1)); }} aria-label="下一步">
          ▶
        </button>
        <button type="button" disabled={!current} onClick={() => { setPlaying(false); setCurrent(0); }}>
          全部
        </button>
        <span className="skc-hint">{current ? `第 ${current} / ${total} 步` : `共 ${total} 步 · ← → 逐步看`}</span>
      </ZoomBar>
      <div className="skc-view sqc-view" ref={viewRef} tabIndex={0} {...panHandlers} onKeyDown={onKeyDown} style={fullscreen.full ? undefined : { height: Math.min(480, Math.max(240, layout.height + 40)) }}>
        <div className="skc-world" style={{ width: layout.width, height: layout.height, transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
          <svg className="skc-edges" width={layout.width} height={layout.height} aria-hidden="true">
            <Markers prefix={markerPrefix} />
            {layout.participants.map((p) => (
              <line key={p.id} className={"sqc-lifeline" + (involved?.has(p.id) ? " lit" : "")} x1={p.x} y1={layout.lifelineTop} x2={p.x} y2={layout.height - SEQ.margin} />
            ))}
            {layout.steps.map((st) => {
              const state = !current ? "" : st.index === current ? " current" : st.index > current ? " future" : " past";
              const marker = st.kind === "call" ? "solid" : "open";
              if (st.self) {
                const d = `M${st.x1} ${st.y} h${SEQ.self} v18 h-${SEQ.self - 2}`;
                return <path key={st.index} className={`sqc-msg k-${st.kind}${state}`} d={d} markerEnd={`url(#${markerPrefix}-${marker})`} />;
              }
              const dir = st.x2 > st.x1 ? 1 : -1;
              return (
                <line
                  key={st.index}
                  className={`sqc-msg k-${st.kind}${state}`}
                  x1={st.x1 + dir * 3}
                  y1={st.y}
                  x2={st.x2 - dir * 3}
                  y2={st.y}
                  markerEnd={`url(#${markerPrefix}-${marker})`}
                />
              );
            })}
          </svg>
          {layout.participants.map((p) => (
            <button
              key={p.id}
              type="button"
              className={"sqc-actor" + (involved?.has(p.id) ? " lit" : "") + (p.node ? " linked" : "")}
              style={{ left: p.x - SEQ.colW / 2 + 8, top: SEQ.margin, width: SEQ.colW - 16, height: SEQ.head }}
              title={p.node ? `${nodes.find((n) => n.id === p.node)?.meaning || ""}（点击在类图中查看）` : p.label}
              onClick={() => p.node && onSelectNode(p.node)}
            >
              {p.label}
            </button>
          ))}
          {layout.steps.map((st) => {
            const state = !current ? "" : st.index === current ? " current" : st.index > current ? " future" : " past";
            const left = st.self ? st.x1 + 6 : Math.min(st.x1, st.x2) + 6;
            const width = st.self ? SEQ.colW - 12 : Math.abs(st.x2 - st.x1) - 12;
            return (
              <button
                key={st.index}
                type="button"
                className={"sqc-label" + state}
                style={{ left, top: st.y - 24, width }}
                onClick={() => {
                  setPlaying(false);
                  setCurrent(st.index === current ? 0 : st.index);
                }}
                title={st.note || st.message}
              >
                <b>{st.index}</b>
                <span className="sqc-message-text">{st.message}</span>
                {st.note && <small style={{ top: st.self ? 46 : 30 }}>{st.note}</small>}
              </button>
            );
          })}
        </div>
      </div>
      <p className="sqc-caption" aria-live="polite">
        {step ? (
          <>
            <b>第 {current} 步</b> {label(step.from)} {step.kind === "return" ? "⇠" : "→"} {label(step.to)}：{step.message}
            {step.note ? `（${step.note}）` : ""}
          </>
        ) : (
          sequence.explanation || "点「播放」或按 → 逐步看这条链路。"
        )}
      </p>
      {step && sequence.explanation && <Markdown text={sequence.explanation} className="sqc-explanation md-compact" />}
    </div>
  );
}

export default function SkeletonCanvas({ skeleton, onPractice, onAsk }) {
  const [selected, setSelected] = useState(null),
    [tab, setTab] = useState(0),
    [dismissed, setDismissed] = useState("");
  // What the conversation changed last: a banner plus a glow on those concepts
  // and relations, for half an hour or until dismissed.
  const change = skeleton.lastChange;
  const fresh = useMemo(() => {
    if (!change?.at || dismissed === change.at || Date.now() - Date.parse(change.at) > FRESH_MS) return null;
    return { nodes: new Set(change.nodes || []), relations: new Set(change.relations || []) };
  }, [change, dismissed]);
  const sequences = skeleton.sequences || [];
  const classRef = useRef(null);
  useEffect(() => {
    setSelected(null);
    setTab(0);
  }, [skeleton.id]);
  return (
    <div className="skc-stack">
      {fresh && (
        <div className="skc-change" role="status">
          <span className="skc-change-dot" aria-hidden="true" />
          <span>{change.summary}</span>
          {change.addedNodes?.length > 0 && skeleton.nodes.some((n) => n.id === change.addedNodes[0]) && (
            <button type="button" onClick={() => setSelected(change.addedNodes[0])}>
              聚焦新概念
            </button>
          )}
          <button type="button" className="skc-change-close" aria-label="知道了" onClick={() => setDismissed(change.at)}>
            ×
          </button>
        </div>
      )}
      <section className="skc-section">
        <div className="skc-section-head">
          <h4>类图 · 概念结构</h4>
          <small className="muted">{skeleton.nodes.length} 个概念 · {skeleton.relations.length + skeleton.nodes.filter((n) => n.parent).length} 条关系</small>
        </div>
        <div ref={classRef}>
          <ClassCanvas key={skeleton.id} skeleton={skeleton} onPractice={onPractice} selected={selected} onSelect={setSelected} onAsk={onAsk} fresh={fresh} />
        </div>
        {skeleton.classNote && <Markdown text={skeleton.classNote} className="skc-note" />}
      </section>
      {sequences.length > 0 && (
        <section className="skc-section">
          <div className="skc-section-head">
            <h4>时序图 · 动态链路</h4>
            {sequences.length > 1 && (
              <div className="skc-tabs" role="tablist">
                {sequences.map((q, i) => (
                  <button key={i} type="button" role="tab" aria-selected={tab === i} className={tab === i ? "on" : ""} onClick={() => setTab(i)}>
                    {q.title}
                  </button>
                ))}
              </div>
            )}
          </div>
          {sequences.length === 1 && <p className="skc-seq-title">{sequences[0].title}</p>}
          <SequenceCanvas
            sequence={sequences[Math.min(tab, sequences.length - 1)]}
            nodes={skeleton.nodes}
            onSelectNode={(id) => {
              setSelected(id);
              classRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
            }}
          />
        </section>
      )}
    </div>
  );
}
