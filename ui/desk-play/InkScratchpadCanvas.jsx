import React, { useMemo, useRef, useState } from 'react';
import { ui } from '../i18n.js';
import { useLiveEffect } from '../use-async.js';
import {
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  clientToCanvasPoint,
  shapePaths,
  snapShapeEnd,
  strokePathData,
} from './ink-engine.js';

const PIGMENT_CLASS = {
  ink: 'desk-play-stroke--ink',
  cinnabar: 'desk-play-stroke--cinnabar',
  jade: 'desk-play-stroke--jade',
  steel: 'desk-play-stroke--steel',
};

function strokeClass(ink) {
  return PIGMENT_CLASS[ink] || PIGMENT_CLASS.ink;
}

/**
 * Interactive vector ink drafting sheet powered by lazy-loaded `perfect-freehand`
 * (calligraphic tapered brush strokes) and `roughjs` (sketchy STEM boxes, circles,
 * and directional arrows).
 */
export default function InkScratchpadCanvas({
  strokes,
  tool,
  ink,
  weight,
  paper,
  canvasRef,
  onCommitStroke,
  onEngineReady,
}) {
  const svgRef = useRef(null);
  const activePointerId = useRef(null);
  const draftRef = useRef(null);
  const seedCounter = useRef(101);
  const [draft, setDraft] = useState(null);
  const [engine, setEngine] = useState(null);

  useLiveEffect((isLive) => {
    Promise.all([import('perfect-freehand'), import('roughjs')])
      .then(([freehandMod, roughMod]) => {
        if (!isLive()) return;
        const getStroke = freehandMod.getStroke || freehandMod.default;
        const roughApi = roughMod.default || roughMod;
        const roughGenerator = roughApi.generator();
        const loaded = { getStroke, roughGenerator };
        setEngine(loaded);
        onEngineReady?.(loaded);
      })
      .catch(() => {
        /* If dynamic import fails in a restricted test env, canvas degrades gracefully. */
      });
  }, [onEngineReady]);

  const toCanvasPoint = (event) => {
    const coords = clientToCanvasPoint(svgRef.current, event.clientX, event.clientY, CANVAS_WIDTH, CANVAS_HEIGHT);
    if (!coords) return null;
    const pressure = event.pointerType === 'pen' && event.pressure > 0 ? event.pressure : 0.5;
    return [coords[0], coords[1], pressure];
  };

  const handlePointerDown = (event) => {
    if (event.button !== 0 && event.pointerType === 'mouse') return;
    if (!engine) return;
    const pt = toCanvasPoint(event);
    if (!pt) return;
    event.preventDefault();
    activePointerId.current = event.pointerId;
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* synthetic events */ }

    const id = `stroke-${Date.now()}-${seedCounter.current}`;
    const seed = seedCounter.current++;
    const nextDraft = tool === 'brush'
      ? { id, kind: 'brush', ink, weight, points: [pt] }
      : { id, kind: tool, ink, weight, seed, x1: pt[0], y1: pt[1], x2: pt[0], y2: pt[1] };
    draftRef.current = nextDraft;
    setDraft(nextDraft);
  };

  const handlePointerMove = (event) => {
    if (activePointerId.current !== event.pointerId) return;
    const prev = draftRef.current;
    if (!prev) return;
    const pt = toCanvasPoint(event);
    if (!pt) return;
    event.preventDefault();
    let next;
    if (prev.kind === 'brush') {
      const last = prev.points[prev.points.length - 1];
      if (last && Math.hypot(pt[0] - last[0], pt[1] - last[1]) < 1.2) return;
      next = { ...prev, points: [...prev.points, pt] };
    } else {
      const snapped = snapShapeEnd(prev.kind, prev.x1, prev.y1, pt[0], pt[1], event.shiftKey);
      next = { ...prev, x2: snapped.x2, y2: snapped.y2 };
    }
    draftRef.current = next;
    setDraft(next);
  };

  const finishStroke = (event) => {
    if (activePointerId.current !== event.pointerId) return;
    activePointerId.current = null;
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* ignore */ }
    const finished = draftRef.current;
    draftRef.current = null;
    setDraft(null);
    if (!finished) return;
    const valid = finished.kind === 'brush'
      ? finished.points.length > 0
      : Math.hypot(finished.x2 - finished.x1, finished.y2 - finished.y1) >= 4;
    if (valid) onCommitStroke?.(finished);
  };

  const renderedStrokes = useMemo(() => {
    if (!engine) return [];
    const list = draft ? [...strokes, draft] : strokes;
    return list.map((item) => {
      if (item.kind === 'brush') {
        return {
          id: item.id,
          kind: 'brush',
          ink: item.ink,
          d: strokePathData(engine.getStroke, item.points, item.weight),
        };
      }
      return {
        id: item.id,
        kind: item.kind,
        ink: item.ink,
        paths: shapePaths(engine.roughGenerator, item, 'currentColor'),
      };
    });
  }, [engine, strokes, draft]);

  const empty = strokes.length === 0 && !draft;

  return (
    <div
      ref={canvasRef}
      className="desk-play-canvas-stage sh-paper"
      data-paper={paper}
      data-tool={tool}
    >
      <svg
        ref={svgRef}
        className="desk-play-canvas-svg"
        viewBox={`0 0 ${CANVAS_WIDTH} ${CANVAS_HEIGHT}`}
        role="img"
        aria-label={ui('毛笔草稿纸画布')}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishStroke}
        onPointerCancel={finishStroke}
      >
        {paper === 'ruled' && (
          <line
            className="desk-play-canvas-headrule"
            x1="24"
            y1="42"
            x2={CANVAS_WIDTH - 24}
            y2="42"
            aria-hidden="true"
          />
        )}
        {renderedStrokes.map((item) => (
          item.kind === 'brush'
            ? (item.d ? <path key={item.id} d={item.d} className={`desk-play-stroke-fill ${strokeClass(item.ink)}`} /> : null)
            : (
              <g key={item.id} className={`desk-play-stroke-line ${strokeClass(item.ink)}`}>
                {item.paths.map((segment, index) => (
                  <path
                    key={`${item.id}-${index}`}
                    d={segment.d}
                    fill="none"
                    strokeWidth={Number(segment.strokeWidth) || 2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                ))}
              </g>
            )
        ))}
      </svg>
      {empty && (
        <p className="desk-play-canvas-hint" aria-hidden="true">
          {engine ? ui('在此随手推演公式、画结构框图或反应箭头') : ui('正在研墨铺纸…')}
        </p>
      )}
    </div>
  );
}
