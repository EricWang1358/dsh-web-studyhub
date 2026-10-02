import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluate, formatReport, validateDataset } from '../lib/jev-eval.js';
import { createJevRuntime } from '../lib/jev-runtime.js';
import { JEV_REPLACE_SITES } from '../lib/jev-sites.js';
import { NONE_KEY } from '../lib/jev-course-suggest.js';
import { FAKE_KEY, startFakeJev, defaultAnswer } from './helpers/fake-jev.mjs';

/* The evaluation harness for the replaceable sites: Jev against the labelled truth AND against what the current model path answered, per site:
   how much Jev settles at the learner's line, how right it is when it settles, what the hybrid the product really runs (Jev where it is sure,
   the model for the rest) scores against the model alone, the agreement, and the latency and tokens. Nothing here claims real Jev is any good. */

const script = fileURLToPath(new URL('../scripts/eval-jev.mjs', import.meta.url));
const card = (id, marker, extra = {}) => ({ id, kind: 'flashcard', prompt: `Question ${id} ${marker}`, answer: 'An answer.', hint: 'A hint.', explanation: 'An explanation that teaches.', citations: [{ sourceId: 's', quote: 'A quoted passage of the source.' }], ...extra });
// Jev answers: "[ok]" cards pass every check, "[bad]" fail answerLeak, "[mid]" are middling.
const answer = (name, question, state) => {
  if (question.type === 'choice') {
    const probabilities = state.title === 'Locks' ? { Databases: 0.9, OS: 0.05, [NONE_KEY]: 0.05 } : state.title === 'Paging' ? { Databases: 0.1, OS: 0.85, [NONE_KEY]: 0.05 } : { Databases: 0.45, OS: 0.45, [NONE_KEY]: 0.1 };
    const keys = Object.keys(question.criteria), full = Object.fromEntries(keys.map(key => [key, probabilities[key] ?? 0]));
    const top = Object.entries(full).sort((a, b) => b[1] - a[1])[0];
    return { type: 'choice', choice: top[0], confidence: 0.5, probabilities: full };
  }
  const text = JSON.stringify(state);
  if (question.type === 'noul') return { type: 'noul', noul: text.includes('[bad]') && name === 'answerLeak' ? 0.03 : text.includes('[mid]') && name === 'sourceSupport' ? 0.5 : 0.95 };
  return defaultAnswer(question);
};

const DATASET = { version: 1, features: {
  cardReview: { items: [
    { id: 'r1', card: card('r1', '[ok]'), verdict: 'accept', model: 'accept' },
    { id: 'r2', card: card('r2', '[ok]'), verdict: 'reject', model: 'reject' },          // Jev wrongly accepts it
    { id: 'r3', card: card('r3', '[bad]'), verdict: 'reject', model: 'accept' },         // Jev right, the model wrong
    { id: 'r4', card: card('r4', '[mid]'), verdict: 'accept', model: 'accept' },         // unsure: falls back to the model
    { id: 'r5', card: card('r5', '[ok]', { kind: 'multi', options: [{ id: 'a', text: 'x', correct: true }, { id: 'b', text: 'y', correct: true }] }), verdict: 'accept', model: 'reject' }, // unsupported: model
  ] },
  courseOrganize: { courses: [{ name: 'Databases', titles: ['Intro to SQL'] }, { name: 'OS', titles: ['Scheduling'] }], items: [
    { id: 'o1', title: 'Locks', text: 'Transactions and locks.', course: 'Databases', model: 'Databases' },
    { id: 'o2', title: 'Paging', text: 'Page replacement.', course: 'OS', model: 'Databases' },
    { id: 'o3', title: 'Week 9', text: 'Mixed notes.', course: 'OS', model: 'OS' },
  ] },
} };

async function harness(t, options = {}) {
  const home = await mkdtemp(join(tmpdir(), 'jev-eval-replace-'));
  const before = Object.fromEntries(['DSH_HOME', 'JEV_API_KEY', 'JEV_BASE_URL'].map(name => [name, process.env[name]]));
  process.env.DSH_HOME = home; delete process.env.JEV_API_KEY; delete process.env.JEV_BASE_URL;
  const fake = await startFakeJev({ answer, ...options });
  const runtime = createJevRuntime({ baseUrl: fake.baseUrl, sleep: async () => {}, random: () => 0, usage: { record: async () => {} },
    settings: async () => ({ provider: 'typesafe', key: fake.key, keySource: 'env', enabled: true, features: {}, replace: Object.fromEntries(JEV_REPLACE_SITES.map(site => [site, true])), threshold: 0.8, confirmedAt: 'eval' }) });
  t.after(async () => { await fake.close(); for (const [name, value] of Object.entries(before)) if (value === undefined) delete process.env[name]; else process.env[name] = value; await rm(home, { recursive: true, force: true }); });
  return { fake, runtime, home };
}

test('the dataset accepts the replaceable sites and names what is wrong with a malformed one', () => {
  assert.doesNotThrow(() => validateDataset(DATASET));
  const bad = patch => () => validateDataset(structuredClone({ version: 1, features: patch }));
  assert.throws(bad({ cardReview: { items: [{ id: 'x', card: card('x', ''), verdict: 'maybe' }] } }), /cardReview item x: verdict must be accept or reject/);
  assert.throws(bad({ cardReview: { items: [{ id: 'x', card: card('x', ''), verdict: 'accept', model: 'maybe' }] } }), /cardReview item x: model must be accept or reject/);
  assert.throws(bad({ cardReview: { items: [{ id: 'x', verdict: 'accept' }] } }), /cardReview item x needs a card/);
  assert.throws(bad({ courseOrganize: { items: [{ id: 'x', title: 't', text: 't', course: 'Nope' }] } }), /courseOrganize needs a non-empty list of courses|course must be null or one of the listed courses/);
  assert.throws(bad({ courseOrganize: { courses: [{ name: 'A' }], items: [{ id: 'x', title: 't', text: 't', course: 'A', model: 5 }] } }), /courseOrganize item x: model must be a course name, null or a proposed name/);
});

test('card review: coverage at the line, accuracy when Jev settles, and the hybrid against the model alone, worked out by hand', async t => {
  const h = await harness(t);
  const report = await evaluate({ dataset: DATASET, runtime: h.runtime, threshold: 0.8, features: ['cardReview'] });
  const entry = report.features.cardReview;
  // r1 accept (right), r2 accept (WRONG: truth reject), r3 reject (right), r4 unsure, r5 unsupported.
  assert.deepEqual([entry.items, entry.settled, entry.coverage, entry.unsure, entry.unsupported], [5, 3, 0.6, 1, 1]);
  assert.equal(entry.accuracySettled, 0.6667);
  assert.deepEqual(entry.confusion, { accept: { accept: 1, reject: 0 }, reject: { accept: 1, reject: 1 } }, 'truth -> Jev: a wrongly accepted card is counted apart');
  assert.equal(entry.falseAccepts, 1);
  // The model alone: r1 ok, r2 ok, r3 WRONG, r4 ok, r5 WRONG -> 3/5.
  assert.equal(entry.model.accuracy, 0.6);
  // The hybrid the product runs: Jev on r1 r2 r3 (right, wrong, right), the model on r4 r5 (ok, wrong) -> 3/5.
  assert.equal(entry.hybrid.accuracy, 0.6);
  assert.equal(entry.hybrid.delta, 0, 'the hybrid minus the model alone');
  assert.equal(entry.agreement, 0.3333, 'on the 3 cards Jev settled the model agreed on r1 and r2 only? r1 yes, r2 Jev accept vs model reject, r3 Jev reject vs model accept');
  assert.ok(entry.latencyMs.mean >= 0 && entry.latencyMs.n === 4, 'one timed Jev call per card Jev could judge');
  assert.ok(entry.cost.calls === 4 && entry.cost.inputTokens > 0);
  assert.equal(h.fake.requests.length, 4, 'the unsupported multi-answer card is never sent');
});

test('course organize: Jev picks at the line, the model for the rest', async t => {
  const h = await harness(t);
  const report = await evaluate({ dataset: DATASET, runtime: h.runtime, threshold: 0.8, features: ['courseOrganize'] });
  const entry = report.features.courseOrganize;
  // o1 Databases (right), o2 OS (right, the model said Databases), o3 unsure -> the model (right).
  assert.deepEqual([entry.items, entry.settled, entry.coverage], [3, 2, 0.6667]);
  assert.equal(entry.accuracySettled, 1);
  assert.equal(entry.model.accuracy, 0.6667);
  assert.equal(entry.hybrid.accuracy, 1);
  assert.equal(entry.hybrid.delta, 0.3333);
  assert.equal(entry.agreement, 0.5, 'Jev and the model agreed on o1 and disagreed on o2');
});

test('without model answers the comparison says what it can: Jev against the truth, no delta', async t => {
  const h = await harness(t);
  const stripped = structuredClone(DATASET);
  for (const section of Object.values(stripped.features)) for (const item of section.items) delete item.model;
  const report = await evaluate({ dataset: stripped, runtime: h.runtime, threshold: 0.8 });
  for (const name of ['cardReview', 'courseOrganize']) {
    assert.equal(report.features[name].model, null, name);
    assert.equal(report.features[name].hybrid, null);
    assert.equal(report.features[name].agreement, null);
    assert.ok(report.features[name].accuracySettled !== null);
  }
});

test('the report is plain text: the line, per-site coverage, accuracy, hybrid delta, agreement, latency and tokens (never money), and it says what is unproven', async t => {
  const h = await harness(t);
  const text = formatReport(await evaluate({ dataset: DATASET, runtime: h.runtime, threshold: 0.8, features: ['cardReview', 'courseOrganize'] }));
  assert.match(text, /cardReview: 5 items/);
  assert.match(text, /replace with Jev at the line: Jev settled 3 of 5 \(60\.0%\)/);
  assert.match(text, /accuracy when Jev settled 66\.7%/);
  assert.match(text, /current model path alone 60\.0%/);
  assert.match(text, /hybrid \(Jev where sure, the model for the rest\) 60\.0%, 0\.0 points vs the model alone/);
  assert.match(text, /false accepts 1/);
  assert.match(text, /agreement with the model/);
  assert.match(text, /Jev latency per call/);
  assert.match(text, /courseOrganize: 3 items/);
  assert.match(text, /\+33\.3 points vs the model alone/);
  assert.match(text, /Tokens used/);
  assert.doesNotMatch(text, /\$|¥|price|cost of/i);
  assert.match(text, /A small dataset proves little/i);
});

function run(args, env) {
  return new Promise(resolve => {
    const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/JEV|API_KEY|BASE_URL|OPENCODE/.test(key)));
    const child = spawn(process.execPath, [script, ...args], { env: { ...clean, ...env } });
    let out = ''; child.stdout.on('data', part => { out += part; }); child.stderr.on('data', part => { out += part; });
    child.on('close', code => resolve({ code, out }));
  });
}

test('the script runs the comparison for a dataset of your own (needs --yes), over any provider, and never prints the key', async t => {
  const h = await harness(t);
  const dir = await mkdtemp(join(tmpdir(), 'jev-eval-replace-file-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'mine.json'), out = join(dir, 'report.json');
  await writeFile(file, JSON.stringify(DATASET));
  const refused = await run([file, '--features', 'cardReview'], { JEV_API_KEY: FAKE_KEY, JEV_BASE_URL: h.fake.baseUrl });
  assert.equal(refused.code, 2);
  assert.match(refused.out, /--yes/);
  const result = await run([file, '--features', 'cardReview,courseOrganize', '--yes', '--out', out, '--threshold', '0.8'], { JEV_API_KEY: FAKE_KEY, JEV_BASE_URL: h.fake.baseUrl });
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /cardReview: 5 items/);
  assert.match(result.out, /Experimental/);
  assert.ok(!result.out.includes(FAKE_KEY));
  const saved = JSON.parse(await readFile(out, 'utf8'));
  assert.equal(saved.features.cardReview.settled, 3);
  const zen = await run([file, '--features', 'courseOrganize', '--yes', '--provider', 'opencode-zen-free'], { OPENCODE_GO_API_KEY_2: FAKE_KEY, JEV_BASE_URL: h.fake.baseUrl });
  assert.equal(zen.code, 0, zen.out);
  assert.equal(h.fake.requests.at(-1).path, '/zen/v1/systemone');
  assert.equal(h.fake.requests.at(-1).payload.model, 'jev-1.13-free');
});
