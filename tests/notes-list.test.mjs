import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';

/* #1709 / #1711: what the list of 学习笔记 says. A row gives its date once and, while one course is picked, no course name (the stored titles stay as they are);
   挑题成文 is a button above the list; 返回 is there only when the learner came from somewhere. The look and the width are measured in tests/notes-page-browser.test.mjs. */

const m = await loadUi(`
  export { default as BlogNotes } from './ui/BlogNotes.jsx';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { setUiLanguage } from './ui/i18n.js';
  export { recapTitle } from './lib/contexts/notes/note-links.js';
`);
const han = /[㐀-鿿]/;
const pad = (value) => String(value).padStart(2, '0');
const dayBack = (days) => { const at = new Date(); at.setDate(at.getDate() - days); return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`; };
const course = 'Course A';
const recap = (id, days, language, extra = {}) => {
  const daily = { day: dayBack(days), course, answeredCount: 12 };
  return { id, kind: 'daily-recap', title: m.recapTitle(daily, language), daily, courses: [course], cardCount: 12, status: 'draft', updatedAt: `${daily.day}T10:00:00Z`, ...extra };
};
const notesOf = (language) => [
  recap('r1', 1, language),
  recap('r2', 2, language === 'en' ? 'zh' : 'en'),
  recap('r3', 3, language, { title: 'My own review' }),
  recap('h1', 4, language, { kind: 'daily-recap-history' }),
  { id: 'q1', title: `${dayBack(5)} · ${course} · ${language === 'en' ? 'Study notes' : '学习笔记'}`, courses: [course], cardCount: 3, status: 'draft', updatedAt: `${dayBack(5)}T09:00:00Z` },
  { id: 'c1', title: `${dayBack(6)} · My topic · 学习笔记`, courses: [course], cardCount: 1, status: 'draft', updatedAt: `${dayBack(6)}T09:00:00Z` },
  { id: 'c2', title: 'Capacity planning', courses: [course], cardCount: 2, status: 'published', updatedAt: `${dayBack(7)}T09:00:00Z` },
];
const services = { call: async () => ({}), act: async () => undefined, busy: false, notify() {}, askInChat() {}, host: {}, openSettings() {}, navigate() {}, openModal() {} };
const draw = (props, { language = 'zh', scope = course } = {}) => {
  m.setUiLanguage(language);
  try {
    const data = { root: 'lib', focus: { course: scope, courses: [course, 'Course B'] }, notes: notesOf(language), decks: [], sources: [], settings: {} };
    return renderToStaticMarkup(React.createElement(m.StudyServicesContext.Provider, { value: services }, React.createElement(m.BlogNotes, { data, ...props })));
  } finally { m.setUiLanguage('zh'); }
};
const text = (markup) => markup.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const rowsOf = (html) => [...html.matchAll(/<button[^>]*class="[^"]*note-list-item[^"]*"[^>]*>(.*?)<\/button>/gs)].map((match) => text(match[1]));
const count = (value, part) => value.split(part).length - 1;

for (const language of ['zh', 'en']) {
  test(`${language}: with one course picked a row gives its date once and no course name; the learner's own titles stay as written`, () => {
    const rows = rowsOf(draw({}, { language }));
    assert.equal(rows.length, 7);
    for (const [at, days] of [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5]]) assert.equal(count(rows[at], dayBack(days)), 1, `row ${at}: ${rows[at]}`);
    for (const at of [0, 1, 3, 4]) {
      assert.ok(!rows[at].includes(course), `no course name: ${rows[at]}`);
      assert.doesNotMatch(rows[at], /每日学习总结|Daily study recap|今日学习总结/);
    }
    assert.match(rows[0], language === 'en' ? /Practised 12|12 questions? practised/i : /已练习 12 题/);
    assert.match(rows[2], /^My own review /, 'a renamed recap keeps its title; its date moves to the facts on the right');
    assert.match(rows[3], language === 'en' ? /before the courses were merged|before the course merge/i : /课程合并前的学习总结/);
    assert.match(rows[5], /· My topic · 学习笔记/, 'a title that names no course of the note is the learner\'s own words');
    assert.match(rows[6], /^Capacity planning /);
    if (language === 'en') assert.doesNotMatch(rows.filter((_, at) => at !== 5).join(' '), han);
  });
}

test('with every course in the list a row of an automatic title names its course', () => {
  const rows = rowsOf(draw({}, { scope: '*' }));
  for (const at of [0, 1, 3, 4]) {
    assert.equal(count(rows[at], course), 1, rows[at]);
    assert.equal(count(rows[at], '20'), 1, `one date: ${rows[at]}`);
  }
});

test('挑题成文 is a closed button above the list, not a fold drawn like a row', () => {
  const html = draw({});
  const button = /<button[^>]*aria-expanded="false"[^>]*>(?:(?!<\/button>).)*挑题成文<\/button>/s.exec(html);
  assert.ok(button, 'a button that says it is closed');
  assert.match(button[0], /class="sh-btn /);
  assert.ok(button.index < html.indexOf('note-list-item'), 'above the first row');
  assert.doesNotMatch(html, /<summary>挑题成文<\/summary>/);
});

test('#1709: no way back from the list unless the learner came from somewhere; a note keeps its way back to the list', () => {
  assert.doesNotMatch(draw({}), /返回学习库/);
  assert.match(draw({ onBack() {}, backLabel: '返回本轮学习结果' }), /返回本轮学习结果/);
  const note = { id: 'c2', title: 'Capacity planning', status: 'draft', markdown: '', cards: [], revision: 0 };
  const open = draw({ initialId: note.id, initialNote: note });
  assert.match(open, /全部笔记/);
  assert.doesNotMatch(open, /返回学习库/);
});

test('#1710: only an open note leaves the shared page width', () => {
  assert.doesNotMatch(draw({}), /data-note-open/);
  const note = { id: 'c2', title: 'Capacity planning', status: 'draft', markdown: '', cards: [], revision: 0 };
  assert.match(draw({ initialId: note.id, initialNote: note }), /<section class="page blog-notes-page" data-note-open=""/);
});
