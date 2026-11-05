/* 深度定制 (4.4 S3 gate E): the note under 「本周：第 N 章」 of a weekly plan. While a week is on, what earlier weeks left unlearnt is placed in it, and the note says so; after the
   last week nothing is placed (lib/plan-weekly.js leaves those points unscheduled), and the note says they are past the plan's end instead. Static markup, no browser. */
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';

const ui = await loadUi(`export { default as WeeklyDays } from './ui/book/WeeklyDays.jsx'; export { setUiLanguage } from './ui/i18n.js';`);
const weeks = [{ n: 1, from: '2026-10-11', until: '2026-10-17', chapters: [{ n: 1, title: 'A', points: 2, learnt: 0 }] }];
const render = (weekly, language = 'zh') => {
  ui.setUiLanguage(language);
  try { return renderToStaticMarkup(React.createElement(ui.WeeklyDays, { answer: { points: [] }, schedule: { weekly, today: null, days: [] }, course: 'SA' })); } finally { ui.setUiLanguage('zh'); }
};

test('during a week the owed points are said to be placed in it', () => {
  const html = render({ chaptersPerWeek: 1, weeks, thisWeek: 1, current: weeks[0], position: 'during', startsOn: '2026-10-11', endsOn: '2026-10-17', behind: 3 });
  assert.match(html, /3 节没学完，已排进本周/);
});

test('after the last week they are past the plan\'s end, not placed anywhere', () => {
  const over = { chaptersPerWeek: 1, weeks, thisWeek: null, current: null, position: 'over', startsOn: '2026-10-11', endsOn: '2026-10-17', behind: 3 };
  const html = render(over);
  assert.doesNotMatch(html, /已排进本周/);
  assert.match(html, /3 节过了计划的最后一周还没学完/);
  assert.match(render(over, 'en'), /3 point\(s\) were not learnt by the end of the plan/);
});
