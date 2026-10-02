import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JEV_FEATURES } from '../lib/jev-settings.js';
import { createJevRuntime } from '../lib/jev-runtime.js';
import { calibration, evaluate, formatReport, scoreBinary, scoreChoice, skeletonFromLibrary, validateDataset } from '../lib/jev-eval.js';
import { Store } from '../lib/store.js';
import { oracleAnswer } from './helpers/jev-oracle.mjs';
import { FAKE_KEY, startFakeJev } from './helpers/fake-jev.mjs';

/* The evaluation harness: metric maths with known answers, the whole pipeline against an oracle and a deliberately wrong provider, and the
   script, which does nothing without a key. The numbers here come from a fake: nothing in this file says anything about real Jev. */

const dataset = JSON.parse(await readFile(new URL('./fixtures/jev-eval/dataset.json', import.meta.url), 'utf8'));
const script = fileURLToPath(new URL('../scripts/eval-jev.mjs', import.meta.url));
const OPEN = async () => ({ key: 'k'.repeat(20), keySource: 'file', enabled: true, features: Object.fromEntries(JEV_FEATURES.map(name => [name, true])), threshold: 0.8, confirmedAt: 'now' });
const close = (a, b, tolerance = 1e-3) => assert.ok(Math.abs(a - b) < tolerance, `${a} is not ${b}`);

function runtimeFor(answer) {
  const used = { calls: 0 };
  return createJevRuntime({ settings: OPEN, usage: { record: async ({ feature, usage }) => { used.calls++; used[feature] = used[feature] || { inputTokens: 0, outputTokens: 0 }; used[feature].inputTokens += usage.inputTokens; used[feature].outputTokens += usage.outputTokens; } },
    provider: () => ({ id: 'oracle', async decide(state, questions) {
      return { model: 'oracle', answers: Object.fromEntries(Object.entries(questions).map(([name, question]) => [name, answer(name, question, state)])), usage: { inputTokens: JSON.stringify(state).length, outputTokens: 5 * Object.keys(questions).length } };
    }, check: async () => ({ ok: true }) }) });
}

test('calibration: expected calibration error over ten equal-width bins, with the table behind it', () => {
  const result = calibration([{ confidence: 0.9, correct: true }, { confidence: 0.9, correct: true }, { confidence: 0.9, correct: false }, { confidence: 0.6, correct: true }]);
  close(result.ece, 0.275);
  const top = result.bins.find(bin => bin.n === 3);
  assert.equal(top.from, 0.9);
  close(top.accuracy, 2 / 3); close(top.confidence, 0.9);
  assert.equal(calibration([]).ece, 0);
  close(calibration([{ confidence: 1, correct: true }, { confidence: 0.5, correct: true }]).ece, 0.25, 1e-9);
});

test('scoreChoice: accuracy, precision, recall and F1 per class, macro F1, and ECE from the top probability', () => {
  const rows = [{ truth: 'a', predicted: 'a', probability: 0.9 }, { truth: 'a', predicted: 'b', probability: 0.8 }, { truth: 'b', predicted: 'b', probability: 0.7 }, { truth: 'b', predicted: 'b', probability: 0.95 }, { truth: 'c', predicted: 'a', probability: 0.6 }];
  const score = scoreChoice(rows, { classes: ['a', 'b', 'c'] });
  assert.equal(score.n, 5);
  close(score.accuracy, 3 / 5);
  close(score.perClass.a.precision, 1 / 2); close(score.perClass.a.recall, 1 / 2);
  close(score.perClass.b.precision, 2 / 3); close(score.perClass.b.recall, 1);
  assert.equal(score.perClass.c.recall, 0);
  assert.equal(score.perClass.c.support, 1);
  close(score.perClass.b.f1, 2 * (2 / 3) * 1 / (2 / 3 + 1));
  close(score.macroF1, (score.perClass.a.f1 + score.perClass.b.f1 + 0) / 3);
  assert.ok(score.ece >= 0 && score.ece <= 1);
  assert.equal(scoreChoice([], { classes: ['a'] }).accuracy, null, 'no rows, no number');
});

test('scoreBinary: precision and recall of the defect class at the product threshold, accuracy at 0.5, ECE from the confidence of the predicted side', () => {
  const rows = [{ truth: true, p: 0.9 }, { truth: true, p: 0.7 }, { truth: false, p: 0.8 }, { truth: false, p: 0.2 }, { truth: true, p: 0.4 }];
  const score = scoreBinary(rows, { threshold: 0.8 });
  assert.equal(score.n, 5); assert.equal(score.positives, 3);
  close(score.accuracy, 3 / 5);
  assert.deepEqual([score.atThreshold.threshold, score.atThreshold.flagged], [0.8, 2]);
  close(score.atThreshold.precision, 1 / 2); close(score.atThreshold.recall, 1 / 3);
  close(score.atThreshold.f1, 0.4);
  const none = scoreBinary([{ truth: false, p: 0.1 }], { threshold: 0.8 });
  assert.equal(none.atThreshold.precision, null, 'nothing flagged: precision is undefined, not 0');
  assert.equal(none.atThreshold.recall, null, 'no positives: recall is undefined');
});

test('the public fixture is a valid dataset covering all four experiments, with neutral content', () => {
  assert.doesNotThrow(() => validateDataset(dataset));
  assert.deepEqual(Object.keys(dataset.features).sort(), [...JEV_FEATURES].sort());
  assert.ok(dataset.features.courseSuggest.items.some(item => item.course === null), 'it includes sources that belong nowhere');
  assert.ok(dataset.features.courseSuggest.items.some(item => item.lang === 'zh'), 'and some Chinese');
  const text = JSON.stringify(dataset);
  assert.ok(!/@|https?:\/\/|\\Users\\|password/i.test(text.replace(/api\.typesafe\.ai/g, '')), 'no addresses, paths or credentials');
});

test('validateDataset says what is wrong, in plain words', () => {
  assert.throws(() => validateDataset(null), /dataset/i);
  assert.throws(() => validateDataset({ version: 1, features: {} }), /feature/i);
  assert.throws(() => validateDataset({ version: 1, features: { courseSuggest: { courses: [], items: [] } } }), /courses/i);
  assert.throws(() => validateDataset({ version: 1, features: { levelCheck: { items: [{ id: 'x', card: { prompt: 'p' }, level: 'expert' }] } } }), /level/i);
  assert.throws(() => validateDataset({ version: 1, features: { outlineNoise: { items: [{ id: 'x', title: 't', label: 'nonsense' }] } } }), /label/i);
  assert.throws(() => validateDataset({ version: 1, features: { levelCheck: { items: [{ id: 'x', card: { prompt: 'p' }, level: 'recall' }, { id: 'x', card: { prompt: 'q' }, level: 'recall' }] } } }), /duplicate/i);
  assert.throws(() => validateDataset({ version: 1, features: { surprise: { items: [] } } }), /unknown feature/i);
});

test('an oracle scores perfectly on every experiment, and the report lists tokens and calls per feature', async () => {
  const report = await evaluate({ dataset, runtime: runtimeFor(oracleAnswer(dataset)), threshold: 0.8 });
  assert.deepEqual(Object.keys(report.features).sort(), [...JEV_FEATURES].sort());
  const f = report.features;
  assert.equal(f.courseSuggest.accuracy, 1);
  assert.equal(f.courseSuggest.filled.precision, 1);
  close(f.courseSuggest.filled.coverage, 11 / 13, 1e-3); // two of the thirteen sources belong nowhere, so nothing is filled for them
  assert.equal(f.levelCheck.accuracy, 1);
  assert.equal(f.levelCheck.heuristic.n, 15);
  assert.ok(f.levelCheck.heuristic.accuracy < 1, 'the keyword heuristic is not perfect on the fixture, which is the point of comparing');
  assert.equal(f.outlineNoise.accuracy, 1);
  assert.equal(f.outlineNoise.noise.precision, 1); assert.equal(f.outlineNoise.noise.recall, 1);
  for (const check of Object.keys(f.preReview.checks)) { assert.equal(f.preReview.checks[check].accuracy, 1, check); }
  assert.deepEqual(Object.keys(f.preReview.checks).sort(), ['answerInEvidence', 'needsSource', 'oneDefensible', 'stemLeaksAnswer']);
  assert.equal(f.preReview.checks.oneDefensible.n, 3, 'only quiz cards are asked the options question');
  for (const name of JEV_FEATURES) { assert.ok(f[name].cost.calls > 0, name); assert.ok(f[name].cost.inputTokens > 0); assert.ok(f[name].cost.perItem.inputTokens > 0); }
  assert.equal(report.failed, 0);
  const text = formatReport(report);
  for (const name of JEV_FEATURES) assert.match(text, new RegExp(name));
  assert.match(text, /tokens/i);
  assert.ok(!/\$|¥|price|cost of|USD/i.test(text.replace(/cost table/gi, '')), 'tokens only, never money');
  assert.match(text, /ECE/);
});

test('a provider that is wrong on some items scores lower, and the breakdown by language shows where', async () => {
  const wrongOnChinese = (kind, id) => kind === 'levelCheck' || dataset.features[kind].items.find(item => item.id === id)?.lang === 'zh';
  const report = await evaluate({ dataset, runtime: runtimeFor(oracleAnswer(dataset, { mistakes: wrongOnChinese })), threshold: 0.8, features: ['courseSuggest', 'levelCheck'] });
  assert.deepEqual(Object.keys(report.features).sort(), ['courseSuggest', 'levelCheck']);
  assert.ok(report.features.courseSuggest.accuracy < 1);
  assert.equal(report.features.courseSuggest.byLang.en.accuracy, 1);
  assert.equal(report.features.courseSuggest.byLang.zh.accuracy, 0);
  assert.ok(report.features.levelCheck.ece > 0.3, 'confidently wrong shows up as poor calibration');
});

test('a Jev that fails is reported as failed items, not as a crash and not as wrong answers', async () => {
  const runtime = createJevRuntime({ settings: OPEN, usage: { record: async () => {} }, provider: () => ({ id: 'down', decide: async () => { throw Object.assign(new Error('x'), { name: 'JevError', code: 'network' }); }, check: async () => ({}) }) });
  const report = await evaluate({ dataset, runtime, threshold: 0.8, features: ['levelCheck'] });
  assert.equal(report.features.levelCheck.n, 0);
  assert.equal(report.failed, 15);
  assert.equal(report.features.levelCheck.accuracy, null);
});

test('a skeleton for the owner’s own library copy: sources with their current course, questions with blank labels to fill in', async t => {
  const root = await mkdtemp(join(tmpdir(), 'jev-eval-skeleton-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root);
  await store.update(state => {
    state.sources.push({ id: 's1', title: 'Lecture 1', text: 'Transactions isolate concurrent changes. '.repeat(10), courses: ['Databases'] }, { id: 's2', title: 'Unfiled', text: 'x'.repeat(40), courses: [] });
    state.decks.push({ id: 'd', title: 'Deck', course: 'Databases', cards: [{ id: 'c1', kind: 'flashcard', topic: 'T', objective: 'O', prompt: 'What is a transaction?', answer: 'A unit of work.', hint: 'h', explanation: 'e', misconception: 'm', citations: [{ sourceId: 's1', quote: 'Transactions isolate concurrent changes.' }] }] });
  });
  const skeleton = skeletonFromLibrary(await store.read());
  assert.equal(skeleton.version, 1);
  assert.deepEqual(skeleton.features.courseSuggest.courses.map(course => course.name), ['Databases']);
  const [item] = skeleton.features.courseSuggest.items;
  assert.equal(item.course, 'Databases');
  assert.ok(item.text.length <= 1000);
  assert.equal(skeleton.features.courseSuggest.items.length, 1, 'an unfiled source has no label to check against');
  assert.equal(skeleton.features.levelCheck.items[0].level, '', 'a level you have to fill in');
  assert.deepEqual(skeleton.features.preReview.items[0].labels, { stemLeaksAnswer: null, needsSource: null, answerInEvidence: null });
  assert.match(skeleton.description, /fill in/i);
  assert.doesNotThrow(() => validateDataset(skeleton, { allowBlank: true }));
  assert.throws(() => validateDataset(skeleton), /blank|fill/i);
});

/* ---- the script ---------------------------------------------------------------------------------------------------------------- */

function run(args, env) {
  return new Promise(resolve => {
    const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/JEV|API_KEY|BASE_URL/.test(key)));
    const child = spawn(process.execPath, [script, ...args], { env: { ...clean, ...env } });
    let out = ''; child.stdout.on('data', part => { out += part; }); child.stderr.on('data', part => { out += part; });
    child.on('close', code => resolve({ code, out }));
  });
}
const fixture = fileURLToPath(new URL('./fixtures/jev-eval/dataset.json', import.meta.url));

test('without JEV_API_KEY the script does nothing and says so', async () => {
  const result = await run([fixture], {});
  assert.equal(result.code, 0);
  assert.match(result.out, /JEV_API_KEY is not set: nothing was done/);
  const bare = await run([], {});
  assert.equal(bare.code, 0, 'the key check comes first, so even a missing path sends nothing');
});

test('with a key it evaluates the dataset against the (fake) service, prints the tables and never the key', async t => {
  const fake = await startFakeJev({ answer: oracleAnswer(dataset) });
  const dir = await mkdtemp(join(tmpdir(), 'jev-eval-out-'));
  t.after(async () => { await fake.close(); await rm(dir, { recursive: true, force: true }); });
  const out = join(dir, 'report.json');
  const result = await run([fixture, '--out', out], { JEV_API_KEY: FAKE_KEY, JEV_BASE_URL: fake.baseUrl });
  assert.equal(result.code, 0, result.out);
  for (const name of JEV_FEATURES) assert.match(result.out, new RegExp(name));
  assert.match(result.out, /accuracy/i);
  assert.match(result.out, /ECE/);
  assert.match(result.out, /tokens/i);
  assert.ok(!result.out.includes(FAKE_KEY));
  assert.ok(fake.requests.length > 40, 'it really asked');
  const saved = JSON.parse(await readFile(out, 'utf8'));
  assert.equal(saved.features.courseSuggest.accuracy, 1);
  assert.ok(!JSON.stringify(saved).includes(FAKE_KEY));
});

test('--features narrows the run; a dataset outside the public fixtures needs --yes because its text is sent to Jev', async t => {
  const fake = await startFakeJev({ answer: oracleAnswer(dataset) });
  const dir = await mkdtemp(join(tmpdir(), 'jev-eval-own-'));
  t.after(async () => { await fake.close(); await rm(dir, { recursive: true, force: true }); });
  const only = await run([fixture, '--features', 'levelCheck'], { JEV_API_KEY: FAKE_KEY, JEV_BASE_URL: fake.baseUrl });
  assert.equal(only.code, 0, only.out);
  assert.match(only.out, /levelCheck/);
  assert.doesNotMatch(only.out, /courseSuggest/);
  const own = join(dir, 'mine.json');
  await writeFile(own, JSON.stringify(dataset));
  fake.requests.length = 0;
  const refused = await run([own], { JEV_API_KEY: FAKE_KEY, JEV_BASE_URL: fake.baseUrl });
  assert.equal(refused.code, 2);
  assert.match(refused.out, /--yes/);
  assert.match(refused.out, /sent to/i);
  assert.equal(fake.requests.length, 0, 'nothing was sent before the confirmation');
  const allowed = await run([own, '--yes', '--features', 'outlineNoise'], { JEV_API_KEY: FAKE_KEY, JEV_BASE_URL: fake.baseUrl });
  assert.equal(allowed.code, 0, allowed.out);
  assert.ok(fake.requests.length > 0);
  const broken = join(dir, 'broken.json');
  await writeFile(broken, '{ nope');
  const bad = await run([broken, '--yes'], { JEV_API_KEY: FAKE_KEY, JEV_BASE_URL: fake.baseUrl });
  assert.equal(bad.code, 2);
  assert.match(bad.out, /not valid JSON|JSON/);
});
