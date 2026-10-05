import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { build } from "esbuild";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanDocumentName } from "../lib/document-title.js";

/* #201: the per-source coverage list names a document once and lists its pages under it, counts pages as 页 and documents as 份, and shows the
   name the 资料 page would: the file name without its extension and without the source-site noise. */

const BOOK = "Software Architecture An Engineering Approach (TruePDF) (Mark Richards, Neal Ford) (z-library.sk, 1lib.sk, z-lib.sk)";
const CLEAN = "Software Architecture An Engineering Approach (Mark Richards, Neal Ford)";
const hash = "a".repeat(64);
const page = (n, extra = {}) => ({ id: `pdf-${n}`, title: `${BOOK} · p.${n}`, text: `Page ${n} text.`, document: { materialId: `document-${hash}-pdf`, id: hash, bookTitle: BOOK, filename: `${BOOK}.pdf`, page: n, totalPages: 400 }, ...extra });
const note = (id, title) => ({ id, title, text: `${title} text.` });

test("a file name loses its extension and the noise of the site it came from, and keeps what names the work", () => {
  assert.equal(cleanDocumentName(`${BOOK}.pdf`), CLEAN);
  assert.equal(cleanDocumentName(BOOK), CLEAN);
  assert.equal(cleanDocumentName("Lecture 3 [Z-Library].pdf"), "Lecture 3");
  assert.equal(cleanDocumentName("www.some-site.com - Distributed Systems.pdf"), "Distributed Systems");
  assert.equal(cleanDocumentName("Distributed Systems (2nd Edition) (Annas Archive).epub"), "Distributed Systems (2nd Edition)");
  assert.equal(cleanDocumentName("Lecture 3.pdf"), "Lecture 3");
  assert.equal(cleanDocumentName("notes_week_2"), "notes_week_2", "underscores and plain names stay");
  assert.equal(cleanDocumentName("My Notes (draft)"), "My Notes (draft)", "a bracket that is not a site tag stays");
  assert.equal(cleanDocumentName("(z-library.sk).pdf"), "(z-library.sk)", "never an empty name");
  assert.equal(cleanDocumentName(""), "");
  assert.equal(cleanDocumentName(undefined), "");
});

const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `export { default as Draft } from './ui/Draft.jsx'; export { coverageGroups, coverageUnit } from './ui/coverage-groups.js'; export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: "node", format: "cjs", external: ["react", "react-dom"], loader: { ".css": "text" }, logLevel: "silent" });
const module = { exports: {} };
new Function("require", "module", "exports", compiled.outputFiles[0].text)(require, module, module.exports);
const m = module.exports;
const noop = () => {};
const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

const pages = [21, 22, 23, 35, 36, 40].map((n) => page(n));
const coverage = (rows) => ({ cited: rows.filter((row) => row.accepted > 0).length, selected: rows.length, sources: rows,
  uncited: rows.filter((row) => !row.accepted).map(({ id, title }) => ({ id, title })) });
const rows = [{ id: "pdf-21", planned: 1, accepted: 2 }, { id: "pdf-22", planned: 0, accepted: 0 }, { id: "pdf-23", planned: 2, accepted: 1 },
  { id: "pdf-35", planned: 1, accepted: 1 }, { id: "pdf-36", planned: 0, accepted: 0 }, { id: "pdf-40", planned: 0, accepted: 0 }].map((row) => ({ ...row, title: pages.find((item) => item.id === row.id).title }));
const draft = (sourceRows) => ({ id: "d1", title: "T", draftVersion: 1, cards: [{ id: "c1", kind: "flashcard", topic: "t", prompt: "p", answer: "a", hint: "h", explanation: "e", misconception: "x" }],
  editorial: { requested: 1, generated: 1, completedParts: 1, parts: 1, failures: [], generation: { sourceIds: sourceRows.map((row) => row.id), kind: "quiz" }, coverage: coverage(sourceRows) } });
const render = (value, sources, language = "zh") => {
  m.setUiLanguage(language);
  try {
    return renderToStaticMarkup(React.createElement(m.Draft, { data: { sources, decks: [], drafts: [value], jobs: [], modelReady: true, runs: [] }, busy: false, act: noop, call: noop, draft: value, draftLoaded: JSON.stringify(value),
      setDraft: noop, draftText: "", setDraftText: noop, jsonMode: false, setJsonMode: noop, openDraft: noop, onOpenPublished: noop, onStartPublished: noop, clearRecovery: noop, setPage: noop, setModal: noop,
      setSelectedSources: noop, setGenSource: noop, blankCard: noop, patchCard: noop, parseDraft: JSON.parse, continueDraft: noop, addFromSources: noop }));
  } finally { m.setUiLanguage("zh"); }
};

test("pages of one document are grouped under its name, which appears once", () => {
  const groups = m.coverageGroups(rows, pages);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].title, CLEAN);
  assert.deepEqual(groups[0].rows.map((row) => row.page), [21, 22, 23, 35, 36, 40], "pages in order");
  assert.equal(groups[0].accepted, 4, "passed questions of the document");
  assert.equal(groups[0].covered, 3, "pages with a passed question");
  assert.equal(m.coverageUnit(groups), "页");
  const out = text(render(draft(rows), pages));
  assert.equal(out.split(CLEAN).length - 1, 2, "the name once among the covered pages and once among the uncovered, not once per page");
  assert.doesNotMatch(out, /z-library|TruePDF|1lib/, "no source-site noise");
  assert.match(out, /逐份资料出题记录 · 已引用 3 \/ 6 页/);
  assert.match(out, /第 21 页：规划 1 个考点，通过 2 题/);
  assert.match(out, /第 23 页：规划 2 个考点，通过 1 题/);
  assert.match(out, /3 页本次没有合格题 · 查看清单/);
  assert.match(out, /为「T」补题：用 3 页未覆盖资料/, "the add button counts pages as pages too");
  assert.match(out, /页码：22、36、40/, "the uncovered pages of the book on one line");
  assert.doesNotMatch(out, /\d+ 份资料本次没有合格题/);
});

test("different documents are counted as 份, and each is named once", () => {
  const sources = [note("a", "Week 1 notes"), note("b", "Week 2 notes"), note("c", "Week 3 notes.md")];
  const list = [{ id: "a", title: "Week 1 notes", planned: 1, accepted: 1 }, { id: "b", title: "Week 2 notes", planned: 0, accepted: 0 }, { id: "c", title: "Week 3 notes.md", planned: 0, accepted: 0 }];
  const groups = m.coverageGroups(list, sources);
  assert.equal(groups.length, 3);
  assert.equal(m.coverageUnit(groups), "份");
  const out = text(render(draft(list), sources));
  assert.match(out, /逐份资料出题记录 · 已引用 1 \/ 3 份/);
  assert.match(out, /Week 1 notes：规划 1 个考点，通过 1 题/);
  assert.match(out, /2 份本次没有合格题 · 查看清单|2 份资料本次没有合格题 · 查看清单/);
  assert.match(out, /Week 3 notes(?!\.md)/, "the extension is not part of the name");
});

test("two books and a note: pages under their own book, the note on its own", () => {
  const other = (n) => ({ ...page(n), id: `o-${n}`, title: `Distributed Systems · p.${n}`, document: { materialId: `document-${"b".repeat(64)}-pdf`, id: "b".repeat(64), bookTitle: "Distributed Systems", filename: "Distributed Systems.pdf", page: n, totalPages: 300 } });
  const sources = [page(21), other(5), page(23), note("n", "Cheat sheet")];
  const list = [{ id: "pdf-21", planned: 1, accepted: 1 }, { id: "o-5", planned: 1, accepted: 1 }, { id: "pdf-23", planned: 0, accepted: 0 }, { id: "n", planned: 0, accepted: 0 }].map((row) => ({ ...row, title: sources.find((item) => item.id === row.id).title }));
  const groups = m.coverageGroups(list, sources);
  assert.deepEqual(groups.map((group) => group.title), [CLEAN, "Distributed Systems", "Cheat sheet"]);
  assert.deepEqual(groups[0].rows.map((row) => row.page), [21, 23]);
  assert.equal(m.coverageUnit(groups), "份", "a note among pages: the count is of materials");
});

test("a source that is no longer in the library is grouped by the document name inside its title", () => {
  const list = [{ id: "gone-1", title: `${BOOK}.pdf · p.7`, planned: 1, accepted: 1 }, { id: "gone-2", title: `${BOOK}.pdf · p.9`, planned: 0, accepted: 0 }];
  const groups = m.coverageGroups(list, []);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].title, CLEAN);
  assert.deepEqual(groups[0].rows.map((row) => row.page), [7, 9]);
});

test("in English the same list reads in English", () => {
  const out = text(render(draft(rows), pages, "en"));
  assert.match(out, /Per-source record · 3 of 6 pages cited/);
  assert.match(out, /p\. 21: 1 knowledge point\(s\) planned, 2 question\(s\) passed/);
  assert.match(out, /Pages: 22, 36, 40/);
  assert.doesNotMatch(out.replace(CLEAN, ""), /[㐀-鿿]/);
});
