/* Pure geometry for the knowledge-graph canvas: node boxes, edge curves and the
   zoom/fit arithmetic. No React and no DOM here, so the column packing can be
   asserted in tests. Node ids look like "deck:<id>", "topic:<JSON [deckId,topic]>"
   and "card:<JSON [deckId,cardId]>"; parse the tail without trusting extra fields. */

export const CARD = { w: 236, h: 26 };
export const TOPIC = { w: 200, h: 34 };
export const DECK = { w: 224, h: 48 };
export const COL = { deck: 12, topic: 296, card: 560 };
export const STAGGER = 40; // cards alternate slightly rightwards inside a topic
export const PAD = 14;
export const ROW_GAP = 8;
export const TOPIC_GAP = 14;
export const DECK_GAP = 26;
export const COLUMN_GAP = 56;
/* One fork column is as wide as its widest branch (deck › topic › card). */
export const COLUMN_W = COL.card + STAGGER + CARD.w + PAD;
/* A column stops growing past this height and the next deck block starts a new
   one, so a library with many decks spreads sideways instead of becoming a
   ribbon that no viewport can show. A single deck taller than the target keeps
   its own column: a deck is never split across columns. */
export const COLUMN_TARGET_H = 1180;
export const PATH = { w: 172, h: 46, gx: 52, gy: 70 };
export const ZOOM_MIN = 0.12;
export const ZOOM_MAX = 2.5;
/* Fit never enlarges a small graph past this, so one deck still looks like a
   diagram rather than a billboard. */
export const FIT_MAX = 1.5;

export const idTail = (id) => {
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
export const kindOf = (node) => String(node?.id ?? "").split(":")[0];

// Horizontal bezier: leaves the parent on its right edge, enters the child on
// its left edge, with symmetric control points for the fork look.
export const bez = (x1, y1, x2, y2) => {
  const dx = Math.max(26, Math.abs(x2 - x1) * 0.45);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
};
// Vertical bezier for serpentine row wraps (bottom of one node to the top of
// the next row's node).
export const bezV = (x1, y1, x2, y2) => {
  const dy = Math.max(20, Math.abs(y2 - y1) * 0.5);
  return `M ${x1} ${y1} C ${x1} ${y1 + dy}, ${x2} ${y2 - dy}, ${x2} ${y2}`;
};

export const clampScale = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, n));
};

/* Scale that makes the whole layout fit the viewport, clamped to ZOOM_MIN and
   never past FIT_MAX (an already-small graph is not blown up). */
export function fitScale(width, height, viewportW, viewportH, pad = 28) {
  const w = Math.max(1, Number(width) || 1);
  const h = Math.max(1, Number(height) || 1);
  const availW = Math.max(80, (Number(viewportW) || 0) - pad * 2);
  const availH = Math.max(80, (Number(viewportH) || 0) - pad * 2);
  return Math.min(FIT_MAX, clampScale(Math.min(availW / w, availH / h)));
}

/* How many path-mode nodes fit in one row for a viewport this wide. The path
   stays a single serpentine so it keeps reading order; only the row length
   follows the canvas. */
export function pathColumns(viewportWidth, min = 3, max = 14) {
  const usable = Math.max(320, Number(viewportWidth) || 0) - PAD * 2;
  const n = Math.floor((usable + PATH.gx) / (PATH.w + PATH.gx));
  return Math.max(min, Math.min(max, n));
}

/* A deck and its branches, laid out in local coordinates from y = 0, so the
   packer below can place the block anywhere in the sheet. */
function deckBlock(deck, topics, loose) {
  const groups = topics.map((t) => ({ topic: t, cards: loose.cardsByTopic.get(t.id) || [] }));
  if (loose.unparented.length) groups.push({ topic: null, cards: loose.unparented });
  const items = [];
  const centers = [];
  let cursor = 0;
  for (const g of groups) {
    if (g.cards.length) {
      const cards = [];
      let i = 0;
      for (const c of g.cards) {
        const item = {
          key: c.id,
          node: c,
          kind: "card",
          x: COL.card + (i % 2) * STAGGER,
          y: cursor + CARD.h / 2,
          w: CARD.w,
          h: CARD.h,
        };
        cards.push(item);
        items.push(item);
        i += 1;
        cursor += CARD.h + ROW_GAP;
      }
      cursor += TOPIC_GAP - ROW_GAP; // widen the gap between topic groups
      const avg = cards.reduce((s, c) => s + c.y, 0) / cards.length;
      centers.push(avg);
      items.push({
        key: g.topic ? g.topic.id : `ghost:${deck.id}:${g.cards[0].id}`,
        node: g.topic || { label: "未分组", ghost: true },
        kind: g.topic ? "topic" : "ghost",
        x: COL.topic,
        y: avg,
        w: TOPIC.w,
        h: TOPIC.h,
      });
    } else {
      const y = cursor + CARD.h / 2;
      centers.push(y);
      items.push({
        key: g.topic.id,
        node: g.topic,
        kind: "topic",
        x: COL.topic,
        y,
        w: TOPIC.w,
        h: TOPIC.h,
      });
      cursor += CARD.h + TOPIC_GAP;
    }
  }
  const deckY = centers.length
    ? centers.reduce((s, y) => s + y, 0) / centers.length
    : DECK.h / 2;
  items.push({
    key: deck.id,
    node: deck,
    kind: "deck",
    x: COL.deck,
    y: deckY,
    w: DECK.w,
    h: DECK.h,
  });
  return { items, height: Math.max(DECK.h, ...items.map((i) => i.y + i.h / 2)) };
}

/* Column target that makes the packed sheet fit the real viewport best. The
   fit scale of a packed sheet is `min(availW / (columns * COLUMN_W), availH /
   target)`; a tall narrow ribbon wastes width and a wide flat strip wastes
   height, so the best target is the one whose aspect ratio is closest to the
   canvas. The pack is cheap, so the target is simply searched. */
function packedSize(blocks, target) {
  let colX = PAD;
  let colY = PAD;
  let width = PAD;
  let bottom = PAD;
  let columns = 0;
  for (const block of blocks) {
    if (colY > PAD && colY + block.height > target) {
      colX += COLUMN_W + COLUMN_GAP;
      colY = PAD;
      columns += 1;
    }
    colY += block.height + DECK_GAP;
    bottom = Math.max(bottom, colY - DECK_GAP);
    width = Math.max(width, colX + COLUMN_W);
  }
  return { width, height: bottom + PAD, columns: columns + (blocks.length ? 1 : 0) };
}

/** The column height that lets the most of this library be seen at once. */
export function bestColumnTarget(blocks, viewportW, viewportH) {
  if (!blocks.length) return COLUMN_TARGET_H;
  const vw = Number(viewportW) || 0;
  const vh = Number(viewportH) || 0;
  if (!vw || !vh) return COLUMN_TARGET_H;
  let best = null;
  for (let target = 600; target <= 6000; target += 100) {
    const size = packedSize(blocks, target);
    const scale = fitScale(size.width, size.height, vw, vh, 28);
    if (!best || scale > best.scale + 1e-9) best = { target, scale };
  }
  return best.target;
}

/* structure mode: deck blocks packed left-to-right into columns, each block
   holding its topic fan and card leaves. Cards without a tree edge (or hanging
   directly off a deck) fall into a "未分组" ghost group under their deck.
   `options.columnTargetH` fixes the column height; otherwise the target is
   chosen for the given viewport so the whole sheet fits as large as possible. */
export function layoutStructure(nodes, edges, options = {}) {
  const parentOf = new Map();
  const seqOf = new Map();
  const topicsByDeck = new Map();
  const cardsByParent = new Map();
  const indexed = (nodes || []).map((n, i) => ({ ...n, __i: i }));
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
  const bySeq = (a, b) =>
    (seqOf.get(a.id) ?? a.__i ?? 0) - (seqOf.get(b.id) ?? b.__i ?? 0);

  const blocks = [];
  for (const deck of indexed.filter((n) => kindOf(n) === "deck")) {
    // "deck:<deckId>" — the tail is a plain id, not a JSON array, so the
    // orphan bucket keys off the domain deck id the card ids carry.
    const deckId = String(deck.id).replace(/^deck:/, "");
    const topics = (topicsByDeck.get(deck.id) || [])
      .slice()
      .sort((a, b) => (a.seq ?? a.__i ?? 0) - (b.seq ?? b.__i ?? 0));
    const loose = {
      cardsByTopic: new Map(
        topics.map((t) => [t.id, (cardsByParent.get(t.id) || []).slice().sort(bySeq)]),
      ),
      unparented: [
        ...(cardsByParent.get(deck.id) || []), // deck→card edges without a topic
        ...(cardsByParent.get("orphan:" + deckId) || []),
      ].sort(bySeq),
    };
    blocks.push(deckBlock(deck, topics, loose));
  }

  const target =
    Number(options.columnTargetH) > 0
      ? Number(options.columnTargetH)
      : bestColumnTarget(blocks, options.viewportW, options.viewportH);
  const placed = [];
  const posOf = new Map();
  let colX = PAD;
  let colY = PAD;
  let width = PAD;
  let bottom = PAD;
  let columns = 0;
  for (const block of blocks) {
    if (colY > PAD && colY + block.height > target) {
      colX += COLUMN_W + COLUMN_GAP;
      colY = PAD;
      columns += 1;
    }
    for (const item of block.items) {
      const p = { ...item, x: item.x + colX, y: item.y + colY };
      placed.push(p);
      posOf.set(p.key, p);
    }
    colY += block.height + DECK_GAP;
    bottom = Math.max(bottom, colY - DECK_GAP);
    width = Math.max(width, colX + COLUMN_W);
  }
  const treeEdges = [];
  const prereqEdges = [];
  for (const e of edges || []) {
    if (e.type === "order") continue;
    if (posOf.has(e.from) && posOf.has(e.to))
      (e.type === "prereq" ? prereqEdges : treeEdges).push(e);
  }
  return {
    placed,
    treeEdges,
    prereqEdges,
    posOf,
    columns: columns + (blocks.length ? 1 : 0),
    width,
    height: bottom + PAD,
  };
}

/* path mode: planPath order as a horizontal chain, perRow nodes per row,
   serpentine wrapping (rows alternate right-to-left so the wrap edge is a
   short vertical drop). */
export function layoutPath(nodes, edges, perRow = 6) {
  const PER = Math.max(1, Math.floor(perRow) || 1);
  const { w: W, h: H, gx: GX, gy: GY } = PATH;
  const list = nodes || [];
  const placed = list.map((n, i) => {
    const row = Math.floor(i / PER);
    const col = row % 2 ? PER - 1 - (i % PER) : i % PER;
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
    const a = placed[i];
    const b = placed[i + 1];
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
  const rows = Math.max(1, Math.ceil(list.length / PER));
  const cols = Math.max(1, Math.min(PER, list.length));
  return {
    placed,
    orderPaths,
    prereqEdges,
    posOf,
    width: PAD * 2 + cols * W + (cols - 1) * GX,
    height: PAD * 2 + rows * H + (rows - 1) * GY,
  };
}
