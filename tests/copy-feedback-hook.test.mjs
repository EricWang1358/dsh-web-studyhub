import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

// #908: three copy buttons pass a function to useCopyFeedback; the clipboard must receive the function's RETURN value.
// No DOM here, so the hook runs against a tiny stand-in for react's useState / useRef / useEffect (the hook's own code is real).
const reactStandIn = `
  let slots = [], index = 0, pending = [];
  export const __begin = () => { index = 0; pending = []; };
  export const __flush = () => { for (const run of pending) run(); };
  export const useState = initial => { const slot = index++; slots[slot] ??= { value: initial }; return [slots[slot].value, value => { slots[slot].value = value; }]; };
  export const useRef = initial => { const slot = index++; return slots[slot] ??= { current: initial }; };
  export const useEffect = (effect, deps) => {
    const slot = index++, before = slots[slot];
    if (before && deps.every((dep, i) => Object.is(dep, before.deps[i]))) return;
    pending.push(() => { before?.cleanup?.(); slots[slot] = { deps, cleanup: effect() }; });
  };`;
const compiled = await build({ stdin: { contents: "export * from './ui/use-copy-feedback.js'; export { __begin, __flush } from 'react';", resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent',
  plugins: [{ name: 'react-stand-in', setup(b) { b.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'stand-in' })); b.onLoad({ filter: /.*/, namespace: 'stand-in' }, () => ({ contents: reactStandIn, loader: 'js' })); } }] });
const module = { exports: {} };
new Function('module', 'exports', compiled.outputFiles[0].text)(module, module.exports);
const { useCopyFeedback, __begin, __flush } = module.exports;

const mount = () => ({ render(text, options) { __begin(); const result = useCopyFeedback(text, options); __flush(); return result; } });
const withClipboard = async run => {
  const written = [], before = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async text => { written.push(text); } } } });
  try { await run(written); } finally { if (before) Object.defineProperty(globalThis, 'navigator', before); else delete globalThis.navigator; }
};

test('a function argument is read when copy() runs and its return value reaches the clipboard (#908)', () => withClipboard(async written => {
  let current = 'first';
  const hook = mount().render(() => current);
  current = 'second';
  assert.equal(await hook.copy(), true);
  assert.deepEqual(written, ['second'], 'the text at the moment of the copy, not the function and not its source');
}));

test('a function that changes between renders: the newest one is used (#908)', () => withClipboard(async written => {
  const view = mount();
  view.render(() => 'old text');
  const hook = view.render(() => 'new text');
  await hook.copy();
  assert.deepEqual(written, ['new text']);
}));

test('a string argument still copies the string, and a new string replaces the old one (#908)', () => withClipboard(async written => {
  const view = mount();
  await view.render('plain').copy();
  await view.render('changed').copy();
  assert.deepEqual(written, ['plain', 'changed']);
}));
