import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/* #196 (button names its deck and is off while a fill runs), #200/#203 and #201 draw from the draft page and the home, rendered here. */
const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `export { default as Draft } from './ui/Draft.jsx'; export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
const m = module.exports;
const noop = () => {};
const han = /[㐀-鿿]/;
const card = id => ({ id, kind: 'flashcard', topic: 't', prompt: `p${id}`, answer: 'a', hint: 'h', explanation: 'e', misconception: 'x' });
const draft = (extra = {}) => ({ id: 'd1', title: '第1步 架构思维', draftVersion: 3, cards: [card('c1'), card('c2')],
  editorial: { requested: 2, generated: 2, completedParts: 1, parts: 1, failures: [], generation: { sourceIds: ['s1', 's2', 's3'], kind: 'quiz' },
    coverage: { cited: 1, selected: 3, sources: [{ id: 's1', title: 'S1', planned: 2, accepted: 2 }, { id: 's2', title: 'S2', planned: 0, accepted: 0 }, { id: 's3', title: 'S3', planned: 0, accepted: 0 }],
      uncited: [{ id: 's2', title: 'S2' }, { id: 's3', title: 'S3' }] } }, ...extra });
const page = (value, data = {}, props = {}, language = 'zh') => {
  m.setUiLanguage(language);
  try {
    return renderToStaticMarkup(React.createElement(m.Draft, { data: { sources: ['s1', 's2', 's3'].map(id => ({ id, title: id.toUpperCase() })), decks: [], drafts: [value], jobs: [], modelReady: true, runs: [], ...data },
      busy: false, act: noop, call: noop, draft: value, draftLoaded: JSON.stringify(value), setDraft: noop, draftText: '', setDraftText: noop, jsonMode: false, setJsonMode: noop,
      openDraft: noop, onOpenPublished: noop, onStartPublished: noop, clearRecovery: noop, setPage: noop, setNotice: noop, setError: noop, setModal: noop,
      setSelectedSources: noop, setGenSource: noop, blankCard: noop, patchCard: noop, parseDraft: JSON.parse, continueDraft: noop, addFromSources: noop, ...props }));
  } finally { m.setUiLanguage('zh'); }
};
const text = html => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
/** The opening tag of the button whose label starts with `label`. */
const buttonTag = (html, label) => new RegExp('<button([^>]*)>(?:<[^>]+>)*' + label).exec(html)?.[0];

test('the add button names the deck it adds to, the sources and the count, and a new deck is a separate choice (#196)', () => {
  const out = page(draft());
  assert.match(text(out), /为「第1步 架构思维」补题：用 2 份未覆盖资料，追加约 4 题/);
  assert.match(text(out), /给「第1步 架构思维」补 4 题 →/);
  assert.match(text(out), /用这些资料新建题组/);
  assert.match(out, /data-add-from-sources/);
  assert.ok(buttonTag(out, '给「第1步'), 'the add button is there');
  assert.doesNotMatch(buttonTag(out, '给「第1步'), /disabled/, 'idle: the button works');
  assert.match(out, /<input[^>]*type="number"[^>]*value="4"/);
  const english = text(page(draft(), {}, {}, 'en'));
  assert.doesNotMatch(english.replaceAll('第1步 架构思维', 'TITLE'), han);
  assert.match(english, /Adding to “第1步 架构思维”: 4 more questions from 2 uncovered sources/);
  assert.match(english, /Create a new deck from these sources/);
});

test('the add button is off, and says 补题中, while a fill or generation runs on that deck (#196)', () => {
  const running = { id: 'j1', status: 'running', draftId: 'd1', continued: true, savedCount: 2, requestedTotal: 4 };
  const out = page(draft(), { jobs: [running] });
  assert.match(text(out), /补题中 · 草稿 2\/4 题/);
  assert.match(buttonTag(out, '补题中'), /disabled/);
  assert.doesNotMatch(text(out), /给「第1步 架构思维」补/, 'the add label gives way to the running label');
  // A fill that publishes straight into the deck this draft merges into owns it too.
  const merging = page(draft({ mergeTargetId: 'deck-9' }), { jobs: [{ id: 'j2', status: 'running', mergeTargetId: 'deck-9', type: 'supplement', continued: false }] });
  assert.match(buttonTag(merging, '补题中'), /disabled/);
  const finished = page(draft(), { jobs: [{ ...running, status: 'complete' }] });
  assert.doesNotMatch(buttonTag(finished, '给「第1步'), /disabled/, 'once the fill is done the deck can be added to again');
});

test('generation details say how many questions the repair kept and how many were dropped (#202)', () => {
  const repaired = draft(); Object.assign(repaired.editorial, { repairedInRun: 3, repairTried: 4, omitted: [{ part: 1, prompt: 'q', reasons: ['x'] }, { part: 1, prompt: 'r', reasons: ['y'] }] });
  assert.match(text(page(repaired)), /修复后保留 3 题 · 丢弃 2 题（其中 1 题修复后仍未通过，原因见「没进入草稿的题」）/);
  assert.doesNotMatch(text(page(draft())), /修复后保留/, 'no repair, no line');
  const english = text(page(repaired, {}, {}, 'en'));
  assert.match(english, /3 kept after repair · 2 dropped \(1 of them still failed after repair/);
  assert.doesNotMatch(english.replaceAll('第1步 架构思维', 'TITLE'), han);
});

test('the add button is not offered for a case paper, an edit of a published deck or an unsaved edit', () => {
  const none = (value) => assert.doesNotMatch(page(value), /data-add-from-sources/);
  none(draft({ editingDeckId: 'deck-1' }));
  const kind = draft(); kind.editorial.generation.kind = 'case'; none(kind);
  const repair = draft(); repair.editorial.repairOfDeckId = 'deck-1'; none(repair);
});
