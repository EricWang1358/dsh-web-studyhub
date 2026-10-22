/* The result page of every practice round says how the mastery of its questions moved: one line 「这组题掌握度 a% → b%」 between the subtitle and
   the score, from the run itself (lib/run-mastery.js), so it is in the page's first draw. A reader round keeps its own card (「这几页的掌握度」 with
   回到阅读) and says it once; a run stored before 3.6 shows no line. Both lines are the same component with the same rounding. */
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

const compiled = await build({ stdin: { contents: `export { default } from './ui/Review.jsx'; export { StudyServicesContext } from './ui/study-context.jsx'; export { setUiLanguage } from './ui/i18n.js';
  export { masteryChangeText } from './ui/document-preview/practice/ReadingReturn.jsx';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react'], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const { default: Review, StudyServicesContext, setUiLanguage, masteryChangeText } = module.exports;
const han = /[㐀-鿿]/;
const noop = () => {};
const card = { id: 'q', kind: 'quiz', topic: 'Context', prompt: 'Who?', options: [] };
const summary = (percent, total = 4) => ({ percent, total, state: percent >= 75 ? 'familiar' : 'learning', due: 0, weak: 0, fresh: 0 });
const rose = { before: summary(40), after: summary(58) };
const reading = { documentId: 'doc', sourceId: 'doc-p1', page: 3, sectionTitle: 'Hash indexes', scope: { kind: 'here', count: 1, label: 'p.3' }, origin: { page: 'sources' },
  before: summary(41), after: summary(58) };
function result({ run = {}, ...rest } = {}) {
  return renderToStaticMarkup(reviewElement(Review, StudyServicesContext, {
    run: { id: 'r', mode: 'path', complete: true, index: 4, total: 4, questions: 4, answered: 4, correct: 3, selfAnswered: 0, weakTopics: [], weakScopes: {}, scope: [], card, ...run },
    data: { sources: [] }, host: {}, choice: true, selected: [], shellTitle: 'Consistency', busy: false, act: noop, enterRun: noop, setPage: noop, askInChat: noop, ...rest,
  }));
}
const at = (html, marker) => html.indexOf(marker);
const lines = html => (html.match(/data-testid="mastery-change"/g) || []).length;
const text = html => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test('a deck round: one line 这组题掌握度 a% → b% between the subtitle and the score, in the first draw', () => {
  setUiLanguage('zh');
  const html = result({ run: { mastery: rose } });
  assert.equal(lines(html), 1);
  assert.match(text(html), /这组题掌握度 40% → 58%/);
  const line = at(html, 'data-testid="mastery-change"');
  assert.ok(line > at(html, 'class="result-subtitle"') && line < at(html, 'class="result-hero'), 'under the subtitle, above the score');
  assert.match(html, /class="reading-result__change result-mastery"/);
  assert.match(html, /class="mastery-mark[^"]*" data-state="learning"/, 'the mark of those questions now, as on the reader\'s line');
  const buttons = value => (value.match(/<button/g) || []).length;
  assert.equal(buttons(html), buttons(result()), 'no button is added');
  assert.doesNotMatch(html, /这几页/);
});

test('no change is said plainly; a round with no measurable question, or a run stored before 3.6, shows no line', () => {
  setUiLanguage('zh');
  assert.match(text(result({ run: { mastery: { before: summary(50), after: summary(50) } } })), /这组题掌握度 50%（这一轮没有变化）/);
  assert.equal(lines(result({ run: { mastery: { before: summary(null, 0), after: summary(null, 0) } } })), 0);
  const old = result();
  assert.equal(lines(old), 0, 'an old run without the value');
  assert.doesNotMatch(old, /掌握度 /);
});

test('a reader round keeps its own words and card, and says the change once', () => {
  setUiLanguage('zh');
  const html = result({ run: { reading, mastery: { before: reading.before, after: reading.after } }, onReturnToReading: noop });
  assert.equal(lines(html), 1);
  assert.match(text(html), /这几页的掌握度 41% → 58%/);
  assert.doesNotMatch(html, /这组题掌握度/);
  assert.ok(at(html, 'class="reading-result"') > 0 && at(html, 'data-testid="mastery-change"') > at(html, 'class="reading-result"'), 'inside the reader\'s card');
  // Shown where the page has no way back to the reader (no onReturnToReading), the round still says its change, in the round's words.
  const elsewhere = result({ run: { reading, mastery: { before: reading.before, after: reading.after } } });
  assert.equal(lines(elsewhere), 1);
  assert.match(text(elsewhere), /这组题掌握度 41% → 58%/);
});

test('English: the line is translated', () => {
  try {
    setUiLanguage('en');
    const html = result({ run: { mastery: rose } });
    const line = html.slice(at(html, 'data-testid="mastery-change"'), at(html, 'class="result-hero'));
    assert.match(text(line), /Mastery of these questions 40% → 58%/);
    assert.doesNotMatch(line.replace(/<[^>]+>/g, ''), han);
    assert.match(text(result({ run: { mastery: { before: summary(50), after: summary(50) } } })), /Mastery of these questions 50% \(no change this round\)/);
  } finally { setUiLanguage('zh'); }
});

test('the same rounding as the reader: both words carry the stored percentages untouched', () => {
  setUiLanguage('zh');
  for (const [before, after] of [[0, 100], [33, 67], [87, 88], [15, 15]]) {
    const change = { before: summary(before), after: summary(after) };
    const numbers = value => value.match(/\d+%/g);
    assert.deepEqual(numbers(masteryChangeText(change, 'round')), numbers(masteryChangeText(change, 'pages')));
    assert.deepEqual(numbers(masteryChangeText(change, 'round')), before === after ? [`${after}%`] : [`${before}%`, `${after}%`]);
  }
  assert.equal(masteryChangeText(rose), '这几页的掌握度 40% → 58%', 'the reader\'s words stay the default');
});

test('a real round: the finished projection draws the line with its own numbers', async (t) => {
  setUiLanguage('zh');
  const root = await mkdtemp(join(tmpdir(), 'round-mastery-ui-'));
  const service = new StudyService(root);
  t.after(async () => { await service.dispose(); await rm(root, { recursive: true, force: true }); });
  await service.store.update(s => {
    s.decks.push({ id: 'd', title: 'Consistency', folder: '', cards: ['a', 'b', 'c'].map(id => ({ id, kind: 'flashcard', topic: 'CAP', objective: id, prompt: `${id}?`, answer: 'A', explanation: '', citations: [] })) });
  });
  let run = await service.call('review.start', { mode: 'path', scope: [{ deckId: 'd' }], fresh: true });
  while (!run.complete) {
    const ref = { runId: run.id, cardId: run.card.id, queueVersion: run.queueVersion };
    await service.call('review.reveal', ref);
    run = await service.call('review.answer', { ...ref, grade: 4 });
    if (!run.complete) run = await service.call('review.move', { runId: run.id, direction: 1 });
  }
  assert.equal(run.mastery.before.percent, 0, 'three new questions');
  assert.ok(run.mastery.after.percent > 0);
  assert.match(text(result({ run })), new RegExp(`这组题掌握度 0% → ${run.mastery.after.percent}%`));
});
