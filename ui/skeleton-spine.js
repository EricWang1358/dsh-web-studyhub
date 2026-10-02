/* Spine reading of a knowledge skeleton: top-level concepts become stations
   on one horizontal learning axis (in the order the skeleton lists them),
   their children hang below as a vertical branch, and deeper nodes branch
   again from those. Pure data, no React, so the shape can be tested. */

const cardKey = (ref) => `${ref.deckId}:${ref.cardId}`;

function uniqueCards(refs) {
  const seen = new Map();
  for (const ref of refs) if (ref?.cardId && !seen.has(cardKey(ref))) seen.set(cardKey(ref), ref);
  return [...seen.values()];
}

export function skeletonSpine(skeleton) {
  const nodes = Array.isArray(skeleton?.nodes) ? skeleton.nodes : [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const children = new Map();
  for (const n of nodes) {
    const parent = n.parent && byId.has(n.parent) && n.parent !== n.id ? n.parent : "";
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(n);
  }
  const contrasts = new Map();
  for (const r of skeleton?.relations || []) {
    if (r.type !== "contrasts" || !byId.has(r.from) || !byId.has(r.to)) continue;
    for (const [a, b] of [[r.from, r.to], [r.to, r.from]]) {
      if (!contrasts.has(a)) contrasts.set(a, []);
      contrasts.get(a).push(byId.get(b).term);
    }
  }
  const visited = new Set();
  const branch = (node, depth) => {
    visited.add(node.id);
    const kids = (children.get(node.id) || []).filter((k) => !visited.has(k.id)).map((k) => branch(k, depth + 1));
    return {
      id: node.id,
      term: node.term,
      meaning: node.meaning || "",
      attributes: node.attributes || [],
      contrasts: [...new Set(contrasts.get(node.id) || [])],
      depth,
      cards: node.cards || [],
      children: kids,
      subtreeCards: uniqueCards([...(node.cards || []), ...kids.flatMap((k) => k.subtreeCards)]),
    };
  };
  const stations = (children.get("") || []).map((root) => branch(root, 0));
  // Parent cycles leave nodes no root reaches; they still get a station.
  for (const n of nodes) if (!visited.has(n.id)) stations.push(branch(n, 0));
  return stations.map((s, i) => ({ ...s, step: i + 1 }));
}

/* ── The compact spine: counts, keys and the remembered fold ─────────── */

/** Stations and the points under them (at any depth), for the "5 站 · 8 个要点" line. */
export function spineCounts(stations) {
  const below = (list) => list.reduce((n, item) => n + 1 + below(item.children), 0);
  const list = Array.isArray(stations) ? stations : [];
  return { stations: list.length, points: list.reduce((n, station) => n + below(station.children), 0) };
}

/** Where a key on the station strip moves the current station, or null for a key the strip does not handle. The ends stay put. */
export function spineKeyTarget(index, key, count) {
  if (!(count > 0)) return null;
  if (key === "ArrowRight") return Math.min(count - 1, index + 1);
  if (key === "ArrowLeft") return Math.max(0, index - 1);
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}

/** The spine opens by itself only on the step whose subject it is; in a lesson it is one folded line. */
export const spineDefaultOpen = (stepKind) => stepKind === "skeleton";

/** One small per-browser convenience per step type. */
export const spineOpenKey = (stepKind) => `study-spine-${stepKind || "page"}`;

const browserStorage = () => { try { return globalThis.localStorage || null; } catch { return null; } };

export function readSpineOpen(stepKind, storage = browserStorage()) {
  try {
    const saved = storage?.getItem(spineOpenKey(stepKind));
    if (saved === "open") return true;
    if (saved === "folded") return false;
  } catch { /* blocked storage: the default applies */ }
  return spineDefaultOpen(stepKind);
}

export function writeSpineOpen(stepKind, open, storage = browserStorage()) {
  try { storage?.setItem(spineOpenKey(stepKind), open ? "open" : "folded"); } catch { /* blocked storage: the fold just is not remembered */ }
}
