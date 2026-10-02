import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { saveJevSettings } from '../lib/jev-settings.js';
import { createJevRuntime } from '../lib/jev-runtime.js';
import { createJevUsage } from '../lib/jev-usage.js';
import { OUTLINE_LABELS, buildOutlineRequest, classifyOutline, readOutlineAnswer } from '../lib/jev-outline.js';
import { applyOutlineLabels } from '../ui/jev-outline.js';
import { startFakeJev } from './helpers/fake-jev.mjs';

/* 目录噪声判断: is a heading a chapter title, a section label ("English original" / "Chinese version"), a running header or footer,
   or something else? A pure server-side classifier plus a pure function the reader can call to demote or drop entries. The reader
   itself is not touched (it belongs to another work package): the hook is documented in docs/jev-experimental.md. */

const entries = Array.from({ length: 20 }, (_, index) => ({ id: `h-${index}`, level: 1, title: index % 5 === 0 ? 'English original' : `Chapter ${index}: Topic` }));

async function harness(t, serverOptions = {}) {
  const home = await mkdtemp(join(tmpdir(), 'study-jev-outline-'));
  const before = { DSH_HOME: process.env.DSH_HOME, JEV_API_KEY: process.env.JEV_API_KEY, JEV_BASE_URL: process.env.JEV_BASE_URL };
  process.env.DSH_HOME = home; delete process.env.JEV_API_KEY; delete process.env.JEV_BASE_URL;
  const fake = await startFakeJev(serverOptions);
  const runtime = createJevRuntime({ baseUrl: fake.baseUrl, sleep: async () => {}, random: () => 0, usage: createJevUsage() });
  t.after(async () => { await fake.close(); for (const [k, v] of Object.entries(before)) if (v === undefined) delete process.env[k]; else process.env[k] = v; await rm(home, { recursive: true, force: true }); });
  return { fake, runtime, open: () => saveJevSettings({ key: fake.key, confirm: true, enabled: true, features: { outlineNoise: true } }) };
}
/** Probabilities by heading text: label entries are "label", "Page n of m" are "running", everything else "chapter". */
const byText = (name, question, state) => {
  const n = Number(name.slice(1)), heading = state.headings.find(item => item.n === n).text;
  const pick = /^English original$/.test(heading) ? 'label' : /^Page \d/.test(heading) ? 'running' : 'chapter';
  const keys = Object.keys(question.criteria), probabilities = Object.fromEntries(keys.map(key => [key, key === pick ? 0.9 : 0.1 / (keys.length - 1)]));
  return { type: 'choice', choice: pick, confidence: 0.8, probabilities };
};

test('four labels, each with a plain description; one question per heading over a small window of its neighbours', () => {
  assert.deepEqual(Object.keys(OUTLINE_LABELS), ['chapter', 'label', 'running', 'other']);
  const request = buildOutlineRequest(entries.slice(0, 3), entries, 0);
  assert.deepEqual(Object.keys(request.questions), ['h0', 'h1', 'h2']);
  for (const question of Object.values(request.questions)) { assert.equal(question.type, 'choice'); assert.deepEqual(Object.keys(question.criteria), ['chapter', 'label', 'running', 'other']); }
  assert.deepEqual(request.state.headings.map(item => item.n), [0, 1, 2, 3, 4], 'the window adds two neighbours on each side');
  assert.equal(request.state.headings[0].text, 'English original');
  assert.ok(!JSON.stringify(request).includes('"id"'), 'entry ids stay out of the request');
});

test('a title is clipped, never sent whole', () => {
  const request = buildOutlineRequest([{ id: 'x', level: 2, title: 'T'.repeat(5000) }], [{ id: 'x', level: 2, title: 'T'.repeat(5000) }], 0);
  assert.ok(request.state.headings[0].text.length <= 160);
});

test('reading an answer: the top label with its probability; "chapter" and "other" are never noise', () => {
  assert.deepEqual(readOutlineAnswer({ type: 'choice', choice: 'label', confidence: 0.8, probabilities: { chapter: 0.05, label: 0.9, running: 0.03, other: 0.02 } }), { label: 'label', probability: 0.9 });
});

test('classifyOutline: chunks of 8 headings, bounded concurrency, labels by entry id, tokens reported', async t => {
  const h = await harness(t, { answer: byText });
  await h.open();
  const list = [...entries.slice(0, 18), { id: 'p1', level: 1, title: 'Page 3 of 90' }, { id: 'p2', level: 1, title: 'Page 4 of 90' }];
  const result = await classifyOutline({ runtime: h.runtime, entries: list, threshold: 0.8, language: 'en' });
  assert.equal(h.fake.requests.length, 3, '20 headings in chunks of 8');
  assert.equal(Object.keys(result.labels).length, 20);
  assert.deepEqual(result.labels['h-0'], { label: 'label', probability: 0.9 });
  assert.deepEqual(result.labels['h-1'], { label: 'chapter', probability: 0.9 });
  assert.equal(result.labels.p1.label, 'running');
  assert.ok(result.usage.inputTokens > 0);
  assert.equal(result.unavailable, undefined);
});

test('the gate and failures: nothing is sent while off, and a failing Jev leaves the outline as it was', async t => {
  const h = await harness(t, { answer: byText });
  let result = await classifyOutline({ runtime: h.runtime, entries, threshold: 0.8, language: 'en' });
  assert.equal(result.unavailable.reason, 'off');
  assert.deepEqual(result.labels, {});
  assert.equal(h.fake.requests.length, 0);
  await h.open(); h.fake.fail(401);
  result = await classifyOutline({ runtime: h.runtime, entries, threshold: 0.8, language: 'en', concurrency: 1 });
  assert.equal(result.unavailable.reason, 'invalid-key');
  assert.deepEqual(result.labels, {});
});

test('applyOutlineLabels: a confident running header is dropped, a confident section label is demoted a level, everything unsure is kept as it is', () => {
  const list = [{ id: 'a', level: 1, title: 'Intro' }, { id: 'b', level: 1, title: 'English original' }, { id: 'c', level: 1, title: 'Page 3 of 90' },
    { id: 'd', level: 2, title: 'Maybe' }, { id: 'e', level: 1, title: 'Chapter' }];
  const labels = { a: { label: 'chapter', probability: 0.95 }, b: { label: 'label', probability: 0.92 }, c: { label: 'running', probability: 0.97 },
    d: { label: 'running', probability: 0.6 }, e: { label: 'other', probability: 0.99 } };
  const copy = JSON.stringify(list);
  const shown = applyOutlineLabels(list, labels, { threshold: 0.8 });
  assert.equal(JSON.stringify(list), copy, 'the input is not modified');
  assert.deepEqual(shown.map(entry => entry.id), ['a', 'b', 'd', 'e'], 'the running header is gone, order unchanged');
  assert.equal(shown.find(entry => entry.id === 'b').level, 2);
  assert.equal(shown.find(entry => entry.id === 'b').muted, true);
  assert.equal(shown.find(entry => entry.id === 'd').level, 2, 'unsure: untouched');
  assert.equal(shown.find(entry => entry.id === 'd').muted, undefined);
  assert.equal(shown.find(entry => entry.id === 'a').level, 1);
  // Mode "keep": nothing is dropped, noise is only muted.
  assert.deepEqual(applyOutlineLabels(list, labels, { threshold: 0.8, mode: 'keep' }).map(entry => entry.id), ['a', 'b', 'c', 'd', 'e']);
  assert.equal(applyOutlineLabels(list, labels, { threshold: 0.8, mode: 'keep' }).find(entry => entry.id === 'c').muted, true);
  // No labels at all: the very same entries.
  assert.deepEqual(applyOutlineLabels(list, {}, { threshold: 0.8 }), list);
  assert.deepEqual(applyOutlineLabels(list, null), list);
  // An outline is never emptied: if everything would be dropped, nothing is.
  assert.equal(applyOutlineLabels([list[2]], { c: labels.c }, { threshold: 0.8 }).length, 1);
});

test('jev.outline.classify through a service: 1 to 200 entries, off by default, labels back', async t => {
  const home = await mkdtemp(join(tmpdir(), 'study-jev-outline-svc-home-')), root = await mkdtemp(join(tmpdir(), 'study-jev-outline-svc-'));
  const before = { DSH_HOME: process.env.DSH_HOME, JEV_BASE_URL: process.env.JEV_BASE_URL }; process.env.DSH_HOME = home; delete process.env.JEV_BASE_URL;
  const fake = await startFakeJev({ answer: byText });
  const service = new StudyService(root, { jev: { baseUrl: fake.baseUrl, sleep: async () => {}, random: () => 0 } });
  t.after(async () => { service.dispose(); await fake.close(); for (const [k, v] of Object.entries(before)) if (v === undefined) delete process.env[k]; else process.env[k] = v; await rm(home, { recursive: true, force: true }); await rm(root, { recursive: true, force: true }); });
  let result = await service.call('jev.outline.classify', { entries: entries.slice(0, 4) });
  assert.equal(result.unavailable.reason, 'off');
  assert.equal(fake.requests.length, 0);
  await service.call('jev.settings.set', { key: fake.key, confirm: true, enabled: true, features: { outlineNoise: true } });
  result = await service.call('jev.outline.classify', { entries: entries.slice(0, 4) });
  assert.equal(result.labels['h-0'].label, 'label');
  assert.equal(result.threshold, 0.8);
  await assert.rejects(service.call('jev.outline.classify', { entries: [] }), /1–200/);
  await assert.rejects(service.call('jev.outline.classify', { entries: Array.from({ length: 201 }, (_, i) => ({ id: `x${i}`, title: 't', level: 1 })) }), /1–200/);
  await assert.rejects(service.call('jev.outline.classify', { entries: [{ id: '', title: 'x' }] }), /1–200/);
});
