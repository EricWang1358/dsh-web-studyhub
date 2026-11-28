/* 找功能 (#653): the search over the finder's entries (ui/finder/search.js) and which entries a host cannot take you to (ui/finder/availability.js). Pure, no DOM. */
import test from "node:test";
import assert from "node:assert/strict";
import { loadUi } from "./helpers/ui-module.mjs";

const m = await loadUi(`
  export { FINDER_AREAS, FINDER_ENTRIES } from './ui/finder/entries.js';
  export { searchFeatures, groupByArea, normalizeQuery } from './ui/finder/search.js';
  export { finderAvailability, withAvailability } from './ui/finder/availability.js';
  export { setUiLanguage, ui } from './ui/i18n.js';
`);
const { FINDER_AREAS, FINDER_ENTRIES, searchFeatures, groupByArea, normalizeQuery, finderAvailability, withAvailability, setUiLanguage, ui } = m;

const ids = (query, options) => searchFeatures(FINDER_ENTRIES, query, options).map((entry) => entry.id);
const english = { translate: ui };

test("the query is normalised: case, full-width letters and digits, spaces and punctuation", () => {
  assert.equal(normalizeQuery("  Ｔｒａｎｓｌａｔｅ！ "), "translate");
  assert.equal(normalizeQuery("Ctrl + K"), "ctrlk");
  assert.equal(normalizeQuery("花费 上限"), "花费上限");
  assert.equal(normalizeQuery("   "), "");
});

test("翻译 / 译 / translate / Translation all rank the translation entry first", () => {
  setUiLanguage("zh");
  for (const word of ["翻译", "译", "translate", "Translation", "TRANSLATE", "中英对照", "bilingual"]) assert.equal(ids(word, english)[0], "translation", word);
  setUiLanguage("en");
  try {
    for (const word of ["Translate", "translation", "译", "翻译"]) assert.equal(ids(word, english)[0], "translation", `in English: ${word}`);
  } finally { setUiLanguage("zh"); }
});

test("花费 finds 花费上限 first, and an English UI user can type the English name", () => {
  assert.equal(ids("花费")[0], "budget");
  assert.equal(ids("花费上限")[0], "budget");
  assert.equal(ids("token budget")[0], "budget");
  setUiLanguage("en");
  try {
    const title = ui("花费上限");
    assert.notEqual(title, "花费上限", "the English title exists");
    assert.equal(ids(title, english)[0], "budget", title);
    assert.equal(ids(title.toUpperCase(), english)[0], "budget");
  } finally { setUiLanguage("zh"); }
});

test("出题深度 became 写法: the old name and the new options still find it (#1686)", () => {
  setUiLanguage("zh");
  assert.equal(FINDER_ENTRIES.find((entry) => entry.id === "generation-depth").title, "写法");
  for (const word of ["出题深度", "写法", "直接问", "短情境", "先设计再写"]) assert.equal(ids(word)[0], "generation-depth", word);
  assert.equal(ids("快问")[0], "generation-preset", "the presets keep their names");
});

test("资料's type and category filters are said to be where they are, behind its 「筛选与分组」 button (#1694)", () => {
  const { what } = FINDER_ENTRIES.find((entry) => entry.id === "material-facets");
  try {
    for (const language of ["zh", "en"]) {
      setUiLanguage(language);
      // 找功能 answers 类型 with this entry and with the 资料 page's own one: both name the button the filters are behind.
      for (const id of ["material-facets", "material-view"]) assert.ok(ids("类型", english).concat(ids("内容分类", english)).includes(id), `${language}: ${id}`);
      const said = ui(what).split(language === "zh" ? "。" : /\. /).filter((sentence) => sentence.includes(language === "zh" ? "「资料」页" : "Sources page"));
      assert.equal(said.length, 1, `${language}: one sentence about the 资料 page`);
      assert.ok(said[0].includes(ui("筛选与分组")), `${language}: it names ${ui("筛选与分组")}: ${said[0]}`);
    }
  } finally { setUiLanguage("zh"); }
});

test("an old name or a synonym still finds the entry; a page is found by its sidebar label", () => {
  assert.equal(ids("双语")[0], "translation");
  assert.equal(ids("导览")[0], "tour");
  assert.equal(ids("找功能")[0], "finder");
  assert.equal(ids("ctrl k")[0], "finder");
  assert.equal(ids("学习库")[0], "page-library");
  assert.equal(ids("错题与待巩固")[0], "page-wrongbook");
  assert.equal(ids("MinerU").includes("pdf-convert"), true);
  assert.equal(ids("出处")[0], "question-place");
  assert.equal(ids("出自哪一章")[0], "question-place");
  assert.equal(ids("在总纲里的位置")[0], "question-place");
  assert.equal(ids("读全书这一节")[0], "read-book-section");
  assert.equal(ids("对应的全书")[0], "read-book-section");
  assert.equal(ids("读讲解")[0], "read-book-section");
});

test("ranking: exact title, title prefix, alias exact, title substring, alias substring, path, sentence", () => {
  const entries = [
    { id: "sentence", title: "甲", aliases: [], path: ["乙"], what: "里面提到了目标词" },
    { id: "path", title: "丙", aliases: [], path: ["目标词"], what: "没有" },
    { id: "alias-part", title: "丁", aliases: ["含有目标词的别名"], path: ["戊"], what: "没有" },
    { id: "title-part", title: "含有目标词的标题", aliases: [], path: ["己"], what: "没有" },
    { id: "alias-exact", title: "庚", aliases: ["目标词"], path: ["辛"], what: "没有" },
    { id: "title-prefix", title: "目标词的前缀标题", aliases: [], path: ["壬"], what: "没有" },
    { id: "title-exact", title: "目标词", aliases: [], path: ["癸"], what: "没有" },
    { id: "nothing", title: "无关", aliases: [], path: ["无关"], what: "无关" },
  ];
  assert.deepEqual(searchFeatures(entries, "目标词").map((entry) => entry.id),
    ["title-exact", "title-prefix", "alias-exact", "title-part", "alias-part", "path", "sentence"]);
  assert.deepEqual(searchFeatures(entries, "完全没有的词"), []);
});

test("an empty query returns everything, in the order of the entries, and grouping keeps every entry once under its area", () => {
  assert.equal(ids("").length, FINDER_ENTRIES.length);
  assert.equal(ids("   ").length, FINDER_ENTRIES.length);
  const groups = groupByArea(searchFeatures(FINDER_ENTRIES, ""), FINDER_AREAS);
  assert.deepEqual(groups.map((group) => group.area.label), ["每天学习", "资料与阅读", "出题", "练习与复习", "考试与统计", "课程与录音", "设置", "名词"]);
  assert.equal(groups.reduce((sum, group) => sum + group.entries.length, 0), FINDER_ENTRIES.length);
  for (const group of groups) {
    assert.ok(group.entries.length > 0, `${group.area.id} is not empty`);
    assert.ok(group.entries.every((entry) => entry.area === group.area.id));
  }
  // A search keeps the groups of its results only.
  const found = groupByArea(searchFeatures(FINDER_ENTRIES, "翻译"), FINDER_AREAS);
  assert.ok(found.length >= 1 && found.length < groups.length);
});

test("an entry the host cannot take you to carries its reason; the others carry none", () => {
  const off = { features: {}, contexts: ["bank", "study", "materials", "generation", "authoring", "audio", "recording", "notes", "workflows", "skeleton", "system"] };
  const examprep = FINDER_ENTRIES.find((entry) => entry.id === "page-examprep");
  assert.match(finderAvailability(examprep, off), /备考补习/, "a page behind a host switch says which switch");
  assert.equal(finderAvailability(examprep, { ...off, features: { examBlueprint: true } }), "");
  const audio = FINDER_ENTRIES.find((entry) => entry.id === "page-audio");
  assert.match(finderAvailability(audio, { ...off, contexts: ["bank", "study"] }), /audio/, "a page whose host component is off says which one");
  assert.equal(finderAvailability(audio, off), "");
  const setting = FINDER_ENTRIES.find((entry) => entry.id === "setting-audio");
  assert.match(finderAvailability(setting, { ...off, contexts: ["bank"] }), /audio/);
  assert.equal(finderAvailability(setting, off), "");
  const term = FINDER_ENTRIES.find((entry) => entry.kind === "term");
  assert.equal(finderAvailability(term, { contexts: [] }), "", "a term is never unavailable: it has nowhere to go");
  // An older host or the offline demo publishes no list: nothing is switched off.
  assert.equal(finderAvailability(audio, {}), "");
  assert.equal(finderAvailability(audio, null), "");
  const marked = withAvailability(FINDER_ENTRIES, { ...off, contexts: [] });
  assert.equal(marked.length, FINDER_ENTRIES.length);
  assert.ok(marked.some((entry) => entry.unavailable), "some entry is greyed on a bare host");
  assert.ok(marked.filter((entry) => entry.unavailable).every((entry) => entry.kind !== "term"));
  assert.ok(withAvailability(FINDER_ENTRIES, { features: { examBlueprint: true } }).every((entry) => !entry.unavailable), "no switch off, no list of components: nothing is greyed");
});
