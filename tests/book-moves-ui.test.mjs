/* #461 on the book page: after the outline was organised again, the notice lists the notes that moved (old title -> new title) and, apart, how many points'
   notes matched no new title and wait in 未归位; held points are never drawn as moves. Static markup, no browser. */
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';

const ui = await loadUi(`
  export { default as BookMoves } from './ui/book/BookMoves.jsx';
  export { setUiLanguage } from './ui/i18n.js';`);
const draw = moves => renderToStaticMarkup(React.createElement(ui.BookMoves, { course: 'SA', moves }));

test('moves and held points: the moves listed as moves, the held ones in one line of their own; nothing to say draws nothing', () => {
  const both = draw({ at: '2026-10-25T00:00:00.000Z', list: [{ from: 'Lecture one', to: 'What architects do', folded: false, share: 1 }], held: 2,
    heldList: [{ from: 'Cloud native', closest: 'Databases', share: 0.1 }, { from: 'Edge', closest: 'Databases', share: 0.05 }] });
  assert.match(both, /1 个知识点的笔记被移到了新位置/);
  assert.match(both, /「Lecture one」→「What architects do」/);
  assert.match(both, /data-book-held="">2 个知识点的笔记对不上新标题，放在「未归位」里/);
  assert.doesNotMatch(both, /Cloud native|Databases/, 'a held point is not drawn as a move to the closest point');
  const heldOnly = draw({ at: '2026-10-25T00:00:00.000Z', list: [], held: 1, heldList: [{ from: 'Cloud native', closest: 'Databases', share: 0.1 }] });
  assert.match(heldOnly, /1 个知识点的笔记对不上新标题/);
  assert.doesNotMatch(heldOnly, /被移到了新位置/);
  assert.equal(draw({ at: 'x', list: [], held: 0 }), '');
  ui.setUiLanguage('en');
  try {
    assert.match(draw({ at: 'y', list: [], held: 3 }), /The notes of 3 knowledge point\(s\) match no new title; they wait in Not placed/);
  } finally { ui.setUiLanguage('zh'); }
});
