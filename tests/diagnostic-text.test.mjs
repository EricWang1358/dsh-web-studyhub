import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { diagnosticText } from '../ui/diagnostics.js';
import { plainReason } from '../lib/plain-reason.js';
import { nativeSelects } from './helpers/native-selects.mjs';
import { click, textOf, withBrowserGlobals } from './helpers/react-harness.mjs';

/* The copyable diagnostic text (#893 S2, S5): built from a short whitelist of fields, and everything free-form that goes in
   (the error) is redacted. The privacy scan follows tests/usage-privacy.test.mjs: put every kind of private content where it
   could leak, build the text, search the text for each piece. */

const WINDOWS = 'C:\\Users\\student\\Documents\\notes\\midterm.docx';
const POSIX = '/home/student/courses/db/lecture-07.pdf';
const BEARER = 'Bearer abc123SECRETtoken987';
const KEY = 'sk-proj-AbCdEf0123456789XyZ0123456789';
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzdHVkZW50In0.c2lnbmF0dXJlMTIzNDU';
const MATERIAL_EN = 'The mitochondria is the powerhouse of the cell and it produces most of the ATP';
const MATERIAL_ZH = '线粒体是细胞进行有氧呼吸的主要场所';
const QUERY = 'https://school.example/api/file?signature=SECRET-SIG-99';
const PRIVATE = [WINDOWS, POSIX, BEARER, 'abc123SECRETtoken987', KEY, JWT, MATERIAL_EN, MATERIAL_ZH, 'SECRET-SIG-99', 'student',
  'midterm.docx', 'lecture-07.pdf', 'ZZ-Deck 期中冲刺卷', 'ZZ-Source 数据库系统概论.pdf', 'ZZ-Question what is a transaction', 'ZZ-job-title 私人笔记转写'];

function leakyError() {
  const error = new TypeError(`Cannot read properties of undefined (reading 'map') at ${WINDOWS} while opening ${POSIX} with ${BEARER} and ${KEY} ${JWT} ${QUERY}: "${MATERIAL_EN}" 内容：${MATERIAL_ZH}`);
  error.stack = `TypeError: ${error.message}\n    at render (${WINDOWS}:10:5)\n    at Object.run (${POSIX}:3:9)\n    at Page (https://localhost/client.js?token=SECRET-SIG-99:1:2)\n    ${MATERIAL_EN}`;
  return error;
}
const snapshot = () => ({
  root: WINDOWS,
  sources: [{ id: 's1', title: 'ZZ-Source 数据库系统概论.pdf', name: 'lecture-07.pdf', text: MATERIAL_EN }, { id: 's2', title: 'second', text: MATERIAL_ZH }],
  decks: [{ id: 'd1', title: 'ZZ-Deck 期中冲刺卷', count: 12, cards: [{ prompt: 'ZZ-Question what is a transaction' }] }, { id: 'd2', title: 'other', count: 30 }],
  attempts: [{ answer: MATERIAL_ZH }],
  jobs: [{ id: 'j1', type: 'generation', status: 'complete', title: 'ZZ-job-title 私人笔记转写', error: MATERIAL_EN, path: POSIX }],
  experimental: true,
});

test('the diagnostic text of a crash holds none of the private content that was put around it', () => {
  const text = diagnosticText({ version: '4.6.2', language: 'zh', page: 'library', error: leakyError(), data: snapshot() });
  for (const piece of PRIVATE) assert.ok(!text.includes(piece), `"${piece}" leaked into:\n${text}`);
  assert.ok(!/sk-[A-Za-z0-9]/.test(text) && !/eyJ/.test(text) && !/[A-Za-z]:\\/.test(text) && !/\/home\//.test(text), text);
});

test('what a bug report needs is still there: version, language, page, the kind of error and where it broke', () => {
  const error = Object.assign(new TypeError("Cannot read properties of undefined (reading 'map')"), { stack: leakyError().stack });
  const text = diagnosticText({ version: '4.6.2', language: 'en', page: 'wrongbook', error, data: snapshot() });
  assert.match(text, /StudyHub version: 4\.6\.2/);
  assert.match(text, /Interface language: en/);
  assert.match(text, /Page: wrongbook/);
  assert.match(text, /TypeError/);
  assert.match(text, /Cannot read properties of undefined \(reading 'map'\)/);
  assert.match(text, /^  at render$/m, 'a frame keeps only the function that broke: no URL, path or position');
  assert.match(text, /DSH version: .*手动|DSH version: .*by hand/, 'the one thing the page cannot know is left to be filled in by hand');
});

/* Counter-examples from the review of #905: each is a message a learner's own data can end up in, on its own and again as the first line of a stack. */
const LEAKS = [
  ['题组「期中冲刺卷」没有题目', ['期中冲刺卷']],
  ['Restore the archived deck "期中" before opening it', ['期中']],
  ["Cannot read properties of undefined (reading '数据库系统概论')", ['数据库系统概论']],
  ['Failed to open 期中复习笔记.pdf', ['期中复习笔记']],
  [String.raw`C:\Users\Eric Wang\Desktop\期中 笔记 final.pdf`, ['Eric Wang', '期中 笔记', 'final.pdf']],
  ['/Users/Eric Wang/Documents/week 3.pdf', ['Eric Wang', 'week 3']],
  [String.raw`\\fileserver\students\e0123456\notes.pdf`, ['fileserver', 'e0123456', 'notes.pdf']],
  ['AIzaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q', ['AIzaSy']],
  ['request failed with gsk_abcdefghijklmnopqrstuvwxyz0123456789', ['gsk_']],
  ['download failed hf_AbCdEfGhIjKlMnOpQrStUvWxYz012345', ['hf_']],
  ['bad config api_key=veryprivatevalue12345', ['veryprivatevalue']],
  ['sent to student.name@school.example.edu failed', ['student.name', 'school.example']],
  ['Unexpected token \'T\', "The mitoch"... is not valid JSON', ['mitoch']],
];
const FRAMES = [
  'at Page (file:///Users/ericwang/dsh/ui/page.js:10:5)',
  'at Object.run (C:\\Users\\Eric Wang\\dsh\\ui.js:3:9)',
  'at 期中复习笔记.pdf (https://localhost/x.js?token=SECRET-SIG-99:1:2)',
  'at https://localhost/client.js:5:5',
  'render@file:///Users/ericwang/dsh/ui.js:1:1',
];

test('nothing a learner\'s data can put in an error message or a stack frame reaches the text', () => {
  for (const [message, parts] of LEAKS) {
    const error = new Error(message);
    error.stack = `Error: ${message}\n    ${FRAMES.join('\n    ')}`;
    for (const variant of [error, message, Object.assign(new Error('x'), { message: 'x', stack: error.stack })]) {
      const text = diagnosticText({ version: '4.6.2', language: 'zh', page: 'library', error: variant });
      for (const part of [...parts, 'ericwang', 'Eric Wang', 'SECRET-SIG', 'file://', 'https://', '期中复习笔记']) assert.ok(!text.includes(part), `"${part}" leaked from "${message}" into:\n${text}`);
    }
  }
});

test('the lines of a multi-line message are not read as stack frames, in the message or at the top of the stack', () => {
  const message = 'line one\nericwang@gmail.com\n  at Deck_Midterm (x)';
  const stack = `Error: ${message}\n    at render (https://localhost/client.js:10:5)\n    at Object.run (C:\\Users\\a\\x.js:3:9)\n    at https://localhost/client.js:5:5\n    mount@https://localhost/client.js:1:1`;
  for (const error of [Object.assign(new Error(message), { stack }), Object.assign(new Error(message), { stack: `${message}\n${stack}`.replace(`Error: ${message}\n`, '') })]) {
    const text = diagnosticText({ version: '1', language: 'zh', page: 'library', error });
    for (const part of ['ericwang', 'gmail', 'Deck_Midterm', 'line one']) assert.ok(!text.includes(part), `"${part}" leaked into:\n${text}`);
    for (const frame of ['  at render', '  at Object.run', '  at <anonymous>', '  at mount']) assert.ok(text.split('\n').includes(frame), `${frame} missing from:\n${text}`);
  }
  // a line that only looks like a frame has no position at its end, so it is no frame
  const text = diagnosticText({ version: '1', language: 'zh', page: 'library', error: Object.assign(new Error('x'), { stack: 'Error: x\n    at Deck_Midterm_Review (x)\n    notes.pdf@x\n    ericwang@gmail.com' }) });
  assert.doesNotMatch(text, /Deck_Midterm|notes|ericwang/);
});

test('the "is not ..." messages are copied only for a code-shaped subject, never a file name', () => {
  const kept = ['e.cards.map is not a function', 'data?.decks is not iterable', 'a[0].b is not a function', 'Foo is not a constructor', 'React is not defined'];
  const withheld = ['notes.pdf is not defined', 'midterm.docx is not a function', 'x.json is not iterable', 'lecture-07.pdf is not defined', '期中.cards is not iterable'];
  const messageOf = text => diagnosticText({ version: '1', language: 'zh', page: 'library', error: new Error(text) }).split('\n').find(line => line.startsWith('Message: '));
  for (const text of kept) assert.equal(messageOf(text), `Message: ${text}`);
  for (const text of withheld) assert.match(messageOf(text), /^Message: \(not copied: \d+ characters; see 技术详情\)$/, text);
});

test('an error message that is not one of the engine\'s own is replaced by its length, in Chinese or English', () => {
  const text = diagnosticText({ version: '1', language: 'zh', page: 'library', error: new Error('题组「期中冲刺卷」没有题目') });
  assert.match(text, /Message: \(not copied: 13 characters; see 技术详情\)/);
  const english = diagnosticText({ version: '1', language: 'en', page: 'library', error: new Error('secret deck name') });
  assert.match(english, /Message: \(not copied: 16 characters; see Technical details\)/);
  assert.doesNotMatch(english, /[\u3400-\u9fff]/);
});

test('the engine\'s own messages are kept: they say what broke and hold nothing of the learner\'s', () => {
  for (const message of ["Cannot read properties of undefined (reading 'map')", 'e.cards.map is not a function', 'Minified React error #31']) {
    const lines = diagnosticText({ version: '1', language: 'zh', page: 'library', error: new Error(message) }).split('\n');
    assert.ok(lines.includes(`Message: ${message}`), lines.join('\n'));
  }
  const react = diagnosticText({ version: '1', language: 'zh', page: 'library', error: new Error('Minified React error #31; visit https://react.dev/errors/31?args[]=object%20with%20keys%20%7B期中%7D for the full message') });
  assert.match(react, /Message: Minified React error #31$/m);
  assert.ok(!react.includes('期中') && !react.includes('react.dev'));
  assert.match(diagnosticText({ version: '1', language: 'zh', page: 'library', error: new Error('Maximum update depth exceeded. This can happen when a component calls setState') }), /Message: Maximum update depth exceeded$/m);
});

test('the error name is a plain token, else just Error', () => {
  const error = new Error("Cannot read properties of null (reading 'x')");
  error.name = '期中冲刺卷 failed';
  assert.match(diagnosticText({ version: '1', language: 'zh', page: 'library', error }), /^Error: Error$/m);
});

test('the library is described by counts, the jobs by kind and status, the switches by name, and nothing else', () => {
  const text = diagnosticText({ version: '4.6.2', language: 'zh', page: 'library', data: snapshot() });
  assert.match(text, /sources 2, decks 2, questions 42/);
  assert.match(text, /generation\/complete/);
  assert.match(text, /Experimental features: on/);
  assert.doesNotMatch(text, /Error:/, 'with no error (copied from Settings) there is no error section');
});

test('only the last 20 jobs are listed', () => {
  const jobs = Array.from({ length: 30 }, (_, index) => ({ type: `kind${index}`, status: 'done' }));
  const text = diagnosticText({ version: '1', language: 'zh', page: 'tasks', data: { jobs } });
  assert.ok(!text.includes('kind9/'), 'the 10th is older than the last 20');
  assert.ok(text.includes('kind10/done') && text.includes('kind29/done'));
});

test('a snapshot that is missing, or has strange fields, gives a short text and does not throw', () => {
  for (const data of [undefined, null, {}, { sources: 'x', decks: [null, { count: -3 }, { count: 'many' }], jobs: [null, { type: 'a b c <script>', status: {} }] }]) {
    const text = diagnosticText({ version: undefined, language: 'fr', page: '../../etc/passwd', error: 'plain string', data });
    assert.match(text, /StudyHub version: unknown/);
    assert.match(text, /Page: unknown/);
    assert.ok(!text.includes('<script>') && !text.includes('passwd'), text);
  }
});

test('plainReason also removes an API key, so every caller of it gains the same cover', () => {
  assert.equal(plainReason(`key ${KEY} end`), 'key end');
  assert.equal(plainReason('model gpt-4 is not sk-ill, nor a task-list'), 'model gpt-4 is not sk-ill, nor a task-list');
});

async function loadBoundaryApp() {
  const require = createRequire(import.meta.url);
  const ELEMENT = Symbol.for('react.transitional.element');
  const FRAGMENT = Symbol.for('react.fragment');
  const SUSPENSE = Symbol.for('react.suspense');
  const MEMO = Symbol.for('react.memo');
  const FWD = Symbol.for('react.forward_ref');
  const CTX = Symbol.for('react.context');
  const PROVIDER = Symbol.for('react.provider');
  const LAZY = Symbol.for('react.lazy');
  const instances = new Map();
  const ctxStack = new Map();
  let curInst = null, hookIdx = 0, idSeq = 0, dirty = false, active = new Set(), pendingEffects = [];
  const depsEq = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const slot = () => ({ inst: curInst, i: hookIdx++ });
  const pushCtx = (c, v) => { const s = ctxStack.get(c) || []; s.push(v); ctxStack.set(c, s); };
  const popCtx = (c) => { ctxStack.get(c)?.pop(); };
  const readCtx = (c) => { const s = ctxStack.get(c); return s && s.length ? s[s.length - 1] : c._currentValue; };

  class Component {
    constructor(props) { this.props = props; this.state = {}; }
    setState(next) {
      const patch = typeof next === 'function' ? next(this.state, this.props) : next;
      this.state = { ...this.state, ...patch };
      dirty = true;
    }
  }
  const R = {
    Fragment: FRAGMENT, Suspense: SUSPENSE, StrictMode: FRAGMENT, Component, PureComponent: Component,
    createElement(type, rawProps, ...rawChildren) {
      const props = rawProps ? { ...rawProps } : {};
      const key = props.key !== undefined && props.key !== null ? String(props.key) : null;
      const ref = props.ref !== undefined ? props.ref : null;
      delete props.key;
      if (rawChildren.length === 1) props.children = rawChildren[0];
      else if (rawChildren.length > 1) props.children = rawChildren;
      return { $$typeof: ELEMENT, type, key, ref, props };
    },
    cloneElement(el, rawProps, ...rawChildren) {
      const props = { ...el.props, ...(rawProps || {}) };
      const key = rawProps?.key !== undefined && rawProps?.key !== null ? String(rawProps.key) : el.key;
      delete props.key;
      if (rawChildren.length === 1) props.children = rawChildren[0];
      else if (rawChildren.length > 1) props.children = rawChildren;
      return { $$typeof: ELEMENT, type: el.type, key, ref: el.ref, props };
    },
    isValidElement: (x) => Boolean(x && typeof x === 'object' && x.$$typeof === ELEMENT),
    Children: {
      toArray: (c) => (c == null || typeof c === 'boolean' ? [] : (Array.isArray(c) ? c.flat(Infinity).filter((x) => x != null && typeof x !== 'boolean') : [c])),
      map: (c, fn) => R.Children.toArray(c).map(fn),
      forEach: (c, fn) => R.Children.toArray(c).forEach(fn),
      count: (c) => R.Children.toArray(c).length,
      only: (c) => {
        const list = R.Children.toArray(c);
        if (list.length !== 1) throw new Error('React.Children.only expected a single React element child.');
        return list[0];
      },
    },
    createContext(v) { const c = { $$typeof: CTX, _currentValue: v, Provider: null }; c.Provider = { $$typeof: PROVIDER, _context: c }; return c; },
    createRef: () => ({ current: null }),
    memo: (type) => ({ $$typeof: MEMO, type }),
    forwardRef: (render) => ({ $$typeof: FWD, render }),
    lazy: (loader) => ({ $$typeof: LAZY, _loader: loader }),
    startTransition: (fn) => fn(),
    useState(init) {
      const { inst, i } = slot();
      if (!(i in inst.hooks)) inst.hooks[i] = typeof init === 'function' ? init() : init;
      return [inst.hooks[i], (next) => {
        const val = typeof next === 'function' ? next(inst.hooks[i]) : next;
        if (!Object.is(inst.hooks[i], val)) { inst.hooks[i] = val; dirty = true; }
      }];
    },
    useReducer(red, init, initFn) {
      const { inst, i } = slot();
      if (!(i in inst.hooks)) inst.hooks[i] = typeof initFn === 'function' ? initFn(init) : init;
      return [inst.hooks[i], (act) => {
        const val = red(inst.hooks[i], act);
        if (!Object.is(inst.hooks[i], val)) { inst.hooks[i] = val; dirty = true; }
      }];
    },
    useRef(init) { const { inst, i } = slot(); if (!(i in inst.hooks)) inst.hooks[i] = { current: init }; return inst.hooks[i]; },
    useMemo(fn, deps) {
      const { inst, i } = slot(), prev = inst.hooks[i];
      if (!prev || !deps || !depsEq(prev.deps, deps)) { const value = fn(); inst.hooks[i] = { value, deps }; return value; }
      return prev.value;
    },
    useCallback(fn, deps) { return R.useMemo(() => fn, deps); },
    useContext: readCtx,
    useId() { const { inst, i } = slot(); if (!(i in inst.hooks)) inst.hooks[i] = `:b${++idSeq}:`; return inst.hooks[i]; },
    useSyncExternalStore(sub, getSnap) {
      const { inst, i } = slot(), val = getSnap(), prev = inst.hooks[i];
      if (!prev || prev.sub !== sub) {
        prev?.unsub?.();
        inst.hooks[i] = { sub, unsub: sub(() => { dirty = true; }), val };
      } else prev.val = val;
      return val;
    },
    useImperativeHandle() {},
    useDeferredValue: (v) => v,
    useTransition: () => [false, (fn) => fn()],
    useEffect(create, deps) {
      const { inst, i } = slot(), prev = inst.hooks[i];
      if (!prev || !deps || !depsEq(prev.deps, deps)) {
        const entry = prev || { cleanup: null, deps: null };
        entry.deps = deps;
        inst.hooks[i] = entry;
        pendingEffects.push({ entry, create });
      }
    },
    useLayoutEffect(create, deps) { R.useEffect(create, deps); },
    useInsertionEffect() {},
    useDebugValue() {},
  };

  const cleanup = (inst) => {
    for (const s of inst.hooks) {
      if (s && typeof s === 'object') {
        if (typeof s.cleanup === 'function') { try { s.cleanup(); } catch { /* ignore */ } s.cleanup = null; }
        if (typeof s.unsub === 'function') { try { s.unsub(); } catch { /* ignore */ } s.unsub = null; }
      }
    }
  };

  function renderNode(node, path) {
    if (node == null || typeof node === 'boolean') return null;
    if (typeof node === 'string' || typeof node === 'number') return node;
    if (Array.isArray(node)) return node.map((c, idx) => renderNode(c, `${path}/${c && typeof c === 'object' && c.key != null ? `k:${c.key}` : `i:${idx}`}`));
    if (typeof node !== 'object' || node.$$typeof !== ELEMENT) return node;
    const { type, props, key, ref } = node;
    const kpath = key !== null ? `${path}[${key}]` : path;
    if (type === FRAGMENT || type === SUSPENSE) return renderNode(props.children, kpath);
    if (type && typeof type === 'object' && (type.$$typeof === PROVIDER || type.$$typeof === CTX)) {
      const ctx = type.$$typeof === PROVIDER ? type._context : type;
      pushCtx(ctx, props.value);
      try { return renderNode(props.children, kpath); } finally { popCtx(ctx); }
    }
    if (type && typeof type === 'object' && type.$$typeof === LAZY) return null;
    const fn = typeof type === 'function' ? type : type?.$$typeof === MEMO ? type.type : type?.$$typeof === FWD ? type.render : null;
    if (fn) {
      let inst = instances.get(kpath);
      if (!inst || inst.fn !== fn) { if (inst) cleanup(inst); inst = { fn, hooks: [] }; instances.set(kpath, inst); }
      active.add(kpath);
      const isClass = Boolean(fn.prototype && (fn.prototype instanceof Component || typeof fn.prototype.render === 'function'));
      const isBoundary = isClass && typeof fn.getDerivedStateFromError === 'function';
      const runRender = () => {
        const prevInst = curInst, prevIdx = hookIdx;
        curInst = inst; hookIdx = 0;
        try {
          if (isClass) {
            if (!inst.classInst) inst.classInst = new fn(props);
            else inst.classInst.props = props;
            return inst.classInst.render();
          }
          return type?.$$typeof === FWD ? fn(props, ref) : fn(props);
        } finally {
          curInst = prevInst; hookIdx = prevIdx;
        }
      };
      if (isBoundary) {
        try {
          const out = runRender();
          return { $$typeof: ELEMENT, type: fn, key, props, rendered: renderNode(out, `${kpath}>`) };
        } catch (error) {
          const derived = fn.getDerivedStateFromError(error);
          if (derived) inst.classInst.state = { ...inst.classInst.state, ...derived };
          inst.classInst.componentDidCatch?.(error, {});
          const fallbackOut = runRender();
          return { $$typeof: ELEMENT, type: fn, key, props, rendered: renderNode(fallbackOut, `${kpath}>`) };
        }
      }
      const out = runRender();
      return { $$typeof: ELEMENT, type: fn, key, props, rendered: renderNode(out, `${kpath}>`) };
    }
    const children = props.children !== undefined ? renderNode(props.children, `${kpath}.${String(type)}`) : undefined;
    return { $$typeof: ELEMENT, type, key, ref, props: children !== undefined ? { ...props, children } : props };
  }

  const slotKey = `__STUDY_BOUNDARY_REACT_${Date.now()}_${Math.random()}__`;
  globalThis[slotKey] = R;
  const compiled = await build({
    stdin: {
      contents: `
        export { default as App } from './ui/App.jsx';
        export { PAGE_VIEWS } from './ui/app/page-views.jsx';
        export { setUiLanguage } from './ui/i18n.js';
      `,
      resolveDir: resolve(process.cwd()),
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    external: ['@codemirror/*', '@lezer/*', '@base-ui/*', 'markdown-it', 'markdown-it-texmath', 'dompurify', 'katex', 'katex/*', 'parse5', 'pdf-lib', 'yaml', 'schemastery', 'proper-lockfile'],
    plugins: [{
      name: 'boundary-react-shim',
      setup(b) {
        b.onResolve({ filter: /^react$|^react\/jsx-runtime$|^react\/jsx-dev-runtime$/ }, () => ({ path: 'react', namespace: 'b-react' }));
        b.onLoad({ filter: /.*/, namespace: 'b-react' }, () => ({
          contents: `
            const R = globalThis[${JSON.stringify(slotKey)}];
            export default R;
            export const { Fragment, Suspense, StrictMode, Component, PureComponent, createElement, cloneElement, isValidElement, Children,
              createContext, createRef, memo, forwardRef, lazy, startTransition,
              useState, useReducer, useRef, useMemo, useCallback, useContext,
              useId, useSyncExternalStore, useImperativeHandle, useDeferredValue, useTransition,
              useEffect, useLayoutEffect, useInsertionEffect, useDebugValue } = R;
            export const jsx = (t, p, k) => R.createElement(t, k !== undefined ? { ...p, key: k } : p);
            export const jsxs = jsx; export const jsxDEV = jsx;
          `,
          loader: 'js',
        }));
        b.onResolve({ filter: /^react-dom$/ }, () => ({ path: 'react-dom', namespace: 'b-rdom' }));
        b.onLoad({ filter: /.*/, namespace: 'b-rdom' }, () => ({
          contents: 'export const flushSync = (fn) => fn(); export const createPortal = (c) => c; export default { flushSync, createPortal };',
          loader: 'js',
        }));
      },
    }, nativeSelects],
    loader: { '.css': 'text' },
    logLevel: 'silent',
  });
  const mod = { exports: {} };
  try {
    new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, mod, mod.exports);
  } finally {
    delete globalThis[slotKey];
  }

  const collect = (node, pred, out = []) => {
    if (node == null || typeof node !== 'object') return out;
    if (Array.isArray(node)) { for (const x of node) collect(x, pred, out); return out; }
    if (pred(node)) out.push(node);
    if ('rendered' in node) collect(node.rendered, pred, out);
    else if (node.props?.children !== undefined) collect(node.props.children, pred, out);
    return out;
  };

  const mount = (renderFn) => {
    let tree = null;
    const reconcile = () => {
      for (let pass = 0; pass < 12; pass += 1) {
        dirty = false;
        active = new Set();
        tree = renderNode(renderFn(), 'root');
        for (const [p, inst] of [...instances.entries()]) {
          if (!active.has(p)) { cleanup(inst); instances.delete(p); }
        }
        const effs = pendingEffects; pendingEffects = [];
        for (const item of effs) {
          if (typeof item.entry.cleanup === 'function') { item.entry.cleanup(); item.entry.cleanup = null; }
          const clean = item.create();
          if (typeof clean === 'function') item.entry.cleanup = clean;
        }
        if (!dirty) break;
      }
      return tree;
    };
    reconcile();
    return {
      get tree() { return tree; },
      flush: async (ticks = 5) => {
        for (let i = 0; i < ticks; i += 1) {
          await Promise.resolve();
          if (dirty) reconcile();
        }
        return tree;
      },
      act: async (fn) => { await fn(); await Promise.resolve(); reconcile(); },
      find: (pred, root = tree) => collect(root, pred)[0] || null,
      findAll: (pred, root = tree) => collect(root, pred),
      unmount: () => { for (const inst of instances.values()) cleanup(inst); instances.clear(); },
    };
  };
  return { exports: mod.exports, React: R, mount };
}

test('the page boundary sits inside <main> beside the sidebar, so a crashed page cannot take the sidebar with it', async () => {
  const prevMatchMedia = globalThis.matchMedia;
  const reducedMatchMedia = (query) => ({
    matches: String(query).includes('prefers-reduced-motion'),
    addEventListener() {},
    removeEventListener() {},
  });
  globalThis.matchMedia = reducedMatchMedia;
  try {
    await withBrowserGlobals(async () => {
      const bundle = await loadBoundaryApp();
      const { App, PAGE_VIEWS, setUiLanguage } = bundle.exports;
      setUiLanguage('zh');
      const origLibrary = PAGE_VIEWS.library;
      const origSources = PAGE_VIEWS.sources;
      const origConsoleError = console.error;
      const caughtLogs = [];
      let shouldCrash = true;

      console.error = (...args) => { caughtLogs.push(args); };
      PAGE_VIEWS.library = function CrashingLibrary() {
        if (shouldCrash) throw new TypeError("Cannot read properties of undefined (reading 'map')");
        return bundle.React.createElement('section', { 'data-page-ok': 'library' }, 'library-recovered-ok');
      };
      PAGE_VIEWS.sources = function CleanSources() {
        return bundle.React.createElement('section', { 'data-page-ok': 'sources' }, 'sources-clean-ok');
      };

      const snap = {
        root: '/lib',
        fingerprint: 'fp-1',
        sources: [],
        decks: [],
        drafts: [],
        runs: [],
        jobs: [],
        courses: [],
        focus: { course: '*', courses: [] },
        settings: {},
      };
      const call = async (action) => {
        if (action === 'binding.get') return { root: '/lib', provider: '', model: '' };
        if (action === 'snapshot') return snap;
        if (action === 'board.get') return { columns: [], cards: {} };
        return { status: 'ok' };
      };

      const mounted = bundle.mount(() => bundle.React.createElement(App, { call }));
      try {
        await mounted.flush(8);

        // 1. Sidebar <aside> and <main> are siblings in .study-app, with <aside> before <main>.
        const appShell = mounted.find((n) => n.type === 'div' && typeof n.props?.className === 'string' && n.props.className.includes('study-app'));
        assert.ok(appShell, 'rendered .study-app root');
        const directChildren = (Array.isArray(appShell.props.children) ? appShell.props.children : [appShell.props.children]).filter(Boolean);
        const sidebarIdx = directChildren.findIndex((n) => Boolean(mounted.find((el) => el.type === 'aside' && el.props?.className === 'sidebar', n)));
        const mainIdx = directChildren.findIndex((n) => n.type === 'main');
        assert.ok(sidebarIdx >= 0, 'sidebar <aside> renders even when the active page throws');
        assert.ok(mainIdx > sidebarIdx, 'sidebar <aside> sits before <main> as a sibling');

        const asideEl = mounted.find((n) => n.type === 'aside' && n.props?.className === 'sidebar');
        const mainEl = mounted.find((n) => n.type === 'main');
        assert.equal(mounted.find((n) => n.type === 'aside', mainEl), null, 'sidebar is outside <main>');

        // 2. The active page crash is caught inside <main> by PageBoundary, rendering CrashFallback with diagnostic copy & retry.
        const mainText = textOf(mainEl);
        assert.match(mainText, /这个页面没能显示/, 'PageBoundary renders crash fallback inside <main>');
        assert.match(mainText, /复制诊断信息/, 'CrashFallback offers diagnostic copy action');
        assert.ok(caughtLogs.some((args) => String(args[0]).includes('[study-workspace] page render failed:')), 'PageBoundary.componentDidCatch logged the crash');

        // 3. Sidebar stays interactive: clicking 资料 switches page and resets PageBoundary via key={page}.
        const sourcesNavBtn = mounted.find((n) => n.type === 'button' && n.props?.['data-tour'] === 'nav-sources', asideEl);
        assert.ok(sourcesNavBtn, 'sidebar keeps 资料 nav button interactive after page crash');
        await mounted.act(() => click(sourcesNavBtn));
        await mounted.flush(4);

        const mainAfterSwitch = mounted.find((n) => n.type === 'main');
        const switchText = textOf(mainAfterSwitch);
        assert.match(switchText, /sources-clean-ok/, 'switching to another page resets PageBoundary cleanly');
        assert.doesNotMatch(switchText, /这个页面没能显示/, 'crash fallback clears on page switch');

        // 4. Returning to the crashed page and clicking 重试 recovers once the error condition clears.
        const libraryNavBtn = mounted.find((n) => n.type === 'button' && n.props?.['data-tour'] === 'nav-library', mounted.find((n) => n.type === 'aside'));
        assert.ok(libraryNavBtn, 'sidebar keeps 学习库 nav button');
        await mounted.act(() => click(libraryNavBtn));
        await mounted.flush(4);
        assert.match(textOf(mounted.find((n) => n.type === 'main')), /这个页面没能显示/);

        shouldCrash = false;
        const retryBtn = mounted.find((n) => n.type === 'button' && textOf(n).trim() === '重试', mounted.find((n) => n.type === 'main'));
        assert.ok(retryBtn, 'CrashFallback exposes 重试 button');
        await mounted.act(() => click(retryBtn));
        assert.match(textOf(mounted.find((n) => n.type === 'main')), /library-recovered-ok/, '重试 clears PageBoundary error and renders recovered page');
      } finally {
        mounted.unmount();
        PAGE_VIEWS.library = origLibrary;
        PAGE_VIEWS.sources = origSources;
        console.error = origConsoleError;
        setUiLanguage('zh');
      }
    }, { window: { matchMedia: reducedMatchMedia } });
  } finally {
    if (prevMatchMedia === undefined) delete globalThis.matchMedia;
    else globalThis.matchMedia = prevMatchMedia;
  }
});

/* #893 S4: the in-memory performance summary of this session. It is built from numbers and the ids of the app's own pages, whatever it is given. */
const SESSION = {
  switches: { all: { count: 5, median: 30, worst: 90 }, byPage: [{ page: 'library', count: 3, median: 50, worst: 90 }, { page: 'sources', count: 2, median: 12, worst: 13 }] },
  longTasks: { count: 3, totalMs: 315, worstMs: 180 },
  snapshots: { chars: { count: 4, median: 3000, worst: 250000 }, applyMs: { count: 4, median: 4, worst: 40 } },
};
const sessionLines = text => text.split('\n').slice(text.split('\n').findIndex(line => line.startsWith('Session performance')));

test('the performance section follows the diagnostic style: short lines, numbers and page ids; Chinese labels follow the English ones only in a Chinese interface', () => {
  const text = diagnosticText({ version: '4.6.2', language: 'zh', page: 'library', session: SESSION });
  const lines = sessionLines(text);
  assert.equal(lines.length, 4, text);
  assert.match(lines[0], /^Session performance .*本次会话.*in memory/);
  assert.equal(lines[1], 'Page switches 页面切换 (ms, median/worst): library 3x 50/90, sources 2x 12/13');
  assert.equal(lines[2], 'Long tasks 长任务 (over 50 ms): 3, total 315 ms, worst 180 ms');
  assert.equal(lines[3], 'Snapshots 快照 (changed ones): 4, size 3000/250000 chars, diff and apply 4/40 ms');
  assert.match(text, /^Library: sources/m, 'the existing lines are as they were');
  const english = sessionLines(diagnosticText({ version: '4.6.2', language: 'en', page: 'library', session: SESSION })).join('\n');
  const wide = /[^\x00-\x7f]/;
  assert.doesNotMatch(english, wide, 'an English interface gets no Han at all');
  assert.equal(english.split('\n').length, lines.length, 'and the same four lines');
  assert.match(lines.join('\n'), wide, 'while a Chinese interface gets the Chinese words');
});

test('a webview that does not report long tasks says so, and a session with nothing yet says none yet: no invented zeros', () => {
  const none = { switches: { all: { count: 0, median: 0, worst: 0 }, byPage: [] }, longTasks: null, snapshots: { chars: { count: 0, median: 0, worst: 0 }, applyMs: { count: 0, median: 0, worst: 0 } } };
  const lines = sessionLines(diagnosticText({ version: '1', language: 'zh', page: 'library', session: none }));
  assert.match(lines[1], /^Page switches .*: none yet$/);
  assert.match(lines[2], /^Long tasks .*: not reported by this webview 此环境不提供$/);
  assert.match(lines[3], /^Snapshots .*: none yet$/);
});

test('without a session there is no performance section, so the text only gains it when the app passes one', () => {
  assert.doesNotMatch(diagnosticText({ version: '1', language: 'zh', page: 'library' }), /Session performance/);
});

test('the performance section holds no path, title, question or source text, whatever the summary it is given holds', () => {
  const hostile = {
    switches: { all: { count: WINDOWS, median: MATERIAL_EN, worst: -5 },
      byPage: [{ page: WINDOWS, count: 1, median: 1, worst: 1 }, { page: 'ZZ-Deck 期中冲刺卷', count: 1, median: 1, worst: 1 }, { page: '__proto__', count: 1, median: 1, worst: 1 },
        { page: 'review', count: MATERIAL_ZH, median: 7.5, worst: KEY }, null, 'library', { page: 'wrongbook', count: 2, median: 5, worst: 9, title: 'ZZ-Question what is a transaction' }] },
    longTasks: { count: BEARER, totalMs: POSIX, worstMs: JWT },
    snapshots: { chars: { count: 'many', median: QUERY, worst: {} }, applyMs: null },
    title: 'ZZ-job-title 私人笔记转写', extra: MATERIAL_EN,
  };
  const text = diagnosticText({ version: '4.6.2', language: 'zh', page: 'library', data: snapshot(), session: hostile });
  for (const piece of PRIVATE) assert.ok(!text.includes(piece), `"${piece}" leaked into:\n${text}`);
  const lines = sessionLines(text);
  assert.match(lines[1], /: review 0x 0\/0, wrongbook 2x 5\/9$/, 'known page ids stay, with their numbers made safe; any other entry is dropped');
  assert.match(lines[2], /: 0, total 0 ms, worst 0 ms$/, 'a number that is not a number is 0');
  for (const line of lines.slice(1)) assert.match(line.replace(/^[^:]*:/, ''), /^[\sa-z0-9,./()-]*$/i, line);
});

test('an upgrade seen adds one line with its version and whether the restart took effect; no marker, no line (#951)', () => {
  const at = upgrade => diagnosticText({ version: '4.7.0', language: 'en', page: 'settings', upgrade });
  assert.doesNotMatch(at(undefined), /Upgrade seen/);
  assert.doesNotMatch(at({}), /Upgrade seen/);
  assert.match(at({ version: '4.7.1', restartFailed: true }), /^Upgrade seen: 4\.7\.1, restart did not take effect$/m);
  assert.match(at({ version: '4.7.1', restartFailed: false }), /^Upgrade seen: 4\.7\.1, waiting for a restart$/m);
  assert.match(at({ version: '4.7.1', restartFailed: true }), /^StudyHub version: 4\.7\.0$/m, 'the running version stays on its own line');
  // Only a version-shaped token is copied: whatever else a marker held (a path, a sentence) is not.
  for (const version of ['C:\\Users\\student\\Documents\\x', 'a sentence with spaces and 线粒体', '/home/student/x'])
    assert.doesNotMatch(at({ version, restartFailed: true }), /Upgrade seen/, version);
});
