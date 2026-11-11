import test from "node:test";
import assert from "node:assert/strict";
import { REVEAL_ANCHORS_EVENT, closedFolds, locateAnchor, scrollToAnchor } from "../ui/tour/anchor.js";

/* #900: a list that draws its rows in chunks (ui/components/ScrollWindow.jsx ChunkedRows) may not have drawn the row that holds an anchor yet. 找功能 looks through
   locateAnchor, which asks first: the lists hear the question, draw the row and the look that follows finds it. Here the page is a stand-in root. */

const element = (box = { width: 10, height: 10 }, extra = {}) => ({ isConnected: true, tagName: "DIV", parentElement: null, getBoundingClientRect: () => box, ...extra });
function page(present = {}) {
  const root = new EventTarget();
  root.querySelector = (selector) => present[selector.match(/data-tour="([^"]+)"/)[1]] ?? null;
  root.asked = [];
  root.addEventListener(REVEAL_ANCHORS_EVENT, (event) => root.asked.push(event.detail.anchors));
  return root;
}

test("an anchor that is not on the page yet is asked for before the look, in the order of preference", () => {
  const root = page({ list: element() });
  const hit = locateAnchor(root, ["custom-book-row", "list"]);
  assert.deepEqual(root.asked, [["custom-book-row"]], "only the anchor that is missing is asked for");
  assert.equal(hit.index, 1, "the gateway is what is there now");
});

test("a row a list draws when asked is what the look finds, the first time", () => {
  const root = page({ list: element() });
  root.addEventListener(REVEAL_ANCHORS_EVENT, () => { root.querySelector = () => element(); });
  const hit = locateAnchor(root, ["custom-book-row", "list"]);
  assert.equal(hit.index, 0, "the row is drawn before the look, so it wins over the gateway");
});

test("anchors that are all there ask nothing, and a missing page asks nothing", () => {
  const root = page({ a: element(), b: element() });
  assert.equal(locateAnchor(root, ["a", "b"]).index, 0);
  assert.deepEqual(root.asked, []);
  assert.equal(locateAnchor(null, ["a"]), null);
  assert.equal(locateAnchor({ querySelector: () => null }, ["a"]), null, "a root that cannot be told anything is only looked through");
});

test("#927: an anchor inside a <details>'s <summary> keeps its own fold closed so summary-only notices stay visible, while outer closed folds still open", () => {
  const outer = { tagName: "DETAILS", open: false, parentElement: null };
  const card = { tagName: "DETAILS", open: false, parentElement: outer };
  const summary = { tagName: "SUMMARY", parentElement: card };
  const prompt = { tagName: "SPAN", parentElement: summary };
  const notice = {
    isConnected: true,
    tagName: "SMALL",
    parentElement: prompt,
    // Like .draft-card[open] > .draft-card__row .draft-card__similar { display: none }: visible only when outer is open AND card stays closed.
    getBoundingClientRect: () => (outer.open && !card.open ? { width: 80, height: 16 } : { width: 0, height: 0 }),
  };
  assert.deepEqual(closedFolds(notice), [outer], "the card whose summary holds the notice is skipped, outer folds stay");
  const root = page({ "draft-similar": notice, "draft-publish": element() });
  const hit = locateAnchor(root, ["draft-similar", "draft-publish"]);
  assert.equal(hit?.index, 0, "locates draft-similar instead of hiding it and falling back to draft-publish");
  assert.equal(outer.open, true, "outer fold around the card was opened");
  assert.equal(card.open, false, "the card itself stayed closed so its summary notice stayed visible");
  assert.equal(hit?.opened, true);
});

test("#930: scrollToAnchor re-scrolls without animation when chunks appended above push the target away", async () => {
  const calls = [];
  let top = 5000, chunksLeft = 2;
  const target = {
    isConnected: true,
    getBoundingClientRect: () => ({ top, bottom: top + 40, width: 200, height: 40 }),
    scrollIntoView(options) { calls.push(options); top = 260; },
  };
  const frames = [];
  const prevRaf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (cb) => { frames.push(cb); return frames.length; };
  try {
    const done = scrollToAnchor(target, { block: "center" });
    assert.equal(calls.length, 1, "first scroll happens synchronously");
    assert.deepEqual(calls[0], { block: "center", behavior: "auto" });
    while (frames.length) {
      const batch = frames.splice(0);
      // Simulate ChunkedRows appending a chunk right after a scroll lands near an open group's end marker.
      if (chunksLeft > 0 && top === 260) { chunksLeft -= 1; top = 9860; }
      for (const cb of batch) cb();
    }
    await done;
    assert.equal(calls.length, 3, "re-scrolled once per appended chunk until the target stayed put");
    assert.ok(calls.every((call) => call.behavior === "auto"), "every corrective scroll is instant");
    assert.equal(top, 260);
  } finally {
    globalThis.requestAnimationFrame = prevRaf;
  }
});
