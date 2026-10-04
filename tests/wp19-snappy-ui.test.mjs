import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readAppSource } from "./helpers/app-source.mjs";

/* WP19: "知道了" must not freeze the page. Cards leave at once through the light path
   (ui/quick-actions.js), nothing is disabled, failures come back next to the card. */

const compiled = await build({
  stdin: { contents: `export { default as StudyMap } from './ui/StudyMap.jsx';
    export { AudioJobs } from './ui/AudioImport.jsx';
    export { QuickActionsContext } from './ui/quick-actions.js';
    export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: "node", format: "cjs", external: ["react"], loader: { ".json": "json", ".css": "text" },
});
const module = { exports: {} };
new Function("require", "module", "exports", compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const { StudyMap, AudioJobs, QuickActionsContext, setUiLanguage } = module.exports;

const noop = () => {};
const deck = { id: "d1", title: "行为型模式", folder: "CS3219", course: "CS3219", topics: ["Memento"],
  available: 5, count: 5, quizCount: 3, createdAt: "2026-09-01T00:00:00Z" };
const progress = { d1: { counts: { mastered: 1, familiar: 1, learning: 1, weak: 1, new: 1 }, total: 5, mastery: 60, due: 1, status: "active", topics: [] } };
const generation = (id, status, extra = {}) => ({ id, status, type: "generate", stage: "", parts: 1, trace: [], ...extra });
const audio = (id, status, extra = {}) => ({ id, status, type: "audio-import", filename: `${id}.mp3`, phase: "done", ...extra });
const quickValue = (failures = {}, run = noop) => ({ failures, run, clearFailure: noop });
const map = (jobs, { busy = false, quick, dismissJob = noop } = {}) => {
  const tree = React.createElement(StudyMap, {
    data: { root: "/tmp/lib", decks: [deck], progress, sources: [{ id: "s" }], drafts: [], jobs, runs: [],
      today: { due: 0, weak: 0, new: 0, size: 0 }, focus: { mode: "class", course: "CS3219", courses: [{ name: "CS3219" }], fresh: [] } },
    busy, start: noop, resume: noop, endRun: noop, manage: noop, openDraft: noop, continueDraft: noop, retryGeneration: noop,
    addSource: noop, createManual: noop, importLibrary: noop, askInChat: noop, notebooks: [], onFocus: noop, cancelJob: noop, dismissJob });
  return renderToStaticMarkup(quick ? React.createElement(QuickActionsContext.Provider, { value: quick }, tree) : tree);
};

test("知道了 stays clickable while another action is busy: it is not part of the single-flight act", () => {
  const html = map([generation("a", "failed"), generation("b", "complete")], { busy: true });
  const buttons = html.match(/<button[^>]*class="[^"]*sh-job__dismiss[^"]*"[^>]*>/g) || [];
  assert.equal(buttons.length, 2);
  for (const button of buttons) assert.doesNotMatch(button, /disabled/);
  assert.match(html, /class="[^"]*jobs-dismiss-all"(?![^>]*disabled)/);
});

test("a card that is leaving is animated out and no longer counted for 全部知道了", () => {
  const html = map([generation("a", "failed", { leaving: true }), generation("b", "complete")]);
  assert.match(html, /<article[^>]*class="sh-job sh-job--failed is-leaving[^"]*"[^>]*data-job-id="a"/);
  assert.doesNotMatch(html, /sh-job--complete is-leaving/);
  assert.doesNotMatch(html, /全部知道了/, "only one visible finished card is left, so the bulk action goes away");
  const leavingButton = html.match(/data-job-id="a"[\s\S]*?<\/article>/)[0];
  assert.match(leavingButton, /aria-hidden="true"/, "a card on its way out is hidden from assistive tech");
});

test("the dismiss-all button hands the whole decision to the light path", () => {
  const calls = [];
  const html = map([generation("a", "failed"), generation("b", "complete")], { dismissJob: (id) => calls.push(id) });
  assert.match(html, /全部知道了/);
  assert.deepEqual(calls, []);
});

test("a failed dismissal puts a short error next to the card that came back", () => {
  const html = map([generation("a", "failed")], { quick: quickValue({ a: "磁盘忙" }) });
  const section = html.match(/data-job-id="a"[\s\S]*?<\/article>/)[0];
  assert.match(section, /role="alert"[^>]*>[^]*磁盘忙/, "an alert inside the card, not in a page-level banner");
});

test("a failed dismiss-all puts its error beside the bulk button", () => {
  const html = map([generation("a", "failed"), generation("b", "complete")], { quick: quickValue({ "jobs:all": "网络中断" }) });
  const actions = html.match(/class="jobs-actions"[\s\S]*?<\/div>/)[0];
  assert.match(actions, /网络中断/);
});

test("audio cards: 知道了 is never disabled, leaving cards animate out, errors appear inside the card", () => {
  const jobs = [audio("one", "complete", { sourceIds: ["s"] }), audio("two", "failed", { retryable: true, leaving: true })];
  const render = (quick) => {
    const tree = React.createElement(AudioJobs, { data: { jobs }, busy: true, act: noop, openAgent: noop });
    return renderToStaticMarkup(quick ? React.createElement(QuickActionsContext.Provider, { value: quick }, tree) : tree);
  };
  const html = render();
  const buttons = html.match(/<button[^>]*class="[^"]*sh-job__dismiss[^"]*"[^>]*>/g) || [];
  assert.equal(buttons.length, 2);
  for (const button of buttons) assert.doesNotMatch(button, /disabled/);
  assert.match(html, /class="sh-job sh-job--complete"/);
  assert.match(html, /class="sh-job sh-job--failed is-leaving"/);
  const withError = render(quickValue({ one: "写入失败" }));
  assert.match(withError.match(/one\.mp3[\s\S]*?(?=two\.mp3)/)[0], /写入失败/);
});

test("the English strings exist for the new error labels", async () => {
  const en = JSON.parse(await readFile("ui/locales/en.snappy.json", "utf8"));
  assert.ok(Object.keys(en).length >= 1);
  setUiLanguage("en");
  try {
    const html = map([generation("a", "failed")], { quick: quickValue({ a: "disk busy" }) });
    assert.match(html, /Could not remove this card/);
  } finally { setUiLanguage("zh"); }
});

test("App wires every 知道了 and 全部知道了 through the light path, not through act", async () => {
  const app = await readAppSource();
  assert.match(app, /dismissJob=\{[^}]*dismissJobs\(quick/, "StudyMap dismissJob uses dismissJobs()");
  assert.doesNotMatch(app, /act\("job\.dismiss"/);
  const audioUi = await readFile("ui/audio/AudioJobs.jsx", "utf8");
  assert.match(audioUi, /quick \? dismissJobs\(quick, job\.id\)/, "audio cards use the light path; act is only the fallback outside App");
  assert.match(app, /QuickActionsContext\.Provider/);
  assert.match(app, /markInboxRead\(quick/, "全部已读 is light as well");
});

test("act itself still serialises heavy actions and keeps its busy flag", async () => {
  const app = await readAppSource();
  assert.match(app, /const act = useCallback\(/);
  assert.match(app, /createActRunner/, "App's act() is the single-flight runner (see tests/act-runner.test.mjs)");
  const runner = await readFile("ui/act-runner.js", "utf8");
  assert.match(runner, /if \(current\) return;/);
  assert.match(runner, /setBusy\(true\)/);
});
