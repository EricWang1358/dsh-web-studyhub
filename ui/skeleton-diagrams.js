/* Pure geometry for the knowledge-skeleton diagrams: a UML class diagram for
   the concept structure and UML sequence diagrams for dynamic chains. No React
   or DOM, so the layouts can be asserted in tests. Text is fitted by width
   units (CJK counts double) because SVG text does not wrap. */

export const CLASS = { w: 224, head: 36, line: 18, pad: 8, empty: 14, gx: 64, gy: 96, perRow: 5, margin: 24 };
export const SEQ = { colW: 208, head: 36, margin: 20, first: 38, step: 64, note: 20, tail: 40, self: 42 };

/** UML notation for each skeleton relation type. */
export const RELATION_UML = Object.freeze({
  "part-of": { edge: "composition", label: "" },
  causes: { edge: "dependency", label: "«导致»" },
  prerequisite: { edge: "dependency", label: "«前置»" },
  "example-of": { edge: "realization", label: "" },
  contrasts: { edge: "association", label: "对比" },
  related: { edge: "association", label: "" },
});

const units = (ch) => (/[\u1100-\uffff]/.test(ch) ? 2 : 1);
/** Clip text to a width budget in units (ASCII 1, CJK 2), adding an ellipsis. */
export function fit(text, max) {
  const s = String(text ?? "");
  let used = 0;
  for (let i = 0; i < s.length; i++) {
    used += units(s[i]);
    if (used > max) return s.slice(0, Math.max(0, i - 1)) + "…";
  }
  return s;
}

export const classBoxHeight = (node) => {
  const n = node.attributes?.length || 0;
  return CLASS.head + (n ? n * CLASS.line + CLASS.pad * 2 : CLASS.empty);
};

/** Where the segment from the box centre towards (tx, ty) leaves the box. */
export function clipToBox(box, tx, ty) {
  const cx = box.x + box.w / 2,
    cy = box.y + box.h / 2,
    dx = tx - cx,
    dy = ty - cy;
  if (!dx && !dy) return { x: cx, y: cy };
  const sx = dx ? box.w / 2 / Math.abs(dx) : Infinity,
    sy = dy ? box.h / 2 / Math.abs(dy) : Infinity,
    s = Math.min(sx, sy);
  return { x: cx + dx * s, y: cy + dy * s };
}

/** Recompute attachment points after dragging; side lanes keep long links in
 * a narrow focus view from running through intervening concept boxes. */
export function routeClassEdge(edge, boxes) {
  const a = boxes.get(edge.from), b = boxes.get(edge.to);
  if (edge.routeSide) {
    const right = edge.routeSide === "right";
    const x1 = a.x + (right ? a.w : 0), x2 = b.x + (right ? b.w : 0);
    const y1 = a.y + a.h / 2, y2 = b.y + b.h / 2;
    const lane = right ? Math.max(x1, x2) + edge.laneOffset : Math.min(x1, x2) - edge.laneOffset;
    return { ...edge, x1, x2, y1, y2, labelX: lane, labelY: (y1 + y2) / 2,
      d: `M ${x1} ${y1} H ${lane} V ${y2} H ${x2}` };
  }
  const start = clipToBox(a, b.x + b.w / 2, b.y + b.h / 2), end = clipToBox(b, a.x + a.w / 2, a.y + a.h / 2);
  return { ...edge, x1: start.x, y1: start.y, x2: end.x, y2: end.y };
}

/**
 * Layered class layout: generalization parents sit above their children, and a
 * whole sits above its parts (part-of) or realizations when no parent is set.
 * Children are ordered under their parents; wide layers wrap into rows.
 */
function layoutClassComponent(skeleton, { direction = "down", spacing = 1, compact = false } = {}) {
  const nodes = skeleton?.nodes || [];
  const heightOf = compact ? () => CLASS.head : classBoxHeight;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const up = new Map();
  for (const n of nodes) if (n.parent && byId.has(n.parent)) up.set(n.id, n.parent);
  for (const r of skeleton?.relations || [])
    if ((r.type === "part-of" || r.type === "example-of") && !up.has(r.from) && byId.has(r.to) && r.from !== r.to)
      up.set(r.from, r.to);
  const structuralIds = new Set(up.keys());
  // Causal chains run forward; explicit class inheritance takes precedence.
  for (const r of skeleton?.relations || [])
    if ((r.type === "causes" || r.type === "prerequisite") && !up.has(r.to) && byId.has(r.from) && byId.has(r.to) && r.from !== r.to)
      up.set(r.to, r.from);
  // Association-only networks still have structure: traverse from the most
  // connected concept rather than making one giant flat row.
  if (!up.size && nodes.length > 1) {
    const neighbours = new Map(nodes.map((n) => [n.id, []]));
    for (const r of skeleton.relations || []) {
      if (r.from === r.to || !byId.has(r.from) || !byId.has(r.to)) continue;
      neighbours.get(r.from).push(r.to); neighbours.get(r.to).push(r.from);
    }
    const root = nodes.reduce((a, b) => neighbours.get(b.id).length > neighbours.get(a.id).length ? b : a);
    const queue = [root.id], seen = new Set(queue);
    for (let at = 0; at < queue.length; at++) for (const id of neighbours.get(queue[at])) {
      if (seen.has(id)) continue;
      seen.add(id); up.set(id, queue[at]); queue.push(id);
    }
  }
  const depthOf = new Map();
  // Resolve parent chains iteratively: no recursion limit or truncated depth.
  // Cut one layout-only link for cycles; the actual relation stays in the graph.
  for (const n of nodes) {
    const path = [], seen = new Set();
    let id = n.id;
    while (id && !depthOf.has(id)) {
      if (seen.has(id)) { up.delete(path[path.length - 1]); break; }
      seen.add(id); path.push(id); id = up.get(id);
    }
    for (let i = path.length - 1; i >= 0; i--) {
      const parent = up.get(path[i]);
      depthOf.set(path[i], parent ? (depthOf.get(parent) ?? -1) + 1 : 0);
    }
  }
  // For acyclic directed networks, account for every incoming edge so a merge
  // follows both branches, including when one branch is much longer.
  const next = new Map(nodes.map((n) => [n.id, new Set()]));
  const indegree = new Map(nodes.map((n) => [n.id, 0]));
  const link = (from, to) => {
    if (from === to || !byId.has(from) || !byId.has(to) || next.get(from).has(to)) return;
    next.get(from).add(to); indegree.set(to, indegree.get(to) + 1);
  };
  for (const n of nodes) if (n.parent) link(n.parent, n.id);
  for (const r of skeleton.relations || []) {
    if (r.type === "part-of" || r.type === "example-of") link(r.to, r.from);
    if ((r.type === "causes" || r.type === "prerequisite") && !structuralIds.has(r.to)) link(r.from, r.to);
  }
  if ([...next.values()].some((set) => set.size)) {
    const queue = nodes.filter((n) => !indegree.get(n.id)).map((n) => n.id);
    const ranks = new Map(queue.map((id) => [id, 0]));
    for (let at = 0; at < queue.length; at++) for (const id of next.get(queue[at])) {
      ranks.set(id, Math.max(ranks.get(id) || 0, ranks.get(queue[at]) + 1));
      indegree.set(id, indegree.get(id) - 1);
      if (!indegree.get(id)) queue.push(id);
    }
    if (queue.length === nodes.length) for (const [id, rank] of ranks) depthOf.set(id, rank);
  }
  const layers = [];
  for (const n of nodes) (layers[depthOf.get(n.id)] ||= []).push(n);

  const order = new Map();
  const boxes = new Map();
  let y = CLASS.margin,
    width = 0;
  const rows = [];
  const gx = CLASS.gx * spacing * (compact ? 0.65 : 1), gy = CLASS.gy * spacing * (compact ? 0.75 : 1);
  layers.forEach((layer, i) => {
    if (!layer) return;
    const sorted = i === 0
      ? layer
      : [...layer].sort((a, b) => (order.get(up.get(a.id)) ?? 1e9) - (order.get(up.get(b.id)) ?? 1e9));
    sorted.forEach((n, k) => order.set(n.id, k));
    // A branch is one rank, never arbitrary wrapped rows with false hierarchy.
    const h = Math.max(...sorted.map(heightOf));
    const w = sorted.length * CLASS.w + (sorted.length - 1) * gx;
    rows.push({ row: sorted, y, w, h });
    width = Math.max(width, w);
    y += h + gy;
  });
  for (const { row, y: rowY, w } of rows) {
    const x0 = CLASS.margin + (width - w) / 2;
    row.forEach((n, k) => boxes.set(n.id, { id: n.id, node: n, x: x0 + k * (CLASS.w + gx), y: rowY, w: CLASS.w, h: heightOf(n) }));
  }

  if (direction === "right") {
    boxes.clear();
    const heights = rows.map(({ row }) => row.reduce((h, n) => h + heightOf(n), 0) + (row.length - 1) * gx);
    const height = Math.max(0, ...heights);
    rows.forEach(({ row }, i) => {
      let top = CLASS.margin + (height - heights[i]) / 2;
      for (const n of row) {
        boxes.set(n.id, { id: n.id, node: n, x: CLASS.margin + i * (CLASS.w + gy), y: top, w: CLASS.w, h: heightOf(n) });
        top += heightOf(n) + gx;
      }
    });
    return { width: rows.length * (CLASS.w + gy) - gy + CLASS.margin * 2, height: height + CLASS.margin * 2, boxes: [...boxes.values()] };
  }

  return {
    width: width + CLASS.margin * 2,
    height: Math.max(CLASS.margin * 2, y - gy + CLASS.margin),
    boxes: [...boxes.values()],
    edges: classEdges(skeleton, boxes),
  };
}

/** Viewport filtering leaves an overscan margin and keeps the active node.
 * Layout and relationships remain complete; only offscreen DOM is omitted. */
export function visibleClasses(boxes, edges, view, viewport, keepId, overscan = 180) {
  if (boxes.size <= 120 || !viewport.w || !viewport.h) return { boxes: [...boxes.values()], edges };
  const left = (-view.x - overscan) / view.k, top = (-view.y - overscan) / view.k;
  const right = (viewport.w - view.x + overscan) / view.k, bottom = (viewport.h - view.y + overscan) / view.k;
  const overlaps = (x1, y1, x2, y2) => x2 >= left && x1 <= right && y2 >= top && y1 <= bottom;
  return {
    boxes: [...boxes.values()].filter((b) => b.id === keepId || overlaps(b.x, b.y, b.x + b.w, b.y + b.h)),
    edges: edges.filter((e) => overlaps(Math.min(e.x1, e.x2), Math.min(e.y1, e.y2), Math.max(e.x1, e.x2), Math.max(e.y1, e.y2))),
  };
}

/** Weak components include every relationship, not just inheritance. Iterative
 * traversal keeps isolated concepts and cycles safe on large libraries. */
export function classComponents(skeleton) {
  const nodes = skeleton?.nodes || [];
  const adjacency = new Map(nodes.map((n) => [n.id, []]));
  const connect = (a, b) => {
    if (a === b || !adjacency.has(a) || !adjacency.has(b)) return;
    adjacency.get(a).push(b);
    adjacency.get(b).push(a);
  };
  for (const n of nodes) connect(n.id, n.parent);
  for (const r of skeleton?.relations || []) connect(r.from, r.to);
  const owner = new Map(), groups = [];
  for (const node of nodes) {
    if (owner.has(node.id)) continue;
    const group = { id: node.id, title: node.term || node.id, nodes: [], relations: [] };
    groups.push(group);
    const queue = [node.id];
    owner.set(node.id, group);
    for (let at = 0; at < queue.length; at++) {
      for (const id of adjacency.get(queue[at])) {
        if (owner.has(id)) continue;
        owner.set(id, group);
        queue.push(id);
      }
    }
  }
  for (const node of nodes) owner.get(node.id).nodes.push(node);
  for (const r of skeleton?.relations || []) {
    const group = owner.get(r.from);
    if (group && group === owner.get(r.to)) group.relations.push(r);
  }
  return groups;
}

/** Lay out each independent network, then pack networks with a clear gutter. */
export function layoutClasses(skeleton, options = {}) {
  const groups = classComponents(skeleton);
  const blocks = groups.map((group) => ({ group, layout: layoutClassComponent(group, options) }));
  const gutter = 80;
  const area = blocks.reduce((sum, b) => sum + (b.layout.width + gutter) * (b.layout.height + gutter + 32), 0);
  const aspect = options.aspect || 1.6;
  const estimate = Math.max(800, Math.sqrt(area * aspect));
  const packSize = (target) => {
    let x = 0, y = 0, h = 0, w = 0;
    for (const { layout } of blocks) {
      if (x && x + layout.width > target) { x = 0; y += h + gutter; h = 0; }
      w = Math.max(w, x + layout.width); h = Math.max(h, layout.height + 32); x += layout.width + gutter;
    }
    return Math.max(w / aspect, y + h);
  };
  // A shelf just narrower than two blocks wastes most of a wide viewport.
  // Compare nearby packings instead of accepting that discontinuity.
  let target = estimate, score = packSize(target);
  for (const factor of [0.5, 0.75, 1.25, 1.5, 2, 3]) {
    const candidate = estimate * factor, next = packSize(candidate);
    if (next < score) { score = next; target = candidate; }
  }
  const boxes = [], components = [];
  let x = 0, y = 0, rowH = 0, width = 0;
  for (const { group, layout } of blocks) {
    if (x && x + layout.width > target) { x = 0; y += rowH + gutter; rowH = 0; }
    components.push({ id: group.id, title: group.title, count: group.nodes.length, x, y, w: layout.width, h: layout.height + 32 });
    for (const b of layout.boxes) boxes.push({ ...b, x: b.x + x, y: b.y + y + 32 });
    width = Math.max(width, x + layout.width);
    rowH = Math.max(rowH, layout.height + 32);
    x += layout.width + gutter;
  }
  return { width: Math.max(CLASS.margin * 2, width), height: Math.max(CLASS.margin * 2, y + rowH), boxes,
    edges: classEdges(skeleton, new Map(boxes.map((b) => [b.id, b]))), components };
}

/** UML edges (generalization + relations) between the boxes that are present. */
export function classEdges(skeleton, boxes) {
  const nodes = skeleton?.nodes || [];
  const edge = (from, to, kind, label, extra = {}) => {
    const a = boxes.get(from),
      b = boxes.get(to);
    if (!a || !b || from === to) return null;
    const start = clipToBox(a, b.x + b.w / 2, b.y + b.h / 2),
      end = clipToBox(b, a.x + a.w / 2, a.y + a.h / 2);
    return { from, to, kind, label, x1: start.x, y1: start.y, x2: end.x, y2: end.y, ...extra };
  };
  return [
    ...nodes.filter((n) => n.parent).map((n) => edge(n.id, n.parent, "generalization", "")),
    ...(skeleton?.relations || []).map((r) => {
      const uml = RELATION_UML[r.type] || RELATION_UML.related;
      return edge(r.from, r.to, uml.edge, uml.label, { type: r.type, ...(r.note ? { note: r.note } : {}) });
    }),
  ].filter(Boolean);
}

/** The focused concept's direct neighbours, grouped by where they sit around it. */
export function focusNeighbours(skeleton, focusId) {
  const nodes = skeleton?.nodes || [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const focus = byId.get(focusId);
  if (!focus) return null;
  const seen = new Set([focusId]);
  const bands = { up: [], down: [], left: [], right: [] };
  const add = (band, id) => {
    if (!byId.has(id) || seen.has(id)) return;
    seen.add(id);
    bands[band].push(byId.get(id));
  };
  // Above: what it is a kind of / part of / an example of. Below: its subtypes, parts, examples.
  if (focus.parent) add("up", focus.parent);
  for (const r of skeleton.relations || [])
    if ((r.type === "part-of" || r.type === "example-of") && r.from === focusId) add("up", r.to);
  for (const n of nodes) if (n.parent === focusId) add("down", n.id);
  for (const r of skeleton.relations || [])
    if ((r.type === "part-of" || r.type === "example-of") && r.to === focusId) add("down", r.from);
  // Sides: whatever points at it (causes, prerequisites, contrasts) and what it points to.
  for (const r of skeleton.relations || []) {
    if (r.to === focusId) add("left", r.from);
    else if (r.from === focusId) add("right", r.to);
  }
  return { focus, ...bands, ids: seen };
}

/**
 * Focus view: only the selected concept and its direct neighbours, laid out
 * around it (generalizations/wholes above, subtypes/parts below, incoming
 * relations left, outgoing right). Edges among the neighbours stay visible.
 */
export function layoutFocus(skeleton, focusId, { perRow = 4, narrow = false, compact = false } = {}) {
  const found = focusNeighbours(skeleton, focusId);
  if (!found) return null;
  const { focus, up, down, left, right } = found;
  const heightOf = compact ? () => CLASS.head : classBoxHeight;
  if (narrow) {
    const boxes = new Map();
    let y = CLASS.margin;
    for (const n of [...up, ...left, focus, ...right, ...down]) {
      const h = heightOf(n);
      boxes.set(n.id, { id: n.id, node: n, x: CLASS.margin + 48, y, w: CLASS.w, h });
      y += h + 48;
    }
    const edges = classEdges(skeleton, boxes).map((e, i) => {
      const a = boxes.get(e.from), b = boxes.get(e.to);
      const adjacent = Math.abs(a.y - b.y) <= Math.max(a.h, b.h) + 49;
      return adjacent ? e : routeClassEdge({ ...e, routeSide: e.from === focusId ? "right" : "left", laneOffset: 24 + (i % 3) * 12 }, boxes);
    });
    return { width: CLASS.w + CLASS.margin * 2 + 96, height: y - 48 + CLASS.margin,
      boxes: [...boxes.values()], edges, focusId, neighbours: boxes.size - 1 };
  }
  const W = CLASS.w,
    gx = CLASS.gx,
    gy = CLASS.gy,
    m = CLASS.margin;
  const rowsOf = (list) => {
    const rows = [];
    for (let i = 0; i < list.length; i += perRow) rows.push(list.slice(i, i + perRow));
    return rows;
  };
  const rowWidth = (row) => row.length * W + (row.length - 1) * gx;
  const upRows = rowsOf(up),
    downRows = rowsOf(down);
  const centerW = Math.max(W, ...upRows.map(rowWidth), ...downRows.map(rowWidth));
  const sideW = (list) => (list.length ? W + gx * 2 : 0);
  const leftW = sideW(left),
    rightW = sideW(right);
  const centerX = m + leftW;
  const boxes = new Map();
  const place = (n, x, y) => boxes.set(n.id, { id: n.id, node: n, x, y, w: W, h: heightOf(n) });

  let y = m;
  for (const row of upRows) {
    const x0 = centerX + (centerW - rowWidth(row)) / 2;
    row.forEach((n, k) => place(n, x0 + k * (W + gx), y));
    y += Math.max(...row.map(heightOf)) + gy;
  }
  const focusH = heightOf(focus),
    stack = (list) => list.reduce((sum, n) => sum + heightOf(n), 0) + Math.max(0, list.length - 1) * 18;
  const middleH = Math.max(focusH, stack(left), stack(right));
  place(focus, centerX + (centerW - W) / 2, y + (middleH - focusH) / 2);
  for (const [list, x] of [[left, m], [right, centerX + centerW + gx * 2]]) {
    let sy = y + (middleH - stack(list)) / 2;
    for (const n of list) {
      place(n, x, sy);
      sy += heightOf(n) + 18;
    }
  }
  y += middleH + gy;
  for (const row of downRows) {
    const x0 = centerX + (centerW - rowWidth(row)) / 2;
    row.forEach((n, k) => place(n, x0 + k * (W + gx), y));
    y += Math.max(...row.map(heightOf)) + gy;
  }
  return {
    width: leftW + centerW + rightW + m * 2,
    height: y - gy + m,
    boxes: [...boxes.values()],
    edges: classEdges(skeleton, boxes),
    focusId,
    neighbours: boxes.size - 1,
  };
}

/** Lifelines left to right; one row per step, self-messages loop to the right. */
export function layoutSequence(sequence) {
  const participants = (sequence?.participants || []).map((p, i) => ({
    ...p,
    x: SEQ.margin + i * SEQ.colW + SEQ.colW / 2,
  }));
  const xOf = new Map(participants.map((p) => [p.id, p.x]));
  let y = SEQ.margin + SEQ.head + SEQ.first;
  const steps = (sequence?.steps || []).map((st, i) => {
    const row = { ...st, index: i + 1, y, x1: xOf.get(st.from), x2: xOf.get(st.to), self: st.from === st.to };
    y += SEQ.step + (st.note ? SEQ.note : 0);
    return row;
  });
  return {
    width: participants.length * SEQ.colW + SEQ.margin * 2 + (steps.some((st) => st.self && st.from === participants.at(-1)?.id) ? SEQ.colW / 2 : 0),
    height: Math.max(SEQ.head + SEQ.margin * 2, y - SEQ.step + SEQ.tail + SEQ.margin),
    lifelineTop: SEQ.margin + SEQ.head,
    participants,
    steps,
  };
}
