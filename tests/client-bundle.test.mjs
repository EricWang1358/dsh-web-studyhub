import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { hostReact } from "../scripts/host-react.mjs";
import { jsx, jsxs, Fragment } from "../ui/jsx-runtime.js";

test("the DSH client asks the host for react only, never its JSX runtime", async () => {
  const out = await build({
    entryPoints: ["ui/host.jsx"], bundle: true, write: false, format: "cjs", platform: "browser",
    plugins: [hostReact], loader: { ".css": "text" }, jsx: "transform", logLevel: "silent",
  });
  const requires = new Set(out.outputFiles[0].text.match(/require\("[^"]+"\)/g));
  assert.deepEqual([...requires], ['require("react")']);
});

test("the JSX runtime shim renders children, fragments and keys like React's", () => {
  const tree = jsxs("ul", {
    className: "list",
    children: [jsx("li", { children: "a" }, "1"), jsx(Fragment, { children: [jsx("li", { children: "b" }, "2")] })],
  });
  assert.equal(renderToStaticMarkup(tree), '<ul class="list"><li>a</li><li>b</li></ul>');
  assert.equal(jsx("li", { children: "x" }, "k").key, "k");
  assert.equal(React.isValidElement(jsx("span", {})), true);
});
