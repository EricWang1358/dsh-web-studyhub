import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { build } from "esbuild";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

/* The owner's report: 765,472 tok used against a stated 432K-697K, 0% cache hit
   with 720,802 written and 0 read across 14 calls, and nothing on screen said
   either was unusual. A job card now says so, in plain words. */

const compiled = await build({ stdin: { contents: `export * as format from './ui/token-usage.js'; export { JobUsage } from './ui/TokenUsage.jsx'; export { setUiLanguage } from './ui/i18n.js';`,
  resolveDir: process.cwd() }, bundle: true, write: false, platform: "node", format: "cjs", external: ["react"], loader: { ".css": "text" }, logLevel: "silent" });
const module = { exports: {} };
new Function("require", "module", "exports", compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const { format, JobUsage, setUiLanguage } = module.exports;
const han = /[㐀-鿿]/;
const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
test.afterEach(() => setUiLanguage("zh"));

const range = (low, high) => ({ low, high });
const estimate = { feature: "generate", totalTokens: range(432000, 697000), calls: range(14, 16), inputTokens: range(420000, 680000), outputTokens: range(12000, 17000) };
const reported = { uncachedInputTokens: 42, outputTokens: 44628, cacheReadTokens: 0, cacheWriteTokens: 720802, calls: 14 };

test("a run that used more than its estimate says by how much, and why that can happen", () => {
  const notes = format.usageNotes({ tokenUsage: reported, estimate });
  assert.equal(notes.length, 2);
  assert.match(notes[0], /超出了预计上限/);
  assert.match(notes[0], /10%/, "765,472 is 9.8% above 697K");
  assert.match(notes[1], /没有命中缓存/);
  assert.match(notes[1], /各自独立/);
});

test("a run inside its estimate, or one that read from the cache, has nothing to apologise for", () => {
  assert.deepEqual(format.usageNotes({ tokenUsage: { ...reported, cacheReadTokens: 300000, cacheWriteTokens: 100000, outputTokens: 1000 }, estimate }), []);
  assert.deepEqual(format.usageNotes({ tokenUsage: { ...reported, calls: 1 }, estimate: undefined }), [], "one call has no other call to share a cache with");
  assert.deepEqual(format.usageNotes({}), []);
  assert.deepEqual(format.usageNotes({ tokenUsage: { uncachedInputTokens: 500, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 3 }, estimate }).length, 1,
    "no cache hit on three calls is still worth a line, but the total is within the estimate");
});

test("the job usage block shows the notes in both languages", () => {
  const job = { tokenUsage: reported, estimate };
  const zh = text(renderToStaticMarkup(React.createElement(JobUsage, { job })));
  assert.match(zh, /实际用量/);
  assert.match(zh, /超出了预计上限/);
  setUiLanguage("en");
  const en = text(renderToStaticMarkup(React.createElement(JobUsage, { job })));
  assert.doesNotMatch(en, han);
  assert.match(en, /above the expected upper bound/);
  assert.match(en, /no cache hit/i);
});
