import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { inApp } from './helpers/fake-app.mjs';
import { documentTopUp, plainCoverage } from '../lib/coverage-state.js';
import { stampPart } from '../lib/deck-parts.js';
import { shortfallOf } from '../lib/shortfall.js';
import { transcriptFixture } from './helpers/coverage-fixture.mjs';

/* The screens of a deck's parts (the owner's decision of 2026-10-06), in Chinese and English: the 资料 row / reader's 为没覆盖的部分补题 of a published deck's material (the same words, round, way to full
   coverage and estimate as a draft's), the draft page saying whose part it is and where it goes, the 任务 console's title, and the deck page's 「第一部分 N 题 · 第二部分 M 题」 with one part at a time. */

const m = await loadUi(`
  export { AppContext } from './ui/app/app-context.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { default as Manage } from './ui/Manage.jsx';
  export { default as DocumentTopUp, DocumentTopUpBody, offersDocumentTopUp } from './ui/coverage/DocumentTopUp.jsx';
  export { DraftPartLine, PartTargetChoice, partTargets, defaultPartTarget, draftPartTitle } from './ui/DraftPart.jsx';
  export { taskTitle } from './ui/tasks/task-summary.js';
  export { jobDeckName } from './ui/generation-status.js';
  export * as copy from './ui/coverage/copy.js';
  export { setUiLanguage } from './ui/i18n.js';
`);
const text = html => html.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim();
const inLanguage = (language, run) => { m.setUiLanguage(language); try { return run(); } finally { m.setUiLanguage('zh'); } };
const render = (element, { language = 'zh', data = {} } = {}) => inLanguage(language, () => renderToStaticMarkup(inApp(m, element, { data })));
const noop = () => {};

const fx = transcriptFixture({ recordings: 2, parts: 6, paragraphs: 4 });
const first = fx.leaves.slice(0, 2).map(section => fx.card(section));
const deck = { id: 'D', title: '期中复习', cards: first };
const state = { sources: fx.sources, decks: [deck], drafts: [] };
const offer = documentTopUp(state, { sourceId: fx.sources[0].id });
const view = { status: 'ok', scope: 'document', key: offer.item.key, coverage: plainCoverage(offer.coverage), topUp: { canTopUp: offer.canTopUp, candidates: offer.candidates, inFlight: offer.inFlight, round: offer.round } };
const item = { key: offer.item.key, sourceIds: offer.item.sourceIds, usedBy: [{ kind: 'deck', id: 'D', title: '期中复习', archived: false }] };

test('the confirmation of the 资料 row says the part, the round and the way to full coverage in the draft top-up\'s own words (zh and en), then the one button', () => {
  const s = shortfallOf({ coverage: view.coverage, round: view.topUp.round });
  for (const language of ['zh', 'en']) {
    const said = text(render(React.createElement(m.DocumentTopUpBody, { view, onStart: noop }), { language }));
    const path = inLanguage(language, () => m.copy.coveragePathText(s)), next = inLanguage(language, () => m.copy.nextRoundText(s));
    assert.ok(path && said.includes(path), `${language}: the way to full coverage, one wording: ${said}`);
    assert.ok(said.includes(next), `${language}: the round`);
    assert.ok(said.includes(language === 'zh' ? '作为「期中复习」的第二部分' : 'Part 2 of "期中复习"'), `${language}: whose part it is: ${said}`);
    assert.ok(said.includes(language === 'zh' ? '为没覆盖的部分补题' : inLanguage('en', () => m.copy.actionLabel('topup'))), `${language}: the same button`);
  }
  const zh = text(render(React.createElement(m.DocumentTopUpBody, { view, onStart: noop })));
  assert.match(zh, /覆盖现在 2\/\d+ 个小节（\d+%）→ 本轮后约 \d+% → 目标 100%，还要 \d+ 轮、约 \d+ 题/);
});

test('several decks hold the material: the learner chooses which one; every section in another draft\'s rounds: it says so instead of a button', () => {
  const two = { ...view, topUp: { ...view.topUp, candidates: [...view.topUp.candidates, { id: 'E', title: '期末', questions: 1, total: 1, nextPart: 2 }] } };
  assert.match(render(React.createElement(m.DocumentTopUpBody, { view: two, onStart: noop })), /data-part-target/);
  const busy = { ...view, topUp: { ...view.topUp, canTopUp: false, inFlight: 5 } };
  const said = text(render(React.createElement(m.DocumentTopUpBody, { view: busy, onStart: noop })));
  assert.ok(said.includes('正在另一份草稿里补题'), said);
  assert.ok(!said.includes('为没覆盖的部分补题'));
});

test('the button is offered only when a section has no question, a published deck holds the material, a model is ready and no top-up of it runs', () => {
  const digest = [2, 0, fx.leaves.length - 2, 1, 'part'];
  assert.equal(m.offersDocumentTopUp({ item, coverage: digest }), true);
  assert.equal(m.offersDocumentTopUp({ item, coverage: [fx.leaves.length, 0, 0, 1, 'part'] }), false, 'nothing uncovered: no button');
  assert.equal(m.offersDocumentTopUp({ item: { ...item, usedBy: [{ kind: 'draft', id: 'd' }] }, coverage: digest }), false, 'only drafts: the draft page has its top-up');
  assert.equal(m.offersDocumentTopUp({ item: { ...item, usedBy: [{ kind: 'deck', id: 'D', archived: true }] }, coverage: digest }), false);
  assert.equal(m.offersDocumentTopUp({ item, coverage: digest, modelReady: false }), false);
  assert.equal(m.offersDocumentTopUp({ item, coverage: digest, jobs: [{ id: 'j', status: 'running', part: { deckId: 'D', deckTitle: '期中复习', n: 2, documentKey: item.key } }] }), false);
  assert.match(render(React.createElement(m.DocumentTopUp, { item })), /为没覆盖的部分补题/);
});

const partDraft = { id: 'p', title: 'merged (1/1)', draftVersion: 2, cards: [], editorial: { requested: 4, generation: { sourceIds: fx.sources.map(source => source.id) }, part: { deckId: 'D', n: 2 } } };
const data = { decks: [{ id: 'D', title: '期中复习', count: 2 }, { id: 'X', title: '无关', count: 3 }], sources: fx.sources.map(source => ({ id: source.id, usedBy: [{ kind: 'deck', id: 'D', archived: false }] })) };

test('the draft page says whose part it is before publishing and offers where it goes: into the deck (default) or a deck of its own', () => {
  const targets = m.partTargets(partDraft, data);
  assert.deepEqual(targets.candidates.map(item => [item.id, item.n]), [['D', 2]], 'only decks that hold the material');
  assert.equal(m.defaultPartTarget(targets), 'D');
  const zh = text(render(React.createElement(React.Fragment, null, React.createElement(m.DraftPartLine, { targets }), React.createElement(m.PartTargetChoice, { targets, value: 'D', onChange: noop }))));
  assert.ok(zh.includes('这份草稿是「期中复习」的第二部分'), zh);
  assert.ok(zh.includes('并入「期中复习」，作为第二部分') && zh.includes('单独成为新题组'), zh);
  const en = text(render(React.createElement(m.PartTargetChoice, { targets, value: '', onChange: noop }), { language: 'en' }));
  assert.ok(en.includes('Merge into "期中复习" as Part 2') && en.includes('Publish as a deck of its own'), en);
  assert.equal(m.partTargets({ ...partDraft, editorial: { requested: 1 } }, data), null, 'any other draft is not a part');
  // A deck that already has its second part: the draft would be the third.
  const third = m.partTargets(partDraft, { ...data, decks: [{ id: 'D', title: '期中复习', count: 5, parts: [2, 3], partNumbers: [1, 2] }] });
  assert.equal(m.draftPartTitle(third), '期中复习 · 第三部分');
});

test('the 任务 console and the job card call the run 「期中复习 · 第二部分」 (Part 2 in English)', () => {
  const job = { id: 'j', type: 'generate', status: 'running', deckTitle: 'merged (1/1)', part: { deckId: 'D', deckTitle: '期中复习', n: 2 },
    contract: { jobId: 'j', kind: 'generation', title: 'merged (1/1)', detail: { part: { deckId: 'D', deckTitle: '期中复习', n: 2 } }, progress: {} } };
  assert.equal(m.taskTitle(job), '期中复习 · 第二部分');
  assert.equal(m.jobDeckName(job), '期中复习 · 第二部分');
  assert.equal(inLanguage('en', () => m.taskTitle(job)), '期中复习 · Part 2');
});

test('the deck page: 「第一部分 2 题 · 第二部分 3 题」 and one part at a time; an old deck of one part says nothing and lists every question', () => {
  const later = stampPart(fx.leaves.slice(4, 7).map(section => ({ ...fx.card(section), topic: 'T', objective: 'o', answer: 'a', kind: 'flashcard' })), 2);
  const managed = { id: 'D', title: '期中复习', folder: '', cards: [...first.map(card => ({ ...card, topic: 'T', objective: 'o', answer: 'a' })), ...later] };
  const page = deckView => render(React.createElement(m.Manage, { openDraft: noop, setPage: noop, managedDeck: deckView, decks: [], sources: fx.sources, setManagedDeck: noop, folderDraft: '', setFolderDraft: noop, onRemoveDeck: noop }));
  const said = text(page(managed));
  assert.ok(said.includes('第一部分 2 题 · 第二部分 3 题'), said);
  assert.match(page(managed), /data-part-filter/);
  const en = text(render(React.createElement(m.Manage, { openDraft: noop, setPage: noop, managedDeck: managed, decks: [], sources: fx.sources, setManagedDeck: noop, folderDraft: '', setFolderDraft: noop, onRemoveDeck: noop }), { language: 'en' }));
  assert.ok(en.includes('Part 1: 2 questions · Part 2: 3 questions'), en);
  const old = page({ ...managed, cards: managed.cards.map(({ part: _part, ...card }) => card) });
  assert.doesNotMatch(old, /data-deck-parts|data-part-filter/);
});
