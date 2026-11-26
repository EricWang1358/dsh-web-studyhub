import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readAppSource } from "./helpers/app-source.mjs";
import { mapProps } from './helpers/study-map-props.mjs';
import { click, loadInteractiveUi, withBrowserGlobals } from './helpers/react-harness.mjs';
import { createActRunner } from '../ui/act-runner.js';

/* WP19: "知道了" must not freeze the page. Cards leave at once through the light path
   (ui/quick-actions.js), nothing is disabled, failures come back next to the card. */

const compiled = await build({
  stdin: { contents: `export { default as StudyMap } from './ui/StudyMap.jsx';
    export { AudioJobs } from './ui/audio/AudioJobs.jsx';
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
  const tree = React.createElement(StudyMap, mapProps({
    data: { root: "/tmp/lib", decks: [deck], progress, sources: [{ id: "s" }], drafts: [], jobs, runs: [],
      today: { due: 0, weak: 0, new: 0, size: 0 }, focus: { mode: "class", course: "CS3219", courses: [{ name: "CS3219" }], fresh: [] } },
    busy, start: noop, resume: noop, endRun: noop, manage: noop, openDraft: noop, continueDraft: noop, retryGeneration: noop,
    addSource: noop, createManual: noop, importLibrary: noop, askInChat: noop, notebooks: [], onFocus: noop, cancelJob: noop, dismissJob }));
  return renderToStaticMarkup(quick ? React.createElement(QuickActionsContext.Provider, { value: quick }, tree) : tree);
};

test("归档 stays clickable while another action is busy: it is not part of the single-flight act", () => {
  const html = map([generation("a", "failed"), generation("b", "complete")], { busy: true });
  const buttons = html.match(/<button[^>]*aria-label="归档：[^"]*"[^>]*>/g) || [];
  assert.equal(buttons.length, 2);
  for (const button of buttons) assert.doesNotMatch(button, /disabled/);
  assert.match(html, /class="[^"]*jobs-dismiss-all"(?![^>]*disabled)/);
});

test("a card that is leaving is animated out and no longer counted for 全部归档", () => {
  const html = map([generation("a", "failed", { leaving: true }), generation("b", "complete")]);
  assert.match(html, /<article[^>]*class="cjc is-leaving[^"]*"[^>]*data-job-id="a"/);
  assert.doesNotMatch(html, /is-leaving[^>]*data-job-id="b"/);
  assert.doesNotMatch(html, /全部归档/, "only one visible finished card is left, so the bulk action goes away");
  const leavingButton = html.match(/data-job-id="a"[\s\S]*?<\/article>/)[0];
  assert.match(leavingButton, /aria-hidden="true"/, "a card on its way out is hidden from assistive tech");
});

test("the dismiss-all button hands the whole decision to the light path", () => {
  const calls = [];
  const html = map([generation("a", "failed"), generation("b", "complete")], { dismissJob: (id) => calls.push(id) });
  assert.match(html, /全部归档/);
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

test("audio cards: 归档 is never disabled, leaving cards animate out, errors appear inside the card", () => {
  const jobs = [audio("one", "complete", { sourceIds: ["s"] }), audio("two", "failed", { retryable: true, leaving: true })];
  const render = (quick) => {
    const tree = React.createElement(AudioJobs, { data: { jobs }, busy: true, act: noop, openAgent: noop });
    return renderToStaticMarkup(quick ? React.createElement(QuickActionsContext.Provider, { value: quick }, tree) : tree);
  };
  const html = render();
  const buttons = html.match(/<button[^>]*aria-label="归档：[^"]*"[^>]*>/g) || [];
  assert.equal(buttons.length, 2);
  for (const button of buttons) assert.doesNotMatch(button, /disabled/);
  assert.match(html, /class="cjc"[^>]*data-job-id="one"/);
  assert.match(html, /class="cjc is-leaving"[^>]*data-job-id="two"/);
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

test("App wires every 知道了 and 全部知道了 through the light path, and CompactJobCard uses quick when provided or falls back to act", async () => {
  const app = await readAppSource();
  assert.match(await readFile("ui/StudyMap.jsx", "utf8"), /dismissJob = \(jobId, alsoIds\) => dismissJobs\(quick, jobId, alsoIds\)/, "StudyMap dismissJob uses dismissJobs()");
  assert.doesNotMatch(app, /act\("job\.dismiss"/);
  assert.match(app, /QuickActionsContext\.Provider/);
  assert.match(app, /markInboxRead\(quick/, "全部已读 is light as well");

  const ui = await loadInteractiveUi(`
    export { AppContext } from './ui/app/app-context.js';
    export { QuickActionsContext, createQuickActions } from './ui/quick-actions.js';
    export { default as CompactJobCard } from './ui/tasks/CompactJobCard.jsx';
    export { setUiLanguage } from './ui/i18n.js';
  `);
  const { AppContext, QuickActionsContext, createQuickActions, CompactJobCard, setUiLanguage } = ui.exports;
  const h = ui.React.createElement;

  const prevCss = globalThis.CSS;
  globalThis.CSS = { escape: (value) => String(value) };

  await withBrowserGlobals(async () => {
    setUiLanguage("zh");
    try {
      // 1) WITH QuickActionsContext.Provider -> clicking 归档 uses the light path (dismissJobs -> job.archive), never act
      const quickCalls = [];
      const actCallsWithQuick = [];
      const quickController = createQuickActions({
        call: async (action, args) => {
          quickCalls.push({ action, args });
          return { ok: true };
        },
        timers: false,
      });
      const lightJob = generation("j-light", "failed");
      quickController.view({ jobs: [lightJob] });

      const withQuick = ui.mount(() => h(
        AppContext.Provider,
        { value: { host: {}, core: { act: async (action, args) => { actCallsWithQuick.push({ action, args }); return { ok: true }; }, refresh: async () => {} }, nav: { show: { task: noop } } } },
        h(
          QuickActionsContext.Provider,
          { value: quickController.snapshot() },
          h(CompactJobCard, { job: lightJob }),
        ),
      ));
      try {
        const dismissBtn = withQuick.find((node) => node.type === "button" && /^归档：/.test(node.props?.["aria-label"] || ""));
        assert.ok(dismissBtn, "finished CompactJobCard renders 归档 button");
        await withQuick.act(() => click(dismissBtn));
        await withQuick.flush(3);
        assert.deepEqual(quickCalls, [{ action: "job.archive", args: { jobId: "j-light" } }]);
        assert.deepEqual(actCallsWithQuick, [], "light path never touches single-flight act");
      } finally {
        withQuick.unmount();
      }

      // 2) WITHOUT QuickActionsContext.Provider -> clicking 归档 falls back to app.core.act('job.archive', ...)
      const actCallsFallback = [];
      const fallbackJob = generation("j-fallback", "complete");
      const withoutQuick = ui.mount(() => h(
        AppContext.Provider,
        { value: { host: {}, core: { act: async (action, args) => { actCallsFallback.push({ action, args }); return { ok: true }; }, refresh: async () => {} }, nav: { show: { task: noop } } } },
        h(CompactJobCard, { job: fallbackJob }),
      ));
      try {
        const dismissBtn = withoutQuick.find((node) => node.type === "button" && /^归档：/.test(node.props?.["aria-label"] || ""));
        assert.ok(dismissBtn, "standalone CompactJobCard renders 归档 button");
        await withoutQuick.act(() => click(dismissBtn));
        await withoutQuick.flush(3);
        assert.deepEqual(actCallsFallback, [{ action: "job.archive", args: { jobId: "j-fallback" } }]);
      } finally {
        withoutQuick.unmount();
      }
    } finally {
      setUiLanguage("zh");
      if (prevCss === undefined) delete globalThis.CSS;
      else globalThis.CSS = prevCss;
    }
  });
});

test("act itself still serialises heavy actions and keeps its busy flag", async () => {
  const app = await readAppSource();
  assert.match(app, /const act = useCallback\(/);
  assert.match(app, /createActRunner/, "App's act() is the single-flight runner (see tests/act-runner.test.mjs)");

  // Behavioral single-flight check on createActRunner (also covered in depth by tests/act-runner.test.mjs)
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const calls = [];
  const busyStates = [];
  const runner = createActRunner(() => ({
    call: (action) => {
      calls.push(action);
      return gate;
    },
    refresh: async () => {},
    epoch: () => 0,
    navigation: () => 0,
    setBusy: (value) => busyStates.push(value),
    setError: () => {},
    holdMs: 20,
  }));

  const first = runner.act("review.answer", { grade: 4 }, undefined, { refreshAfter: false });
  assert.equal(runner.busy(), true);
  assert.deepEqual(busyStates, [true]);
  assert.equal(await runner.act("review.move", { direction: 1 }, undefined, { refreshAfter: false }), undefined, "re-entrant act is dropped while busy");
  assert.deepEqual(calls, ["review.answer"]);

  release({ ok: true });
  assert.deepEqual(await first, { ok: true });
  assert.equal(runner.busy(), false);
  assert.deepEqual(busyStates, [true, false]);
});
