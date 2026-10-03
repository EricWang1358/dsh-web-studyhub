import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { importedReferences, referenceSelection } from '../ui/reference-questions.js';
import { queueSteps } from '../ui/generation-path-flow.js';

const compiled = await build({ stdin: { contents: `export { default as Generate } from './ui/Generate.jsx';
  export { default as CaseCreate } from './ui/CaseCreate.jsx'; export { default as ReferenceQuestions } from './ui/ReferenceQuestions.jsx';
  export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() }, bundle: true, write: false,
  platform: 'node', format: 'cjs', external: ['react'], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const { Generate, CaseCreate, ReferenceQuestions, setUiLanguage } = module.exports;
// Exercise event closures without a browser, storage or executing effects/model calls.
const hooks = { ...React, useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {}, useCallback: callback => callback, useMemo: read => read(), useRef: initial => ({ current: initial }) };
const eventModule = { exports: {} };
const require = createRequire(import.meta.url);
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(name => name === 'react' ? hooks : require(name), eventModule, eventModule.exports);
const eventComponents = eventModule.exports;
function findElement(tree, predicate) {
  if (Array.isArray(tree)) return tree.map(item => findElement(item, predicate)).find(Boolean);
  if (!React.isValidElement(tree)) return undefined;
  return predicate(tree) ? tree : findElement(tree.props.children, predicate);
}
const noop = () => {};
const sources = [{ id: 'textbook', title: 'Teaching material', text: 'Verified source passage.' },
  { id: 'examples', title: 'My example questions.md', text: 'Question, answer and explanation.' }];
const data = { root: 'fixture', sources, decks: [], drafts: [], jobs: [], modelReady: true, focus: { courses: [] } };
const gen = { kind: 'quiz', count: 5, difficulty: 'mixed', language: 'English', focus: '', role: '' };
const render = (type, props) => renderToStaticMarkup(React.createElement(type, props));
function generation(overrides = {}) {
  return render(Generate, { data, gen, busy: false, genSource: 'files', selectedSources: ['textbook'],
    setGen: noop, setGenSource: noop, setSelectedSources: noop, setModal: noop, setNotice: noop,
    call: noop, act: noop, setPage: noop, ...overrides });
}

test('reference upload selections stay separate from factual sources, including repeat imports', () => {
  assert.deepEqual(importedReferences(['old'], ['examples', 'examples'], ['textbook', 'examples']),
    { referenceSourceIds: ['old', 'examples'], sourceIds: ['textbook'] });
  assert.deepEqual(referenceSelection(sources), { ids: [], chars: 0, reason: '' });
  assert.equal(referenceSelection(sources, ['examples'], ['textbook']).reason, '');
  assert.equal(referenceSelection(sources, ['examples'], ['examples']).reason, 'overlap');
  assert.equal(referenceSelection(sources, ['deleted']).reason, 'missing');
});

test('reference limits count source pages and complete text, with no silent truncation', () => {
  const pages = Array.from({ length: 6 }, (_, index) => ({ id: String(index), chars: 100 }));
  assert.equal(referenceSelection(pages, pages.map(page => page.id)).reason, 'size');
  assert.equal(referenceSelection([{ id: 'a', text: 'x'.repeat(12001) }], ['a']).reason, 'size');
  assert.equal(referenceSelection([{ id: 'a', text: 'x'.repeat(12000) }], ['a']).reason, '');
});

test('the optional selector explains style-only reuse and supports both UI languages', () => {
  try {
    for (const language of ['zh', 'en']) {
      setUiLanguage(language);
      const html = render(ReferenceQuestions, { sources, selected: ['examples'], evidenceIds: ['textbook'], onChange: noop, onImport: noop });
      assert.doesNotMatch(html, /Teaching material/);
      assert.match(html, /My example questions/);
      assert.match(html, /12,000/);
      if (language === 'en') {
        assert.match(html, /Upload reference questions/);
        assert.match(html, /facts and answers still require textbook evidence/);
        assert.match(html, /configured model/);
        assert.doesNotMatch(html.replace(/<[^>]*>/g, ''), /[㐀-鿿]/);
      } else assert.match(html, /事实和答案仍以教材依据为准/);
    }
  } finally { setUiLanguage('zh'); }
});

test('oversized references block generation visibly while the default remains optional', () => {
  const huge = { id: 'large', title: 'Large samples', chars: 12001 };
  const html = generation({ data: { ...data, sources: [...sources, huge] }, gen: { ...gen, referenceSourceIds: ['large'] } });
  assert.match(html, /role="alert"/);
  assert.match(html, /type="submit"[^>]*disabled/);
  assert.doesNotMatch(generation(), /role="alert"/);
});

test('missing references can be cleared even when every remaining source is selected as evidence', () => {
  const props = { sources: [sources[0]], selected: ['deleted'], evidenceIds: ['textbook'], onImport: noop };
  let next;
  const tree = eventComponents.ReferenceQuestions({ ...props, onChange: ids => { next = ids; } });
  const clear = findElement(tree, node => node.props.children === '清空样题选择');
  assert.ok(clear, 'clearing stays available outside an empty source picker');
  clear.props.onClick();
  assert.deepEqual(next, []);
  const html = render(ReferenceQuestions, { ...props, onChange: noop });
  assert.match(html, /role="alert"/);
  assert.match(html, /清空样题选择/);
  assert.doesNotMatch(generation({ data: { ...data, sources: [sources[0]] }, gen: { ...gen, referenceSourceIds: next } }), /role="alert"/);
});

test('case generation offers examples, while importing a supplied case does not rewrite it with samples', () => {
  const props = { data, call: noop, act: noop, setNotice: noop, openImport: noop, openReferenceImport: noop };
  assert.match(render(CaseCreate, { ...props, initial: { sourceIds: ['textbook'], referenceSourceIds: ['examples'] } }), /参考样题（可选）/);
  assert.doesNotMatch(render(CaseCreate, { ...props, initial: { mode: 'import' } }), /参考样题（可选）/);
});

test('generation paths forward the same optional examples into every factual step', async () => {
  const calls = [];
  await queueSteps(async (operation, args) => { calls.push({ operation, args }); return { id: 'fixture' }; },
    [{ sourceIds: ['textbook'], count: 2, focus: '' }], { ...gen, referenceSourceIds: ['examples'] });
  assert.deepEqual(calls[0].args.sourceIds, ['textbook']);
  assert.deepEqual(calls[0].args.referenceSourceIds, ['examples']);
});

test('submit events send reference examples separately, while uploads open the reference import route', () => {
  const submitted = [], modals = [];
  const tree = eventComponents.Generate({ data, gen: { ...gen, referenceSourceIds: ['examples'] }, busy: false,
    genSource: 'files', selectedSources: ['textbook'], setGen: noop, setGenSource: noop, setSelectedSources: noop,
    setModal: modal => modals.push(modal), setNotice: noop, setPage: noop, call: noop,
    act: (operation, args) => submitted.push({ operation, args }) });
  findElement(tree, node => node.type === 'form').props.onSubmit({ preventDefault: noop });
  assert.equal(submitted[0].operation, 'generate');
  assert.deepEqual(submitted[0].args.sourceIds, ['textbook']);
  assert.deepEqual(submitted[0].args.referenceSourceIds, ['examples']);
  findElement(tree, node => node.type === eventComponents.ReferenceQuestions).props.onImport();
  assert.equal(modals[0].type, 'add');
  assert.equal(modals[0].referenceQuestions, true);
});

test('case submit events carry optional examples without treating them as course sources', () => {
  const submitted = [];
  const tree = eventComponents.CaseCreate({ data, busy: false, setNotice: noop, call: noop,
    initial: { sourceIds: ['textbook'], referenceSourceIds: ['examples'] },
    act: (operation, args) => submitted.push({ operation, args }) });
  tree.props.onSubmit({ preventDefault: noop });
  assert.equal(submitted[0].args.kind, 'case');
  assert.deepEqual(submitted[0].args.sourceIds, ['textbook']);
  assert.deepEqual(submitted[0].args.referenceSourceIds, ['examples']);
});
