/* Zero-dependency interactive React component & hook test harness built on esbuild.
   Bundles real UI modules with a stateful React runtime so Node tests can mount components,
   fire handlers (onClick / onChange / onSubmit / onKeyDown), re-render with updated props or
   keys, run real useEffect / useLayoutEffect cleanups, and assert actual behavior instead of
   grepping source files. */
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { nativeSelects } from './native-selects.mjs';

const require = createRequire(import.meta.url);
const MEMO_TYPE = Symbol.for('react.memo');
const FORWARD_REF_TYPE = Symbol.for('react.forward_ref');
const CONTEXT_TYPE = Symbol.for('react.context');
const PROVIDER_TYPE = Symbol.for('react.provider');
const FRAGMENT_TYPE = Symbol.for('react.fragment');
const SUSPENSE_TYPE = Symbol.for('react.suspense');
const LAZY_TYPE = Symbol.for('react.lazy');
const ELEMENT_TYPE = Symbol.for('react.transitional.element');

const EXTERNAL = [
  '@codemirror/*', '@lezer/*', '@base-ui/*',
  'markdown-it', 'markdown-it-texmath', 'dompurify',
  'katex', 'katex/*', 'parse5', 'pdf-lib', 'yaml', 'schemastery', 'proper-lockfile',
];

function depsEqual(prev, next) {
  if (!prev || !next || prev.length !== next.length) return false;
  for (let i = 0; i < prev.length; i += 1) {
    if (!Object.is(prev[i], next[i])) return false;
  }
  return true;
}

function createRuntime() {
  const instances = new Map();
  const contextStack = new Map();
  let currentInst = null;
  let hookCursor = 0;
  let idSeq = 0;
  let pendingLayout = [];
  let pendingEffects = [];
  let dirty = false;
  let activePaths = new Set();

  const readContext = (ctx) => {
    const stack = contextStack.get(ctx);
    return stack && stack.length > 0 ? stack[stack.length - 1] : ctx._currentValue;
  };

  const pushContext = (ctx, value) => {
    let stack = contextStack.get(ctx);
    if (!stack) {
      stack = [];
      contextStack.set(ctx, stack);
    }
    stack.push(value);
  };

  const popContext = (ctx) => {
    const stack = contextStack.get(ctx);
    if (stack) stack.pop();
  };

  const nextSlot = () => {
    const inst = currentInst;
    const idx = hookCursor++;
    return { inst, idx };
  };

  const React = {
    Fragment: FRAGMENT_TYPE,
    Suspense: SUSPENSE_TYPE,
    createElement(type, rawProps, ...rawChildren) {
      const props = rawProps ? { ...rawProps } : {};
      const key = props.key !== undefined && props.key !== null ? String(props.key) : null;
      const ref = props.ref !== undefined ? props.ref : null;
      delete props.key;
      if (rawChildren.length === 1) props.children = rawChildren[0];
      else if (rawChildren.length > 1) props.children = rawChildren;
      return { $$typeof: ELEMENT_TYPE, type, key, ref, props };
    },
    cloneElement(el, rawProps, ...rawChildren) {
      const props = { ...el.props, ...(rawProps || {}) };
      const key = rawProps?.key !== undefined && rawProps?.key !== null ? String(rawProps.key) : el.key;
      const ref = rawProps?.ref !== undefined ? rawProps.ref : el.ref;
      delete props.key;
      if (rawChildren.length === 1) props.children = rawChildren[0];
      else if (rawChildren.length > 1) props.children = rawChildren;
      return { $$typeof: ELEMENT_TYPE, type: el.type, key, ref, props };
    },
    isValidElement(obj) {
      return Boolean(obj && typeof obj === 'object' && obj.$$typeof === ELEMENT_TYPE);
    },
    Children: {
      toArray(children) {
        if (children === null || children === undefined || typeof children === 'boolean') return [];
        return Array.isArray(children) ? children.flat(Infinity).filter((c) => c !== null && c !== undefined && typeof c !== 'boolean') : [children];
      },
      map(children, fn) {
        return React.Children.toArray(children).map(fn);
      },
      forEach(children, fn) {
        React.Children.toArray(children).forEach(fn);
      },
      count(children) {
        return React.Children.toArray(children).length;
      },
      only(children) {
        const list = React.Children.toArray(children);
        if (list.length !== 1) throw new Error('React.Children.only expected a single React element child.');
        return list[0];
      },
    },
    Component: class Component {
      constructor(props) { this.props = props; this.state = {}; }
      setState(next) { Object.assign(this.state, typeof next === 'function' ? next(this.state, this.props) : next); }
    },
    PureComponent: class PureComponent {
      constructor(props) { this.props = props; this.state = {}; }
      setState(next) { Object.assign(this.state, typeof next === 'function' ? next(this.state, this.props) : next); }
    },
    createContext(defaultValue) {
      const ctx = {
        $$typeof: CONTEXT_TYPE,
        _currentValue: defaultValue,
        Provider: null,
      };
      ctx.Provider = { $$typeof: PROVIDER_TYPE, _context: ctx };
      return ctx;
    },
    memo(type, compare) {
      return { $$typeof: MEMO_TYPE, type, compare: compare || null };
    },
    forwardRef(render) {
      return { $$typeof: FORWARD_REF_TYPE, render };
    },
    lazy(loader) {
      const state = { status: 'uninitialized', value: null, promise: null };
      return {
        $$typeof: LAZY_TYPE,
        _loader: loader,
        _state: state,
      };
    },
    useState(init) {
      const { inst, idx } = nextSlot();
      if (!(idx in inst.hooks)) {
        inst.hooks[idx] = typeof init === 'function' ? init() : init;
      }
      const setState = (next) => {
        const prev = inst.hooks[idx];
        const value = typeof next === 'function' ? next(prev) : next;
        if (!Object.is(prev, value)) {
          inst.hooks[idx] = value;
          dirty = true;
        }
      };
      return [inst.hooks[idx], setState];
    },
    useReducer(reducer, initArg, initFn) {
      const { inst, idx } = nextSlot();
      if (!(idx in inst.hooks)) {
        inst.hooks[idx] = typeof initFn === 'function' ? initFn(initArg) : initArg;
      }
      const dispatch = (action) => {
        const prev = inst.hooks[idx];
        const value = reducer(prev, action);
        if (!Object.is(prev, value)) {
          inst.hooks[idx] = value;
          dirty = true;
        }
      };
      return [inst.hooks[idx], dispatch];
    },
    useRef(init) {
      const { inst, idx } = nextSlot();
      if (!(idx in inst.hooks)) inst.hooks[idx] = { current: init };
      return inst.hooks[idx];
    },
    useMemo(factory, deps) {
      const { inst, idx } = nextSlot();
      const prev = inst.hooks[idx];
      if (!prev || !deps || !depsEqual(prev.deps, deps)) {
        const value = factory();
        inst.hooks[idx] = { value, deps };
        return value;
      }
      return prev.value;
    },
    useCallback(fn, deps) {
      return React.useMemo(() => fn, deps);
    },
    useContext(ctx) {
      return readContext(ctx);
    },
    useId() {
      const { inst, idx } = nextSlot();
      if (!(idx in inst.hooks)) inst.hooks[idx] = `:r${++idSeq}:`;
      return inst.hooks[idx];
    },
    useSyncExternalStore(subscribe, getSnapshot) {
      const { inst, idx } = nextSlot();
      const val = getSnapshot();
      const prev = inst.hooks[idx];
      if (!prev || prev.subscribe !== subscribe) {
        if (prev?.unsub) prev.unsub();
        const unsub = subscribe(() => {
          dirty = true;
        });
        inst.hooks[idx] = { subscribe, unsub, val };
      } else {
        prev.val = val;
      }
      return val;
    },
    useImperativeHandle(ref, createHandle, deps) {
      React.useLayoutEffect(() => {
        if (!ref) return undefined;
        const val = createHandle();
        if (typeof ref === 'function') ref(val);
        else ref.current = val;
        return () => {
          if (typeof ref === 'function') ref(null);
          else ref.current = null;
        };
      }, deps);
    },
    useDeferredValue(value) {
      return value;
    },
    useTransition() {
      return [false, (fn) => fn()];
    },
    useEffect(create, deps) {
      const { inst, idx } = nextSlot();
      const prev = inst.hooks[idx];
      if (!prev || !deps || !depsEqual(prev.deps, deps)) {
        const slot = prev || { cleanup: null, deps: null };
        slot.deps = deps;
        inst.hooks[idx] = slot;
        pendingEffects.push({ inst, slot, create });
      }
    },
    useLayoutEffect(create, deps) {
      const { inst, idx } = nextSlot();
      const prev = inst.hooks[idx];
      if (!prev || !deps || !depsEqual(prev.deps, deps)) {
        const slot = prev || { cleanup: null, deps: null };
        slot.deps = deps;
        inst.hooks[idx] = slot;
        pendingLayout.push({ inst, slot, create });
      }
    },
    useInsertionEffect() {},
    useDebugValue() {},
    startTransition(fn) { fn(); },
    createRef() { return { current: null }; },
    StrictMode: FRAGMENT_TYPE,
  };

  function cleanupInstance(inst) {
    for (const slot of inst.hooks) {
      if (slot && typeof slot === 'object') {
        if (typeof slot.cleanup === 'function') {
          try { slot.cleanup(); } catch { /* ignore cleanup error */ }
          slot.cleanup = null;
        }
        if (typeof slot.unsub === 'function') {
          try { slot.unsub(); } catch { /* ignore unsub error */ }
          slot.unsub = null;
        }
      }
    }
  }

  function renderNode(node, path) {
    if (node === null || node === undefined || typeof node === 'boolean') return null;
    if (typeof node === 'string' || typeof node === 'number') return node;
    if (Array.isArray(node)) {
      return node.map((child, idx) => {
        const childKey = child && typeof child === 'object' && child.key !== null && child.key !== undefined ? `k:${child.key}` : `i:${idx}`;
        return renderNode(child, `${path}/${childKey}`);
      });
    }
    if (typeof node !== 'object' || node.$$typeof !== ELEMENT_TYPE) return node;

    const { type, props, key, ref } = node;
    const keyedPath = key !== null ? `${path}[${key}]` : path;

    if (type === FRAGMENT_TYPE || type === SUSPENSE_TYPE) {
      return renderNode(props.children, keyedPath);
    }

    if (type && typeof type === 'object' && (type.$$typeof === PROVIDER_TYPE || type.$$typeof === CONTEXT_TYPE)) {
      const ctx = type.$$typeof === PROVIDER_TYPE ? type._context : type;
      pushContext(ctx, props.value);
      try {
        return renderNode(props.children, keyedPath);
      } finally {
        popContext(ctx);
      }
    }

    if (type && typeof type === 'object' && type.$$typeof === LAZY_TYPE) {
      if (type._state.status === 'resolved') {
        return renderNode(React.createElement(type._state.value, { ...props, ...(key !== null ? { key } : {}) }), path);
      }
      if (type._state.status === 'uninitialized') {
        type._state.status = 'pending';
        type._state.promise = Promise.resolve(type._loader()).then((mod) => {
          type._state.status = 'resolved';
          type._state.value = mod?.default || mod;
          dirty = true;
        }).catch(() => {
          type._state.status = 'rejected';
        });
      }
      return { $$typeof: ELEMENT_TYPE, type: '__lazy_pending__', key, props: { ...props } };
    }

    let fn = null;
    let isForwardRef = false;
    if (typeof type === 'function') {
      fn = type;
    } else if (type && typeof type === 'object' && type.$$typeof === MEMO_TYPE) {
      fn = type.type;
    } else if (type && typeof type === 'object' && type.$$typeof === FORWARD_REF_TYPE) {
      fn = type.render;
      isForwardRef = true;
    }

    if (fn) {
      let inst = instances.get(keyedPath);
      if (!inst || inst.fn !== fn) {
        if (inst) cleanupInstance(inst);
        inst = { fn, hooks: [] };
        instances.set(keyedPath, inst);
      }
      activePaths.add(keyedPath);
      const prevInst = currentInst;
      const prevCursor = hookCursor;
      currentInst = inst;
      hookCursor = 0;
      let output;
      try {
        if (fn.prototype && (fn.prototype instanceof React.Component || fn.prototype instanceof React.PureComponent || typeof fn.prototype.render === 'function')) {
          if (!inst.classInst) inst.classInst = new fn(props);
          else inst.classInst.props = props;
          output = inst.classInst.render();
        } else {
          output = isForwardRef ? fn(props, ref) : fn(props);
        }
      } finally {
        currentInst = prevInst;
        hookCursor = prevCursor;
      }
      const rendered = renderNode(output, `${keyedPath}>`);
      return { $$typeof: ELEMENT_TYPE, type: fn, key, props, rendered };
    }

    // Host element (string tag)
    if (ref) {
      const stub = {
        tagName: String(type).toUpperCase(),
        style: {},
        dataset: {},
        clientWidth: 600,
        clientHeight: 800,
        width: 600,
        height: 800,
        scrollTop: 0,
        scrollLeft: 0,
        isConnected: true,
        get ownerDocument() { return globalThis.document; },
        focus() {},
        scrollTo() {},
        scrollIntoView() {},
        normalize() {},
        setAttribute() {},
        removeAttribute() {},
        getAttribute: () => null,
        showModal() { this.open = true; },
        close() { this.open = false; },
        addEventListener() {},
        removeEventListener() {},
        querySelector: () => null,
        querySelectorAll: () => [],
        closest: () => null,
        contains: () => false,
        getContext: () => ({ drawImage() {}, clearRect() {} }),
        getBoundingClientRect: () => ({ left: 0, top: 0, right: 600, bottom: 800, width: 600, height: 800 }),
      };
      if (typeof ref === 'function') ref(stub);
      else if (typeof ref === 'object' && ref.current === null) ref.current = stub;
    }
    const renderedChildren = props.children !== undefined ? renderNode(props.children, `${keyedPath}.${String(type)}`) : undefined;
    return {
      $$typeof: ELEMENT_TYPE,
      type,
      key,
      ref,
      props: renderedChildren !== undefined ? { ...props, children: renderedChildren } : props,
    };
  }

  function flushEffects() {
    const layout = pendingLayout;
    pendingLayout = [];
    for (const item of layout) {
      if (typeof item.slot.cleanup === 'function') {
        item.slot.cleanup();
        item.slot.cleanup = null;
      }
      const clean = item.create();
      if (typeof clean === 'function') item.slot.cleanup = clean;
    }
    const effects = pendingEffects;
    pendingEffects = [];
    for (const item of effects) {
      if (typeof item.slot.cleanup === 'function') {
        item.slot.cleanup();
        item.slot.cleanup = null;
      }
      const clean = item.create();
      if (typeof clean === 'function') item.slot.cleanup = clean;
    }
  }

  function reconcile(element) {
    let tree = null;
    for (let pass = 0; pass < 12; pass += 1) {
      dirty = false;
      activePaths = new Set();
      tree = renderNode(element, 'root');
      for (const [path, inst] of [...instances.entries()]) {
        if (!activePaths.has(path)) {
          cleanupInstance(inst);
          instances.delete(path);
        }
      }
      flushEffects();
      if (!dirty) break;
    }
    return tree;
  }

  function unmountAll() {
    for (const inst of instances.values()) cleanupInstance(inst);
    instances.clear();
  }

  return { React, reconcile, unmountAll, isDirty: () => dirty };
}

export function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (typeof node === 'object') {
    if ('rendered' in node) return textOf(node.rendered);
    return textOf(node.props?.children);
  }
  return '';
}

function collectNodes(node, pred, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const item of node) collectNodes(item, pred, out);
    return out;
  }
  if (pred(node)) out.push(node);
  if ('rendered' in node) collectNodes(node.rendered, pred, out);
  else if (node.props?.children !== undefined) collectNodes(node.props.children, pred, out);
  return out;
}

/**
 * Bundle one or more UI modules against a fresh interactive React runtime and return
 * `{ exports, mount, mountHook, React }`.
 */
export function syntheticEvent(extra = {}) {
  return {
    preventDefault() {},
    stopPropagation() {},
    currentTarget: {},
    target: {},
    ...extra,
  };
}

export function click(node, extra = {}) {
  return node.props.onClick(syntheticEvent(extra));
}

export async function withBrowserGlobals(fn, overrides = {}) {
  const prev = {
    window: globalThis.window,
    document: globalThis.document,
    getComputedStyle: globalThis.getComputedStyle,
    ResizeObserver: globalThis.ResizeObserver,
  };
  const noop = () => {};
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  globalThis.document = {
    hidden: false,
    visibilityState: 'visible',
    activeElement: null,
    documentElement: { style: {}, dataset: {}, clientWidth: 1200, clientHeight: 800, addEventListener: noop, removeEventListener: noop },
    body: { contains: () => false, addEventListener: noop, removeEventListener: noop },
    head: { appendChild: noop },
    addEventListener: noop,
    removeEventListener: noop,
    createElement: () => ({ style: {}, remove: noop, setAttribute: noop }),
    createTreeWalker: () => ({ nextNode: () => null }),
    createRange: () => ({ setStart: noop, setEnd: noop, getClientRects: () => [], getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }) }),
    querySelector: () => null,
    querySelectorAll: () => [],
    ...(overrides.document || {}),
  };
  globalThis.window = {
    innerWidth: 1200,
    innerHeight: 800,
    devicePixelRatio: 1,
    visualViewport: { addEventListener: noop, removeEventListener: noop },
    addEventListener: noop,
    removeEventListener: noop,
    matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
    getSelection: () => ({ toString: () => '' }),
    ...(overrides.window || {}),
  };
  globalThis.getComputedStyle = overrides.getComputedStyle || (() => ({ zoom: '1', overflowY: 'auto' }));
  try {
    return await fn();
  } finally {
    for (const key of ['window', 'document', 'getComputedStyle', 'ResizeObserver']) {
      if (prev[key] === undefined) delete globalThis[key];
      else globalThis[key] = prev[key];
    }
  }
}

export async function loadInteractiveUi(contents, { plugins = [] } = {}) {
  const runtime = createRuntime();

  const shimPlugin = {
    name: 'study-react-harness-shim',
    setup(builder) {
      builder.onResolve({ filter: /^react$|^react\/jsx-runtime$|^react\/jsx-dev-runtime$/ }, () => ({
        path: 'react',
        namespace: 'study-react-shim',
      }));
      builder.onLoad({ filter: /.*/, namespace: 'study-react-shim' }, () => ({
        contents: `
          const R = __studyHarnessReact;
          export default R;
          export const {
            Fragment, Suspense, StrictMode, Component, PureComponent, createElement, cloneElement, isValidElement, Children,
            createContext, createRef, memo, forwardRef, lazy, startTransition,
            useState, useReducer, useRef, useMemo, useCallback, useContext,
            useId, useSyncExternalStore, useImperativeHandle, useDeferredValue, useTransition,
            useEffect, useLayoutEffect, useInsertionEffect, useDebugValue,
          } = R;
          export const jsx = (t, p, k) => R.createElement(t, k !== undefined ? { ...p, key: k } : p);
          export const jsxs = jsx;
          export const jsxDEV = jsx;
        `,
        loader: 'js',
      }));
      builder.onResolve({ filter: /^react-dom$/ }, () => ({
        path: 'react-dom',
        namespace: 'study-react-dom-shim',
      }));
      builder.onLoad({ filter: /.*/, namespace: 'study-react-dom-shim' }, () => ({
        contents: `
          export const flushSync = (fn) => fn();
          export const createPortal = (children) => children;
          export default { flushSync, createPortal };
        `,
        loader: 'js',
      }));
    },
  };

  const compiled = await build({
    stdin: { contents, resolveDir: resolve(process.cwd()) },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    external: EXTERNAL,
    plugins: [shimPlugin, nativeSelects, ...plugins],
    loader: { '.css': 'text' },
    logLevel: 'silent',
  });

  const mod = { exports: {} };
  // The batch runner can clear globals between imports. Each compiled module captures only its own React runtime.
  new Function('require', 'module', 'exports', '__studyHarnessReact', compiled.outputFiles[0].text)(require, mod, mod.exports, runtime.React);

  const mount = (renderEl) => {
    let currentFn = typeof renderEl === 'function' ? renderEl : () => renderEl;
    let tree = runtime.reconcile(currentFn());

    const rerender = (nextRenderEl) => {
      if (nextRenderEl !== undefined) {
        currentFn = typeof nextRenderEl === 'function' ? nextRenderEl : () => nextRenderEl;
      }
      tree = runtime.reconcile(currentFn());
      return tree;
    };

    const act = async (fn) => {
      const res = await fn();
      await Promise.resolve();
      tree = runtime.reconcile(currentFn());
      return res;
    };

    const flush = async (ticks = 3) => {
      for (let i = 0; i < ticks; i += 1) {
        await Promise.resolve();
        if (runtime.isDirty()) tree = runtime.reconcile(currentFn());
      }
      return tree;
    };

    const unmount = () => {
      runtime.unmountAll();
    };

    return {
      get tree() { return tree; },
      rerender,
      act,
      flush,
      unmount,
      text: (node = tree) => textOf(node),
      find: (pred, node = tree) => collectNodes(node, pred)[0] || null,
      findAll: (pred, node = tree) => collectNodes(node, pred),
    };
  };

  const mountHook = (useHook, initialProps, wrap = (el) => el) => {
    let result;
    let latestProps = initialProps;
    function Probe({ hookProps }) {
      result = useHook(hookProps);
      return null;
    }
    const mounted = mount(() => wrap(runtime.React.createElement(Probe, { hookProps: latestProps })));
    return {
      get current() { return result; },
      rerender: (nextProps) => {
        latestProps = nextProps;
        mounted.rerender();
        return result;
      },
      act: async (fn) => {
        const out = await mounted.act(fn);
        return out;
      },
      flush: async (ticks = 3) => {
        await mounted.flush(ticks);
        return result;
      },
      unmount: mounted.unmount,
    };
  };

  return { exports: mod.exports, React: runtime.React, mount, mountHook, textOf };
}
