import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { inApp } from './helpers/fake-app.mjs';
import { reviewedCardFingerprint } from '../lib/review-integrity.js';
import { draftView, seedView, small } from './helpers/coverage-view.mjs';

/* From a finished run to practising, with the fewest presses: 发布并练习 on the finished card of a clean draft (the same quick publish as 保存并发布 on the draft page, one shared function),
   打开草稿 beside it so the learner can still look first; and while a job works on the draft, the draft page says which job, why 保存并发布 waits, and offers to stop it. */

const m = await loadUi(`
  export { AppContext } from './ui/app/app-context.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { default as JobCard } from './ui/study-map/JobCard.jsx';
  export { default as Draft } from './ui/Draft.jsx';
  export { publishAndPractice } from './ui/app/use-drafts.js';
  export * as publish from './ui/draft-publish.js';
  export { seedCoverage, forgetCoverage } from './ui/coverage/use-coverage.js';
  export { setUiLanguage } from './ui/i18n.js';`);
const han = /[㐀-鿿]/;
const noop = () => {};
const text = html => html.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const inLanguage = (language, run) => { m.setUiLanguage(language); try { return run(); } finally { m.setUiLanguage('zh'); } };

const card = id => ({ id, kind: 'quiz', topic: 'T', prompt: `题 ${id}`, answer: 'A', options: ['A', 'B'], explanation: 'E', citations: [{ sourceId: 's', quote: 'q' }] });
const cleanDraft = (extra = {}) => {
  const cards = [card('c1'), card('c2'), card('c3')];
  return { id: 'd1', title: '期中复习', draftVersion: 4, cards, quality: { warnings: [], errors: [] },
    editorial: { requested: 3, generated: 3, reviewedCards: Object.fromEntries(cards.map(item => [item.id, reviewedCardFingerprint(item)])), generation: { sourceIds: ['s'], kind: 'quiz' }, ...extra.editorial }, ...extra.draft };
};
const ready = { ready: true, state: 'done', questionsMissing: 0, action: null };

/* ---------- the shared quick publish ---------- */

function harness({ reviewFails = false, current = true } = {}) {
  const calls = [], effects = [];
  const call = async (action, args) => {
    calls.push([action, args]);
    if (action === 'draft.save') return { ...args.deck, draftVersion: args.deck.draftVersion + 1 };
    if (action === 'draft.publish.quick') return { id: 'deck1' };
    if (action === 'review.start') { if (reviewFails) throw new Error('no new questions'); return { id: 'run1', total: 7 }; }
    throw new Error(`unexpected ${action}`);
  };
  const options = [];
  const act = async (action, args, after, option) => { options.push(option); const result = await call(action, args); await after?.(result, { isCurrent: () => current }); return result; };
  return { calls, effects, options, parts: { call, act, toast: { success: text => effects.push(['toast', text]) }, openDraft: saved => effects.push(['openDraft', saved.draftVersion]),
    clearRecovery: () => effects.push(['clearRecovery']), enterRun: run => effects.push(['enterRun', run.id]), setPage: page => effects.push(['setPage', page]) } };
}

test('from the draft page: save, quick publish into the chosen deck, start the new questions, in one act', async () => {
  const h = harness();
  await m.publishAndPractice({ ...h.parts, draft: cleanDraft(), intoDeck: 'deckA' });
  assert.deepEqual(h.calls.map(([action]) => action), ['draft.save', 'draft.publish.quick', 'review.start']);
  assert.deepEqual(h.calls[1][1], { id: 'd1', draftVersion: 5, mergeTargetId: 'deckA' }, 'publishes the version it just saved, into the chosen deck');
  assert.deepEqual(h.calls[2][1], { deckId: 'deck1', mode: 'new', count: 10, ordered: true, fresh: true });
  assert.deepEqual(h.effects, [['openDraft', 5], ['clearRecovery'], ['enterRun', 'run1'], ['toast', '已发布，开始学习本轮 7 道新题。']]);
  assert.deepEqual(h.options, [{ afterNavigation: true }], 'the follow-up work survives the page change');
});

test('from the finished card: no save (nothing was edited), the same publish and the same practice', async () => {
  const h = harness();
  await m.publishAndPractice({ ...h.parts, draft: cleanDraft(), save: false });
  assert.deepEqual(h.calls.map(([action]) => action), ['draft.publish.quick', 'review.start']);
  assert.deepEqual(h.calls[0][1], { id: 'd1', draftVersion: 4 });
  assert.deepEqual(h.effects, [['clearRecovery'], ['enterRun', 'run1'], ['toast', '已发布，开始学习本轮 7 道新题。']]);
});

test('with no new question to start the deck is published all the same, and the page says so', async () => {
  const h = harness({ reviewFails: true });
  await m.publishAndPractice({ ...h.parts, draft: cleanDraft(), save: false });
  assert.deepEqual(h.effects, [['clearRecovery'], ['setPage', 'library'], ['toast', '题组已发布；当前没有可开始的新题。']]);
});

test('a page the learner has left gets no UI effect from the late answer (the publication itself still happens)', async () => {
  const h = harness({ current: false });
  await m.publishAndPractice({ ...h.parts, draft: cleanDraft() });
  assert.deepEqual(h.calls.map(([action]) => action), ['draft.save', 'draft.publish.quick', 'review.start']);
  assert.deepEqual(h.effects, []);
});

/* ---------- which draft may be published from the card ---------- */

test('a draft is published from the card only when nothing is left to look at: complete, reviewed as it is, no problem, no deck to choose, nothing working on it', () => {
  const ok = (extra = {}, over = {}) => m.publish.canPublishAtOnce({ draft: cleanDraft(extra), shortfall: ready, known: true, jobs: [], targets: null, ...over });
  assert.equal(ok(), true);
  assert.equal(ok({}, { shortfall: { ...ready, questionsMissing: 2 } }), false, 'questions still missing');
  assert.equal(ok({}, { shortfall: { ready: false, state: 'stopped', questionsMissing: 0, action: 'topup' } }), false, 'sections still without a question, or the coverage not known yet');
  assert.equal(ok({}, { shortfall: null }), false);
  assert.equal(ok({}, { targets: { part: {}, candidates: [] } }), false, 'a next part chooses its deck on the draft page');
  assert.equal(ok({ editorial: { rejectedIssues: { c1: ['x'] } } }), false);
  assert.equal(ok({ draft: { quality: { warnings: [], errors: ['q1: broken'] } } }), false);
  assert.equal(ok({ draft: { editingDeckId: 'x' } }), false, 'an edit of a published deck');
  assert.equal(ok({ editorial: { repairOfDeckId: 'x' } }), false);
  assert.equal(ok({ draft: { cards: [] } }), false);
  const edited = cleanDraft(); edited.cards[1] = { ...edited.cards[1], prompt: '改过的题' };
  assert.equal(m.publish.canPublishAtOnce({ draft: edited, shortfall: ready, known: true, jobs: [], targets: null }), false, 'a question changed since its review');
  // the pipeline stamps WHERE a quote stands (citation.at) after the review has marked the card: that is not a change to what was reviewed
  const stamped = cleanDraft(); stamped.cards = stamped.cards.map(item => ({ ...item, citations: item.citations.map(ref => ({ ...ref, at: { start: 10, end: 42 } })) }));
  assert.equal(m.publish.canPublishAtOnce({ draft: stamped, shortfall: ready, jobs: [], targets: null }), true, 'a place stamped after the review is still the reviewed card');
  const unreviewed = cleanDraft(); delete unreviewed.editorial.reviewedCards;
  assert.equal(m.publish.canPublishAtOnce({ draft: unreviewed, shortfall: ready, known: true, jobs: [], targets: null }), false, 'a draft with no review marks');
  assert.equal(ok({}, { jobs: [{ id: 'j', draftId: 'd1', type: 'generate', status: 'running' }] }), false, 'a job works on it');
});

/* ---------- the card ---------- */

const done = (extra = {}) => ({ id: 'j1', type: 'generate', status: 'complete', stage: 'Draft ready for review', deckTitle: '期中复习', draftId: 'd1', kind: 'quiz', count: 3, requestedTotal: 3, savedCount: 3,
  parts: 1, steps: [], startedAt: '2026-10-06T10:00:00.000Z', finishedAt: '2026-10-06T10:02:00.000Z', ...extra });
// The coverage the card asks for (coverage.get): every section of the material has a question, or one has not.
const seed = ({ all = true } = {}) => { m.forgetCoverage(); seedView(m, draftView({ draftId: 'd1', draftVersion: 4, covered: all ? small.ids : small.ids.slice(0, 2) })); };
const draw = (job, { draft = cleanDraft(), app = {}, language = 'zh', props = {}, all = true } = {}) => inLanguage(language, () => {
  seed({ all });
  const data = { jobs: [job], drafts: [draft], decks: [], sources: [], model: { ready: true } };
  return renderToStaticMarkup(inApp(m, React.createElement(m.JobCard, { job, jobs: [job], drafts: [draft], data, busy: false, openDraft: noop, cancelJob: noop, dismissJob: noop, modelReady: true, ...props }),
    { data, app: { drafts: { publishAndPractice: noop }, ...app } }));
});
const buttons = html => [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map(match => text(match[1]).replace(/\s*→$/, ''));

test('the finished card of a clean draft says 发布并练习, and keeps 打开草稿 as the quiet way to look first', () => {
  const html = draw(done());
  assert.match(html, /class="[^"]*cjc__go[^"]*"[^>]*>(?:(?!<\/button>)[\s\S])*发布并练习/, 'the primary button');
  const links = html.match(/<div class="cjc__links"[\s\S]*?<\/div>/)?.[0] || '';
  assert.match(text(links), /打开草稿/, 'the other way is a link under the card');
  assert.equal((html.match(/cjc__go/g) || []).length, 1, 'still one primary button');
  inLanguage('en', () => assert.doesNotMatch(text(draw(done(), { language: 'en' })), /发布并练习|打开草稿/));
  assert.match(text(draw(done(), { language: 'en' })), /Publish and practise/);
});

test('every other finished card keeps its own button: a draft with something missing, a next part, a failed run', () => {
  assert.doesNotMatch(draw(done(), { all: false }), /发布并练习/, 'sections without a question: the card offers the top-up, not publication');
  const html = draw(done(), { draft: cleanDraft({ editorial: { rejectedIssues: { c1: ['x'] } } }) });
  assert.doesNotMatch(html, /发布并练习/);
  assert.match(buttons(html).join('|'), /打开草稿/);
  assert.doesNotMatch(draw(done(), { app: { drafts: {} } }), /发布并练习/, 'a host without the publish action does not draw a button that cannot work');
  assert.doesNotMatch(draw(done({ status: 'failed', stage: 'boom' })), /发布并练习/);
});

/* ---------- the draft page while a job works on it ---------- */

test('holdLine says what works on the draft, why saving and publishing wait, and how to get past it', () => {
  const { holdLine, canStopWork } = m.publish;
  const draft = cleanDraft();
  const job = (extra = {}) => ({ id: 'j9', draftId: 'd1', type: 'generate', status: 'running', continued: true, savedCount: 5, requestedTotal: 10, ...extra });
  const work = (extra, kind = 'topup') => ({ kind, job: job(extra) });
  assert.equal(holdLine(work({}), draft), '补题中 · 草稿 5/10 题。这期间不能保存或发布；想现在发布，先停止它（已通过检查的题都保留在草稿里）。');
  assert.equal(holdLine(work({ continued: false }, 'generating'), draft), '生成中 · 草稿 5/10 题。这期间不能保存或发布；想现在发布，先停止它（已通过检查的题都保留在草稿里）。');
  assert.match(holdLine(work({ status: 'queued' }), draft), /^补题排队中。这期间不能保存或发布/);
  assert.equal(holdLine(work({ status: 'cancelling' }), draft), '正在停止；停下后就可以保存或发布。');
  assert.equal(holdLine(work({ type: 'draft-repair' }, 'repair'), draft), '后台修题中…。修题期间不能保存或发布；想现在发布，先停止修题（已修好的题保留）。');
  assert.equal(holdLine({ kind: 'publish', job: job({ type: 'draft-publish', stage: '正在检查第 2 道' }) }, draft), '正在检查第 2 道');
  // a run of rounds names its round
  const rounds = ['done', 'running', 'pending'].map((status, index) => ({ round: index + 1, questions: 24, status, fill: false, sections: 6, ...(status === 'done' ? { kept: 24, covered: 6, tokens: 400_000, ms: 600_000 } : {}) }));
  const run = job({ coverageRun: { autoComplete: true, state: 'running', percent: 31, tokensUsed: 1_200_000, startedAt: '2026-10-06T10:00:00.000Z', list: rounds } });
  assert.match(holdLine({ kind: 'topup', job: run }, draft, 31), /^第 2\/3 轮 · 覆盖 31%.*这期间不能保存或发布/, 'which round');
  // the stop action
  assert.equal(canStopWork(work({})), true);
  assert.equal(canStopWork(work({ status: 'cancelling' })), false);
  assert.equal(canStopWork({ kind: 'publish', job: job({ type: 'draft-publish' }) }), false, 'a publication check is not stopped from here');
  assert.equal(canStopWork(work({ contract: { actions: { cancel: { available: false } } } })), false, 'the contract says it cannot');
  inLanguage('en', () => {
    for (const w of [work({}), work({ status: 'queued' }), work({ status: 'cancelling' }), work({ type: 'draft-repair' }, 'repair')]) assert.doesNotMatch(holdLine(w, draft), han);
    assert.match(holdLine(work({}), draft), /Saving and publishing wait/);
  });
});

function page(draft, data = {}, { language = 'zh' } = {}) {
  m.forgetCoverage();
  return inLanguage(language, () => renderToStaticMarkup(inApp(m, React.createElement(m.Draft, { data: { sources: [{ id: 's', title: 'S' }], decks: [], drafts: [draft], jobs: [], modelReady: true, runs: [], ...data },
    draft, draftLoaded: JSON.stringify(draft), setDraft: noop, draftText: '', setDraftText: noop, jsonMode: false, setJsonMode: noop, openDraft: noop, onOpenPublished: noop, onStartPublished: noop,
    clearRecovery: noop, setPage: noop, setModal: noop, blankCard: noop, patchCard: noop, parseDraft: JSON.parse, topUpDraft: noop }), { data })));
}
const sticky = html => /<div class="sticky-actions"[\s\S]*?<\/div>/.exec(html)?.[0] || '';
const holdOf = html => /<div[^>]*data-draft-hold[\s\S]*?<\/div><\/div><\/div>/.exec(html)?.[0] || '';
const buttonTag = (html, label) => new RegExp('<button([^>]*)>(?:<[^>]+>)*' + label).exec(html)?.[0];
const working = (extra = {}) => ({ id: 'j9', draftId: 'd1', type: 'generate', status: 'running', continued: true, savedCount: 5, requestedTotal: 10, startedAt: '2026-10-06T10:00:00.000Z', ...extra });

test('while a job works on the draft, the page says which job, why 保存并发布 waits and how to stop it; with nothing working there is no such line', () => {
  const draft = cleanDraft();
  assert.doesNotMatch(page(draft), /data-draft-hold/);
  const html = page(draft, { jobs: [working()] });
  const hold = holdOf(html);
  assert.ok(hold, 'the line is there');
  assert.match(text(hold), /补题中 · 草稿 5\/10 题。这期间不能保存或发布；想现在发布，先停止它/);
  assert.match(text(hold), /停止并保留已出的题/, 'and the way out');
  assert.match(buttonTag(html, '保存并发布'), /disabled/, 'the button is still off');
  assert.match(buttonTag(html, '保存并发布'), /aria-describedby="draft-hold"/, 'and the line is its description');
  assert.ok(html.indexOf('data-draft-hold') > html.indexOf('sticky-actions'), 'under the buttons');
  assert.doesNotMatch(html, /后台任务正在更新这份草稿/, 'the old generic line is gone: one fact once');
  // a publication check cannot be stopped from here; it says what it is doing
  const publishing = page(draft, { jobs: [working({ type: 'draft-publish', continued: false, stage: '正在检查第 2 道题' })] });
  assert.match(text(publishing), /正在检查第 2 道题/);
  assert.doesNotMatch(text(holdOf(publishing)), /停止/);
  // a job that is already stopping
  const stopping = page(draft, { jobs: [working({ status: 'cancelling' })] });
  assert.match(text(stopping), /正在停止；停下后就可以保存或发布。/);
  assert.doesNotMatch(text(holdOf(stopping)), /停止并保留/);
  inLanguage('en', () => {
    const english = text(page(draft, { jobs: [working()] }, { language: 'en' }));
    assert.match(english, /Saving and publishing wait until it is done; to publish now, stop it first/);
    assert.match(english, /Stop and keep the questions so far/);
  });
});

test('while the job writes the draft the library moves ahead of the page: the same line says so and that the page loads the new content by itself (no "修题" banner for a top-up)', () => {
  const draft = cleanDraft(), newer = { ...draft, draftVersion: draft.draftVersion + 1 };
  const html = page(draft, { jobs: [working()], drafts: [newer] });
  assert.match(text(holdOf(html)), /这期间不能保存或发布.*完成后本页会自动载入最新内容。/);
  assert.doesNotMatch(html, /后台修题正在更新草稿/, 'a top-up is not a repair');
  assert.match(buttonTag(html, '保存并发布'), /disabled/);
  // idle and behind: the old line about loading what was repaired stays
  assert.match(text(page(draft, { jobs: [], drafts: [newer] })), /正在载入后台修好的题目…/);
  inLanguage('en', () => assert.match(text(holdOf(page(draft, { jobs: [working()], drafts: [newer] }, { language: 'en' }))), /This page loads the new content by itself when it is done./));
});

test('right after a save the page is ahead of the snapshot: that is not "stale", so the saved edit is not replaced by the older copy', () => {
  const draft = cleanDraft(), older = { ...draft, draftVersion: draft.draftVersion - 1 };
  const html = page(draft, { drafts: [older] });
  assert.doesNotMatch(html, /草稿已在后台更新|正在载入后台修好的题目/);
  assert.doesNotMatch(buttonTag(html, '保存并发布') || '', /disabled/, 'and publishing is not held for it');
});

test('a sticky bar that waits does not move the buttons: the line sits under the bar, not inside it', () => {
  const html = page(cleanDraft(), { jobs: [working()] });
  assert.doesNotMatch(sticky(html), /data-draft-hold/);
});
