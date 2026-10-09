import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { appSourceFiles, readAppSource, readShellFile } from './helpers/app-source.mjs';

// UI wave 2 · WP-F: the App shell is composed, not one 2500-line closure (#108 #109 #111 #112 #113 #114 #73 #74).
const m = await loadUi(`export { default as FlagDialog } from './ui/app/modals/FlagDialog.jsx';
  export { default as SourceListDialog } from './ui/app/modals/SourceListDialog.jsx';
  export { default as SourceReaderDialog } from './ui/app/modals/SourceReaderDialog.jsx';
  export { ModalRouter } from './ui/app/AppModalHost.jsx';
  export { AppContext } from './ui/app/app-context.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { setUiLanguage } from './ui/i18n.js';`);
const h = React.createElement;
const han = /[㐀-鿿]/;
const app = await readShellFile('ui/App.jsx');
const count = (text, pattern) => (text.match(pattern) || []).length;

test('App.jsx stays a composition: at most 1000 lines, no state of its own, at most five page literals', () => {
  assert.ok(app.split('\n').length <= 1000, `${app.split('\n').length} lines`);
  assert.equal(count(app, /\buseState\(/g), 0, 'the state lives in the hooks');
  assert.ok(count(app, /\bpage\s*===\s*['"]/g) <= 5, 'pages are drawn from the registry, not chosen by name');
  assert.doesNotMatch(app, /\buseEffect\(|\bsetInterval\(|localStorage\./);
});

test('the three navigation functions and the label tables are gone: one navigate(), one registry', async () => {
  const shell = await readAppSource();
  for (const gone of [/navigatePage/, /switchPage/, /\bshowPage\b.*=>?\s*\{?\s*$/m, /\bnavLabels\b/, /const shellTitle\s*=/, /pageContexts/]) {
    assert.doesNotMatch(shell, gone, String(gone));
  }
  assert.match(shell, /createNavigator\(/);
  assert.match(await readFile('ui/capabilities.js', 'utf8'), /from '\.\/pages\.js'/, 'availability reads the registry');
});

test('the practice session left App: no choose, flipCard, teaching, EN or keyboard handler there', async () => {
  for (const gone of [/function choose\b/, /flipCard/, /teachingAct/, /translateEn/, /autopilot/i, /keydown/, /askAboutCard/, /cardBrief/, /assistCard/]) assert.doesNotMatch(app, gone, String(gone));
  const session = await readShellFile('ui/review/useReviewSession.js');
  for (const present of [/shortcutAction\(/, /autopilotPlan\(/, /createFlightSet\(/, /isCurrentEntry\(/, /usePersistentState\(/]) assert.match(session, present, String(present));
});

test('Review takes at most twelve props and no raw setter', async () => {
  const review = await readShellFile('ui/Review.jsx');
  const signature = review.match(/export default function Review\(\{([\s\S]*?)\}\) \{/)?.[1] ?? '';
  const props = signature.split(',').map((item) => item.split('=')[0].trim()).filter(Boolean);
  assert.ok(props.length > 0 && props.length <= 12, props.join());
  assert.deepEqual(props.filter((name) => /^set[A-Z]/.test(name)), []);
  assert.doesNotMatch(review, /(?<!actions\.)\bset(Modal|Page|Flag|Hint|Explain|Response|TeachAnswer|ClozeValues)\b/, 'only the session\'s own actions, never a React setter');
  assert.match(review, /useStudy\(\)/);
});

test('the review leftovers are components: Spinner, ProgressBar, Popover and Menu, no details menus or private spinner', async () => {
  const review = await readShellFile('ui/Review.jsx') + await readShellFile('ui/review/QuestionRun.jsx'), toolbar = await readShellFile('ui/ReviewToolbar.jsx');
  assert.doesNotMatch(review, /<progress\b|assist-spin|<details className="publication-mark"/);
  assert.match(review, /<Spinner\b/);
  assert.match(review, /<ProgressBar\b/);
  assert.match(review, /<Popover\b/);
  assert.doesNotMatch(toolbar, /<details|review-more-menu/);
  assert.match(toolbar, /<Menu\b/);
  assert.doesNotMatch(review, /ui\("[^"]*"\)\}\{[a-z]/, 'no sentence is glued from a fragment and a value');
});

test('the intents replace the copies: one place builds a practice request, one opens a deck on the maintenance page', async () => {
  const shell = await readAppSource();
  assert.doesNotMatch(shell, /mode:\s*['"]path['"]/, 'practice requests are built by practiceArgs');
  assert.equal(count(await readFile('ui/learning-navigation.js', 'utf8'), /mode:\s*'path'/g), 1);
  assert.ok(count(app, /setGenSource\(/g) <= 2);
  assert.equal(count(shell, /setFolderDraft\(deck\.folder/g), 1);
  assert.equal(count(shell, /setHint\(false\)/g), 0, 'the entry is one object: emptyEntry()');
});

test('ModalFrame is gone and App holds no modal.type chain; the four dialogs are files behind one router', async () => {
  await assert.rejects(access('ui/ModalFrame.jsx'));
  assert.doesNotMatch(app, /modal\??\.type\s*===/);
  assert.doesNotMatch(await readAppSource(), /ModalFrame/);
  for (const file of ['FlagDialog', 'SourceListDialog', 'AddSourceDialog', 'SourceReaderDialog']) await access(`ui/app/modals/${file}.jsx`);
  assert.match(await readShellFile('ui/app/AppModalHost.jsx'), /export function ModalRouter/);
});

test('the dialogs that take files keep guardDrops (the add-material dialog and the reader), and Workflows can open the model settings', async () => {
  assert.match(await readShellFile('ui/app/modals/AddSourceDialog.jsx'), /<Dialog [^>]*guardDrops/);
  assert.match(await readShellFile('ui/app/modals/SourceReaderDialog.jsx'), /<Dialog [^>]*guardDrops/);
  assert.match(await readShellFile('ui/app/page-views.jsx'), /<Workflows [^>]*onOpenSettings=\{settingsEntry\.openModelSettings\}/);
});

test('the legacy focus trap is gone from the shell: Dialog owns focus, Escape and return', async () => {
  const shell = await readAppSource();
  assert.doesNotMatch(shell, /querySelector\('\[role="dialog"\]'\)|querySelector\("\[role=\\"dialog\\"\]"\)/);
  assert.doesNotMatch(shell, /previous\?\.focus/);
});

test('the shell reads its preferences through usePersistentState, and the poll through usePolling', async () => {
  const shell = await readAppSource();
  assert.doesNotMatch(shell, /localStorage\./);
  assert.ok(count(shell, /usePersistentState\(/g) >= 3, 'science, sidebar and EN (autopilot is a library setting now: 设置 › 练习)');
  assert.doesNotMatch(shell, /setInterval\(|setTimeout\(tick/);
});

test('every file of the shell is below a thousand lines, and the count of useState is reported', async () => {
  const files = await appSourceFiles();
  let states = 0;
  for (const { name, source } of files) {
    assert.ok(source.split('\n').length <= 1000, name);
    states += count(source, /\buseState\(/g);
  }
  assert.ok(states > 0);
});

// ── the dialogs ──
const render = (node) => renderToStaticMarkup(node);
const services = (patch = {}) => ({ call: async () => ({}), act: async () => undefined, busy: false, notify() {}, askInChat() {}, host: {}, openSettings() {}, navigate() {}, openModal() {}, ...patch });
const withServices = (node, patch) => h(m.StudyServicesContext.Provider, { value: services(patch) }, node);

test('FlagDialog: the save is the footer\'s one primary Button, and it shows work in progress', () => {
  m.setUiLanguage('zh');
  const run = { deckId: 'd', card: { id: 'c' } };
  const idle = render(withServices(h(m.FlagDialog, { run, onClose() {} })));
  assert.match(idle, /<dialog[^>]*sh-dialog--md/);
  const footer = idle.match(/<footer class="sh-dialog__footer">([\s\S]*)<\/footer>/)?.[1] ?? '';
  assert.match(footer, /<button[^>]*class="[^"]*sh-btn--primary[^"]*"[^>]*type="submit"|<button[^>]*type="submit"[^>]*class="[^"]*sh-btn--primary/);
  assert.match(footer, /保存标记/);
  const formId = idle.match(/<form id="([^"]+)"/)?.[1];
  assert.ok(formId && footer.includes(`form="${formId}"`), 'the footer button submits the form in the body');
  assert.doesNotMatch(idle.replace(footer, ''), /保存标记/, 'not in the body any more');
  const busy = render(withServices(h(m.FlagDialog, { run, onClose() {} }), { busy: true }));
  assert.match(busy, /<dialog[^>]*aria-busy="true"/, 'a running save locks the dialog (Dialog busy, not an if (!busy) guard)');
  assert.match(busy.match(/<footer[\s\S]*<\/footer>/)[0], /aria-busy="true"[^>]*disabled|disabled[^>]*aria-busy="true"/);
});

test('SourceListDialog and SourceReaderDialog: the reader is the full-size dialog, the list the medium one', () => {
  m.setUiLanguage('zh');
  const data = { sources: [{ id: 's1', title: '第一章.pdf' }] };
  const list = render(h(m.SourceListDialog, { modal: { type: 'sources', sourceIds: ['s1', 'gone'] }, data, run: null, onClose() {}, onOpenSource() {} }));
  assert.match(list, /<dialog[^>]*sh-dialog--md/);
  assert.equal(count(list, /class="[^"]*source-row/g), 1, 'a source that is gone is not listed');
  assert.match(list, /第一章\.pdf/);
  const fallbackFromRun = render(h(m.SourceListDialog, { modal: { type: 'sources' }, data, run: { sourceIds: ['s1'] }, onClose() {}, onOpenSource() {} }));
  assert.match(fallbackFromRun, /第一章\.pdf/, 'without ids of its own it lists the run\'s sources');
  const app = { data, host: {}, core: { call() {}, act() {}, busy: false, notify() {}, refresh() {} }, nav: { navigate() {} }, learn: {}, intents: {}, dailyPlan: null, selectionNotices: {} };
  const reader = render(h(m.AppContext.Provider, { value: app }, h(m.SourceReaderDialog, { modal: { type: 'source', quote: '一句话' }, onClose() {} })));
  assert.match(reader, /<dialog[^>]*class="[^"]*sh-dialog--full[^"]*source-preview/);
  assert.match(reader, /aria-label="资料内容"/);
  assert.match(reader, /资料不可用/);
  assert.match(reader, /一句话/, 'the quote that could not be found in a source still shows');
  m.setUiLanguage('en');
  try {
    const english = render(withServices(h(m.FlagDialog, { run: { deckId: 'd', card: { id: 'c' } }, onClose() {} }))) + render(h(m.AppContext.Provider, { value: app }, h(m.SourceReaderDialog, { modal: { type: 'source' }, onClose() {} })));
    assert.doesNotMatch(english, han);
  } finally { m.setUiLanguage('zh'); }
});

test('ModalRouter draws nothing without a modal and the reader for any unknown type', () => {
  const base = { data: { sources: [] }, host: {}, core: { call() {}, act() {}, busy: false, notify() {}, refresh() {} }, nav: { navigate() {} }, learn: {}, intents: {}, dailyPlan: null,
    selectionNotices: {}, session: { run: null }, set: { setModal() {} } };
  assert.equal(render(h(m.AppContext.Provider, { value: { ...base, lib: { modal: null } } }, h(m.ModalRouter))), '');
  assert.match(render(h(m.AppContext.Provider, { value: { ...base, lib: { modal: { type: 'whatever' } } } }, h(m.ModalRouter))), /source-preview/);
});
