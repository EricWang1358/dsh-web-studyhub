import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { importedReferences, referenceSelection } from '../ui/reference-questions.js';
import { queueSteps } from '../ui/generation-path-flow.js';
import { services as studyServices } from './helpers/study-services.mjs';

const compiled = await build({ stdin: { contents: `export { default as Generate } from './ui/Generate.jsx';
  export { default as CaseCreate } from './ui/CaseCreate.jsx'; export { default as ReferenceQuestions } from './ui/ReferenceQuestions.jsx';
  export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() }, bundle: true, write: false,
  platform: 'node', format: 'cjs', external: ['react'], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const { Generate, CaseCreate, ReferenceQuestions, setUiLanguage } = module.exports;
// Exercise event closures without a browser, storage or executing effects/model calls.
const services = { current: null }; // what useStudy() answers inside the event closures (see tests/helpers/study-services.mjs)
const hooks = { ...React, useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useInsertionEffect: () => {}, useContext: () => services.current, useEffect: () => {}, useCallback: callback => callback, useMemo: read => read(), useRef: initial => ({ current: initial }) };
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

test('configured limits accept more excerpts and text while enforcing shared hard caps', () => {
  const pages = Array.from({ length: 6 }, (_, index) => ({ id: String(index), chars: 2500 }));
  const ids = pages.map(page => page.id);
  assert.equal(referenceSelection(pages, ids, [], { sources: 6, chars: 15000 }).reason, '');
  assert.equal(referenceSelection(pages, ids, [], { sources: 6, chars: 14999 }).reason, 'size');
  assert.equal(referenceSelection(pages, ids, [], { sources: 5, chars: 15000 }).reason, 'size');
  assert.equal(referenceSelection(pages, ids, [], { sources: 50, chars: 100000 }).reason, '');
  for (const limits of [null, [], 5, { sources: '' }, { sources: '6' }, { sources: 1.5 }, { sources: 51 },
    { chars: Number.NaN }, { chars: 100001 }, { chars: 0 }, { sources: -1 }, { extra: 1 }])
    assert.equal(referenceSelection(pages, ids, [], limits).reason, 'limits', String(limits));
});

test('editable limit controls preserve invalid edits, use shared defaults and disable while busy', () => {
  const changes = [];
  const tree = ReferenceQuestions({ sources, onChange: noop, onImport: noop, onLimitsChange: value => changes.push(value) });
  const group = findElement(tree, node => node.props.role === 'group');
  const sourceInput = group.props.children[0].props.children[1];
  const charsInput = group.props.children[1].props.children[1];
  assert.equal(sourceInput.props.value, 5);
  assert.equal(sourceInput.props.max, 50);
  assert.equal(charsInput.props.value, 12000);
  assert.equal(charsInput.props.max, 100000);
  sourceInput.props.onChange({ target: { value: '8' } });
  charsInput.props.onChange({ target: { value: '' } });
  assert.deepEqual(changes, [{ sources: 8, chars: 12000 }, { sources: 5, chars: '' }]);
  const busyHtml = render(ReferenceQuestions, { sources, busy: true, selected: [], onChange: noop, onImport: noop });
  assert.equal((busyHtml.match(/type="number"[^>]*disabled/g) || []).length, 2);
  assert.match(busyHtml, /已选择 0 个样题片段/);
  assert.match(render(ReferenceQuestions, { sources, limits: { sources: 1.5 }, onChange: noop, onImport: noop }), /role="alert"/);
});

test('the three-stop format slider emits enums and defaults to balanced with readable labels', () => {
  const choices = [];
  const tree = ReferenceQuestions({ sources, onChange: noop, onImport: noop, onFormatChange: value => choices.push(value) });
  const slider = findElement(tree, node => node.props.type === 'range');
  assert.deepEqual([slider.props.min, slider.props.max, slider.props.step, slider.props.value], ['0', '2', '1', 1]);
  for (const value of ['0', '1', '2']) slider.props.onChange({ target: { value } });
  assert.deepEqual(choices, ['flexible', 'balanced', 'strict']);
  assert.equal(referenceSelection(sources, ['examples'], [], undefined, 'strict').reason, '');
  for (const value of ['', null, 'maximum', 100])
    assert.equal(referenceSelection(sources, [], [], undefined, value).reason, 'format');
  assert.match(render(ReferenceQuestions, { sources, busy: true, format: 'strict', onChange: noop, onImport: noop }), /type="range"[^>]*disabled/);
  assert.match(render(ReferenceQuestions, { sources, format: 'invalid', onChange: noop, onImport: noop }), /role="alert"/);
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
    [{ sourceIds: ['textbook'], count: 2, focus: '' }], { ...gen, referenceSourceIds: ['examples'], referenceLimits: { sources: 8, chars: 20000 }, referenceFormat: 'strict' });
  assert.deepEqual(calls[0].args.sourceIds, ['textbook']);
  assert.deepEqual(calls[0].args.referenceSourceIds, ['examples']);
  assert.deepEqual(calls[0].args.referenceLimits, { sources: 8, chars: 20000 });
  assert.equal(calls[0].args.referenceFormat, 'strict');
});

test('submit events send reference examples separately, while uploads open the reference import route', () => {
  const submitted = [], modals = [];
  const limits = { sources: 8, chars: 20000 };
  services.current = studyServices({ act: (operation, args) => submitted.push({ operation, args }) });
  const tree = eventComponents.Generate({ data, gen: { ...gen, referenceSourceIds: ['examples'], referenceLimits: limits, referenceFormat: 'strict' },
    genSource: 'files', selectedSources: ['textbook'], setGen: noop, setGenSource: noop, setSelectedSources: noop,
    setModal: modal => modals.push(modal), setPage: noop });
  services.current = null;
  findElement(tree, node => node.type === 'form').props.onSubmit({ preventDefault: noop });
  assert.equal(submitted[0].operation, 'generate');
  assert.deepEqual(submitted[0].args.sourceIds, ['textbook']);
  assert.deepEqual(submitted[0].args.referenceSourceIds, ['examples']);
  assert.deepEqual(submitted[0].args.referenceLimits, limits);
  assert.equal(submitted[0].args.referenceFormat, 'strict');
  assert.deepEqual(findElement(tree, node => node.props.request?.feature === 'generate').props.request.referenceLimits, limits);
  assert.equal(findElement(tree, node => node.props.request?.feature === 'generate').props.request.referenceFormat, 'strict');
  findElement(tree, node => node.type === eventComponents.ReferenceQuestions).props.onImport();
  assert.equal(modals[0].type, 'add');
  assert.equal(modals[0].referenceQuestions, true);
});

test('case submit events carry optional examples without treating them as course sources', () => {
  const submitted = [];
  const limits = { sources: 8, chars: 20000 };
  services.current = studyServices({ act: (operation, args) => submitted.push({ operation, args }) });
  const tree = eventComponents.CaseCreate({ data,
    initial: { sourceIds: ['textbook'], referenceSourceIds: ['examples'], referenceLimits: limits, referenceFormat: 'flexible' } });
  services.current = null;
  tree.props.onSubmit({ preventDefault: noop });
  assert.equal(submitted[0].args.kind, 'case');
  assert.deepEqual(submitted[0].args.sourceIds, ['textbook']);
  assert.deepEqual(submitted[0].args.referenceSourceIds, ['examples']);
  assert.deepEqual(submitted[0].args.referenceLimits, limits);
  assert.equal(submitted[0].args.referenceFormat, 'flexible');
  assert.deepEqual(findElement(tree, node => node.props.request?.feature === 'case').props.request.referenceLimits, limits);
  assert.equal(findElement(tree, node => node.props.request?.feature === 'case').props.request.referenceFormat, 'flexible');
});
