import test from "node:test";
import assert from "node:assert/strict";
import {
  layoutStructure,
  layoutPath,
  bestColumnTarget,
  pathColumns,
  fitScale,
  clampScale,
  COLUMN_TARGET_H,
  COLUMN_W,
  COLUMN_GAP,
  PAD,
  ZOOM_MIN,
  ZOOM_MAX,
  FIT_MAX,
} from "../ui/graph-layout.js";

/* A library shaped like a real one: decks of topics of cards, with optional
   prerequisite links between consecutive cards of a topic. */
function library({ decks = 3, topicsPerDeck = 2, cardsPerTopic = 6, prereq = false } = {}) {
  const nodes = [];
  const edges = [];
  const cardId = (d, t, c) => `${d}-t${t}-c${c}`;
  const cardNode = (deckId, id) => `card:${JSON.stringify([deckId, id])}`;
  for (let d = 0; d < decks; d += 1) {
    const deckId = `d${d}`;
    nodes.push({
      id: `deck:${deckId}`,
      kind: "deck",
      label: `题组 ${d}`,
      mastery: 40,
      due: 2,
      total: topicsPerDeck * cardsPerTopic,
    });
    for (let t = 0; t < topicsPerDeck; t += 1) {
      const topic = `主题 ${t}`;
      const topicId = `topic:${JSON.stringify([deckId, topic])}`;
      nodes.push({ id: topicId, kind: "topic", label: topic, mastery: 30, due: 1, total: cardsPerTopic });
      edges.push({ from: `deck:${deckId}`, to: topicId, type: "tree", seq: t });
      for (let c = 0; c < cardsPerTopic; c += 1) {
        nodes.push({ id: cardNode(deckId, cardId(d, t, c)), kind: "card", label: `${topic} ${c}`, level: "weak" });
        edges.push({ from: topicId, to: cardNode(deckId, cardId(d, t, c)), type: "tree" });
        if (prereq && c > 0)
          edges.push({
            from: cardNode(deckId, cardId(d, t, c - 1)),
            to: cardNode(deckId, cardId(d, t, c)),
            type: "prereq",
          });
      }
    }
  }
  return { nodes, edges };
}

test("deck blocks pack into columns instead of one clipped ribbon", () => {
  const { nodes, edges } = library({ decks: 3, topicsPerDeck: 2, cardsPerTopic: 6 });
  const layout = layoutStructure(nodes, edges);
  assert.equal(layout.columns, 2, "three medium decks wrap into two columns");
  assert.ok(layout.height < COLUMN_TARGET_H + 400, `height stays near the target: ${layout.height}`);
  assert.ok(layout.width > COLUMN_W + COLUMN_GAP, "the sheet grows sideways");
  // The old renderer cut every drawing at 1200px; nothing caps the height now.
  const big = library({ decks: 1, topicsPerDeck: 1, cardsPerTopic: 60 });
  const tall = layoutStructure(big.nodes, big.edges);
  assert.ok(tall.height > COLUMN_TARGET_H, `a tall deck keeps its own column: ${tall.height}`);
  assert.equal(tall.columns, 1);
});

test("every node is placed exactly once, with finite non-negative coordinates", () => {
  const { nodes, edges } = library({ decks: 4, topicsPerDeck: 3, cardsPerTopic: 5, prereq: true });
  const layout = layoutStructure(nodes, edges);
  assert.equal(layout.placed.length, nodes.length);
  assert.equal(layout.posOf.size, nodes.length);
  for (const p of layout.placed) {
    for (const key of ["x", "y", "w", "h"])
      assert.ok(Number.isFinite(p[key]), `${p.key}.${key} is a number`);
    assert.ok(p.x >= PAD && p.y >= PAD, `${p.key} sits inside the sheet`);
    assert.ok(p.x + p.w <= layout.width, `${p.key} does not overflow the sheet`);
    assert.ok(p.y + p.h / 2 <= layout.height, `${p.key} does not overflow vertically`);
  }
});

test("deck branches keep reading order and both edge kinds survive", () => {
  const { nodes, edges } = library({ decks: 2, topicsPerDeck: 2, cardsPerTopic: 4, prereq: true });
  const layout = layoutStructure(nodes, edges);
  const cardsOfDeck0 = layout.placed
    .filter((p) => p.kind === "card" && p.node.id.includes('"d0"'))
    .map((p) => p.y);
  for (let i = 1; i < cardsOfDeck0.length; i += 1)
    assert.ok(cardsOfDeck0[i] > cardsOfDeck0[i - 1], "cards stay in sequence order");
  assert.ok(layout.treeEdges.length > 0);
  assert.equal(layout.prereqEdges.length, edges.filter((e) => e.type === "prereq").length);
  for (const e of [...layout.treeEdges, ...layout.prereqEdges]) {
    assert.ok(layout.posOf.has(e.from) && layout.posOf.has(e.to), "edges only survive with both ends placed");
  }
});

test("a card without a tree edge falls into the 未分组 ghost group", () => {
  const { nodes, edges } = library({ decks: 1, topicsPerDeck: 1, cardsPerTopic: 2 });
  const orphan = { id: `card:${JSON.stringify(["d0", "loose-1"])}`, kind: "card", label: "散题", level: "new" };
  const layout = layoutStructure([...nodes, orphan], edges);
  const ghost = layout.placed.find((p) => p.kind === "ghost");
  assert.ok(ghost, "ghost group is placed");
  assert.equal(ghost.node.label, "未分组");
  assert.ok(layout.posOf.has(orphan.id), "the orphan card is still clickable");
});

test("the column target follows the viewport so the sheet fits bigger", () => {
  const { nodes, edges } = library({ decks: 10, topicsPerDeck: 4, cardsPerTopic: 8 });
  const ribbon = layoutStructure(nodes, edges);
  const canvas = layoutStructure(nodes, edges, { viewportW: 1440, viewportH: 900 });
  assert.ok(canvas.columns < ribbon.columns, `fewer columns: ${canvas.columns} < ${ribbon.columns}`);
  assert.ok(canvas.height > ribbon.height, "the sheet uses the height it has");
  assert.ok(
    fitScale(canvas.width, canvas.height, 1440, 900, 28) >
      fitScale(ribbon.width, ribbon.height, 1440, 900, 28),
    "a viewport-shaped sheet is shown larger than the default ribbon",
  );
  assert.equal(bestColumnTarget([], 1440, 900), COLUMN_TARGET_H, "an empty library keeps the default");
});

test("fit scale shows everything without ever magnifying past FIT_MAX", () => {
  // Height is the binding constraint, so the ratio is the vertical one.
  assert.ok(Math.abs(fitScale(800, 1800, 1200, 700, 28) - (700 - 56) / 1800) < 1e-9);
  // A drawing too tall to fit at ZOOM_MIN still comes back inside the range.
  assert.equal(fitScale(1800, 6000, 1200, 700, 28), ZOOM_MIN);
  assert.equal(fitScale(300, 200, 1200, 700), FIT_MAX);
  assert.equal(fitScale(500000, 500000, 1200, 700), ZOOM_MIN);
  const unmeasured = fitScale(800, 600, 0, 0);
  assert.ok(
    Number.isFinite(unmeasured) && unmeasured >= ZOOM_MIN && unmeasured <= ZOOM_MAX,
    "an unmeasured viewport still yields a usable scale, not NaN or 0",
  );
});

test("clampScale keeps zoom inside its range and survives junk input", () => {
  assert.equal(clampScale(0.001), ZOOM_MIN);
  assert.equal(clampScale(99), ZOOM_MAX);
  assert.equal(clampScale(0.5), 0.5);
  assert.equal(clampScale("nope"), 1);
  assert.equal(clampScale(0), 1);
});

test("path mode packs more nodes per row on a wider canvas and wraps serpentine", () => {
  assert.ok(pathColumns(1600) > pathColumns(420));
  assert.equal(pathColumns(4000, 3, 14), 14);
  assert.ok(pathColumns(1600) >= 7);
  assert.equal(pathColumns(10, 3, 14), 3);
  const nodes = Array.from({ length: 9 }, (_, i) => ({ id: `card:${JSON.stringify(["d", "c" + i])}`, kind: "card", label: "c" + i }));
  const edges = nodes.slice(1).map((n, i) => ({ from: nodes[i].id, to: n.id, type: "order", seq: i }));
  const layout = layoutPath(nodes, edges, 4);
  assert.equal(layout.placed.length, 9);
  assert.equal(layout.orderPaths.length, 8);
  assert.equal(layout.placed[0].y, layout.placed[3].y, "a full row shares one y");
  assert.ok(layout.placed[4].y > layout.placed[3].y, "the next row drops below");
  assert.ok(layout.placed[4].x > layout.placed[5].x, "the wrapped row runs right to left");
  assert.equal(layout.width, PAD * 2 + 4 * 172 + 3 * 52);
});
