import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';

// UI wave 3 · WP-P: the one page header with a scope slot (#142) and the Panel tones (#143).
const m = await loadUi(`export * from './ui/components/index.js'; export { setUiLanguage } from './ui/i18n.js';`);
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
  assert.match(readFileSync('ui/components/page-header.css', 'utf8'), /\.sh-page-header--compact \.sh-page-header__title/);
});

test('Panel tones, density and element', () => {
  assert.match(html(m.Panel, { title: 'a' }, 'x'), /^<section class="sh-panel">/, 'plain is the default and adds no modifier class');
  for (const tone of ['sunken', 'accent', 'dashed', 'paper']) assert.match(html(m.Panel, { tone }, 'x'), new RegExp(`class="sh-panel sh-panel--${tone}"`));
  assert.match(html(m.Panel, { tone: 'plain' }, 'x'), /class="sh-panel"/);
  assert.match(html(m.Panel, { tone: 'glitter' }, 'x'), /class="sh-panel"/, 'unknown tones fall back to plain');
  assert.match(html(m.Panel, { density: 'compact' }, 'x'), /class="sh-panel sh-panel--compact"/);
  assert.match(html(m.Panel, { density: 'normal' }, 'x'), /class="sh-panel"/);
  assert.match(html(m.Panel, { as: 'article', tone: 'dashed', className: 'mine' }, 'x'), /^<article class="sh-panel sh-panel--dashed mine">/);
  assert.match(html(m.Panel, { as: 'li' }, 'x'), /^<li class="sh-panel">/);
});

test('the tones live in a new stylesheet that uses tokens only', () => {
  const css = readFileSync('ui/components/panel-tones.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const tone of ['sunken', 'accent', 'dashed', 'paper', 'compact']) assert.match(css, new RegExp(`\\.sh-panel--${tone}\\b`), tone);
  assert.match(css, /\.sh-panel--paper[^}]*var\(--radius-card\)/s, 'only the paper tone uses the card radius');
  assert.doesNotMatch(css.replace(/\.sh-panel--paper[^}]*}/gs, ''), /--radius-card/, 'desktop surfaces use --radius');
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|\d+px/i, 'no raw colours or px sizes');
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
  ['ui/Welcome.jsx', 'the welcome card is not a page frame'],
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
  const draft = readFileSync('ui/Draft.jsx', 'utf8');
  assert.doesNotMatch(draft, /PUBLISH YOUR DRAFT/, 'the Draft eyebrow goes through ui()');
});
