import test from "node:test";
import assert from "node:assert/strict";
import { REVEAL_ANCHORS_EVENT, locateAnchor } from "../ui/tour/anchor.js";

/* #900: a list that draws its rows in chunks (ui/components/ScrollWindow.jsx ChunkedRows) may not have drawn the row that holds an anchor yet. 找功能 looks through
   locateAnchor, which asks first: the lists hear the question, draw the row and the look that follows finds it. Here the page is a stand-in root. */

const element = (box = { width: 10, height: 10 }) => ({ isConnected: true, tagName: "DIV", parentElement: null, getBoundingClientRect: () => box });
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
