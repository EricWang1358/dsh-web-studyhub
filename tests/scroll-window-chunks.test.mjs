import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { build } from "esbuild";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

/* A scroll window draws its first rows and the rest as the learner scrolls: a library of a thousand materials used to put
   every row (thousands of DOM nodes, half a second of rendering) on the page when the picker opened. */

const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `export { default as ScrollWindow, ChunkedRows, SCROLL_WINDOW_CHUNK, windowRows, nearEnd, withinReach, nextLimit, anchorRow } from './ui/components/ScrollWindow.jsx';
  export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
bundle: true, write: false, platform: "node", format: "cjs", external: ["react", "react-dom"], loader: { ".css": "text" }, logLevel: "silent" });
const module = { exports: {} };
new Function("require", "module", "exports", compiled.outputFiles[0].text)(require, module, module.exports);
const { ScrollWindow, ChunkedRows, SCROLL_WINDOW_CHUNK, windowRows, nearEnd, withinReach, nextLimit, anchorRow, setUiLanguage } = module.exports;
const h = React.createElement;
const items = Array.from({ length: 1000 }, (_, index) => `Item ${index}`);
const render = (props) => { setUiLanguage("zh"); return renderToStaticMarkup(h(ScrollWindow, { label: "List", items, itemKey: (item) => item, renderItem: (item) => h("span", null, item), ...props })); };
const rowCount = (html) => (html.match(/data-scroll-key=/g) || []).length;

test("a long list draws one chunk of rows and still counts them all", () => {
  const html = render({ filterable: true });
  assert.equal(rowCount(html), SCROLL_WINDOW_CHUNK);
  assert.match(html, /共 1000 项/, "the count is the real total, not the drawn rows");
  assert.match(html, /Item 0</);
  assert.doesNotMatch(html, /Item 500</);
});

test("a short list, or renderLimit Infinity, draws everything", () => {
  assert.equal(rowCount(render({ items: items.slice(0, SCROLL_WINDOW_CHUNK) })), SCROLL_WINDOW_CHUNK);
  assert.equal(rowCount(render({ renderLimit: Infinity })), 1000);
  assert.equal(rowCount(render({ renderLimit: 10 })), 10);
});

test("the active row is always drawn, even past the first chunk", () => {
  const html = render({ activeKey: "Item 500" });
  assert.equal(rowCount(html), 501);
  assert.match(html, /data-scroll-key="Item 500"[^>]*data-active="true"|data-active="true"[^>]*data-scroll-key="Item 500"/);
});

test("a filter searches every item, not only the drawn ones", () => {
  const html = render({ filterable: true, query: "Item 99" });
  const expected = items.filter((item) => item.includes("99")).length;
  assert.match(html, new RegExp(`共 1000 项 / 显示 ${expected} 项`));
  assert.equal(rowCount(html), expected);
  const far = render({ filterable: true, query: "Item 500" });
  assert.equal(rowCount(far), 1, "a match far beyond the first chunk is found and drawn");
  assert.match(far, /Item 500</);
});

test("windowRows and nearEnd", () => {
  assert.deepEqual(windowRows([1, 2, 3, 4, 5], 2), [1, 2]);
  assert.deepEqual(windowRows([1, 2, 3, 4, 5], 2, 3), [1, 2, 3, 4]);
  assert.deepEqual(windowRows([1, 2], 10), [1, 2]);
  assert.equal(nearEnd({ scrollTop: 0, clientHeight: 400, scrollHeight: 4000 }), false);
  assert.equal(nearEnd({ scrollTop: 3300, clientHeight: 400, scrollHeight: 4000 }), true, "within a screen of the last drawn row");
});

/* #900: the pages that scroll as a whole (the sources page, the wrong book, a long draft) draw their rows with the same helper: the same first chunk, the same
   rule for "near the end", and a row that something jumps to is always drawn. The behaviour in a browser is tests/chunked-lists-browser.test.mjs. */

test("withinReach is the one rule of near the end: nearEnd and the page lists share it", () => {
  assert.equal(withinReach(319), true);
  assert.equal(withinReach(320), false);
  assert.equal(withinReach(-40), true, "the end is already above the bottom of the screen");
  assert.equal(nearEnd({ scrollTop: 3280, clientHeight: 400, scrollHeight: 4000 }), false, "exactly 320 px left");
  assert.equal(nearEnd({ scrollTop: 3281, clientHeight: 400, scrollHeight: 4000 }), true, "319 px left");
});

test("the next limit is one chunk beyond what is drawn now, so a row drawn for a jump is not drawn twice", () => {
  assert.equal(nextLimit(SCROLL_WINDOW_CHUNK), 2 * SCROLL_WINDOW_CHUNK);
  assert.equal(nextLimit(251), 251 + SCROLL_WINDOW_CHUNK, "a jump had drawn 251 rows: the chunk adds to those");
  assert.equal(nextLimit(80, 80), 160, "a list with a chunk of its own");
});

test("anchorRow: the row of the first wanted anchor this list holds, or -1", () => {
  assert.equal(anchorRow({ custom: 130 }, ["custom", "list"]), 130);
  assert.equal(anchorRow({ custom: 130, other: 5 }, ["other", "custom"]), 5, "the wanted list is in order of preference");
  assert.equal(anchorRow({ custom: 130 }, ["list"]), -1, "an anchor this list does not hold asks for nothing");
  assert.equal(anchorRow({ custom: -1 }, ["custom"]), -1, "a list with no such row says -1");
  assert.equal(anchorRow(undefined, ["custom"]), -1);
  assert.equal(anchorRow({ custom: 0 }, ["custom"]), 0, "the very first row");
  assert.equal(anchorRow({ custom: 3 }, undefined), -1);
});

test("ChunkedRows draws one chunk of rows and an end marker; a short list draws everything and no marker", () => {
  const rows = (props) => renderToStaticMarkup(h(ChunkedRows, { items, render: (item, index) => h("i", { key: item, "data-at": index }, item), ...props }));
  const long = rows({});
  assert.equal((long.match(/<i /g) || []).length, SCROLL_WINDOW_CHUNK);
  assert.match(long, /data-chunk-end/, "the marker the page asks about near the end");
  assert.match(long, /data-at="0"[^>]*>Item 0</);
  assert.doesNotMatch(long, /Item 500</);
  const short = rows({ items: items.slice(0, 40) });
  assert.equal((short.match(/<i /g) || []).length, 40);
  assert.doesNotMatch(short, /data-chunk-end/, "nothing more to draw: no marker");
  assert.equal((rows({ chunk: 80 }).match(/<i /g) || []).length, 80, "a list with a chunk of its own");
  assert.match(rows({ as: "li" }), /<li[^>]*data-chunk-end/, "inside a <ul> the marker is a list item");
});

test("ChunkedRows always draws the row that is revealed, and the rows before it", () => {
  const html = renderToStaticMarkup(h(ChunkedRows, { items, reveal: 700, render: (item) => h("i", { key: item }, item) }));
  assert.equal((html.match(/<i[ >]/g) || []).length, 701);
  assert.match(html, /Item 700</);
  assert.match(html, /data-chunk-end/, "299 rows are still to come");
  const none = renderToStaticMarkup(h(ChunkedRows, { items, reveal: -1, render: (item) => h("i", { key: item }, item) }));
  assert.equal((none.match(/<i[ >]/g) || []).length, SCROLL_WINDOW_CHUNK, "-1 reveals nothing");
});
