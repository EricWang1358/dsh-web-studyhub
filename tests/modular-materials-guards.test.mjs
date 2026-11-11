/* global File */
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { loadUi } from './helpers/ui-module.mjs';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));

const uiMod = await loadUi(`
  export { fallbackLandingPage } from './ui/app/use-initial-landing.js';
  export { runImport } from './ui/ImportHub.jsx';
  export { selectionMenu } from './ui/document-preview/marks/model.js';
  export { setUiLanguage } from './ui/i18n.js';
`);
const { fallbackLandingPage, runImport, selectionMenu, setUiLanguage } = uiMod;

test('fallbackLandingPage chooses the first available main or grouped page when library is disabled', () => {
  assert.equal(fallbackLandingPage({ contexts: ['library', 'bank', 'study'] }), 'library');
  assert.equal(fallbackLandingPage({ contexts: ['library', 'materials'] }), 'sources');
  assert.equal(fallbackLandingPage({ contexts: ['library', 'notes'] }), 'tasks');
  assert.equal(fallbackLandingPage({ contexts: ['library'] }), 'tasks');
});

test('runImport blocks deck JSON with a clear permanent message when deckImport is disabled, while allowing converted textbook JSON', async () => {
  const calls = [];
  const call = async (action, args) => {
    calls.push(action);
    if (action === 'materials.document.import') {
      return { documentId: 'doc-1', sourceIds: ['src-1'], document: { title: args.filename, format: 'json', sources: [{ id: 'src-1', document: { converter: 'mineru' } }] } };
    }
    throw new Error(`Unexpected call: ${action}`);
  };

  const deckFile = new File([JSON.stringify({ title: 'OS Quiz', cards: [{ prompt: 'Q', answer: 'A' }] })], 'os-deck.json', { type: 'application/json' });
  setUiLanguage('zh');
  const zhRes = await runImport([deckFile], { call, deckImport: false });
  assert.equal(zhRes[0].status, 'error');
  assert.equal(zhRes[0].permanent, true);
  assert.match(zhRes[0].error, /需要启用题库与出题组件/);
  assert.deepEqual(calls, [], 'draft.import.propose must not be called when deckImport is false');

  setUiLanguage('en');
  try {
    const enRes = await runImport([deckFile], { call, deckImport: false });
    assert.match(enRes[0].error, /turn on the question bank and authoring components/i);
  } finally {
    setUiLanguage('zh');
  }

  const convertedJson = JSON.stringify([
    { type: 'text', text: 'Chapter 1 Operating Systems', page_idx: 0 },
    { type: 'text', text: 'Processes and threads overview.', page_idx: 1 },
  ]);
  const bookFile = new File([convertedJson], 'os-book.json', { type: 'application/json' });
  const bookRes = await runImport([bookFile], { call, deckImport: false });
  assert.equal(bookRes[0].status, 'done');
  assert.equal(bookRes[0].result.kind, 'document');
  assert.deepEqual(calls, ['materials.document.import']);
});

test('selectionMenu hides mark:queue when canQueue is false while preserving strokes, explain, and existing unmark:queue', () => {
  const withoutQueue = selectionMenu({ here: [], explain: 'ready', canQueue: false });
  assert.equal(withoutQueue.some(item => item.id === 'mark:queue'), false);
  assert.equal(withoutQueue.some(item => item.id === 'mark:underline'), true);
  assert.equal(withoutQueue.some(item => item.id === 'explain'), true);

  const existingQueue = selectionMenu({ here: [{ id: 'q1', style: 'queue' }], explain: 'ready', canQueue: false });
  assert.equal(existingQueue.some(item => item.id === 'unmark:queue'), true, 'existing queue mark can still be removed');
});

test('ESLint context-boundaries/no-private-context-import blocks cross-context private imports, bare dirs, template literals, and query spoofing while permitting contracts.js', async () => {
  const eslint = new ESLint({ cwd: repoRoot });
  const filePath = join(repoRoot, 'lib/contexts/notes/jobs/note-generate.js');
  const rootContextFile = join(repoRoot, 'lib/contexts/notes/index.js');

  for (const [code, targetFile, label] of [
    [`import { view } from '../../audio/jobs/view.js';\nexport const x = view;\n`, filePath, 'static relative import'],
    [`export const load = () => import('../../audio/index.js');\n`, filePath, 'dynamic import'],
    [`export const load = () => import('../audio/index.js');\n`, rootContextFile, '1-level dynamic import'],
    [`export const load = () => import('../audio');\n`, rootContextFile, 'bare directory import without trailing slash'],
    [`export const load = () => import(\`../audio/index.js\`);\n`, rootContextFile, 'static template literal dynamic import'],
    [`import * as x from '../../audio/index.js?spoof=/lib/contexts/audio/contracts.js';\nexport const y = x;\n`, filePath, 'query-string contracts.js spoof'],
  ]) {
    const res = await eslint.lintText(code, { filePath: targetFile });
    assert.ok(res[0].messages.some(m => m.ruleId === 'context-boundaries/no-private-context-import'), `${label} must fail`);
  }

  const goodContract = await eslint.lintText(`import * as audioContract from '../../audio/contracts.js';\nimport * as own from '../note-generation.js';\nexport const ok = [audioContract, own];\n`, { filePath });
  assert.deepEqual(goodContract[0].messages.filter(m => m.ruleId === 'context-boundaries/no-private-context-import'), []);
});
