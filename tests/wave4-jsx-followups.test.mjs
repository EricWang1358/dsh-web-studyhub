import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// Wave 4 item 1: the small JSX follow-ups of the earlier waves (#91 #104 #120 #142 #145 #124).
const read = (file) => readFileSync(file, 'utf8');
const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `
  export { default as ModelSetupGate } from './ui/ModelSetupGate.jsx';
  export { Icon } from './ui/components/index.js';
  export { ExamHeader } from './ui/ExamShell.jsx';
  export { default as AgentLink } from './ui/AgentLink.jsx';
  export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
const m = module.exports;
const h = React.createElement;
const noop = () => {};

test('Sources and the reader import the audio parts from ui/audio/*, and AudioImport re-exports nothing (#124)', () => {
  assert.doesNotMatch(read('ui/AudioImport.jsx'), /^export \{/m);
  assert.match(read('ui/Sources.jsx'), /from ["']\.\/audio\/AudioJobs\.jsx["']/);
  assert.match(read('ui/document-preview/DocumentViewer.jsx'), /from ['"]\.\.\/audio\/AudioCorrections\.jsx['"]/);
  for (const file of ['ui/Sources.jsx', 'ui/document-preview/DocumentViewer.jsx']) assert.doesNotMatch(read(file), /AudioImport\.jsx/, file);
});

test('ModelSetupGate has a case feature whose last step names the case button (#104)', () => {
  m.setUiLanguage('zh');
  const html = renderToStaticMarkup(h(m.ModelSetupGate, { variant: 'block', feature: 'case', model: { ready: false, reason: 'no-route' }, onOpenSettings: noop }));
  assert.match(html, /回到这里，点「出一套案例题」/);
  assert.doesNotMatch(html, /生成并检查题组/, 'not the deck generator’s step');
  assert.match(read('ui/CaseCreate.jsx'), /feature="case"/);
  assert.doesNotMatch(read('ui/CaseCreate.jsx'), /feature="generate"/);
});

test('AgentLink is a link Button and AudioJobs no longer dresses it by class (#145)', () => {
  const html = renderToStaticMarkup(h(m.AgentLink, { childId: 'c1', openAgent: noop, label: '查看子代理' }));
  assert.match(html, /sh-btn--link/);
  assert.match(html, /sh-btn--sm/);
  assert.doesNotMatch(read('ui/audio/AudioJobs.jsx'), /sh-btn sh-btn--link|className="sh-btn/);
});

test('Icon has arrow-up and arrow-down, and the audio order buttons use them without rotating a chevron (#145)', () => {
  for (const name of ['arrow-up', 'arrow-down']) assert.match(renderToStaticMarkup(h(m.Icon, { name })), /<path/, name);
  const page = read('ui/AudioImport.jsx');
  assert.match(page, /name="arrow-up"/);
  assert.match(page, /name="arrow-down"/);
  assert.doesNotMatch(page, /audio-order-icon/);
  assert.doesNotMatch(read('ui/audio/audio-import.css'), /rotate\(/);
});

test('the exam header passes the course scope through PageHeader\'s scope slot (#142)', () => {
  m.setUiLanguage('zh');
  const html = renderToStaticMarkup(h(m.ExamHeader, { courses: [{ name: 'Math' }], course: '*', onCourse: noop, format: 'written', onFormat: noop, showInactive: false, onShowInactive: noop }));
  assert.match(html, /sh-page-header__scope[^>]*>(?:(?!<\/div>).)*page-scope/s, 'the picker sits in the slot');
  assert.doesNotMatch(html, /es-controls[^>]*>(?:(?!es-format).)*page-scope/s, 'and no longer in the controls row');
});

function sources(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (name === 'locales' || name === 'node_modules') continue;
    if (statSync(path).isDirectory()) sources(path, out);
    else if (/\.jsx$/.test(name)) out.push(path);
  }
  return out;
}

test('no caller passes setNotice / onNotice / notify props any more (#91)', () => {
  for (const file of sources('ui')) assert.doesNotMatch(read(file), /\b(setNotice|onNotice|notify)=\{/, `${file} still passes a notice prop`);
  assert.doesNotMatch(read('ui/Settings.jsx'), /setNotice/);
});

test('Ingest takes its options from the prompt registry (#124)', () => {
  const source = read('ui/Ingest.jsx');
  assert.match(source, /INGEST_KINDS/);
  assert.match(source, /INGEST_MISTAKES/);
  assert.doesNotMatch(source, /^const (KINDS|MISTAKES) = \[/m);
});

test('the coach docs describe rewriteVia and fix, in both languages (#124)', () => {
  for (const file of ['docs/coach.md', 'docs/coach.zh-CN.md']) {
    const text = read(file);
    assert.match(text, /rewriteVia/, file);
    assert.match(text, /`fix`/, file);
  }
});

test('use-app-core has no unused eslint-disable (#124)', () => {
  assert.doesNotMatch(read('ui/app/use-app-core.js'), /eslint-disable/);
});
