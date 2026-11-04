/* 找功能 (#653): the finder's data (ui/finder/entries.js) is checked against the registries it is made from and against the UI it points into:
   a page, a settings category or a glossary term that has no entry fails here, an anchor that no longer exists in the UI source fails here, and every
   sentence has an English translation, so a later fold or rename cannot quietly make a feature unfindable. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { anchorsInSource } from "./helpers/tour-anchors.mjs";
import { PAGES } from "../ui/pages.js";
import { SETTINGS_CATEGORIES } from "../ui/settings-groups.js";
import { GLOSSARY } from "../ui/mastery-terms.js";
import { FINDER_AREAS, FINDER_ENTRIES, FEATURES, PREPARE_STEPS, finderCopy, entryTags } from "../ui/finder/entries.js";

const han = /[㐀-鿿]/;
const catalogue = Object.assign({}, ...await Promise.all((await readdir("ui/locales")).filter((name) => /^en(\..+)?\.json$/.test(name))
  .map(async (name) => JSON.parse(await readFile(join("ui/locales", name), "utf8")))));
const byId = new Map(FINDER_ENTRIES.map((entry) => [entry.id, entry]));
const areaIds = FINDER_AREAS.map((area) => area.id);

test("every page with a sidebar group or a purpose has a page entry made from its registry row", () => {
  for (const [id, page] of Object.entries(PAGES)) {
    if (!page.group && !page.purpose) continue;
    const entry = byId.get(`page-${id}`);
    assert.ok(entry, `no finder entry for the page ${id}`);
    assert.equal(entry.kind, "page");
    assert.equal(entry.title, page.label, `${id}: the title is the sidebar label`);
    assert.equal(entry.what, page.purpose, `${id}: the sentence is the page's purpose`);
    assert.equal(entry.page, id);
    assert.ok(entry.anchors.length > 0 && entry.anchors.every((anchor) => anchor === `nav-${id}`), `${id}: the sidebar entry is the anchor`);
    assert.deepEqual(entry.path, [page.label]);
    assert.ok(areaIds.includes(entry.area), `${id}: area ${entry.area}`);
  }
});

test("every settings category has an entry that goes to its first anchor under 设置", () => {
  for (const category of SETTINGS_CATEGORIES) {
    const entry = byId.get(`setting-${category.id}`);
    assert.ok(entry, `no finder entry for the settings category ${category.id}`);
    assert.equal(entry.kind, "setting");
    assert.equal(entry.title, category.title);
    assert.equal(entry.area, "settings");
    assert.equal(entry.page, "settings");
    assert.deepEqual(entry.path, ["设置", category.title]);
    assert.equal(entry.anchors[0], category.anchors[0]);
    assert.ok(entry.what && han.test(entry.what), `${category.id}: a sentence (the category's purpose in ui/settings-groups.js)`);
    if (category.needs) assert.equal(entry.needs?.capability, category.needs, `${category.id}: what the category needs`);
  }
});

test("every glossary term is an entry of kind term: it shows its meaning and has nowhere to go", () => {
  for (const [key, term] of Object.entries(GLOSSARY)) {
    const entry = byId.get(`term-${key}`);
    assert.ok(entry, `no finder entry for the term ${key}`);
    assert.equal(entry.kind, "term");
    assert.equal(entry.title, term.label);
    assert.equal(entry.what, term.hint);
    assert.equal(entry.area, "terms");
    assert.deepEqual(entry.anchors, []);
    assert.equal(entry.page, undefined);
  }
});

test("ids are unique and every entry has an area, a title, a path and a sentence", () => {
  assert.equal(byId.size, FINDER_ENTRIES.length, "unique ids");
  for (const entry of FINDER_ENTRIES) {
    assert.ok(["page", "setting", "feature", "term"].includes(entry.kind), entry.id);
    assert.ok(areaIds.includes(entry.area), `${entry.id}: area ${entry.area}`);
    assert.ok(entry.title && han.test(entry.title + entry.what), entry.id);
    assert.ok(Array.isArray(entry.aliases) && Array.isArray(entry.path) && Array.isArray(entry.anchors), entry.id);
    assert.ok(entry.path.length >= 1 && entry.what.length >= 6, `${entry.id}: a path and a sentence`);
    if (entry.prepare) assert.ok(Object.hasOwn(PREPARE_STEPS, entry.prepare), `${entry.id}: unknown prepare ${entry.prepare}`);
    if (entry.kind !== "term") assert.ok(entry.page !== undefined, `${entry.id}: where it lives (a page id, or null for the whole app)`);
  }
});

test("every anchor of every entry exists in the UI source (data-tour)", async () => {
  const anchors = await anchorsInSource();
  const missing = FINDER_ENTRIES.flatMap((entry) => entry.anchors.filter((anchor) => !anchors.has(anchor)).map((anchor) => `${entry.id}: ${anchor}`));
  assert.deepEqual(missing, []);
});

test("an entry's page is a page of the registry, and a settings anchor belongs to a settings category", () => {
  for (const entry of FINDER_ENTRIES) {
    if (entry.page) assert.ok(Object.hasOwn(PAGES, entry.page), `${entry.id}: page ${entry.page}`);
    if (entry.page === "settings" && entry.kind !== "page") for (const anchor of entry.anchors)
      assert.ok(SETTINGS_CATEGORIES.some((category) => category.anchors.includes(anchor)), `${entry.id}: ${anchor} is no anchor of any settings category (the link could not select its category)`);
  }
});

test("every Chinese string an entry can show has an English translation without Han", () => {
  const strings = finderCopy(FINDER_ENTRIES);
  assert.ok(strings.length > 200, "the finder says a lot");
  for (const text of strings) {
    assert.match(text, han, `source text is Chinese: ${text}`);
    assert.ok(Object.hasOwn(catalogue, text), `missing English for 「${text}」`);
    assert.doesNotMatch(catalogue[text], han, `English copy of 「${text}」`);
  }
  for (const step of Object.values(PREPARE_STEPS)) assert.ok(Object.hasOwn(catalogue, step.text), `missing English for 「${step.text}」`);
});

test("the features that are about to be folded away or are hard to find today all have an entry", () => {
  const required = ["translation", "original-file", "practice-pages", "original-pdf", "selection-ask", "selection-quiz", "generate-from-source", "archive", "organize-courses",
    "pdf-convert", "json-import", "case-exam", "coverage", "custom-count", "budget", "difficulty", "question-language", "notation", "generate-focus", "generate-assist",
    "reference-questions", "target-role", "top-up", "publish-draft", "draft-advanced", "hint", "help-me-understand", "autopilot", "en-toggle", "font-size", "thumbs", "write-note",
    "slay", "retrain", "similar", "variants", "recommend", "exam-formats", "course-settings", "daily-recap", "task-controls", "mailbox", "library-folder", "choose-model",
    "audio-keys", "live-local", "retrieval", "appearance-theme", "appearance-accent", "appearance-scale", "appearance-font", "appearance-density", "appearance-radius",
    "appearance-motion", "appearance-contrast", "appearance-transfer", "ui-language", "shortcuts", "tour", "glossary", "sample-remove", "backup", "legacy-import", "update",
    "usage-record", "experimental", "hand-off", "finder"];
  for (const id of required) assert.ok(byId.get(id)?.kind === "feature", `the feature ${id} is missing`);
  assert.ok(FEATURES.length >= required.length);
});

test("the words a learner types for the old names and the English words are aliases (so a later rename keeps finding them)", () => {
  const aliases = (id) => byId.get(id).aliases.map((alias) => alias.toLowerCase());
  for (const word of ["译", "中英对照", "双语", "translate", "translation", "bilingual"]) assert.ok(aliases("translation").includes(word), `translation: ${word}`);
  for (const word of ["token", "预算", "上限"]) assert.ok(aliases("budget").includes(word), `budget: ${word}`);
  assert.ok(aliases("tour").includes("导览") && aliases("tour").includes("tour"));
  assert.ok(aliases("finder").includes("ctrl k"));
});

test("the tags say what an entry needs, never hide it", () => {
  assert.deepEqual(entryTags({ needs: { model: true } }), ["需要 AI 模型"]);
  assert.deepEqual(entryTags({ needs: { flag: "examBlueprint" } }), ["需要 DSH 开启备考补习"]);
  assert.deepEqual(entryTags({ needs: { install: "MinerU" } }), ["需要先安装 MinerU"]);
  assert.deepEqual(entryTags({ needs: {} }), []);
  assert.deepEqual(entryTags({}), []);
  assert.ok(byId.get("translation").needs.model, "translation needs a model");
  assert.equal(byId.get("page-examprep").needs.flag, "examBlueprint");
});
