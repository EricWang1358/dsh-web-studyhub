import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { inApp } from './helpers/fake-app.mjs';

/* #1328 review: the deck page's 所属课程 box must start from the deck's course. A deck row always carries `folder` (an empty string
   when it has none), so a box filled from `folder` first is empty for every deck that only has a course - 保存课程 is then enabled
   and one click moves the deck out of its course. */

const m = await loadUi(`
  export { AppContext } from './ui/app/app-context.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { default as Manage } from './ui/Manage.jsx';
  export { deckCourseOf } from './ui/deck-course.js';
`);
const noop = () => {};
const card = { id: 'c1', topic: 'T', objective: 'o', answer: 'a', kind: 'flashcard', prompt: 'q' };
// The shape the library snapshot gives a deck that belongs to a course and never had a folder of its own.
const deck = { id: 'D', title: '练习题组', course: '示例课', folder: '', cards: [card] };
const page = (folderDraft) => renderToStaticMarkup(inApp(m, React.createElement(m.Manage, {
  openDraft: noop, setPage: noop, managedDeck: deck, decks: [deck], sources: [], setManagedDeck: noop, folderDraft, setFolderDraft: noop, onRemoveDeck: noop,
}), { data: {} }));
const saveCourseButton = (html) => /<button\b[^>]*>(?:(?!<\/button>)[\s\S])*保存课程(?:(?!<\/button>)[\s\S])*<\/button>/.exec(html)?.[0] || '';

test('the course box of a deck starts from its course, also when the row carries an empty folder', () => {
  assert.equal(m.deckCourseOf(deck), '示例课');
  assert.equal(m.deckCourseOf({ folder: '旧目录' }), '旧目录', 'an older deck that only has a folder still reads it');
  assert.equal(m.deckCourseOf({ course: '', folder: '旧目录' }), '', 'an explicit empty course is the answer, not the folder');
  assert.equal(m.deckCourseOf(null), '');
});

test('opened with its own course in the box, the deck page offers nothing to save', () => {
  const button = saveCourseButton(page(m.deckCourseOf(deck)));
  assert.ok(button, 'the page has a 保存课程 button');
  assert.match(button, /\bdisabled\b/);
});

test('an empty box is a real change the page would save: that is why the box must never start empty by accident', () => {
  const button = saveCourseButton(page(''));
  assert.ok(button);
  assert.doesNotMatch(button, /\bdisabled\b/);
});
