/* #882 step 4 and its review: the 考前对齐 switch in 间隔复习 · FSRS-6 (ui/settings/ExamAlignmentSwitch.jsx). Shown only when an
   active course has an exam date ahead; one short sentence under it, the whole rule in the Tooltip beside the label (no later than
   the exam day, from 00:00 that day; exam-day answers fall after it; memory and mastery unchanged; after the exam new answers as
   usual, moved ones stay due until answered or restored); what switching does to the next 14 days as an estimate; 现在对齐 when
   questions wait; 恢复原来的日期 for questions moved for an exam that is over, even with the switch hidden. The course settings
   point at it (ui/ExamAlignmentPointer.jsx) while a course's questions wait. */
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadUi } from "./helpers/ui-module.mjs";

const m = await loadUi(`
  export { ExamAlignmentView, changeList, previewLine } from './ui/settings/ExamAlignmentSwitch.jsx';
  export { ExamAlignmentPointerView, examPointerShown } from './ui/ExamAlignmentPointer.jsx';
  export { alignmentReceipt, examDateText } from './ui/exam-alignment-words.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { setUiLanguage } from './ui/i18n.js';
  export { FINDER_ENTRIES } from './ui/finder/entries.js';
  export { searchFeatures } from './ui/finder/search.js';
`);
const han = /[㐀-鿿]/;
const day = (date, before, after = before) => ({ date, before, after });
const preview = (extra = {}) => ({
  enabled: false, pending: 0, restorable: 0, courses: [{ name: "OS", date: "2026-11-20", pending: 0 }],
  days: [day("2026-11-10", 4), day("2026-11-11", 2), day("2026-11-12", 0)],
  on: [day("2026-11-10", 4, 6), day("2026-11-11", 2, 4), day("2026-11-12", 0)],
  off: [day("2026-11-10", 4), day("2026-11-11", 2), day("2026-11-12", 0)],
  ...extra,
});
const render = (element, language = "zh", services = null) => {
  m.setUiLanguage(language);
  const tree = services ? React.createElement(m.StudyServicesContext.Provider, { value: services }, element) : element;
  try { return renderToStaticMarkup(tree); } finally { m.setUiLanguage("zh"); }
};
const view = (props, language, services) => render(React.createElement(m.ExamAlignmentView, props), language, services);

test("no exam ahead and nothing to give back (or nothing read yet): nothing at all", () => {
  assert.equal(view({ preview: null }), "");
  assert.equal(view({ preview: preview({ courses: [] }) }), "");
});

test("the switch names the exam on the calendar, says one sentence, keeps the rule in its Tooltip and previews switching on", () => {
  const html = view({ preview: preview() });
  assert.match(html, /data-tour="settings-exam-alignment"/);
  assert.match(html, /role="switch"/);
  assert.doesNotMatch(html, /checked=""/, "off as read");
  assert.match(html, /考试日：OS 2026年11月20日。已关闭：复习按平常安排。/, "the shared date formatter, not raw ISO; switched off, the sentence says so");
  assert.doesNotMatch(html, /复习不会排到考试之后|不晚于考试日。/, "no promise the switch is not keeping");
  assert.doesNotMatch(html, /2026-11-20/);
  assert.match(html, /role="tooltip"[^>]*>[^<]*考试当天 0 点起就会出现/, "the whole rule is in the Tooltip");
  assert.match(html, /考试当天作答的题只能排到考试之后/);
  assert.match(html, /提前了还没作答的题仍然到期，直到作答，或在这里恢复原来的日期/);
  assert.match(html, /打开后，未来 14 天每天的复习量（估计）：11月10日 \+2 · 11月11日 \+2。/);
  assert.doesNotMatch(html, /11月12日/, "days that do not change are left out");
  assert.doesNotMatch(html, /保证|title=/);
});

test("switched on: previews switching off; with questions waiting it offers 现在对齐; the press in flight shows on its button", () => {
  const on = view({ preview: preview({ enabled: true, off: [day("2026-11-10", 6, 4), day("2026-11-11", 4, 2), day("2026-11-12", 0)] }) });
  assert.match(on, /checked=""/);
  assert.match(on, /考试日：OS 2026年11月20日。之后的作答不晚于考试日。/, "switched on: what it does to answers from now on");
  assert.match(on, /关闭后，未来 14 天每天的复习量（估计）：11月10日 −2 · 11月11日 −2。/);
  assert.doesNotMatch(on, /<button/, "nothing waits: no 现在对齐 button");
  const waiting = view({ preview: preview({ enabled: true, pending: 7 }) });
  assert.match(waiting, /还有 7 道题排在考试之后/);
  assert.match(waiting, /<button[^>]*>[\s\S]*?现在对齐/);
  assert.match(view({ preview: preview({ on: preview().off }) }), /打开后，未来 14 天每天的复习量不变。/);
  const pressed = view({ preview: preview({ enabled: true, pending: 7 }), working: "align" }, "zh", { busy: true });
  assert.match(pressed, /aria-busy="true"[^>]*>[\s\S]*?现在对齐|现在对齐[\s\S]*?aria-busy="true"/, "the pressed button says it is working");
  assert.match(pressed, /role="switch"[^>]*disabled=""|disabled=""[^>]*role="switch"/, "the switch waits while the app works");
});

test("moved questions of an exam that is over are counted and can be given back, also when the switch itself is hidden", () => {
  const html = view({ preview: preview({ courses: [], restorable: 4 }) });
  assert.doesNotMatch(html, /role="switch"/);
  assert.match(html, /4 道题之前为考试提前了（考试已经过去，或题组已不在那门课），之后还没再作答，仍按提前的日子到期。/);
  assert.match(html, /<button[^>]*>[\s\S]*?恢复原来的日期/);
});

test("the receipts say what moved, and the course settings point at the switch only while that course's questions wait", () => {
  assert.equal(m.alignmentReceipt({ pulled: 3, restored: 0 }), "已把 3 道题提前到考试前");
  assert.equal(m.alignmentReceipt({ pulled: 2, restored: 5 }), "已把 2 道题提前到考试前；5 道题恢复了原来的日期");
  assert.equal(m.alignmentReceipt({ pulled: 0, restored: 0 }), "");
  const pointer = (props) => render(React.createElement(m.ExamAlignmentPointerView, props));
  const waiting = preview({ enabled: true, pending: 6, courses: [{ name: "OS", date: "2026-11-20", pending: 6 }, { name: "DB", date: "2026-11-25", pending: 0 }] });
  assert.match(pointer({ preview: waiting, course: "OS" }), /6 道题仍排在考试之后 → [\s\S]*?设置 · 考前对齐/);
  assert.equal(pointer({ preview: waiting, course: "DB" }), "");
  assert.equal(pointer({ preview: { ...waiting, enabled: false }, course: "OS" }), "", "switched off: nothing to point at");
  assert.equal(pointer({ preview: null, course: "OS" }), "");
});

test("the course settings mount the pointer (and read the preview) only for a course whose exam date is after today", () => {
  const now = new Date(2026, 10, 10, 15, 0).getTime();
  assert.equal(m.examPointerShown(null, now), false, "no exam");
  assert.equal(m.examPointerShown({ format: "closed-book" }, now), false, "an exam without a date");
  assert.equal(m.examPointerShown({ date: "2026-11-09" }, now), false, "over");
  assert.equal(m.examPointerShown({ date: "2026-11-10" }, now), false, "today: nothing can move before it");
  assert.equal(m.examPointerShown({ date: "2026-11-11" }, now), true, "tomorrow");
});

test("找功能 finds the switch by its two buttons and by the course line that points at it", () => {
  for (const query of ["现在对齐", "恢复原来的日期", "题仍排在考试之后", "align now", "restore original dates"])
    assert.equal(m.searchFeatures(m.FINDER_ENTRIES, query)[0]?.id, "exam-alignment", query);
});

test("English: every line is in English and the dates are written the English way", () => {
  for (const shown of [preview(), preview({ enabled: true, pending: 3 }), preview({ enabled: true }), preview({ on: preview().off }), preview({ courses: [], restorable: 2 })]) {
    const html = view({ preview: shown }, "en");
    assert.doesNotMatch(html, han, html);
  }
  assert.match(view({ preview: preview() }, "en"), /Exam alignment[\s\S]*Exam day: OS Nov 20, 2026\. Switched off: reviews are scheduled as usual\./);
  assert.match(view({ preview: preview({ enabled: true }) }, "en"), /Exam day: OS Nov 20, 2026\. Answers from now on come back by the exam day\./);
  // Counts follow the catalogue's way with a number that may be 1: "question(s)", never "1 questions".
  const counted = [view({ preview: preview({ enabled: true, pending: 1 }) }, "en"), view({ preview: preview({ courses: [], restorable: 1 }) }, "en"),
    render(React.createElement(m.ExamAlignmentPointerView, { preview: preview({ enabled: true, courses: [{ name: "OS", date: "2026-11-20", pending: 1 }] }), course: "OS" }), "en")];
  m.setUiLanguage("en");
  try { counted.push(m.alignmentReceipt({ pulled: 1, restored: 1 })); } finally { m.setUiLanguage("zh"); }
  for (const shown of counted) {
    assert.match(shown, /\b1 question\(s\)/, shown);
    assert.doesNotMatch(shown, /\b1 questions\b/, shown);
  }
  assert.match(view({ preview: preview() }, "en"), /November 10 \+2/);
  m.setUiLanguage("en");
  try { assert.doesNotMatch(m.alignmentReceipt({ pulled: 1, restored: 1 }), han); } finally { m.setUiLanguage("zh"); }
  const pointer = render(React.createElement(m.ExamAlignmentPointerView, { preview: preview({ enabled: true, courses: [{ name: "OS", date: "2026-11-20", pending: 2 }] }), course: "OS" }), "en");
  assert.doesNotMatch(pointer, han);
});
