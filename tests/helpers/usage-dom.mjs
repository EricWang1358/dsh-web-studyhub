import { createRequire } from 'node:module';
import { parseFragment } from 'parse5';
import { build } from 'esbuild';

/* Test helpers for the usage frequency capture: the page code bundled for Node, and a minimal DOM over parse5 (the element interface the
   capture and the key resolver use: tagName, parentElement, getAttribute, hasAttribute, classList, textContent, type, labels).
   `strict` elements throw when anything asks for a layout measurement, which is how the "no layout reads in the handler" budget is checked. */

const require = createRequire(import.meta.url);
export async function loadUsageModules() {
  const compiled = await build({ stdin: { contents: `
    export * from './ui/usage/keys.js';
    export * from './ui/usage/names.js';
    export * from './ui/usage/collector.js';
    export * from './ui/usage/capture.js';
    export * from './ui/usage/controller.js';
    export { setUiLanguage, ui, uiFormat } from './ui/i18n.js';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text', '.json': 'json' }, logLevel: 'silent' });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
  return module.exports;
}

const LAYOUT = ['getBoundingClientRect', 'getClientRects', 'offsetWidth', 'offsetHeight', 'offsetTop', 'offsetLeft', 'clientWidth', 'clientHeight', 'scrollWidth', 'scrollHeight', 'scrollTop', 'innerText', 'checkVisibility'];
const wrappers = new WeakMap();
const TEXT_TYPES = new Set(['text', 'search', 'email', 'url', 'tel', 'number', 'password']);

function wrap(node, strict) {
  if (!node || node.nodeName === '#document-fragment') return null;
  if (wrappers.has(node)) return wrappers.get(node);
  const element = {
    node,
    tagName: String(node.tagName || node.nodeName).toUpperCase(),
    get parentElement() { return wrap(node.parentNode, strict); },
    get attrs() { return node.attrs || []; },
    getAttribute(name) { return node.attrs?.find(item => item.name === name)?.value ?? null; },
    hasAttribute(name) { return !!node.attrs?.some(item => item.name === name); },
    get id() { return this.getAttribute('id') || ''; },
    get type() { return (this.getAttribute('type') || (this.tagName === 'INPUT' ? 'text' : '')).toLowerCase(); },
    get className() { return this.getAttribute('class') || ''; },
    get classList() { const names = this.className.split(/\s+/).filter(Boolean); return { contains: name => names.includes(name), length: names.length, [Symbol.iterator]: () => names[Symbol.iterator]() }; },
    get textContent() { const parts = []; const visit = item => { if (item.nodeName === '#text') parts.push(item.value); for (const child of item.childNodes || []) visit(child); }; visit(node); return parts.join(''); },
    get labels() {
      if (this.tagName !== 'INPUT' && this.tagName !== 'SELECT' && this.tagName !== 'TEXTAREA') return null;
      const found = []; let root = node; while (root.parentNode) root = root.parentNode;
      const visit = item => { if (item.nodeName === 'label' && (item.attrs?.find(a => a.name === 'for')?.value === this.id && this.id || contains(item, node))) found.push(wrap(item, strict)); for (const child of item.childNodes || []) visit(child); };
      visit(root); return found;
    },
    get isTextLike() { return this.tagName === 'TEXTAREA' || (this.tagName === 'INPUT' && TEXT_TYPES.has(this.type)); },
    children: undefined,
  };
  if (strict) for (const name of LAYOUT) Object.defineProperty(element, name, { get() { throw new Error(`layout read: ${name}`); } });
  wrappers.set(node, element);
  return element;
}
const contains = (outer, inner) => { for (let at = inner; at; at = at.parentNode) if (at === outer) return true; return false; };

/** Parse HTML into wrapped elements; `find(selector-ish)` is just a predicate over the tree. */
export function dom(html, { strict = false } = {}) {
  const fragment = parseFragment(html);
  const all = [];
  const visit = node => { if (node.tagName) all.push(wrap(node, strict)); for (const child of node.childNodes || []) visit(child); };
  visit(fragment);
  const find = predicate => all.find(predicate) || null;
  return { all, find, byTag: tag => all.filter(item => item.tagName === tag.toUpperCase()), root: all[0], first: all[0],
    text: text => all.find(item => item.tagName !== 'HTML' && item.textContent.trim() === text && !item.node.childNodes.some(child => child.tagName)) || all.find(item => item.textContent.trim() === text) };
}

/** A stand-in for the app root: records the listeners it is given, and fires events at them. */
export function fakeRoot(area = 'library') {
  const listeners = [];
  return {
    listeners,
    added: [],
    addEventListener(type, handler, options) { listeners.push({ type, handler, options }); this.added.push(type); },
    removeEventListener(type, handler) { const at = listeners.findIndex(item => item.type === type && item.handler === handler); if (at >= 0) listeners.splice(at, 1); },
    getAttribute: name => name === 'data-usage-area' ? area : null,
    fire(type, event) { for (const item of [...listeners]) if (item.type === type) item.handler({ type, detail: 1, repeat: false, ...event }); },
  };
}

/** Manual timers, so a test decides when "30 seconds" pass. */
export function fakeTimers() {
  let next = 1; const active = new Map();
  return {
    set: (fn, ms) => { const id = next++; active.set(id, { fn, ms }); return id; },
    clear: id => { active.delete(id); },
    count: () => active.size,
    fire() { const due = [...active.entries()]; for (const [id, timer] of due) { active.delete(id); timer.fn(); } return due.length; },
    delays: () => [...active.values()].map(timer => timer.ms),
  };
}
