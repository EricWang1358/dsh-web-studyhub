import test from "node:test";
import assert from "node:assert/strict";
import { countMaterials, groupSourcesByDocument } from "../lib/source-groups.js";

/* #661: a PDF is stored as one source per page, so a question deck built from one PDF and two texts cites FOUR source ids (the PDF's p.1 and p.3 are two ids) while the
   learner has THREE materials. The practice page's 「查看 N 份资料」 counts materials, like the 资料 page: one function, lib/source-groups.js countMaterials. */

const HASH = "a".repeat(64);
const page = (n) => ({ id: `pdf-${HASH}-text2-p${n}`, title: `notes.pdf · p.${n}`, text: `page ${n}`, document: { id: HASH, page: n, format: "pdf", totalPages: 3, extractionVersion: 2 } });
const sources = [
  { id: "t1", title: "Spaced repetition", text: "text one" },
  { id: "t2", title: "observer-pattern.md", text: "text two", document: { materialId: "document-m2", format: "md" } },
  page(1), page(2), page(3),
];

test("two pages of one PDF and two texts are three materials", () => {
  const cited = ["t1", "t2", page(1).id, page(3).id];
  assert.equal(cited.length, 4, "the run cites four source ids");
  assert.equal(countMaterials(sources, cited), 3);
});

test("it agrees with the 资料 page: the number of document rows the cited sources belong to", () => {
  const cited = [page(1).id, page(2).id, page(3).id, "t1"];
  const rows = groupSourcesByDocument(sources).filter((item) => item.sourceIds.some((id) => cited.includes(id)));
  assert.equal(countMaterials(sources, cited), rows.length);
  assert.equal(countMaterials(sources, cited), 2);
});

test("one id twice, an unknown id, no ids and no library are counted honestly", () => {
  assert.equal(countMaterials(sources, ["t1", "t1"]), 1);
  assert.equal(countMaterials(sources, ["t1", "gone"]), 2, "a deleted material is still a material the questions came from");
  assert.equal(countMaterials(sources, []), 0);
  assert.equal(countMaterials(undefined, ["x", "x", "y"]), 2);
  assert.equal(countMaterials(sources, undefined), 0);
});

test("an archived material still counts: the questions came from it", () => {
  const archived = sources.map((source) => (source.id === "t1" ? { ...source, archived: true } : source));
  assert.equal(countMaterials(archived, ["t1", "t2"]), 2);
});
