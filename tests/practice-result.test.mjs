/* The result page of a practice round: the next step is the first thing under the score, the score is worded by how the answers were graded,
   the weak topics start practice of that topic, and the 点评 says once that it asks the model and where to switch that. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { renderToStaticMarkup } from 'react-dom/server';
import { StudyService } from '../lib/service.js';
import { reviewElement } from './helpers/review-render.mjs';
import { continueDestination } from '../ui/review/session-logic.js';

const compiled = await build({ stdin: { contents: "export { default } from './ui/Review.jsx'; export { StudyServicesContext } from './ui/study-context.jsx'; export { setUiLanguage } from './ui/i18n.js'; export { captureContext } from './ui/learning-navigation.js'; export { isBackDestination, trailKindOf, wayBackOf } from './ui/review/way-back.js';", resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react'], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const { default: Review, StudyServicesContext, setUiLanguage, captureContext, isBackDestination, trailKindOf, wayBackOf } = module.exports;
const han = /[㐀-鿿]/;
const noop = () => {};
const card = { id: 'q', kind: 'quiz', topic: 'Context', prompt: 'Who processes payments?', options: [] };
const debrief = (next = 'continue_path', extra = {}) => ({ headline: '状态不错，接着学下一批。', why: '本轮 4 题。', next, insights: [], metrics: { answered: 4, gradedAnswered: 4, gradedCorrect: 2 },
  status: { enabled: true, consent: false, ready: 0 }, ...extra });
const destination = (label = '继续学习 →', extra = {}) => ({ kind: 'path', reason: 'continuing', label, go: noop, note: '', ...extra });
function result({ run = {}, coach = {}, data = {}, links = {}, ...rest } = {}) {
  return renderToStaticMarkup(reviewElement(Review, StudyServicesContext, {
    run: { id: 'r', mode: 'path', complete: true, index: 4, total: 4, questions: 4, answered: 4, correct: 2, selfAnswered: 0, weakTopics: ['Context'],
      weakScopes: { Context: [{ deckId: 'd1', topic: 'Context' }] }, scope: [], card, ...run },
    data: { sources: [], ...data }, host: {}, choice: true, isCloze: false, selected: [], clozeValues: {}, shellTitle: '今日学习', busy: false,
    act: noop, enterRun: noop, setPage: noop, askInChat: noop,
    coachProps: { debrief: debrief(), autopilot: false, onPractice: noop, onContinue: noop, onReviewWeak: noop, destination: destination(), ...coach },
    ...links, ...rest,
  }));
}
const at = (html, marker) => html.indexOf(marker);
const primaries = (html) => (html.match(/class="sh-btn sh-btn--primary/g) || []).length;

test('the next step is the first thing under the score, above the recap panel, the 点评 and the weak topics', () => {
  setUiLanguage('zh');
  const html = result();
  const next = at(html, 'class="result-next"');
  assert.ok(next > at(html, 'class="result-hero'), 'under the score');
  for (const later of ['class="daily-recap"', 'coach-debrief', 'class="summary-topics', 'result-details']) assert.ok(next < at(html, later), `above ${later}`);
  assert.match(html.slice(next, at(html, 'coach-debrief')), /继续学习/);
});

test('a path round has its 继续学习 outside the fold, once; the fold keeps only what is an explicit repeat', () => {
  setUiLanguage('zh');
  const html = result();
  assert.equal((html.match(/继续学习/g) || []).length, 1, 'the next step is said once (the 点评 card does not repeat it)');
  const fold = html.slice(at(html, 'class="result-details"'));
  assert.doesNotMatch(fold, /继续学习/);
  const scoped = result({ run: { scope: [{ deckId: 'd1' }] }, coach: { destination: destination('继续这个范围 →', { kind: 'scope' }) } });
  assert.match(scoped, /再练此范围/, 'repeating the same scope stays an explicit, folded choice');
  assert.ok(at(scoped, '再练此范围') > at(scoped, 'result-details'));
});

test('exactly one filled button on the page, even when the 点评 suggests something else', () => {
  setUiLanguage('zh');
  assert.equal(primaries(result()), 1);
  for (const next of ['review_weak', 'practice_prepared']) {
    const html = result({ coach: { debrief: debrief(next, { status: { enabled: true, consent: false, ready: 3 } }) } });
    assert.equal(primaries(html), 1, next);
    assert.match(html, /先补薄弱点 →|刷 3 道为你定制的题 →/, 'the suggestion is still offered');
    assert.ok(at(html, 'class="result-next"') < at(html, '先补薄弱点 →') || at(html, 'class="result-next"') < at(html, '刷 3 道为你定制的题 →'));
  }
});

test('the way back to an original question or a workflow is the next step, and nothing else competes', () => {
  setUiLanguage('zh');
  const back = result({ run: { returnTo: 'orig' }, coach: { destination: destination('回到原题 →', { kind: 'original', runId: 'orig' }) } });
  assert.equal(primaries(back), 1);
  assert.match(back.slice(at(back, 'class="result-next"'), at(back, 'coach-debrief')), /回到原题/);
  assert.doesNotMatch(back, /继续学习/);
  const flow = result({ run: { workflow: { sessionId: 's', stepIndex: 0, stepCount: 3, stepTitle: 'x', current: true } }, onBackToWorkflow: noop });
  assert.match(flow.slice(at(flow, 'class="result-next"'), at(flow, 'coach-debrief')), /回到学习流，继续下一步/);
  assert.equal(primaries(flow), 1);
  const course = result({ run: { course: { name: '网络', next: { label: 'x', fresh: 3 }, learned: 1, cards: 5 } } });
  assert.match(course.slice(at(course, 'class="result-next"'), at(course, 'coach-debrief')), /继续课程下一批/);
  assert.equal(primaries(course), 1);
});

test('without a decision from the page (no library) the card keeps its own button, as before', () => {
  setUiLanguage('zh');
  const html = result({ coach: { destination: undefined } });
  assert.match(html, /继续学习 →/);
});

test('the score says what was measured: answered right for choices, met for self-graded cards, met for a mix', () => {
  setUiLanguage('zh');
  assert.match(result(), /道题答对 \/ 4 道/);
  assert.match(result({ run: { selfAnswered: 4 } }), /道题自评达标 \/ 4 道/);
  assert.doesNotMatch(result({ run: { selfAnswered: 4 } }), /道题答对/);
  const mixed = result({ run: { selfAnswered: 2 } });
  assert.match(mixed, /道题达标 \/ 4 道/);
  assert.doesNotMatch(mixed, /道题答对|自评达标 \/ 4/);
  setUiLanguage('en');
  try {
    assert.match(result({ run: { selfAnswered: 4 } }), /questions self-graded as met \/ 4/);
    assert.match(result({ run: { selfAnswered: 2 } }), /questions met the bar \/ 4/);
    assert.match(result(), /questions correct \/ 4/);
  } finally { setUiLanguage('zh'); }
});

test('a weak topic is a button that practises that topic; one with no known place stays a label', () => {
  setUiLanguage('zh');
  const html = result({ run: { weakTopics: ['Context', 'Orphan'], weakScopes: { Context: [{ deckId: 'd1', topic: 'Context' }] } } });
  const topics = html.slice(at(html, 'class="summary-topics'));
  assert.match(topics, /<button[^>]*>(?:(?!<\/button>).)*Context/);
  assert.match(topics, /练这个主题/);
  assert.doesNotMatch(topics, /<button[^>]*>(?:(?!<\/button>).)*Orphan/);
  assert.match(topics, /Orphan/);
});

test('the 点评 says once that it asks the model and links to the setting; switched off it says it did not', () => {
  setUiLanguage('zh');
  const on = result({ links: {}, data: { settings: {} } });
  assert.equal((on.match(/class="coach-model-note"/g) || []).length, 1);
  const noteOn = on.slice(at(on, 'class="coach-model-note"'));
  assert.match(noteOn, /请较轻量的模型写一句话/);
  assert.match(noteOn.slice(0, noteOn.indexOf('</p>')), /<button[^>]*>前往设置<\/button>/);
  const off = result({ data: { settings: { practice: { debrief: false } } } });
  const noteOff = off.slice(at(off, 'class="coach-model-note"'));
  assert.match(noteOff.slice(0, noteOff.indexOf('</p>')), /没有调用模型/);
  assert.match(noteOff.slice(0, noteOff.indexOf('</p>')), /<button[^>]*>前往设置<\/button>/);
  const short = result({ run: { answered: 2, questions: 2, total: 2 } });
  assert.doesNotMatch(short, /coach-model-note/, 'a round of fewer than three answers never asks the model, so there is nothing to disclose');
});

test('English: the new lines are translated', () => {
  setUiLanguage('en');
  try {
    const html = result({ run: { selfAnswered: 2 }, coach: { destination: destination('Continue studying →') } });
    const text = html.replace(/<[^>]*>/g, ' ');
    assert.match(text, /Go to settings/);
    assert.match(text, /lighter model/);
    assert.match(html, /aria-label="Practise this topic: Context"/);
    assert.doesNotMatch(text.replace(/Context|状态不错，接着学下一批。|本轮 4 题。|今日学习/g, ''), han);
  } finally { setUiLanguage('zh'); }
});

/* ---------- what the server tells the page ---------- */

async function study(t) {
  const root = await mkdtemp(join(tmpdir(), 'study-practice-result-'));
  const service = new StudyService(root);
  t.after(async () => { service.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const quiz = (id, topic) => ({ id, kind: 'quiz', topic, prompt: `${id}?`, answer: 'a',
    options: [{ id: 'y', text: 'Yes', correct: true }, { id: 'n', text: 'No', correct: false }] });
  const flash = (id, topic) => ({ id, kind: 'flashcard', topic, prompt: `${id}?`, answer: 'a' });
  await service.store.update((s) => { s.decks.push({ id: 'd1', title: 'D1', course: 'A', cards: [quiz('q1', 'Alpha'), flash('f1', 'Beta'), quiz('q2', 'Alpha')] },
    { id: 'd2', title: 'D2', course: 'A', cards: [quiz('q3', 'Alpha')] }); });
  return service;
}

test('a finished round says how many answers were self-graded and where each weak topic lives', async (t) => {
  const service = await study(t);
  let run = await service.call('review.start', { mode: 'path', scope: [{ deckId: 'd1' }, { deckId: 'd2' }], fresh: true });
  for (let step = 0; step < run.total; step++) {
    const card = run.card;
    if (card.kind === 'flashcard') { await service.call('review.reveal', { runId: run.id, cardId: card.id }); run = await service.call('review.answer', { runId: run.id, cardId: card.id, grade: 1 }); }
    else run = await service.call('review.answer', { runId: run.id, cardId: card.id, selected: ['n'] });
    run = await service.call('review.move', { runId: run.id, direction: 1 });
  }
  assert.equal(run.complete, true);
  assert.equal(run.answered, 4);
  assert.equal(run.selfAnswered, 1, 'the flashcard was graded by the learner');
  assert.equal(run.correct, 0);
  assert.deepEqual(Object.keys(run.weakScopes).sort(), ['Alpha', 'Beta']);
  assert.deepEqual(run.weakScopes.Beta, [{ deckId: 'd1', topic: 'Beta' }]);
  assert.deepEqual(run.weakScopes.Alpha.map((ref) => ref.deckId).sort(), ['d1', 'd2'], 'the same topic name in two decks is one button over both');
  assert.ok(run.weakScopes.Alpha.every((ref) => ref.topic === 'Alpha'));
});

test('the round of a course carries on with the next round of that course, never with the whole course as a scope', () => {
  const run = { id: 'r1', mode: 'path', scope: [{ deckId: 'd1' }, { deckId: 'd2' }], dailyCourse: '网络', questions: 20, answered: 20, complete: true };
  const progress = { d1: { counts: { new: 9 }, due: 3, topics: [] }, d2: { counts: { new: 9 }, due: 3, topics: [] } };
  const tasks = [{ id: 't', title: '读讲义', kind: 'reading', status: 'todo', available: true }];
  assert.deepEqual(continueDestination({ run, progress, tasks }), { kind: 'path', reason: 'continuing', course: '网络' });
  assert.deepEqual(continueDestination({ run: { ...run, dailyCourse: '' }, progress, tasks: [] }), { kind: 'path', reason: 'continuing', course: '' }, 'the decks without a course are a course too');
  assert.equal(continueDestination({ run: { ...run, returnTo: 'orig' }, runs: [{ id: 'orig' }], progress, tasks }).kind, 'original', 'a way back still wins');
  assert.equal(continueDestination({ run: { ...run, dailyCourse: undefined }, progress, tasks }).kind, 'scope', 'a run that is not a course round keeps its scope');
});

test('a course round has no 再练此范围: it is not a scope the learner chose', () => {
  setUiLanguage('zh');
  const round = result({ run: { scope: [{ deckId: 'd1' }], dailyCourse: 'A' } });
  assert.doesNotMatch(round, /再练此范围/);
  assert.match(result({ run: { scope: [{ deckId: 'd1' }] } }), /再练此范围/);
});

/* ---------- the way back to the review book / the 总纲: the main button of the result page and the label of the header's return button ---------- */

const bookTrail = (extra = {}) => ({ contextKind: 'book', contextPlace: '1.2.2 Architect the Solution (Asset)', contextReturnLabel: '回到复习全书', onReturnContext: noop, ...extra });
const nextBlock = (html) => html.slice(at(html, 'class="result-next'), at(html, 'coach-debrief'));
const buttonsOf = (html) => [...html.matchAll(/<button[^>]*class="([^"]*)"[^>]*>(.*?)<\/button>/gs)].map((match) => ({ cls: match[1], html: match[2], text: match[2].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() }));
const arrowRight = /<svg[^>]*>(?:(?!<\/svg>).)*<\/svg>\s*$/s, arrowLeft = /^\s*<svg/;

test('a round started in the book: the way back is the one filled button, with the point it leads to in a quiet second line; the page\'s own next step is a plain button after it', () => {
  setUiLanguage('zh');
  const html = result(bookTrail());
  assert.equal(primaries(html), 1, 'exactly one filled button on the page');
  const [first, second] = buttonsOf(nextBlock(html));
  assert.match(first.cls, /sh-btn--primary/);
  assert.match(first.cls, /reading-result__return/);
  assert.equal(first.text, '回到复习全书 回到 1.2.2 Architect the Solution (Asset)');
  assert.match(nextBlock(html), /<small[^>]*>回到 1\.2\.2 Architect the Solution \(Asset\)<\/small>/);
  assert.match(nextBlock(html), /<svg/, 'the arrow is a Phosphor icon, not a character');
  assert.match(second.cls, /sh-btn--secondary/);
  assert.equal(second.text, '继续学习', 'the next step is still there, as the second button');
  assert.match(second.html, arrowRight, 'its arrow is the icon at the end of the label, not a character');
  assert.ok(at(html, '回到复习全书') < at(html, '继续学习'));
  assert.doesNotMatch(nextBlock(html), /← 回到复习全书/, 'the old second button with an arrow character is gone');
  assert.doesNotMatch(html, /review-return/, 'the header does not say the same thing twice: the main button below is the way back');
  assert.doesNotMatch(html, /返回学习库/);
});

test('the book\'s way back and a second button that also goes back never stand side by side: only a forward step of the round is the second button', () => {
  setUiLanguage('zh');
  // Another place to go back to (the path, with nothing left in the scope): left out, and the 点评 card does not repeat it either.
  const back = result(bookTrail({ coach: { destination: destination('回到学习路径 →', { reason: 'scope-done' }) } }));
  const buttons = buttonsOf(nextBlock(back));
  assert.equal(buttons.length, 1, 'the way back to the book is the only button');
  assert.equal(buttons[0].text, '回到复习全书 回到 1.2.2 Architect the Solution (Asset)');
  assert.doesNotMatch(back, /回到学习路径/, 'neither the second button nor the 点评 card says it');
  assert.doesNotMatch(back, /接着学下一批/, 'and the 点评 headline does not promise a next batch that nothing on the page offers');
  assert.match(back, /这一轮的状态不错。/);
  assert.equal(primaries(back), 1);
  assert.match(back, /result-next result-next--back/);
  // The same for the 总纲.
  assert.doesNotMatch(result(bookTrail({ contextKind: 'outline', contextPlace: '', coach: { destination: destination('回到学习路径 →', { reason: 'original-gone' }) } })), /回到学习路径/);
  // A step on stays, as the second button.
  for (const [label, extra] of [['继续这个范围 →', { kind: 'scope' }], ['下一步：复习 →', { kind: 'plan' }], ['继续学习 →', {}]]) {
    const html = result(bookTrail({ coach: { destination: destination(label, extra) } }));
    const [, second] = buttonsOf(nextBlock(html));
    assert.equal(second.text, label.replace(/\s*→$/, ''));
    assert.match(second.cls, /sh-btn--secondary/);
  }
  const batch = buttonsOf(nextBlock(result(bookTrail({ run: { course: { name: '网络', next: { label: 'x', fresh: 3 }, learned: 1, cards: 5 } } }))));
  assert.equal(batch[1].text, '继续课程下一批');
  // Off the book's trail the same step is the main button, as before.
  const home = result({ contextKind: 'library', contextReturnLabel: '返回学习库首页', onReturnContext: noop, coach: { destination: destination('回到学习路径 →', { reason: 'scope-done' }) } });
  assert.equal(buttonsOf(nextBlock(home))[0].text, '回到学习路径');
  assert.equal(isBackDestination({ kind: 'path', reason: 'scope-done' }), true);
  assert.equal(isBackDestination({ kind: 'path', reason: 'continuing' }), false);
  assert.equal(isBackDestination({ kind: 'scope' }), false);
});

test('the main way back has one arrow style, the Phosphor icon, here and in the reader\'s 回到阅读; the second line is one line with an ellipsis', () => {
  setUiLanguage('zh');
  const html = result(bookTrail({ contextPlace: '2.2 Quality attribute scenarios with a rather long title that cannot fit one line' }));
  assert.match(nextBlock(html), /reading-result__label"[^>]*><svg[^>]*>.*?<\/svg>\s*回到复习全书/s);
  assert.match(nextBlock(html), /reading-result__place/, 'the second line is one line with an ellipsis');
  const reader = result({ run: { reading: { sourceId: 's1', sectionTitle: 'Hash indexes', scope: { kind: 'chapter', count: 4 }, before: { percent: 41, total: 5 }, after: { percent: 58, total: 5 } } }, onReturnToReading: noop });
  assert.match(reader, /reading-result__label"[^>]*><svg[^>]*>.*?<\/svg>\s*回到阅读/s);
  assert.doesNotMatch(reader, /回到阅读 →/, 'no text arrow beside the icon');
});

test('book -> reader -> practise -> result: a round of the reader goes back to the reader, and the page has exactly one filled button (回到阅读), with or without a book behind it', () => {
  setUiLanguage('zh');
  const reading = { sourceId: 's1', sectionTitle: 'Hash indexes', scope: { kind: 'chapter', count: 4 }, before: { percent: 41, total: 5 }, after: { percent: 58, total: 5 } };
  // The reader is open over the book (a footnote, a 出处): a trail entry captured then leads back to the reader, so it is not the book's way back.
  const overBook = captureContext({ root: 'r', page: 'book', modal: { type: 'source', source: { id: 's1' }, quote: 'q' } });
  const onBook = captureContext({ root: 'r', page: 'book', modal: null });
  assert.equal(trailKindOf(overBook), '');
  assert.equal(trailKindOf(onBook), 'book');
  assert.equal(wayBackOf({ kind: trailKindOf(overBook), onReturn: noop }), null, 'no 回到复习全书 for a trail that began in the reader');
  assert.equal(wayBackOf({ kind: trailKindOf(onBook), onReturn: noop })?.label, '回到复习全书');
  // A plain reader round (no book anywhere): 回到阅读 is the one filled button; the page's own next step goes on as a plain one and no second way back stands beside it.
  const reader = (extra = {}) => result({ contextKind: trailKindOf(overBook), contextReturnLabel: '返回资料', onReturnContext: noop, run: { reading }, onReturnToReading: noop, ...extra });
  const fromReader = reader();
  assert.equal(primaries(fromReader), 1, 'exactly one filled button on a reader round');
  assert.match(fromReader, /回到阅读/);
  assert.doesNotMatch(fromReader, /回到复习全书/);
  const readerNext = buttonsOf(nextBlock(fromReader));
  assert.equal(readerNext.length, 1, 'the next step alone: the reader\'s way back is the one way back');
  assert.equal(readerNext[0].text, '继续学习');
  assert.match(readerNext[0].cls, /sh-btn--secondary/);
  assert.doesNotMatch(fromReader, /返回资料/, 'the generic return button is not drawn beside the reader\'s way back');
  assert.match(fromReader, /coach-debrief/, 'the 点评 card is still there');
  for (const [label, extra] of [['继续这个范围 →', { kind: 'scope' }], ['继续学习 →', {}]]) {
    const html = reader({ coach: { destination: destination(label, extra) } });
    assert.equal(primaries(html), 1, label);
    assert.equal(buttonsOf(nextBlock(html))[0].text, label.replace(/\s*→$/, ''));
  }
  // A next step that is only another place to go back to is dropped, as with the book's way back.
  const backOnly = reader({ coach: { destination: destination('回到学习路径 →', { reason: 'scope-done' }) } });
  assert.equal(primaries(backOnly), 1);
  assert.doesNotMatch(backOnly, /回到学习路径/);
  // The 点评's own suggestion and the daily recap are plain too: the page still has one filled button.
  const suggesting = reader({ coach: { debrief: debrief('review_weak') } });
  assert.equal(primaries(suggesting), 1);
  assert.match(suggesting, /先补薄弱点 →/);
  // A book round whose learner opened the reader and practised from it: the new round carries the reading, the book's trail is still there; the reader's way back wins.
  const nested = result(bookTrail({ run: { reading }, onReturnToReading: noop }));
  assert.equal(primaries(nested), 1, 'one filled button on the page: the reader\'s');
  assert.match(nested, /回到阅读/);
  const filled = buttonsOf(nested).filter((button) => /sh-btn--primary/.test(button.cls));
  assert.equal(filled.length, 1);
  assert.match(filled[0].text, /^回到阅读/, 'and it is 回到阅读');
  assert.equal(buttonsOf(nested).filter((button) => /回到复习全书/.test(button.text)).length, 0, 'the book\'s way back is not drawn at all here');
  assert.doesNotMatch(nested, /reading-result__place">回到/, 'and it has no second line');
  assert.doesNotMatch(buttonsOf(nextBlock(nested)).map((button) => button.text).join('|'), /←|回到阅读/, 'nothing else goes back beside the reader\'s way back');
  assert.doesNotMatch(nested, /review-return/, 'the header does not add a second way back: 回到阅读 below is the main button');
  // A round started from the book page itself still goes back to the book.
  assert.match(result(bookTrail()), /回到复习全书/);
});

test('during a round started in the book the way back is in the header only, not a second time under the card; the other trails keep theirs', () => {
  setUiLanguage('zh');
  const running = (extra = {}) => result({ run: { complete: false, answered: 1 }, ...bookTrail(extra) });
  const html = running();
  assert.doesNotMatch(html, /review-detour/, 'no pill under the card');
  assert.match(html, /aria-label="回到复习全书"/, 'the header button says it');
  const outline = running({ contextKind: 'outline', contextPlace: '', contextReturnLabel: '回到总纲' });
  assert.doesNotMatch(outline, /review-detour/);
  assert.match(outline, /aria-label="回到总纲"/);
  // Any other trail keeps its quiet pill under the card.
  const other = result({ run: { complete: false, answered: 1 }, contextKind: 'notes', contextReturnLabel: '返回笔记', onReturnContext: noop });
  assert.match(other, /review-detour/);
  // A nested round (a detour from the inbox) keeps its own pill.
  const detour = running({ detour: { runId: 'outer', index: 2, title: '课程' }, onReturnFromDetour: noop, contextReturnLabel: undefined });
  assert.match(detour, /review-detour/);
});

test('a round started in the book without a next step to offer still has its way back; the 点评 card keeps its button, plain', () => {
  setUiLanguage('zh');
  const html = result(bookTrail({ coach: { destination: undefined } }));
  assert.equal(primaries(html), 1);
  assert.match(nextBlock(html), /回到复习全书/);
  assert.match(html, /继续学习 →/, 'the 点评 card still offers the way on');
  assert.match(html, /接着学下一批/, 'so its headline may say so');
  assert.equal(primaries(html), 1, 'and it is not a second filled button');
});

test('a round started on the 总纲 says 回到总纲 (no second line); every other trail keeps its next step as the main button and the header\'s 返回学习库', () => {
  setUiLanguage('zh');
  const outline = result(bookTrail({ contextKind: 'outline', contextPlace: '', contextReturnLabel: '回到总纲' }));
  const [back] = buttonsOf(nextBlock(outline));
  assert.equal(back.text, '回到总纲');
  assert.doesNotMatch(outline, /返回学习库/);
  assert.doesNotMatch(outline, /review-return/);
  for (const kind of ['library', 'notes', 'review', 'sources', '']) {
    const html = result({ contextKind: kind, contextReturnLabel: '返回学习库首页', onReturnContext: noop });
    const [first, second] = buttonsOf(nextBlock(html));
    assert.match(first.cls, /sh-btn--primary/, kind);
    assert.equal(first.text, '继续学习', kind);
    assert.equal(second.text, '返回学习库首页', kind);
    assert.match(second.html, arrowLeft, `${kind}: the way back has the arrow icon before its label, like every other way back`);
    assert.doesNotMatch(second.html, /←/, `${kind}: no arrow character`);
    assert.doesNotMatch(html, /reading-result__return/, kind);
    assert.match(html, /aria-label="返回学习库"/, `${kind}: the header keeps its words`);
  }
  assert.doesNotMatch(result({ contextKind: 'book', contextPlace: 'x' }), /reading-result__return/, 'without a way to go back there is no button for it');
});

test('English: the way back to the book and the 总纲 and its second line are translated', () => {
  setUiLanguage('en');
  try {
    const html = result(bookTrail());
    const text = html.replace(/<[^>]*>/g, ' ');
    assert.match(text, /Back to the review book/);
    assert.match(text, /Back to 1\.2\.2 Architect the Solution \(Asset\)/);
    assert.match(result(bookTrail({ contextKind: 'outline', contextPlace: '' })), /Back to the outline/);
  } finally { setUiLanguage('zh'); }
});

test('a round nested inside a book round (a prerequisite round, a detour from the inbox) keeps its own way on as the one filled button; the book is not offered first', () => {
  setUiLanguage('zh');
  const prerequisite = result({ ...bookTrail(), run: { returnTo: { runId: 'outer', index: 2 } }, coach: { destination: destination('回到原题 →', { kind: 'original' }) } });
  const [first, second] = buttonsOf(nextBlock(prerequisite));
  assert.equal(primaries(prerequisite), 1);
  assert.match(first.cls, /sh-btn--primary/);
  assert.equal(first.text, '回到原题', 'the way on to the unfinished question is the main button');
  assert.doesNotMatch(prerequisite, /reading-result__return/);
  assert.ok(!second || /sh-btn--secondary/.test(second.cls), 'what else is there stays plain (the trail\'s own return, as before)');
  assert.match(prerequisite, /aria-label="返回学习库"/, 'and the header keeps its words');
  const detour = result({ ...bookTrail(), detour: { runId: 'outer', index: 2, title: '课程' }, onReturnFromDetour: noop });
  const [back] = buttonsOf(nextBlock(detour));
  assert.match(back.cls, /sh-btn--primary/);
  assert.equal(back.text, '回到之前的第 3 题');
  assert.doesNotMatch(detour, /reading-result__return/);
  assert.equal(primaries(detour), 1);
});

/* The autopilot countdown does not take the learner past a way back (the book's or the reader's) either: tests/review-autopilot-way-back.test.mjs runs the real page in Chromium. */
