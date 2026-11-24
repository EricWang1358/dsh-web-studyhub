import React, { useMemo, useState } from 'react';
import { ui } from '../i18n.js';
import { useInjectCss } from '../shared.js';
import { useLiveEffect } from '../use-async.js';
import { hashString } from './ink-palette.js';
import { edgeKey, sketchBezierEdge, sketchCubicPath, sketchNodePaths, sketchOrderCurve } from './graph-sketch.js';
import { pathPrereqPath } from '../graph-layout.js';
import sketchCss from './graph-sketch.css';

/* Declarative hand-drawn roughjs SVG primitives for Knowledge Graph «手绘墨线» mode.
   Lazy-loads roughjs ONLY when sketch mode is active (0 B cost in crisp mode). */

let roughPromise = null;
function loadRoughGenerator() {
  if (!roughPromise) {
    roughPromise = import('roughjs')
      .then((mod) => {
        const rough = mod?.default || mod;
        return typeof rough?.generator === 'function' ? rough.generator() : null;
      })
      .catch(() => null);
  }
  return roughPromise;
}

/** Lazily load a cached roughjs generator only when sketch mode is turned on. */
export function useGraphRoughGenerator(enabled, injectedGenerator = null) {
  const [loaded, setLoaded] = useState(null);
  useLiveEffect((isLive) => {
    if (!enabled || injectedGenerator) return;
    loadRoughGenerator().then((gen) => {
      if (isLive() && gen) setLoaded(gen);
    });
  }, [enabled, injectedGenerator]);
  return injectedGenerator || loaded;
}

/** Hand-drawn double-ink frame + mastery hachure fill for one Graph node. */
export function SketchNodeFrame({ placed, level, palette, roughGen, compact = false }) {
  useInjectCss(sketchCss, 'study-graph-sketch');
  const strokes = useMemo(
    () => sketchNodePaths(placed, level, palette, roughGen, compact),
    [placed, level, palette, roughGen, compact],
  );
  return (
    <>
      <rect className="graph-sketch-hit" width={placed.w} height={placed.h} />
      <g className="graph-sketch-node" aria-hidden="true">
        {strokes.map((p, idx) => (
          <path
            key={idx}
            d={p.d}
            stroke={p.stroke}
            strokeWidth={p.strokeWidth}
            strokeDasharray={p.dashArray}
            strokeLinecap="round"
            strokeLinejoin="round"
            fill={p.fill}
            opacity={p.opacity}
          />
        ))}
      </g>
    </>
  );
}

function edgeSpotlightClass(lineage, key) {
  if (!lineage) return 'gn-spotlight-edge';
  return lineage.highlightedEdges.has(key)
    ? 'gn-spotlight-edge gn-spotlight-edge-active'
    : 'gn-spotlight-edge gn-spotlight-edge-dim';
}

/** Hand-drawn sketchy curves for structure tree, path order, and prerequisite edges. */
export function SketchEdgeLayer({ layout, mode, palette, roughGen, lineage }) {
  useInjectCss(sketchCss, 'study-graph-sketch');

  const rendered = useMemo(() => {
    if (!layout) return { primary: [], prereqs: [] };
    const primary = mode === 'path'
      ? (layout.orderPaths || []).map((d, i) => ({
        key: `o${i}`,
        spotKey: `order:${i}`,
        markerEnd: 'url(#gn-arrow-order)',
        paths: sketchOrderCurve(d, palette, roughGen, hashString(`order:${i}:${d.length}`)),
      }))
      : (layout.treeEdges || []).map((e, i) => {
        const a = layout.posOf.get(e.from);
        const b = layout.posOf.get(e.to);
        return {
          key: `t${i}`,
          spotKey: edgeKey('tree', e.from, e.to),
          markerEnd: undefined,
          paths: a && b
            ? sketchBezierEdge(a.x + a.w, a.y, b.x, b.y, 'tree', palette, roughGen, hashString(`tree:${e.from}:${e.to}`))
            : [],
        };
      });

    const prereqs = (layout.prereqEdges || []).map((e, i) => {
      const a = layout.posOf.get(e.from);
      const b = layout.posOf.get(e.to);
      return {
        key: `p${i}`,
        spotKey: edgeKey('prereq', e.from, e.to),
        markerEnd: 'url(#gn-arrow-prereq)',
        paths: a && b
          ? (mode === 'path'
            ? sketchCubicPath(pathPrereqPath(a, b), 'prereq', palette, roughGen, hashString(`prereq:${e.from}:${e.to}`))
            : sketchBezierEdge(a.x + a.w, a.y, b.x, b.y, 'prereq', palette, roughGen, hashString(`prereq:${e.from}:${e.to}`)))
          : [],
      };
    });

    return { primary, prereqs };
  }, [layout, mode, palette, roughGen]);

  return (
    <>
      {rendered.primary.map((item) => (
        <g key={item.key} className={edgeSpotlightClass(lineage, item.spotKey)}>
          {item.paths.map((p, idx) => (
            <path
              key={idx}
              className="graph-sketch-edge"
              d={p.d}
              stroke={p.stroke}
              strokeWidth={p.strokeWidth}
              strokeDasharray={p.dashArray}
              opacity={p.opacity}
              markerEnd={idx === item.paths.length - 1 ? item.markerEnd : undefined}
            />
          ))}
        </g>
      ))}
      {rendered.prereqs.map((item) => (
        <g key={item.key} className={edgeSpotlightClass(lineage, item.spotKey)}>
          {item.paths.map((p, idx) => (
            <path
              key={idx}
              className="graph-sketch-edge"
              d={p.d}
              stroke={p.stroke}
              strokeWidth={p.strokeWidth}
              strokeDasharray={p.dashArray}
              opacity={p.opacity}
              markerEnd={idx === item.paths.length - 1 ? item.markerEnd : undefined}
            >
              {idx === 0 && <title>{ui('前置关系')}</title>}
            </path>
          ))}
        </g>
      ))}
    </>
  );
}
