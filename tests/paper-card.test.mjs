/* #143 (owner decision 2026-10-05): every card-like surface is the one paper card, `.sh-paper-card` (ui/paper.css), which
   <Panel tone="paper"> also renders. Radius, border, shadow and the padding scale live there and nowhere else. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { ROOT, walk, parseCss, scanUi } from '../scripts/qa/guardrail-baseline.mjs';

const m = await loadUi(`export * from './ui/components/index.js'; export { setUiLanguage } from './ui/i18n.js';`);
const read = (file) => readFileSync(join(ROOT, file), 'utf8').replace(/\r\n/g, '\n');
const paper = parseCss(read('ui/paper.css'));
const rule = (selectorPart) => paper.declarations.filter((d) => d.ctx.some((c) => c.includes(selectorPart)));

/* The surfaces that were each styling their own card. */
const SURFACES = {
  'ui/Review.jsx': ['question-card', 'summary-topics', 'result-hero'],
  'ui/FlipCard.jsx': ['flip-face'],
  'ui/study-map/TodayCard.jsx': ['today-card'],
  'ui/Welcome.jsx': ['welcome-card'],
  'ui/CaseResult.jsx': ['case-report__hero'],
  'ui/CaseWorkspace.jsx': ['case-scenario'],
  'ui/ExamShell.jsx': ['es-sheet'],
  'ui/exam/WrittenReport.jsx': ['result-hero'],
  'ui/tour/Tour.jsx': ['tour-pop'],
};

test('<Panel tone="paper"> renders the paper card class and nothing parallel', () => {
  const out = renderToStaticMarkup(React.createElement(m.Panel, { tone: 'paper', title: 'a' }, 'x'));
  assert.match(out, /^<section class="sh-panel sh-paper-card">/);
  assert.doesNotMatch(out, /sh-panel--paper/);
});

test('ui/paper.css defines the paper card once: radius, border, shadow, stock and the padding scale', () => {
  const surface = rule('.sh-paper-card').filter((d) => d.ctx.some((c) => c.startsWith('@layer') || /study-app/.test(c)));
  const props = Object.fromEntries(surface.map((d) => [d.prop, d.value]));
  assert.equal(props['border-radius'], 'var(--paper-radius)');
  assert.equal(props['box-shadow'], 'var(--shadow-card)');
  assert.equal(props.background, 'var(--paper)');
  assert.match(props.border, /^1px solid transparent$/);
  assert.match(read('ui/paper.css'), /--paper-radius:\s*var\(--radius-card\)/);
  for (const size of ['', '--roomy', '--snug', '--flush']) assert.match(read('ui/paper.css'), new RegExp(`\\.sh-paper-card${size}\\b`), `.sh-paper-card${size}`);
  assert.match(read('ui/paper.css'), /\.study-document-viewer\[data-tone='paper'\] \.reader-page/, 'the reading-tone paper is part of the same rule');
});

test('Panel tones no longer carry a paper block of their own', () => {
  const css = read('ui/components/panel-tones.css').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(css, /paper|radius-card|shadow-card/);
});

test('each former card surface carries the primitive in its markup', () => {
  for (const [file, classes] of Object.entries(SURFACES)) {
    const source = read(file);
    for (const name of classes) {
      const line = source.split('\n').find((l) => new RegExp(`["'\` ]${name}["'\` ]`).test(l) && /className/.test(l));
      assert.ok(line, `${file}: no className for ${name}`);
      assert.match(line, /sh-paper-card|tone="paper"/, `${file}: ${name} does not use the paper card`);
    }
  }
});

test('the card look is spelled out only in paper.css: no feature sheet draws its own card corner, shadow or stock', () => {
  const hits = [];
  for (const file of walk(join(ROOT, 'ui'), ['.css'])) {
    const rel = relative(ROOT, file).split('\\').join('/');
    if (rel === 'ui/paper.css' || rel === 'ui/tokens.css' || rel === 'ui/appearance-themes.css') continue;
    for (const d of parseCss(readFileSync(file, 'utf8')).declarations) {
      if (d.prop.startsWith('--')) continue;
      if (/border(-\w+)*-radius$/.test(d.prop) && /--radius-card/.test(d.value) && !rel.startsWith('ui/components/')) hits.push(`${rel}:${d.line} ${d.prop}: ${d.value}`);
      if (d.prop === 'box-shadow' && /^var\(--shadow-card\)$/.test(d.value)) hits.push(`${rel}:${d.line} ${d.prop}: ${d.value}`);
      if (/^background(-color)?$/.test(d.prop) && /^var\(--paper\)$/.test(d.value)) hits.push(`${rel}:${d.line} ${d.prop}: ${d.value}`);
    }
  }
  assert.deepEqual(hits, [], `use the paper card (ui/paper.css):\n${hits.join('\n')}`);
});

test('the radiusCard ratchet is at its floor: 0 feature sheets use --radius-card', () => {
  const found = scanUi(ROOT);
  assert.deepEqual(found.metrics.radiusCard, {});
});
