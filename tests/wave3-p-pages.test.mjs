import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';

// UI wave 3 · WP-P: the page-level leftovers that have one-line rules (#91 #107 #113 #144 #146 #104 #135 #145).
const read = file => readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const OWNED = ['Dashboard', 'Draft', 'DraftShortfall', 'Skeleton', 'WrongBook', 'Manage', 'BlogNotes', 'Review', 'ReviewToolbar', 'ReviewNavigator', 'Sources',
  'Generate', 'GenerateAssist', 'Workflows', 'WorkflowPortal', 'WorkflowLesson', 'WorkflowScope', 'LiveClass', 'LiveHistory', 'LiveNotes', 'AudioDashboard',
  'Settings', 'Welcome', 'StudyMap', 'CoachDebrief', 'DailyPlan'].map(name => `ui/${name}.jsx`);
const walk = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name).replace(/\\/g, '/');
    if (statSync(full).isDirectory()) walk(full, out); else if (/\.jsx?$/.test(full)) out.push(full);
  }
  return out;
};
const ownedFiles = [...OWNED, ...walk('ui/study-map'), ...walk('ui/settings'), 'ui/app/page-views.jsx', 'ui/app/SettingsPanels.jsx'];

test('no sandwiched fragments: a sentence is one catalogue key with its values inside (#107)', () => {
  const offenders = [];
  for (const file of ownedFiles) {
    read(file).split('\n').forEach((line, index) => {
      if (/\{ui\((["'])[^"'\n]*\s\1\)\}\s*\{[a-zA-Z]/.test(line) || /\}\{ui\((["'])\s[^"'\n]*\1\)\}/.test(line) || /\{ui\((["'])\s[^"'\n]*\s\1\)\}/.test(line)) offenders.push(`${file}:${index + 1}`);
    });
  }
  assert.deepEqual(offenders, [], 'use uiFormat("… {0} …", [value]) or uiRich(template, node)');
});

test('the wave-3 locale file has no key that starts or ends with a space, and every value is English', () => {
  const pages = JSON.parse(read('ui/locales/en.pages.json'));
  for (const [key, value] of Object.entries(pages)) {
    assert.equal(key, key.replace(/^ +| +$/g, ''), `key with an edge space: ${JSON.stringify(key)}`);
    assert.equal(typeof value, 'string', key);
    assert.doesNotMatch(value, /[㐀-鿿]/, `Chinese left in the English of ${JSON.stringify(key)}`);
  }
});

test('the pages read their feedback from the toast context, not from setNotice / notify / onNotice props (#91 #113)', () => {
  const pages = ['Dashboard', 'Draft', 'Manage', 'BlogNotes', 'Sources', 'Generate', 'Workflows', 'WorkflowPortal', 'LiveClass', 'WrongBook', 'Skeleton', 'Settings', 'StudyMap']
    .map(name => `ui/${name}.jsx`);
  for (const file of pages) {
    const source = read(file);
    assert.doesNotMatch(source, /\bonNotice\b|\bnotify=\{/, `${file}: no notify prop`);
    assert.doesNotMatch(source, /export default function \w+\(\{[^)]*\bsetNotice\b/, `${file}: setNotice is not a prop`);
  }
  assert.doesNotMatch(read('ui/Draft.jsx'), /\bsetError\b/, 'Draft reports through the toast too');
});

test('StudyMap takes the snapshot and the home verbs, not 48 props (#113)', async () => {
  const source = read('ui/StudyMap.jsx');
  const signature = source.match(/export default function StudyMap\(\{(.*)\}\) \{/)[1];
  const props = signature.split(',').map(item => item.trim().split(/[=\s]/)[0]).filter(Boolean);
  assert.ok(props.length <= 20, `${props.length} props: ${props.join(', ')}`);
  assert.deepEqual(props.sort(), ['actions', 'children', 'data', 'notebooks', 'onRevealed', 'reveal', 'setupHandlers']);
  assert.match(source, /useStudy\(\)/);
});

test('Settings gets plain services and data; its panes draw the panels themselves (#113)', () => {
  const source = read('ui/Settings.jsx');
  const signature = source.match(/export default function Settings\(\{([\s\S]*?)\}\) \{/)[1];
  assert.doesNotMatch(signature, /Panel/, 'no pre-built JSX in the props');
  assert.doesNotMatch(signature, /\b(busy|act|call|host|setNotice)\b/, 'the services come from useStudy()');
  assert.match(read('ui/settings/ModelPane.jsx'), /<WorkspaceBindingPanel \/>/);
  assert.match(read('ui/settings/CoursesPane.jsx'), /<CoursesPanel \/>/);
  assert.match(read('ui/settings/ProfilePane.jsx'), /<OnboardingControls \/>/);
});

test('role="tab" lives in Tabs only, and the fold arrows are not hand-drawn glyphs (#144 #146)', () => {
  for (const file of ['ui/Generate.jsx', 'ui/Sources.jsx', 'ui/Skeleton.jsx']) assert.doesNotMatch(read(file), /role=["']tab["']/, file);
  assert.match(read('ui/Generate.jsx'), /<Tabs\b/);
  assert.doesNotMatch(read('ui/Sources.jsx'), /source-group-caret|▸/);
  for (const file of ownedFiles) assert.doesNotMatch(read(file), /className="[^"]*\b(map-caret|course-caret|sk-caret|source-group-caret)\b/, file);
});

test('no legacy button class, no bare glyph icon in the owned pages (#135 #145)', () => {
  const legacy = /className=\{?["'`][^"'`]*(?<![\w-])(primary|link-btn|ghost-btn|pill|danger-text|wf-danger)(?![\w-])/;
  for (const file of ownedFiles) {
    const source = read(file);
    assert.doesNotMatch(source, legacy, `${file}: a legacy button class`);
    assert.doesNotMatch(source, />\s*[×✕−＋↑↓▸▾▶‹›✓♫✧♧]\s*</, `${file}: a glyph as an icon`);
  }
});

const m = await loadUi(`export { default as WrongBook, WrongBookView } from './ui/WrongBook.jsx';
  export { AppContext } from './ui/app/app-context.js'; export { StudyServicesContext } from './ui/study-context.jsx';
  export { default as ModelSetupGate } from './ui/ModelSetupGate.jsx'; export { setUiLanguage } from './ui/i18n.js';`);
const h = React.createElement;

test('WrongBook without a usable model shows the one shared ModelSetupGate (#104)', () => {
  const html = renderToStaticMarkup(h(m.ModelSetupGate, { variant: 'block', feature: 'variants', model: { ready: false }, onOpenSettings() {} }));
  assert.match(html, /先配置一个 AI 模型/);
  assert.match(html, /前往设置/);
  assert.match(html, /生成变式要调用 AI 模型/);
  assert.doesNotMatch(read('ui/WrongBook.jsx'), /先配置一个 AI 模型/, 'the literal lives in ModelSetupGate only');
  assert.match(read('ui/WrongBook.jsx'), /<ModelSetupGate feature="variants"/);
});

test('every migrated page header is the shared PageHeader and the scope picker sits in its slot (#142)', () => {
  for (const [file, scope] of [['Dashboard', true], ['Skeleton', true], ['WrongBook', true], ['Settings', false], ['Manage', false], ['BlogNotes', true], ['Draft', false], ['Generate', false], ['Sources', false]]) {
    const source = read(`ui/${file}.jsx`);
    assert.match(source, /<PageHeader\b/, file);
    assert.doesNotMatch(source, /className="page-heading|className="section-heading note-heading|<header className="manage-head"/, `${file}: no hand-built heading`);
    if (scope) assert.match(source, /scope=\{[^}]*(<PageScope|!note \?)/, `${file}: PageScope goes in the scope slot`);
  }
  assert.match(read('ui/study-map/CourseHeading.jsx'), /<PageHeader\b/);
});
