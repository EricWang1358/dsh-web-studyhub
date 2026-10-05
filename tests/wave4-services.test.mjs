import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { withStudy, services } from './helpers/study-services.mjs';

// Wave 4 item 7 (#113): the pages read call / act / busy / askInChat from useStudy(), not from props that App threads down.
const read = (file) => readFileSync(file, 'utf8');

/* page file -> the services it takes from the context */
const PAGES = {
  'ui/Manage.jsx': ['call', 'busy', 'act'], 'ui/Draft.jsx': ['call', 'busy', 'act'], 'ui/Generate.jsx': ['call', 'busy', 'act', 'askInChat'],
  'ui/Sources.jsx': ['call', 'busy', 'act'], 'ui/Workflows.jsx': ['call', 'askInChat'], 'ui/WorkflowPortal.jsx': ['call', 'askInChat'],
  'ui/Skeleton.jsx': ['call', 'busy', 'askInChat'], 'ui/WrongBook.jsx': ['call', 'busy'], 'ui/Exam.jsx': ['call'], 'ui/OralExam.jsx': ['call'],
  'ui/AudioImport.jsx': ['call', 'busy', 'act', 'askInChat'], 'ui/Dashboard.jsx': ['call', 'busy'], 'ui/AudioDashboard.jsx': ['call'],
  'ui/CaseCreate.jsx': ['busy', 'act'], 'ui/BlogNotes.jsx': ['call', 'busy', 'act'], 'ui/ImportHub.jsx': ['call', 'busy'],
};

test('each page asks useStudy() for its services and no longer takes them as props (#113)', () => {
  for (const [file, names] of Object.entries(PAGES)) {
    const source = read(file);
    const header = /export default function \w+\(\{([\s\S]*?)\}\)\s*\{/.exec(source)?.[1] ?? /function PortalBody\(\{([^}]*)\}/.exec(source)?.[1] ?? '';
    for (const name of names) {
      assert.doesNotMatch(header, new RegExp(`(^|[\\s,])${name}\\s*(=|,|$)`), `${file}: ${name} is still a prop`);
      assert.match(source, new RegExp(`const \\{[^}]*\\b${name}\\b[^}]*\\} = useStudy\\(\\)`), `${file}: ${name} is not read from useStudy()`);
    }
  }
});

test('App\'s page views stop passing them (#113)', () => {
  const views = read('ui/app/page-views.jsx');
  for (const page of ['Manage', 'Draft', 'Generate', 'Sources', 'Workflows', 'Skeleton', 'WrongBook', 'Exam', 'AudioImport', 'Dashboard', 'AudioDashboard', 'BlogNotes']) {
    const tag = new RegExp(`<${page}\\b[^>]*?(?:call|busy|act|askInChat)=\\{core\\.`, 's');
    assert.doesNotMatch(views.replace(/\n\s+/g, ' '), tag, `<${page}> still gets a core service as a prop`);
  }
  assert.doesNotMatch(read('ui/app/modals/AddSourceDialog.jsx'), /<(ImportHub|AudioImport)\b[^>]*\b(call|busy|act|askInChat)=/s);
});

const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `export { default as Manage } from './ui/Manage.jsx'; export { default as WrongBook } from './ui/WrongBook.jsx'; export { StudyServicesContext } from './ui/study-context.jsx'; export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);

test('a page in the app disables itself from the busy service, and not outside it (#113)', () => {
  const deck = { id: 'd', title: 'Deck', cards: [], folder: '' };
  const page = React.createElement(module.exports.Manage, { openDraft() {}, setPage() {}, managedDeck: deck, decks: [deck], sources: [], setManagedDeck() {}, folderDraft: '', setFolderDraft() {}, onRemoveDeck() {} });
  const busy = renderToStaticMarkup(withStudy(module.exports.StudyServicesContext, page, { busy: true }));
  const idle = renderToStaticMarkup(withStudy(module.exports.StudyServicesContext, page, { busy: false }));
  assert.match(busy, /<button[^>]*disabled=""[^>]*>[^<]*编辑题组/);
  assert.doesNotMatch(idle, /<button[^>]*disabled=""[^>]*>[^<]*编辑题组/);
  assert.equal(typeof services().act, 'function');
});
