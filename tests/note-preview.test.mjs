import test from "node:test";
import assert from "node:assert/strict";
import { renderNoteMarkdown } from "../ui/note-markdown.js";

test("local note preview renders Markdown and LaTeX without executable HTML", () => {
  const html = renderNoteMarkdown("# Example\n\nFormula: $x^2$\n\n<script>alert(1)</script>");
  assert.match(html, /<h1>Example<\/h1>/);
  assert.match(html, /<math/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});
