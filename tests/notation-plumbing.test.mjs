/* WP-M1 · 公式写法 plumbing: the saved default, request normalization, the 创建题组 form control (zh/en),
   the request the form sends, and the draft that keeps the choice (补题 reuses it). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StudyService } from '../lib/service.js';
import { createFakeModel } from '../scripts/fake-model.mjs';
import { GENERATION_SETTINGS_DEFAULTS, GENERATION_NOTATIONS, normalizeGenerationSettings, validateGenerationPatch,
  resolveGenerationRequest } from '../lib/generation-settings.js';

/* ---------- saved default and request normalization ---------- */

test('the saved generation defaults carry a notation that starts as auto', () => {
  assert.equal(GENERATION_SETTINGS_DEFAULTS.notation, 'auto');
  assert.deepEqual([...GENERATION_NOTATIONS], ['auto', 'text', 'latex']);
  assert.equal(normalizeGenerationSettings({ notation: 'latex' }).notation, 'latex');
  assert.equal(normalizeGenerationSettings({ notation: 'markdown' }).notation, 'auto', 'a corrupt saved value falls back');
  assert.deepEqual(validateGenerationPatch({ notation: 'text' }), { notation: 'text' });
  assert.throws(() => validateGenerationPatch({ notation: 'markdown' }), /Invalid generation setting: notation/);
});

test('a request takes the explicit notation, else the saved default; a continuation keeps its own', () => {
  const saved = { ...GENERATION_SETTINGS_DEFAULTS, notation: 'latex' };
  assert.equal(resolveGenerationRequest(saved).notation, 'latex');
  assert.equal(resolveGenerationRequest(saved, { notation: 'text' }).notation, 'text');
  assert.equal(resolveGenerationRequest(saved, { notation: 'nonsense' }).notation, 'auto', 'an unknown choice normalizes to auto');
  const continued = resolveGenerationRequest(saved, { count: 2 }, { continuation: { kind: 'quiz', notation: 'text' } });
  assert.equal(continued.notation, 'text', 'today\'s changed library default does not leak into a continued draft');
  assert.equal(resolveGenerationRequest(saved, { count: 2 }, { continuation: { kind: 'quiz' } }).notation, 'auto', 'a legacy draft has no choice, so auto');
  assert.equal(resolveGenerationRequest(saved, { notation: 'latex' }, { continuation: { kind: 'quiz', notation: 'text' } }).notation, 'latex', 'an explicit choice still wins');
});

/* ---------- the agent tool schema ---------- */

test('the generation tool contract tells the agent it can pass notation', async () => {
  const { libraryContracts } = await import('../lib/study-contracts.js');
  const text = libraryContracts.generation;
  assert.match(text, /notation\?:auto\|text\|latex/);
  assert.ok((text.match(/notation\?:auto\|text\|latex/g) || []).length >= 2, 'generate and supplement both list it');
});

/* ---------- the form ---------- */

const compiled = await build({ stdin: { contents: `
  export { default as Generate } from './ui/Generate.jsx';
  export * as form from './ui/generate-form.js';
  export * as status from './ui/generation-status.js';
  export { GenerationSettingsForm, generationFormErrors } from './ui/GenerationSettings.jsx';
  export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react'], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const { Generate, form, status, GenerationSettingsForm, setUiLanguage } = module.exports;
const noop = () => {};
const sources = [{ id: 'a', title: 'Notes', text: 'Indexes speed up lookups. '.repeat(40), courses: ['DB'] }];
const gen = { kind: 'mixed', count: 10, difficulty: 'mixed', language: '中文', focus: '', role: '' };
const render = (patch = {}) => renderToStaticMarkup(React.createElement(Generate, { data: { root: 'lib', decks: [], drafts: [], jobs: [], sources, modelReady: true,
  focus: { course: 'DB', courses: [{ name: 'DB' }] } }, busy: false, running: false, act: noop, call: noop, openDraft: noop, setPage: noop, setNotice: noop,
genSource: 'files', setGenSource: noop, gen: { ...gen, ...patch }, setGen: noop, selectedSources: ['a'], setSelectedSources: noop, setModal: noop, askInChat: noop,
openModelSettings: noop }));
const more = (html, marker = '更多选项') => html.slice(html.indexOf(marker));
const plain = html => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test('the form offers 公式写法 inside the collapsed 更多选项, with the owner\'s three labels and hint', () => {
  setUiLanguage('zh');
  const html = render(), closed = html.slice(html.indexOf('class="generate-form'));
  assert.match(closed, /<details class="sh-disclosure[^"]*"(?![^>]*\sopen)[^>]*>/);
  assert.doesNotMatch(closed.slice(0, closed.indexOf('更多选项')), /公式写法/, 'it lives inside the disclosure, not in the main rows');
  const inside = more(html);
  assert.match(inside, /公式写法/);
  const group = /<div role="group" aria-label="公式写法" class="sh-seg[^"]*">(.*?)<\/div>/s.exec(inside);
  assert.ok(group, 'a segmented control named 公式写法');
  const labels = [...group[1].matchAll(/sh-seg__item[^>]*>(?:<svg.*?<\/svg>)?([^<]+)<\/button>/g)].map(match => match[1]);
  assert.deepEqual(labels, ['自动', '纯文本', '公式（LaTeX）']);
  assert.match(group[1], /aria-pressed="true"[^>]*>(?:<svg.*?<\/svg>)?自动</, 'auto is the default');
  assert.match(plain(inside), /纯文本更稳定；公式适合数学、化学/);
  assert.match(more(render({ notation: 'text' })), /aria-pressed="true"[^>]*>(?:<svg.*?<\/svg>)?纯文本</);
  assert.match(more(render({ notation: 'latex' })), /aria-pressed="true"[^>]*>(?:<svg.*?<\/svg>)?公式（LaTeX）</);
});

test('the same control and hint read in English', () => {
  setUiLanguage('en');
  try {
    const inside = more(render(), 'More options'), text = plain(inside);
    assert.match(text, /More options/);
    assert.match(inside, /aria-label="Formula notation"/);
    for (const label of ['Auto', 'Plain text', 'Formula \\(LaTeX\\)']) assert.match(inside, new RegExp(`sh-seg__item[^>]*>(?:<svg.*?</svg>)?${label}</button>`), label);
    assert.match(text, /Plain text is the most stable; formulas suit maths and chemistry\./);
    assert.doesNotMatch(text, /公式写法|纯文本更稳定/);
  } finally { setUiLanguage('zh'); }
});

test('the choice persists on the form like the other settings and is sent as notation', () => {
  const defaults = status.generationFormDefaults({ ...GENERATION_SETTINGS_DEFAULTS, notation: 'text' }, 'zh');
  assert.equal(defaults.notation, 'text', 'the saved default fills the form');
  assert.equal(status.generationFormDefaults(undefined, 'zh').notation, 'auto');
  assert.equal(status.GENERATION_DEFAULTS.notation, 'auto');
  const next = status.freshGeneration({ ...gen, notation: 'latex', title: 'x' }, undefined, 'zh');
  assert.equal(next.notation, 'auto', 'a fresh form without saved defaults starts from auto');
  const kept = status.freshGeneration({ ...gen, notation: 'latex' }, { ...GENERATION_SETTINGS_DEFAULTS, notation: 'latex' }, 'zh');
  assert.equal(kept.notation, 'latex');
  const request = form.generationRequest({ ...gen, notation: 'text', count: '12' }, { course: 'DB', sourceIds: ['a'] });
  assert.equal(request.notation, 'text');
  assert.equal(request.count, 12);
  assert.deepEqual(request.sourceIds, ['a']);
  assert.equal(form.generationRequest({ ...gen }, { course: 'DB', sourceIds: ['a'] }).notation, 'auto', 'a form without a choice sends auto');
  assert.equal(form.generationRequest({ ...gen, notation: 'markdown' }, { course: 'DB', sourceIds: ['a'] }).notation, 'auto');
});

test('the saved-defaults editor lists 公式写法 too and saves it', async () => {
  setUiLanguage('zh');
  const html = renderToStaticMarkup(React.createElement(GenerationSettingsForm, { root: '/lib', saved: { ...GENERATION_SETTINGS_DEFAULTS, notation: 'text' }, busy: false, act: noop }));
  assert.match(html, /默认公式写法/);
  assert.match(html, /<option value="text" selected="">纯文本<\/option>/);
});

/* ---------- the draft keeps the choice ---------- */

const maths = 'The quadratic formula gives x = (-b ± √(b²−4ac)) / 2a. We know that x²−5x+6=0 has roots x=2 and x=3, and ∫₀¹ x² dx = 1/3 while ∑ aₙ may diverge. '
  + 'Also a≠b implies a²≠b², and √2 is irrational; x≤3 and y≥1 mark the region. ';
async function library(t) {
  const root = await mkdtemp(join(tmpdir(), 'study-notation-'));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = join(root, 'home');
  const service = new StudyService(root, { complete: createFakeModel({ latencyMs: 1, usage: true }), coach: false, language: 'zh' });
  t.after(async () => {
    await service.dispose();
    if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  const history = await service.call('source.add', { title: 'History', text: 'The Tang dynasty reached its height under Emperor Xuanzong, and later rulers struggled with regional governors. '.repeat(6) });
  const algebra = await service.call('source.add', { title: 'Algebra', text: maths.repeat(4) });
  return { service, historyIds: [history.id], mathIds: [algebra.id] };
}
const finish = async (service, started) => {
  const job = await service.call('job.wait', { jobId: started.jobId, timeoutSeconds: 30 });
  assert.equal(job.status, 'complete', job.stage);
  return (await service.call('export')).drafts.find(draft => draft.id === job.draftId);
};

test('a run stores the chosen notation and the one it resolved to on the draft', async t => {
  const { service, historyIds, mathIds } = await library(t);
  const picked = await finish(service, await service.call('generate', { sourceIds: historyIds, count: 2, notation: 'latex', title: 'Picked' }));
  assert.equal(picked.editorial.generation.notation, 'latex');
  assert.equal(picked.editorial.generation.notationResolved, 'latex');
  const auto = await finish(service, await service.call('generate', { sourceIds: mathIds, count: 2, title: 'Maths' }));
  assert.equal(auto.editorial.generation.notation, 'auto', 'no choice means auto');
  assert.equal(auto.editorial.generation.notationResolved, 'latex', 'auto resolves from the maths source');
  const plainAuto = await finish(service, await service.call('generate', { sourceIds: historyIds, count: 2, title: 'History' }));
  assert.equal(plainAuto.editorial.generation.notationResolved, 'text');
  const bogus = await finish(service, await service.call('generate', { sourceIds: historyIds, count: 2, notation: 'markdown', title: 'Bogus' }));
  assert.equal(bogus.editorial.generation.notation, 'auto');
});

test('the saved default applies when a request names none, and supplement accepts notation too', async t => {
  const { service, historyIds } = await library(t);
  await service.call('settings', { generation: { notation: 'text' } });
  const saved = await finish(service, await service.call('generate', { sourceIds: historyIds, count: 2, title: 'Saved default' }));
  assert.equal(saved.editorial.generation.notation, 'text');
  const overridden = await finish(service, await service.call('generate', { sourceIds: historyIds, count: 2, notation: 'latex', title: 'Override' }));
  assert.equal(overridden.editorial.generation.notation, 'latex');
  assert.equal((await service.call('snapshot')).settings.generation.notation, 'text', 'a one-off choice never rewrites the saved default');
});

test('补题 reuses the draft\'s own choice instead of today\'s default', async t => {
  const { service, historyIds } = await library(t);
  const first = await finish(service, await service.call('generate', { sourceIds: historyIds, count: 2, notation: 'text', title: 'Continue me' }));
  await service.call('settings', { generation: { notation: 'latex' } });
  const partial = await service.call('draft.save', { deck: { ...first, editorial: { ...first.editorial, requested: 4 } } });
  const completed = await finish(service, await service.call('generate', { resumeDraftId: partial.id, draftVersion: partial.draftVersion }));
  assert.equal(completed.id, partial.id);
  assert.equal(completed.cards.length, 4);
  assert.equal(completed.editorial.generation.notation, 'text');
  assert.equal(completed.editorial.generation.notationResolved, 'text');
});
