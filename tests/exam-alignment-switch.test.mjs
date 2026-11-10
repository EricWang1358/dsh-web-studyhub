/* #882 step 4: the 考前对齐 switch in 间隔复习 · FSRS-6 (ui/settings/ExamAlignmentSwitch.jsx). Shown only when a course has an
   exam date ahead; says the rule (no later than the exam day, exam-day answers fall after it, memory and mastery unchanged); shows
   what switching does to the next 14 days as an estimate; offers 现在对齐 when questions are still due after the exam. */
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadUi } from "./helpers/ui-module.mjs";

const m = await loadUi(`
  export { ExamAlignmentView, changeList, previewLine } from './ui/settings/ExamAlignmentSwitch.jsx';
  export { setUiLanguage } from './ui/i18n.js';
`);
const han = /[㐀-鿿]/;
const day = (date, before, after = before) => ({ date, before, after });
const preview = (extra = {}) => ({
  enabled: false, pending: 0, courses: [{ name: "OS", date: "2026-11-20" }],
  days: [day("2026-11-10", 4), day("2026-11-11", 2), day("2026-11-12", 0)],
  on: [day("2026-11-10", 4, 6), day("2026-11-11", 2, 4), day("2026-11-12", 0)],
  off: [day("2026-11-10", 4), day("2026-11-11", 2), day("2026-11-12", 0)],
  ...extra,
});
const render = (props, language = "zh") => {
  m.setUiLanguage(language);
  try { return renderToStaticMarkup(React.createElement(m.ExamAlignmentView, props)); } finally { m.setUiLanguage("zh"); }
};

test("no course with an exam ahead (or nothing read yet): no switch", () => {
  assert.equal(render({ preview: null }), "");
  assert.equal(render({ preview: preview({ courses: [] }) }), "");
});

test("the switch names the exam, says the rule honestly and previews switching on as an estimate", () => {
  const html = render({ preview: preview() });
  assert.match(html, /data-tour="settings-exam-alignment"/);
  assert.match(html, /role="switch"/);
  assert.doesNotMatch(html, /checked=""/, "off as read");
  assert.match(html, /考前对齐/);
  assert.match(html, /考试日：OS 2026-11-20/);
  assert.match(html, /下次复习不晚于考试日/);
  assert.match(html, /考试当天作答的题只能排到考试之后/);
  assert.match(html, /不改记忆估计和掌握程度/);
  assert.match(html, /打开后，未来 14 天每天的复习量（估计）：11\/10 \+2 · 11\/11 \+2。/);
  assert.doesNotMatch(html, /11\/12/, "days that do not change are left out");
  assert.doesNotMatch(html, /保证/);
  assert.doesNotMatch(html, /title=/);
});

test("switched on: previews switching off; with questions still due after the exam it offers 现在对齐", () => {
  const on = render({ preview: preview({ enabled: true, off: [day("2026-11-10", 6, 4), day("2026-11-11", 4, 2), day("2026-11-12", 0)] }) });
  assert.match(on, /checked=""/);
  assert.match(on, /关闭后，未来 14 天每天的复习量（估计）：11\/10 −2 · 11\/11 −2。/);
  assert.doesNotMatch(on, /现在对齐/);
  const waiting = render({ preview: preview({ enabled: true, pending: 7 }) });
  assert.match(waiting, /还有 7 道题排在考试之后/);
  assert.match(waiting, /打开后，未来 14 天每天的复习量（估计）/);
  assert.match(waiting, /<button[^>]*>[\s\S]*?现在对齐/);
  const nothing = render({ preview: preview({ on: preview().off }) });
  assert.match(nothing, /打开后，未来 14 天每天的复习量不变。/);
  assert.match(render({ preview: preview(), busy: true }), /disabled=""/);
});

test("English: every line of the switch is in English", () => {
  for (const shown of [preview(), preview({ enabled: true, pending: 3 }), preview({ enabled: true }), preview({ on: preview().off })]) {
    const html = render({ preview: shown }, "en");
    assert.doesNotMatch(html, han, html);
    assert.match(html, /Exam alignment/);
  }
});
