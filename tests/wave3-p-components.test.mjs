import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { withStudy } from './helpers/study-services.mjs';
import { parseCss } from '../scripts/qa/guardrail-baseline.mjs';

// UI wave 3 · WP-P: the one page header with a scope slot (#142) and the Panel tones (#143).
const m = await loadUi(`
  export * from './ui/components/index.js';
  export { default as Draft } from './ui/Draft.jsx';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { setUiLanguage } from './ui/i18n.js';
`);
const h = React.createElement;
const html = (type, props = {}, ...children) => renderToStaticMarkup(h(type, props, ...children));

test('PageHeader has a scope slot between the description and the actions', () => {
  const out = html(m.PageHeader, { eyebrow: '统计', title: '学习统计', description: '近 30 天', scope: h('label', { className: 'page-scope' }, '课程范围'), actions: h(m.Button, null, '刷新') });
  assert.match(out, /<h1 class="sh-page-header__title">学习统计<\/h1>/);
  assert.match(out, /<div class="sh-page-header__scope"><label class="page-scope">课程范围<\/label><\/div>/);
  assert.ok(out.indexOf('sh-page-header__description') < out.indexOf('sh-page-header__scope'), 'scope sits under the description');
  assert.ok(out.indexOf('sh-page-header__scope') < out.indexOf('sh-page-header__actions'), 'actions come last');
  assert.doesNotMatch(html(m.PageHeader, { title: 'x' }), /sh-page-header__scope/, 'no empty scope wrapper');
});

test('PageHeader titleProps land on the h1 (focus targets and context headings)', () => {
  const out = html(m.PageHeader, { title: '笔记', titleProps: { tabIndex: -1, 'data-context-heading': true } });
  assert.match(out, /<h1 tabindex="-1" data-context-heading="true" class="sh-page-header__title">笔记<\/h1>/);
  assert.match(html(m.PageHeader, { title: 'x', titleProps: { className: 'course-heading', 'data-tour': 'home-course' } }), /<h1 class="sh-page-header__title course-heading" data-tour="home-course">/, 'a class on the title joins the shared one');
});

test('PageHeader compact is the one-line header of a working surface', () => {
  assert.match(html(m.PageHeader, { title: '题', compact: true }), /<header class="sh-page-header sh-page-header--compact">/);
  assert.doesNotMatch(html(m.PageHeader, { title: '题' }), /--compact/);
  assert.match(readFileSync('ui/components/components.css', 'utf8'), /\.sh-page-header--compact \.sh-page-header__title/);
});

test('PageHeader actionsOnTitleRow ends the title line with the actions, above the scope (#573)', () => {
  const out = html(m.PageHeader, { title: '学习统计', actionsOnTitleRow: true, scope: h('label', { className: 'page-scope' }, '课程范围'), actions: h(m.Button, null, '刷新') });
  assert.match(out, /<div class="sh-page-header__title-row"><h1 class="sh-page-header__title">学习统计<\/h1><div class="sh-page-header__actions"><button[^>]*>刷新<\/button><\/div><\/div><div class="sh-page-header__scope">/);
  assert.equal((out.match(/sh-page-header__actions/g) || []).length, 1, 'the actions are not repeated at the end');
  assert.match(html(m.PageHeader, { title: 'x', actionsOnTitleRow: true }), /<div class="sh-page-header__text"><h1 class="sh-page-header__title">x<\/h1><\/div><\/header>/, 'without actions there is no row wrapper');
  assert.match(readFileSync('ui/components/components.css', 'utf8'), /\.sh-page-header__title-row \{[^}]*display: flex;[^}]*align-items: center;[^}]*justify-content: space-between;/);
});

test('Panel tones, density and element', () => {
  assert.match(html(m.Panel, { title: 'a' }, 'x'), /^<section class="sh-panel">/, 'plain is the default and adds no modifier class');
  for (const tone of ['sunken', 'accent', 'dashed']) assert.match(html(m.Panel, { tone }, 'x'), new RegExp(`class="sh-panel sh-panel--${tone}"`));
  assert.match(html(m.Panel, { tone: 'paper' }, 'x'), /class="sh-panel sh-paper-card"/, 'the paper tone is the shared paper card of ui/paper.css (#143)');
  assert.match(html(m.Panel, { tone: 'plain' }, 'x'), /class="sh-panel"/);
  assert.match(html(m.Panel, { tone: 'glitter' }, 'x'), /class="sh-panel"/, 'unknown tones fall back to plain');
  assert.match(html(m.Panel, { density: 'compact' }, 'x'), /class="sh-panel sh-panel--compact"/);
  assert.match(html(m.Panel, { density: 'normal' }, 'x'), /class="sh-panel"/);
  assert.match(html(m.Panel, { as: 'article', tone: 'dashed', className: 'mine' }, 'x'), /^<article class="sh-panel sh-panel--dashed mine">/);
  assert.match(html(m.Panel, { as: 'li' }, 'x'), /^<li class="sh-panel">/);
});

test('the tones live in a new stylesheet that uses tokens only', () => {
  // Repo-wide raw colour and px guards also run in tests/css-token-guard.test.mjs and tests/ui-guardrails.test.mjs.
  const { declarations } = parseCss(readFileSync('ui/components/panel-tones.css', 'utf8'));
  const splitSelectors = (sel) => sel.split(/,(?![^(]*\))/).map((s) => s.trim());
  assert.ok(declarations.length > 0, 'panel-tones.css declares styles');
  for (const tone of ['sunken', 'accent', 'dashed', 'compact']) {
    const toneRe = new RegExp(`\\.sh-panel--${tone}\\b`);
    assert.equal(
      declarations.some((d) => splitSelectors(d.ctx.at(-1) || '').some((sel) => toneRe.test(sel))),
      true,
      tone,
    );
  }
  assert.deepEqual(
    declarations.filter((d) => /--radius-card\b|--paper-radius\b/.test(`${d.prop} ${d.value}`)),
    [],
    'desktop surfaces use --radius; the paper card (ui/paper.css) owns the card corner',
  );
  assert.deepEqual(
    declarations.filter((d) => /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\(|\d+(?:\.\d+)?px\b/i.test(d.value)),
    [],
    'no raw colours or px sizes',
  );
});

const walk = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out); else if (full.endsWith('.jsx')) out.push(full.replace(/\\/g, '/'));
  }
  return out;
};

/* Pages that keep their own <h1>: the shared header, the welcome card and the app's pre-library start page, and the host seat's no-session screen. */
const H1_ALLOWED = new Map([
  ['ui/components/PageHeader.jsx', 'the shared header'],
  ['ui/first-run/FirstRunLine.jsx', 'the first-run line is the whole first screen of an empty library, not a page frame'],
  ['ui/app/page-views.jsx', 'StartPage: the pre-library start screen'],
  ['ui/host/studyhub-page.jsx', 'the "open a session first" screen of the host seat'],
]);

test('<h1 appears only in PageHeader and the allow-listed frames (#142)', () => {
  const found = walk('ui').filter(file => /<h1[\s>]/.test(readFileSync(file, 'utf8')));
  assert.deepEqual(found.filter(file => !H1_ALLOWED.has(file)), [], 'render the page title with <PageHeader eyebrow title description actions scope back>');
  for (const file of H1_ALLOWED.keys()) assert.ok(found.includes(file), `${file} no longer has an <h1>: remove it from the allow-list`);
});

test('no hard-coded English eyebrows and no AudioPageHeader wrapper', () => {
  assert.equal(existsSync('ui/AudioPageHeader.jsx'), false, 'AudioPageHeader.jsx is deleted; the audio page renders PageHeader itself');
  const han = /[\u3400-\u9fff]/;
  const draft = { id: 'draft-1', title: 'Sample Draft', cards: [], quality: { errors: [], warnings: [] } };
  const data = { root: '/tmp/lib', sources: [], decks: [], drafts: [draft], jobs: [], courses: [], settings: {} };
  const renderDraft = (language) => {
    m.setUiLanguage(language);
    const out = renderToStaticMarkup(withStudy(m.StudyServicesContext, h(m.Draft, { draft, data })));
    const eyebrowMatch = out.match(/<p class="sh-page-header__eyebrow">([^<]+)<\/p>/);
    assert.ok(eyebrowMatch, `Draft renders .sh-page-header__eyebrow in ${language}`);
    return { out, eyebrow: eyebrowMatch[1].trim() };
  };
  try {
    const zh = renderDraft('zh');
    assert.equal(zh.eyebrow, '发布草稿', 'the Draft eyebrow renders localized Chinese through ui()');
    assert.doesNotMatch(zh.out, /PUBLISH YOUR DRAFT/, 'Draft never emits hardcoded PUBLISH YOUR DRAFT in zh');

    const en = renderDraft('en');
    assert.ok(en.eyebrow.length > 0, 'the Draft eyebrow renders localized English');
    assert.doesNotMatch(en.eyebrow, han, 'the Draft eyebrow has no untranslated Han characters in en');
    assert.notEqual(en.eyebrow, 'PUBLISH YOUR DRAFT', 'the Draft eyebrow is not hardcoded uppercase PUBLISH YOUR DRAFT');
    assert.doesNotMatch(en.out, /PUBLISH YOUR DRAFT/, 'Draft never emits hardcoded PUBLISH YOUR DRAFT in en');
  } finally {
    m.setUiLanguage('zh');
  }
});
