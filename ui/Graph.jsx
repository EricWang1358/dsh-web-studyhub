import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import css from "./graph.css";

/* Knowledge graph / study path, rendered as a sideways fork: decks on the
   left, topics fanning right, each topic branching into its card leaves.
   Data comes from call("graph", {scope, mode}) per the v0.4 contract §1;
   layout is computed here (no graph library). CSS is injected once with a
   <style data-study-graph> marker. */

const LEVEL_LABEL = {
  mastered: "已掌握",
  familiar: "熟悉",
  learning: "学习中",
  weak: "薄弱",
  new: "未学",
};
const LEVELS = Object.keys(LEVEL_LABEL);

/* Inject the stylesheet once per document, keyed by the data-study-graph
   marker so repeated mounts (or both Graph and Cloze) never duplicate it. */
function useInjectCss() {
  useEffect(() => {
    if (document.querySelector("style[data-study-graph]")) return;
    const el = document.createElement("style");
    el.setAttribute("data-study-graph", "");
    el.textContent = css;
    document.head.appendChild(el);
  }, []);
}

/* ── shared helpers ───────────────────────────────────────────────────── */
// Node ids look like "deck:<id>", "topic:<JSON [deckId,topic]>" and
// "card:<JSON [deckId,cardId]>"; parse the tail without trusting extra fields.
const idTail = (id) => {
  const s = String(id ?? "");
  const i = s.indexOf(":");
  if (i < 0) return null;
  try {
    const v = JSON.parse(s.slice(i + 1));
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
};
const kindOf = (node) => String(node?.id ?? "").split(":")[0];
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
const fit = (t, max) => {
  const s = String(t ?? "");
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
};
// Horizontal bezier: leaves the parent on its right edge, enters the child on
// its left edge, with symmetric control points for the fork look.
const bez = (x1, y1, x2, y2) => {
  const dx = Math.max(26, Math.abs(x2 - x1) * 0.45);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
};
// Vertical bezier for serpentine row wraps (bottom of one node to the top of
// the next row's node).
const bezV = (x1, y1, x2, y2) => {
  const dy = Math.max(20, Math.abs(y2 - y1) * 0.5);
  return `M ${x1} ${y1} C ${x1} ${y1 + dy}, ${x2} ${y2 - dy}, ${x2} ${y2}`;
};

/* ── layout constants ─────────────────────────────────────────────────── */
const CARD = { w: 236, h: 26 };
const TOPIC = { w: 200, h: 34 };
const DECK = { w: 224, h: 48 };
const COL = { deck: 12, topic: 296, card: 560 };
const STAGGER = 40; // cards alternate slightly rightwards inside a topic
const PAD = 14;
const ROW_GAP = 8;
const TOPIC_GAP = 14;
const DECK_GAP = 26;
const MAX_H = 1200;

/* structure mode: three columns, uniform spacing within each column, parent
   y = mean of its children. Cards without a tree edge (or hanging directly
   off a deck) fall into a "未分组" ghost group under their deck. */
function layoutStructure(nodes, edges) {
  const parentOf = new Map(),
    seqOf = new Map(),
    topicsByDeck = new Map(),
    cardsByParent = new Map();
  const indexed = nodes.map((n, i) => ({ ...n, __i: i }));
  for (const e of edges || []) {
    if (e.type === "prereq" || e.type === "order") continue;
    parentOf.set(e.to, e.from);
    if (e.seq != null) seqOf.set(e.to, e.seq);
  }
  for (const n of indexed) {
    if (kindOf(n) === "topic") {
      const deckId = (idTail(n.id) || [])[0];
      const key = "deck:" + deckId;
      if (!topicsByDeck.has(key)) topicsByDeck.set(key, []);
      topicsByDeck.get(key).push(n);
    } else if (kindOf(n) === "card") {
      const tail = idTail(n.id) || [];
      const key = parentOf.get(n.id) || "orphan:" + tail[0];
      if (!cardsByParent.has(key)) cardsByParent.set(key, []);
      cardsByParent.get(key).push(n);
    }
  }
  const bySeq = (a, b) => (seqOf.get(a.id) ?? a.__i ?? 0) - (seqOf.get(b.id) ?? b.__i ?? 0);

  const placed = [],
    treeEdges = [],
    prereqEdges = [],
    posOf = new Map();
  let cy = PAD,
    maxBottom = 0;
  for (const d of indexed.filter((n) => kindOf(n) === "deck")) {
    const tail = idTail(d.id) || [];
    const topics = (topicsByDeck.get(d.id) || [])
      .slice()
      .sort((a, b) => (a.seq ?? a.__i ?? 0) - (b.seq ?? b.__i ?? 0));
    const loose = [
      ...(cardsByParent.get(d.id) || []), // deck→card edges without a topic
      ...(cardsByParent.get("orphan:" + tail[0]) || []),
    ];
    const groups = topics.map((t) => ({ topic: t, cards: (cardsByParent.get(t.id) || []).slice().sort(bySeq) }));
    if (loose.length) groups.push({ topic: null, cards: loose.sort(bySeq) });
    const centers = [];
    for (const g of groups) {
      if (g.cards.length) {
        let i = 0;
        for (const c of g.cards) {
          const p = {
            key: c.id,
            node: c,
            kind: "card",
            x: COL.card + (i % 2) * STAGGER,
            y: cy + CARD.h / 2,
            w: CARD.w,
            h: CARD.h,
          };
          i += 1;
          cy += CARD.h + ROW_GAP;
          posOf.set(c.id, p);
          placed.push(p);
        }
        cy += TOPIC_GAP - ROW_GAP; // widen the gap between topic groups
        const avg = g.cards.reduce((s, c) => s + posOf.get(c.id).y, 0) / g.cards.length;
        centers.push(avg);
        const tp = {
          key: g.topic ? g.topic.id : `ghost:${d.id}:${g.cards[0].id}`,
          node: g.topic || { label: "未分组", ghost: true },
          kind: g.topic ? "topic" : "ghost",
          x: COL.topic,
          y: avg,
          w: TOPIC.w,
          h: TOPIC.h,
        };
        if (g.topic) posOf.set(g.topic.id, tp);
        placed.push(tp);
        maxBottom = Math.max(
          maxBottom,
          avg + TOPIC.h / 2,
          ...g.cards.map((c) => posOf.get(c.id).y + CARD.h / 2),
        );
      } else {
        const y = cy + CARD.h / 2;
        centers.push(y);
        const tp = {
          key: g.topic.id,
          node: g.topic,
          kind: "topic",
          x: COL.topic,
          y,
          w: TOPIC.w,
          h: TOPIC.h,
        };
        posOf.set(g.topic.id, tp);
        placed.push(tp);
        cy += CARD.h + TOPIC_GAP;
        maxBottom = Math.max(maxBottom, y + TOPIC.h / 2);
      }
    }
    const dy = centers.length
      ? centers.reduce((s, y) => s + y, 0) / centers.length
      : cy + DECK.h / 2;
    if (!centers.length) cy += DECK.h;
    const dp = { key: d.id, node: d, kind: "deck", x: COL.deck, y: dy, w: DECK.w, h: DECK.h };
    posOf.set(d.id, dp);
    placed.push(dp);
    maxBottom = Math.max(maxBottom, dy + DECK.h / 2);
    cy += DECK_GAP;
  }
  for (const e of edges || []) {
    if (e.type === "order") continue;
    if (posOf.has(e.from) && posOf.has(e.to)) (e.type === "prereq" ? prereqEdges : treeEdges).push(e);
  }
  return {
    placed,
    treeEdges,
    prereqEdges,
    posOf,
    width: COL.card + STAGGER + CARD.w + PAD,
    height: maxBottom + PAD,
  };
}

/* path mode: planPath order as a horizontal chain, six nodes per row,
   serpentine wrapping (rows alternate right-to-left so the wrap edge is a
   short vertical drop). */
function layoutPath(nodes, edges) {
  const PER = 6,
    W = 172,
    H = 46,
    GX = 52,
    GY = 70;
  const placed = nodes.map((n, i) => {
    const row = Math.floor(i / PER),
      col = row % 2 ? PER - 1 - (i % PER) : i % PER;
    return {
      key: n.id || `#${i}`,
      node: n,
      kind: "pcard",
      x: PAD + col * (W + GX),
      y: PAD + row * (H + GY) + H / 2,
      w: W,
      h: H,
      step: i + 1,
    };
  });
  const posOf = new Map(placed.map((p) => [p.node.id, p]));
  const orderPaths = [];
  for (let i = 0; i + 1 < placed.length; i += 1) {
    const a = placed[i],
      b = placed[i + 1];
    orderPaths.push(
      a.x === b.x
        ? bezV(a.x + a.w / 2, a.y + a.h / 2, b.x + b.w / 2, b.y - b.h / 2)
        : b.x > a.x
          ? bez(a.x + a.w, a.y, b.x, b.y)
          : bez(a.x, a.y, b.x + b.w, b.y),
    );
  }
  const prereqEdges = (edges || []).filter(
    (e) => e.type === "prereq" && posOf.has(e.from) && posOf.has(e.to),
  );
  const rows = Math.max(1, Math.ceil(nodes.length / PER));
  const cols = Math.min(PER, nodes.length) || 1;
  return {
    placed,
    orderPaths,
    prereqEdges,
    posOf,
    width: PAD * 2 + cols * W + (cols - 1) * GX,
    height: PAD * 2 + rows * H + (rows - 1) * GY,
  };
}

/* ── component ────────────────────────────────────────────────────────── */
export default function Graph({ call, busy, scope, onClose, onStudyCard }) {
  useInjectCss();
  const [mode, setMode] = useState("structure");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const seq = useRef(0);
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

  const layout = useMemo(() => {
    if (!data || !Array.isArray(data.nodes)) return null;
    return (data.mode || mode) === "path"
      ? layoutPath(data.nodes, data.edges || [])
      : layoutStructure(data.nodes, data.edges || []);
  }, [data, mode]);
  const clipped = !!layout && layout.height > MAX_H + 0.5;
  const truncated = !!data && (data.truncated || clipped);

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
            {fit(n.label, 15)}
          </text>
          <text className="gn-meta" x={12} y={37}>
            {fit(meta, 22)}
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
            {fit(label, 14)}
          </text>
          <text className="gn-meta" x={10} y={28}>
            {fit(meta, 18)}
          </text>
          <title>{[label, meta].filter(Boolean).join(" · ")}</title>
        </g>
      );
    }
    // card (structure) / pcard (path): clickable leaf
    const lvl = `gn-${levelOf(n)}`;
    const full = n.objective || n.prompt || n.label || "";
    const cap =
      p.kind === "pcard"
        ? fit([n.deckTitle, n.topic].filter(Boolean).join(" › "), 15) || LEVEL_LABEL[levelOf(n)]
        : null;
    return (
      <g
        key={p.key}
        transform={`translate(${p.x} ${p.y - p.h / 2})`}
        className={clickable ? "gn-clickable" : undefined}
        role={clickable ? "button" : undefined}
        tabIndex={clickable ? 0 : undefined}
        aria-label={full}
        onClick={clickable ? () => study(n) : undefined}
        onKeyDown={
          clickable
            ? (ev) => {
                if (ev.key === "Enter" || ev.key === " ") {
                  ev.preventDefault();
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
              {fit(`${p.step}. ${n.label || ""}`, 14)}
            </text>
            <text className="gn-meta" x={12} y={36}>
              {cap}
            </text>
          </>
        ) : (
          <text className="gn-label gn-card-label" x={12} y={p.h / 2 + 4}>
            {fit(n.label, 19)}
          </text>
        )}
        <title>{p.kind === "pcard" ? [`${p.step}. ${full}`, cap].filter(Boolean).join("\n") : full}</title>
      </g>
    );
  };

  return (
    <section className="graph" aria-busy={busy || loading}>
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
        <button onClick={onClose}>关闭</button>
      </div>

      {truncated && <div className="graph-truncated">已截断，缩小范围可看全</div>}

      {loading ? (
        <div className="graph-state graph-scroll">正在生成图谱…</div>
      ) : error ? (
        <div className="graph-state graph-error graph-scroll">
          <div>图谱加载失败：{error}</div>
          <button onClick={load}>重试</button>
        </div>
      ) : !layout || !layout.placed.length ? (
        <div className="graph-state graph-scroll">当前范围内没有可展示的题目。</div>
      ) : (
        <div className="graph-scroll">
          <svg
            className="graph-svg"
            width={layout.width}
            height={Math.min(layout.height, MAX_H)}
            viewBox={`0 0 ${layout.width} ${Math.min(layout.height, MAX_H)}`}
            role="img"
            aria-label={mode === "path" ? "学习路径图" : "知识结构图"}
          >
            <defs>
              <marker id="gn-arrow-prereq" viewBox="0 0 8 8" refX="7" refY="3" markerWidth="8" markerHeight="8" orient="auto">
                <path d="M0,0 L7,3 L0,6 Z" className="gn-arrow gn-arrow-prereq" />
              </marker>
              <marker id="gn-arrow-order" viewBox="0 0 8 8" refX="7" refY="3" markerWidth="8" markerHeight="8" orient="auto">
                <path d="M0,0 L7,3 L0,6 Z" className="gn-arrow gn-arrow-order" />
              </marker>
            </defs>

            {(data.mode || mode) === "path" ? (
              <>
                {layout.orderPaths.map((d, i) => (
                  <path key={`o${i}`} className="gn-order" markerEnd="url(#gn-arrow-order)" d={d} />
                ))}
                {layout.prereqEdges.map((e, i) => {
                  const a = layout.posOf.get(e.from),
                    b = layout.posOf.get(e.to);
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
                  const a = layout.posOf.get(e.from),
                    b = layout.posOf.get(e.to);
                  return <path key={`t${i}`} className="gn-tree" d={bez(a.x + a.w, a.y, b.x, b.y)} />;
                })}
                {layout.prereqEdges.map((e, i) => {
                  const a = layout.posOf.get(e.from),
                    b = layout.posOf.get(e.to);
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
    </section>
  );
}
