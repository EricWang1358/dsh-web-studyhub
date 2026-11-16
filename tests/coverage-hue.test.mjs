import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';

/* #1078: coverage was drawn in the info blue, a fourth hue beside cinnabar, jade and ochre. Coverage is now ink: covered is solid ink, planned and
   failed stays ochre, never planned is an empty track. Mastery keeps its round marks in ochre and jade, so shape still tells the two apart. */

const m = await loadUi(`
  export { coverageSegments, CoverageBar } from './ui/coverage/Coverage.jsx';
  export { StackedBar } from './ui/components/index.js';
`);

const css = await readFile(new URL('../ui/coverage/coverage.css', import.meta.url), 'utf8');
const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');

test('no coverage rule paints in the info hue', () => {
  assert.doesNotMatch(rules, /var\(--info(?:-[a-z]+)?\)/, 'coverage.css must not use --info / --info-ink');
});

test('the coverage segments name their state and never ask for the info tone', () => {
  const segments = m.coverageSegments({ covered: 4, plannedFailed: 1, neverPlanned: 2, scheduled: 1, recorded: true });
  assert.ok(segments.every((part) => part.tone !== 'info'), 'no info tone');
  assert.deepEqual(segments.map((part) => part.kind), ['covered', 'planned-failed', 'scheduled', 'never-planned']);
});

test('a stacked bar passes a part kind to its segment and its legend key', () => {
  const out = renderToStaticMarkup(React.createElement(m.StackedBar, { legend: true, segments: [{ value: 2, tone: 'neutral', kind: 'covered', label: 'a' }] }));
  assert.match(out, /class="sh-stacked__segment"[^>]*data-kind="covered"/);
  assert.match(out, /class="sh-stacked__key"[^>]*data-kind="covered"/);
});

test('the coverage bar colours each kind from coverage.css, ink first', () => {
  assert.match(rules, /\.cov-bar\s+\[data-kind='covered'\]\s*\{[^}]*--sh-tone:\s*var\(--cov-covered\)/);
  assert.match(rules, /\.cov-bar\s+\[data-kind='never-planned'\]/);
});

/* The same colour rule where the coverage figure is said outside coverage.css: the reader's practice panel and the status of a top-up that runs. */
test('the reader practice coverage line is ink, not the info hue', async () => {
  const practice = (await readFile(new URL('../ui/document-preview/practice/practice.css', import.meta.url), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '');
  const line = practice.match(/\.reader-practice__coverage\s*\{[^}]*\}/)?.[0] ?? '';
  assert.ok(line, 'the coverage line has a rule');
  assert.doesNotMatch(line, /var\(--info/, 'the coverage line is not blue');
});

test('the status of a top-up that runs shows the coverage figure in a neutral badge', async () => {
  const source = await readFile(new URL('../ui/coverage/CoverageTopUp.jsx', import.meta.url), 'utf8');
  const status = source.match(/const WorkStatus = [^\n]*/)?.[0] ?? '';
  assert.ok(status, 'WorkStatus exists');
  assert.doesNotMatch(status, /tone="info"/, 'the coverage figure is not an info-blue badge');
});

test('the filled part of a coverage bar is a lighter ink than the page title', () => {
  assert.match(rules, /--cov-covered:\s*var\(--text-muted\)/, 'the bar and the covered mark draw in muted ink, not --text-dim');
});
