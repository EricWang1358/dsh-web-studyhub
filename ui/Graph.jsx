import { ui, uiFormat, errorMessage } from "./i18n.js";
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import css from "./graph.css";
import sketchCss from "./graph-sketch/graph-sketch.css";
import PageScope, { decksInCourse, usePageScope, useShowInactive, scopeArgs } from './PageScope.jsx';
import { Button, ErrorState, Hint, LoadingState, SegmentedControl, useToast } from './components/index.js';
import MasteryMap from './mastery-map/MasteryMap.jsx';
import { FullscreenButton, ZoomControls, useCanvasFullscreen, usePanZoom } from "./canvas/index.js";
import { useInjectCss, LEVEL_LABEL, LEVELS } from "./shared.js";
import { usePersistentState } from "./storage.js";
import { useAppearance } from "./use-appearance.js";
import { joinMeta } from './format.js';
import {
  layoutStructure,
  layoutPath,
  pathColumns,
  bez,
  pathPrereqPath,
  idTail,
  FIT_MAX,
  ZOOM_MIN,
  ZOOM_MAX,
} from "./graph-layout.js";
import { useStudy } from "./study-context.jsx";
import { useInkPalette } from "./graph-sketch/ink-palette.js";
import {
  GRAPH_STYLES,
  buildGraphFilename,
  computeLineage,
  edgeKey,
  exportGraphSvg,
} from "./graph-sketch/graph-sketch.js";
import {
  SketchEdgeLayer,
  SketchNodeFrame,
  useGraphRoughGenerator,
} from "./graph-sketch/GraphSketchLayer.jsx";

/* Knowledge graph / study path, rendered as a sideways fork: decks on the
   left, topics fanning right, each topic branching into its card leaves.
   Data comes from call("graph", {scope, mode}); layout lives in
   ui/graph-layout.js (column-packed, so the sheet grows sideways instead of
   becoming a ribbon). Pan, zoom and fullscreen are the shared canvas kit
   (ui/canvas): drag pans, Ctrl/⌘+wheel zooms, 全屏查看 takes the whole screen
   (the Fullscreen API, or the top layer where the host blocks it), which is
   the only way to see a library's whole structure at once.
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
  if (node?.mastery != null) bits.push(uiFormat("掌握 {0}%", [node.mastery]));
  if (node?.due) bits.push(uiFormat("{0} 待复习", [node.due]));
  if (!bits.length && node?.total != null) bits.push(uiFormat("{0} 题", [node.total]));
  return bits.join(" · ");
};
const fitLabel = (t, max) => {
  const s = String(t ?? "");
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
};

/** What the canvas says when there is no drawing: reading, failed (with a retry) or nothing in this scope. */
export function GraphStatus({ loading, error, onRetry }) {
  if (loading) return <LoadingState className="graph-state graph-state--loading" label={ui("正在生成图谱…")} />;
  if (error) return <div className="graph-state"><ErrorState className="graph-state__inline" error={error} title={ui("图谱加载失败")} onRetry={onRetry} /></div>;
  return <div className="graph-state"><Hint>{ui("当前范围内没有可展示的题目。")}</Hint></div>;
}

const GRAPH_STYLE_KEY = "study-graph-style";
const GRAPH_STYLE_SET = new Set(GRAPH_STYLES);
function parseGraphStyle(raw) {
  try {
    const parsed = JSON.parse(raw);
    return GRAPH_STYLE_SET.has(parsed) ? parsed : undefined;
  } catch {
    return GRAPH_STYLE_SET.has(raw) ? raw : undefined;
  }
}

/* ── component ────────────────────────────────────────────────────────── */
export default function Graph({
  scope,
  library,
  onClose,
  onStudyCard,
  onPracticeScope,
  onResumeRun,
  onManageDeck,
  onOpenOutline,
  onOpenBook,
  onOpenWrongBook,
  onGoGenerateTopic,
  canvasWanted,
  onCanvasHandled,
  defaultMode = "structure",
  defaultStyle = "crisp",
  initialData = null,
  initialOutline = null,
  roughGenerator = null,
}) {
  const { call, busy } = useStudy();
  const toast = useToast();
  useInjectCss(css, "study-graph");
  useInjectCss(sketchCss, "study-graph-sketch");
  const [course, setCourse] = usePageScope(library?.root, 'graph', library?.focus?.course ?? '*');
  const [showInactive, setShowInactive] = useShowInactive(library?.root, 'graph');
  const [browse, setBrowse] = useState(false);
  const objectScope = scope != null && !browse;
  const validMode = defaultMode === "mastery" || defaultMode === "path" ? defaultMode : "structure";
  const [mode, setMode] = useState(validMode);
  useEffect(() => { setMode(validMode); }, [validMode]);
  const [appearance] = useAppearance();
  const minimal = appearance.minimal === "on";
  const [styleMode, setStyleMode] = usePersistentState(
    GRAPH_STYLE_KEY,
    GRAPH_STYLE_SET.has(defaultStyle) ? defaultStyle : "crisp",
    { parse: parseGraphStyle },
  );
  const effectiveStyleMode = minimal ? "crisp" : styleMode;
  const isSketch = effectiveStyleMode === "sketch";
  const [data, setData] = useState(initialData);
  const [loading, setLoading] = useState(!initialData && validMode !== "mastery");
  const [error, setError] = useState("");
  const [outlineData, setOutlineData] = useState(initialOutline);
  const [outlineLoading, setOutlineLoading] = useState(false);
  const [outlineError, setOutlineError] = useState("");
  const [spotlightId, setSpotlightId] = useState(null);
  const fullscreen = useCanvasFullscreen();
  const svgRef = useRef(null);
  const palette = useInkPalette(fullscreen.ref);
  const roughGen = useGraphRoughGenerator(isSketch, roughGenerator);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const { viewRef, view, viewport, fit, zoomAt, panHandlers } = usePanZoom(size.w, size.h, {
    maxFit: FIT_MAX, minInitial: 0, zoomMin: ZOOM_MIN, zoomMax: ZOOM_MAX,
  });
  const seq = useRef(0);
  const outlineSeq = useRef(0);
  const autoTried = useRef(false);
  const scopeKey = JSON.stringify(objectScope ? { scope } : scopeArgs(course, showInactive));
  const isMastery = mode === "mastery";

  const load = useCallback(async () => {
    if (mode === "mastery") return;
    const n = ++seq.current;
    setLoading(true);
    setError("");
    try {
      const d = await call("graph", { ...JSON.parse(scopeKey), mode });
      if (seq.current !== n) return; // a newer request superseded this one
      setData(d);
    } catch (e) {
      if (seq.current !== n) return;
      setError(errorMessage(e));
      setData(null);
    } finally {
      if (seq.current === n) setLoading(false);
    }
  }, [call, mode, scopeKey]);

  useEffect(() => {
    load();
  }, [load]);

  const loadOutline = useCallback(async () => {
    if (mode !== "mastery" || initialOutline) return;
    if (objectScope || course === "*" || typeof course !== "string") {
      setOutlineData(null);
      setOutlineLoading(false);
      setOutlineError("");
      return;
    }
    const n = ++outlineSeq.current;
    setOutlineData((prev) => (prev && prev.course === course ? prev : null));
    setOutlineLoading(true);
    setOutlineError("");
    try {
      const res = await call("course.outline", { course });
      if (outlineSeq.current !== n) return;
      setOutlineData(res);
    } catch (e) {
      if (outlineSeq.current !== n) return;
      setOutlineError(errorMessage(e));
      setOutlineData(null);
    } finally {
      if (outlineSeq.current === n) setOutlineLoading(false);
    }
  }, [call, course, initialOutline, mode, objectScope]);

  useEffect(() => {
    loadOutline();
  }, [loadOutline, library?.revision]);

  const masteryDecks = useMemo(() => {
    if (objectScope && Array.isArray(scope) && scope.length) {
      const wanted = new Set(scope.map((item) => item?.deckId).filter(Boolean));
      if (wanted.size) return (library?.decks || []).filter((deck) => !deck.archived && !deck.systemKind && wanted.has(deck.id));
    }
    return decksInCourse(library, course, showInactive);
  }, [library, course, showInactive, objectScope, scope]);

  const [practising, setPractising] = useState(false);
  const practisingRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const practiseOutlineKeys = useCallback(async (keys, { resume = false } = {}) => {
    if (practisingRef.current || !keys?.length || !onPracticeScope) return;
    practisingRef.current = true;
    setPractising(true);
    try {
      const targetCourse = course !== "*" ? course : (library?.focus?.course ?? null);
      const res = await call("course.outline", { course: targetCourse, pick: { keys } });
      if (!mountedRef.current) return;
      const pickedScope = res?.practice?.scope || [];
      if (!pickedScope.length) {
        toast.info(ui("这里还没有题。可以先在「创建题组」里出题。"));
        return;
      }
      onPracticeScope(pickedScope, { resume });
    } catch (e) {
      if (mountedRef.current) toast.error(errorMessage(e));
    } finally {
      practisingRef.current = false;
      if (mountedRef.current) setPractising(false);
    }
  }, [call, course, library?.focus?.course, onPracticeScope, toast]);

  const handlePracticeChapter = useCallback((chapter) => {
    if (!chapter) return;
    if (chapter.resume?.runId && onResumeRun) {
      onResumeRun(chapter.resume.runId);
      return;
    }
    if (chapter.key) {
      void practiseOutlineKeys([chapter.key], { resume: Boolean(chapter.resume) });
      return;
    }
    if (chapter.deckId && onPracticeScope) {
      onPracticeScope([{ deckId: chapter.deckId }]);
    }
  }, [onPracticeScope, onResumeRun, practiseOutlineKeys]);

  const handlePracticePoint = useCallback((point) => {
    if (!point) return;
    if (point.resume?.runId && onResumeRun) {
      onResumeRun(point.resume.runId);
      return;
    }
    if (point.key) {
      void practiseOutlineKeys([point.key], { resume: Boolean(point.resume) });
      return;
    }
    if (point.deckId && onPracticeScope) {
      onPracticeScope([point.topic ? { deckId: point.deckId, topic: point.topic } : { deckId: point.deckId }]);
    }
  }, [onPracticeScope, onResumeRun, practiseOutlineKeys]);

  const handlePracticeWeakAll = useCallback(({ keys = [], scopes = [] } = {}) => {
    if (keys.length) {
      void practiseOutlineKeys(keys);
      return;
    }
    if (scopes.length && onPracticeScope) {
      onPracticeScope(scopes);
    }
  }, [onPracticeScope, practiseOutlineKeys]);

  const handleGapFill = useCallback((topics) => {
    if (!onGoGenerateTopic || !Array.isArray(topics) || !topics.length) return;
    onGoGenerateTopic(topics, course !== "*" ? course : undefined);
  }, [course, onGoGenerateTopic]);

  useEffect(() => {
    viewRef.current?.focus?.({ preventScroll: true });
  }, [viewRef]);

  /* The drawing is measured, not guessed: the viewport size drives the path
     row length, and the drawing's size drives the shared pan/zoom's fit. */
  const layout = useMemo(() => {
    if (!data || !Array.isArray(data.nodes)) return null;
    return (data.mode || mode) === "path"
      ? layoutPath(data.nodes, data.edges || [], pathColumns(viewport.w))
      : layoutStructure(data.nodes, data.edges || [], {
          viewportW: viewport.w,
          viewportH: viewport.h,
        });
  }, [data, mode, viewport.w, viewport.h]);
  useLayoutEffect(() => {
    const next = layout ? { w: layout.width, h: layout.height } : { w: 0, h: 0 };
    setSize((previous) => (previous.w === next.w && previous.h === next.h ? previous : next));
  }, [layout]);

  const activeMode = data?.mode || mode;
  const lineage = useMemo(
    () => computeLineage(layout, spotlightId, activeMode),
    [layout, spotlightId, activeMode],
  );
  const compactSketch = (layout?.placed.length || 0) > 220;

  /* Opened from the study map: the click that navigated here is the user
     gesture that lets the canvas take the screen, so try it once on mount and
     hand the intent back either way. */
  useEffect(() => {
    if (!canvasWanted || autoTried.current) return;
    autoTried.current = true;
    fullscreen.enter().finally(() => onCanvasHandled?.());
  }, [canvasWanted]); // eslint-disable-line react-hooks/exhaustive-deps

  const onKeyDown = (ev) => {
    if (ev.nativeEvent?.isComposing || ev.isComposing || ev.keyCode === 229) return;
    if (ev.key !== "Escape") return;
    // Expanded in the top layer, Escape leaves that first; native fullscreen is left by the browser itself.
    if (fullscreen.onEscape(ev) || fullscreen.native) return;
    ev.stopPropagation();
    onClose?.();
  };

  const study = useCallback(
    (node) => {
      const tail = idTail(node?.id);
      if (tail && onStudyCard) onStudyCard({ deckId: tail[0], cardId: tail[1] });
    },
    [onStudyCard],
  );
  const handleExportSvg = useCallback(() => {
    if (!layout || !svgRef.current) return;
    const ok = exportGraphSvg(
      svgRef.current,
      buildGraphFilename(activeMode, effectiveStyleMode),
      { width: layout.width, height: layout.height, palette },
    );
    if (ok) toast.success(ui("已导出知识图谱 SVG。"));
    else toast.error(ui("导出知识图谱未成功，请重试。"));
  }, [layout, activeMode, effectiveStyleMode, palette, toast]);
  const clickable = !!onStudyCard && !loading && !error;

  const spotlightNodeClass = (key, extra = "") => {
    const dimmed = lineage && !lineage.connectedNodes.has(key);
    return [extra, "gn-spotlight-item", dimmed ? "gn-spotlight-dim" : ""].filter(Boolean).join(" ");
  };
  const spotlightEdgeClass = (base, key) => {
    if (!lineage) return `${base} gn-spotlight-edge`;
    return `${base} gn-spotlight-edge ${lineage.highlightedEdges.has(key) ? "gn-spotlight-edge-active" : "gn-spotlight-edge-dim"}`;
  };
  const spotlightHandlers = (key) => ({
    onMouseEnter: () => setSpotlightId(key),
    onMouseLeave: () => setSpotlightId((cur) => (cur === key ? null : cur)),
    onFocus: () => setSpotlightId(key),
    onBlur: () => setSpotlightId((cur) => (cur === key ? null : cur)),
  });

  const renderNode = (p) => {
    const n = p.node;
    const level = levelOf(n);
    if (p.kind === "deck") {
      const meta = metaOf(n);
      return (
        <g
          key={p.key}
          data-node-key={p.key}
          className={spotlightNodeClass(p.key)}
          transform={`translate(${p.x} ${p.y - p.h / 2})`}
          {...spotlightHandlers(p.key)}
        >
          {isSketch ? (
            <SketchNodeFrame placed={p} level={level} palette={palette} roughGen={roughGen} compact={compactSketch} />
          ) : (
            <rect className={`gn-node gn-deck gn-${level}`} width={p.w} height={p.h} rx={12} />
          )}
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
      const label = n.ghost ? ui(n.label) : n.label || tail?.[1] || ui("未命名主题");
      const meta = n.ghost ? "" : metaOf(n);
      return (
        <g
          key={p.key}
          data-node-key={p.key}
          className={spotlightNodeClass(p.key)}
          transform={`translate(${p.x} ${p.y - p.h / 2})`}
          {...spotlightHandlers(p.key)}
        >
          {isSketch ? (
            <SketchNodeFrame placed={p} level={level} palette={palette} roughGen={roughGen} compact={compactSketch} />
          ) : (
            <rect
              className={`gn-node gn-topic ${n.ghost ? "gn-ghost" : `gn-${level}`}`}
              width={p.w}
              height={p.h}
              rx={9}
            />
          )}
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
    const lvl = `gn-${level}`;
    const fullText = n.objective || n.prompt || n.label || "";
    const cap =
      p.kind === "pcard"
        ? fitLabel([n.deckTitle, n.topic].filter(Boolean).join(" › "), 15) ||
          LEVEL_LABEL[level]
        : null;
    return (
      <g
        key={p.key}
        data-node-key={p.key}
        transform={`translate(${p.x} ${p.y - p.h / 2})`}
        className={spotlightNodeClass(p.key, clickable ? "gn-clickable" : "")}
        role={clickable ? "button" : undefined}
        tabIndex={clickable ? 0 : undefined}
        aria-label={fullText}
        onClick={clickable ? () => study(n) : undefined}
        {...spotlightHandlers(p.key)}
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
        {isSketch ? (
          <SketchNodeFrame placed={p} level={level} palette={palette} roughGen={roughGen} compact={compactSketch} />
        ) : (
          <rect
            className={`gn-node ${p.kind === "pcard" ? "gn-topic" : "gn-card"} ${lvl}`}
            width={p.w}
            height={p.h}
            rx={p.kind === "pcard" ? 14 : p.h / 2}
          />
        )}
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
  const scopeLabel = objectScope && scopeCount
    ? uiFormat("已选 {0} 项范围", [scopeCount])
    : objectScope || course === '*' ? ui("全部题组（未归档）") : course || ui('未分类');
  const nodeCount = layout?.placed.length || 0;

  return (
    <section
      className={("graph" + (fullscreen.full ? " graph-canvas" : "") + (fullscreen.expanded ? " graph--expanded" : "") + " " + fullscreen.className).trim()}
      data-graph-style={effectiveStyleMode}
      ref={fullscreen.ref}
      tabIndex={-1}
      aria-busy={busy || loading}
      aria-label={ui("知识图谱画布")}
      onKeyDown={onKeyDown}
    >
      <div className="graph-toolbar">
        <SegmentedControl size="sm" label={ui("视图模式")} value={mode} disabled={busy} onChange={setMode}
          options={[
            { value: "structure", label: ui("知识结构") },
            { value: "path", label: ui("学习路径") },
            { value: "mastery", label: ui("掌握图谱") },
          ]} />
        {!isMastery && !minimal && (
          <SegmentedControl size="sm" label={ui("画风")} value={styleMode} disabled={busy} onChange={setStyleMode}
            options={[{ value: "crisp", label: ui("精密") }, { value: "sketch", label: ui("手绘墨线") }]} />
        )}
        {!isMastery && (
          <div className="graph-zoom" role="group" aria-label={ui("缩放")}>
            <ZoomControls variant="quiet" zoomAt={zoomAt} fit={() => fit()} percent={Math.round(view.k * 100)} disabled={!layout}
              fitTitle={ui("缩放到刚好看到整张图（0）")} />
          </div>
        )}
        <div className="graph-actions">
          {!isMastery && (
            <Button variant="quiet" size="sm" icon="download" disabled={!layout || !layout.placed.length} onClick={handleExportSvg}>
              {ui("导出 SVG")}
            </Button>
          )}
          <FullscreenButton full={fullscreen.full} variant={fullscreen.full || isMastery ? "secondary" : "primary"} onToggle={fullscreen.toggle}
            title={fullscreen.full ? ui("回到面板中查看（Esc）") : isMastery ? ui("用整个屏幕看掌握图谱") : ui("用整个屏幕看这张图，可缩放、拖拽")} />
          <Button size="sm" onClick={onClose}>{ui("关闭")}</Button>
        </div>
      </div>

      <div className="graph-toolbar graph-toolbar-sub">
        <PageScope courses={library?.focus?.courses} value={objectScope ? scope.length ? '@selected' : '*' : course}
          selectedLabel={objectScope && scope.length ? uiFormat('已选 {0} 项范围', [scope.length]) : undefined}
          onChange={value => { if (value !== '@selected') { setBrowse(true); setCourse(value); } }}
          showInactive={showInactive} onShowInactive={objectScope ? undefined : setShowInactive} />
        {!isMastery && (
          <>
            <span className="graph-scope">
              {joinMeta([scopeLabel, nodeCount ? uiFormat("{0} 个节点", [nodeCount]) : "", layout?.columns ? uiFormat("{0} 列", [layout.columns]) : ""])}
            </span>
            <div className="graph-legend" aria-label={ui("图例")}>
              {LEVELS.map((l) => (
                <span key={l} className="graph-legend-item">
                  <i className={`graph-swatch gn-${l}`} />
                  {LEVEL_LABEL[l]}
                </span>
              ))}
              <span className="graph-legend-item">
                <svg className="graph-line-demo" width="26" height="8" aria-hidden="true">
                  <line x1="1" y1="4" x2="25" y2="4" className="gn-prereq" />
                </svg>{ui("前置（虚线箭头）")}</span>
            </div>
          </>
        )}
      </div>

      {isMastery ? (
        <div className="graph-mastery-body">
          <MasteryMap
            outline={objectScope ? null : (initialOutline ?? (outlineData && outlineData.course === course ? outlineData : null))}
            decks={masteryDecks}
            progress={library?.progress || {}}
            course={course}
            loading={outlineLoading}
            error={outlineError}
            onRetry={loadOutline}
            onPracticeChapter={onPracticeScope || onResumeRun ? handlePracticeChapter : undefined}
            onPracticePoint={onPracticeScope || onResumeRun ? handlePracticePoint : undefined}
            onPracticeWeakAll={onPracticeScope ? handlePracticeWeakAll : undefined}
            onGoGenerate={onGoGenerateTopic ? handleGapFill : undefined}
            onOpenDeck={onManageDeck}
            onOpenOutline={onOpenOutline ? () => onOpenOutline(course !== "*" ? course : undefined) : undefined}
            onOpenBook={onOpenBook ? (key) => onOpenBook(key, course !== "*" ? course : undefined) : undefined}
            onOpenWrongBook={onOpenWrongBook}
            practising={practising}
          />
        </div>
      ) : (
        <>
          {!!data?.truncated && (
            <div className="graph-truncated">{ui("题目超过 400 张，画布只画前 400 张；在目录里选定范围可查看全部。")}</div>
          )}

          <div
            className={`graph-viewport${isSketch ? " graph-sketch-surface" : ""}`}
            ref={viewRef}
            role="group"
            tabIndex={0}
            aria-label={ui("知识图谱，方向键平移，加减号缩放，0 适应")}
            data-full={fullscreen.full ? "1" : undefined}
            {...panHandlers}
          >
        {loading ? (
          <GraphStatus loading />
        ) : error ? (
          <GraphStatus error={error} onRetry={load} />
        ) : !layout || !layout.placed.length ? (
          <GraphStatus />
        ) : (
          <div
            className="graph-plane"
            style={{ width: layout.width, height: layout.height, transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}
          >
            <svg
              ref={svgRef}
              className="graph-svg"
              width={layout.width}
              height={layout.height}
              viewBox={`0 0 ${layout.width} ${layout.height}`}
              role="img"
              aria-label={mode === "path" ? ui("学习路径图") : ui("知识结构图")}
              onMouseLeave={() => setSpotlightId(null)}
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

              {isSketch ? (
                <SketchEdgeLayer layout={layout} mode={activeMode} palette={palette} roughGen={roughGen} lineage={lineage} />
              ) : activeMode === "path" ? (
                <>
                  {layout.orderPaths.map((d, i) => (
                    <path
                      key={`o${i}`}
                      className={spotlightEdgeClass("gn-order", `order:${i}`)}
                      markerEnd="url(#gn-arrow-order)"
                      d={d}
                    />
                  ))}
                  {layout.prereqEdges.map((e, i) => {
                    const a = layout.posOf.get(e.from);
                    const b = layout.posOf.get(e.to);
                    return (
                      <path
                        key={`p${i}`}
                        className={spotlightEdgeClass("gn-prereq", edgeKey("prereq", e.from, e.to))}
                        markerEnd="url(#gn-arrow-prereq)"
                        d={pathPrereqPath(a, b)}
                      >
                        <title>{ui("前置关系")}</title>
                      </path>
                    );
                  })}
                </>
              ) : (
                <>
                  {layout.treeEdges.map((e, i) => {
                    const a = layout.posOf.get(e.from);
                    const b = layout.posOf.get(e.to);
                    return (
                      <path
                        key={`t${i}`}
                        className={spotlightEdgeClass("gn-tree", edgeKey("tree", e.from, e.to))}
                        d={bez(a.x + a.w, a.y, b.x, b.y)}
                      />
                    );
                  })}
                  {layout.prereqEdges.map((e, i) => {
                    const a = layout.posOf.get(e.from);
                    const b = layout.posOf.get(e.to);
                    return (
                      <path
                        key={`p${i}`}
                        className={spotlightEdgeClass("gn-prereq", edgeKey("prereq", e.from, e.to))}
                        markerEnd="url(#gn-arrow-prereq)"
                        d={bez(a.x + a.w, a.y, b.x, b.y)}
                      >
                        <title>{ui("前置关系")}</title>
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
            {fullscreen.full
              ? ui("拖拽平移 · Ctrl/⌘+滚轮缩放 · Esc 退出全屏")
              : uiFormat("拖拽平移 · Ctrl/⌘+滚轮缩放 · 缩放范围 {0}–{1}%", [Math.round(ZOOM_MIN * 100), Math.round(ZOOM_MAX * 100)])}
            {lineage && (lineage.upstreamCount > 0 || lineage.downstreamCount > 0) && (
              <>
                {" · "}
                <span className="graph-sketch-lineage" data-testid="graph-lineage-hint">
                  {uiFormat("前置 {0} 项 · 后续 {1} 项", [lineage.upstreamCount, lineage.downstreamCount])}
                </span>
              </>
            )}
          </div>
        </>
      )}
    </section>
  );
}
