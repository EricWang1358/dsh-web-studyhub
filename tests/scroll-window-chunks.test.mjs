import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { build } from "esbuild";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

/* A scroll window draws its first rows and the rest as the learner scrolls: a library of a thousand materials used to put
   every row (thousands of DOM nodes, half a second of rendering) on the page when the picker opened. */

const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `export { default as ScrollWindow, SCROLL_WINDOW_CHUNK, windowRows, nearEnd } from './ui/components/ScrollWindow.jsx';
  export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
bundle: true, write: false, platform: "node", format: "cjs", external: ["react", "react-dom"], loader: { ".css": "text" }, logLevel: "silent" });
const module = { exports: {} };
new Function("require", "module", "exports", compiled.outputFiles[0].text)(require, module, module.exports);
const { ScrollWindow, SCROLL_WINDOW_CHUNK, windowRows, nearEnd, setUiLanguage } = module.exports;
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
