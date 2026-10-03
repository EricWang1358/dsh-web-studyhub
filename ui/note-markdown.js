import MarkdownIt from "markdown-it";
import texmath from "markdown-it-texmath";
import katex from "katex/dist/katex.js";
import "katex/dist/contrib/mhchem.js";

// Parser and math renderer are bundled locally. MathML avoids a font/CDN
// dependency and uses the host browser's native math layout.
const renderer = new MarkdownIt({ html: false, linkify: true, breaks: true })
  .use(texmath, { engine: katex, delimiters: "dollars",
    katexOptions: { output: "mathml", throwOnError: false } });

export const renderNoteMarkdown = (source) => renderer.render(String(source || ""));
