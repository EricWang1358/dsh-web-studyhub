import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { build } from "esbuild";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

// A whole-app render catches ordering mistakes (a hook reading state declared
// below it) that component-level tests never reach.
const compiled = await build({ entryPoints: ["ui/App.jsx"], bundle: true, write: false, platform: "node",
  format: "cjs", external: ["react", "react-dom"], loader: { ".css": "text" }, logLevel: "silent" });
const module = { exports: {} };
new Function("require", "module", "exports", compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const App = module.exports.default;

test("the whole study app renders without throwing", () => {
  // Every hook runs before the loading return, so a hook reading state it
  // precedes throws here.
  const html = renderToStaticMarkup(React.createElement(App, { call: () => new Promise(() => {}) }));
  assert.match(html, /class="study-app"/);
  assert.match(html, /正在打开学习工作区/);
});
