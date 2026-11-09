import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { classifyFailure } from '../lib/tool-install.js';
import { LIVE_LOCAL_MESSAGES } from '../lib/live-local-install-text.js';
import { LIVE_LOOPBACK_MESSAGES } from '../lib/live-loopback-install-text.js';
import { loadUi } from './helpers/ui-module.mjs';

const uiMod = await loadUi(`
  export { default as DiagnosticActions, DiagnosticBar } from './ui/install/DiagnosticActions.jsx';
  export {
    redactDiagnosticText,
    joinLogBlocks,
    formatDiagnosticReport,
    mineruDiagnostic,
    markerDiagnostic,
    liveLocalDiagnostic,
    liveLoopbackDiagnostic,
    extensionDiagnostic,
  } from './ui/install/install-diagnostics.js';
  export { handOffText } from './ui/agent-prompts/index.js';
  export { default as LiveLocalCard } from './ui/LiveLocalCard.jsx';
  export { default as LiveLoopbackCard } from './ui/LiveLoopbackCard.jsx';
  export { default as ExtensionPanel } from './ui/ExtensionPanel.jsx';
  export { default as ExtensionNotStarted } from './ui/ExtensionNotStarted.jsx';
  export { default as MarkerSettings } from './ui/MarkerSettings.jsx';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { setUiLanguage } from './ui/i18n.js';
`);

const h = React.createElement;
const han = /[\u3400-\u9fff]/;
const textOf = html => html.replace(/<[^>]*>/g, ' ').replace(/&[a-z#0-9]+;/g, ' ').replace(/\s+/g, ' ');
const primaries = html => (html.match(/class="sh-btn sh-btn--primary/g) || []).length;
const render = (el, lang = 'zh') => { uiMod.setUiLanguage(lang); try { return renderToStaticMarkup(el); } finally { uiMod.setUiLanguage('zh'); } };
const flush = () => new Promise(resolve => setImmediate(resolve));

async function mountCopyHarness() {
  const states = [], refs = [], deps = [], cleanups = [];
  let stateAt = 0, refAt = 0, effectAt = 0, pending = [];
  const hooks = {
    ...React,
    useId: () => 'diag',
    useContext: () => null,
    useSyncExternalStore: (_sub, get) => get(),
    useLayoutEffect: () => {},
    useInsertionEffect: () => {},
    useMemo: fn => fn(),
    useCallback: fn => fn,
    useRef: initial => refs[refAt++] ||= { current: initial },
    useState: initial => {
      const idx = stateAt++;
      if (!(idx in states)) states[idx] = typeof initial === 'function' ? initial() : initial;
      return [states[idx], value => { states[idx] = typeof value === 'function' ? value(states[idx]) : value; }];
    },
    useEffect: (effect, dependencies) => {
      const idx = effectAt++;
      if (!deps[idx] || !dependencies || dependencies.some((v, pos) => v !== deps[idx][pos])) {
        deps[idx] = dependencies;
        pending.push(() => { cleanups[idx]?.(); cleanups[idx] = effect(); });
      }
    },
  };
  const require = createRequire(import.meta.url);
  const compiled = await build({
    stdin: {
      contents: `
        export { default as DiagnosticActions, DiagnosticBar } from './ui/install/DiagnosticActions.jsx';
        export { useCopyFeedback } from './ui/use-copy-feedback.js';
      `,
      resolveDir: process.cwd(),
    },
    bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react'],
    loader: { '.css': 'text', '.json': 'json' }, logLevel: 'silent',
  });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(name => (name === 'react' ? hooks : require(name)), mod, mod.exports);
  return {
    exports: mod.exports,
    run(fn) {
      stateAt = 0; refAt = 0; effectAt = 0; pending = [];
      const out = fn(mod.exports);
      pending.forEach(effect => effect());
      return out;
    },
    close() { cleanups.forEach(cleanup => cleanup?.()); },
  };
}

test('tool-install classifyFailure detects ENAMETOOLONG and Windows/POSIX access-denied messages', () => {
  assert.equal(classifyFailure('Error: ENAMETOOLONG: name too long, open C:\\deep\\file'), 'path-too-long');
  assert.equal(classifyFailure("error CS0016: Access to the path 'D:\\Locked\\out.exe' is denied."), 'not-writable');
  assert.equal(classifyFailure('Error: EACCES: permission denied, mkdir /opt/locked'), 'not-writable');
});

test('useCopyFeedback evaluates lazy getter functions, tracks refused clipboards, and resets cleanly via DiagnosticBar', async t => {
  const prevDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  let written = '', shouldFail = false;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { clipboard: { writeText: async value => { if (shouldFail) throw new Error('denied'); written = value; } } },
  });
  t.after(() => { if (prevDescriptor) Object.defineProperty(globalThis, 'navigator', prevDescriptor); else delete globalThis.navigator; });

  const harness = await mountCopyHarness();
  t.after(() => harness.close());

  let count = 0;
  let bar = harness.run(({ DiagnosticBar }) => DiagnosticBar({ text: () => `lazy-report-${++count}`, resetKey: 'a', children: null }));
  const findBtn = node => {
    if (!node || typeof node !== 'object') return null;
    if (typeof node.props?.onClick === 'function') return node;
    for (const child of [node.props?.children].flat()) { const hit = findBtn(child); if (hit) return hit; }
    return null;
  };
  assert.equal(count, 0, 'lazy getter is not called before clicking copy');
  await findBtn(bar).props.onClick();
  await flush();
  assert.equal(written, 'lazy-report-1');
  bar = harness.run(({ DiagnosticBar }) => DiagnosticBar({ text: () => `lazy-report-${++count}`, resetKey: 'a', children: null }));
  assert.equal(findBtn(bar).props.children, '已复制');

  // Changing resetKey resets copied state back to 复制诊断信息.
  bar = harness.run(({ DiagnosticBar }) => DiagnosticBar({ text: () => `lazy-report-${++count}`, resetKey: 'b', children: null }));
  bar = harness.run(({ DiagnosticBar }) => DiagnosticBar({ text: () => `lazy-report-${++count}`, resetKey: 'b', children: null }));
  assert.equal(findBtn(bar).props.children, '复制诊断信息');

  // Clipboard rejection surfaces the fallback note instead of throwing.
  shouldFail = true;
  await findBtn(bar).props.onClick();
  await flush();
  bar = harness.run(({ DiagnosticBar }) => DiagnosticBar({ text: () => 'x', resetKey: 'b', children: null }));
  const flatText = JSON.stringify(bar);
  assert.match(flatText, /没能复制，请点「发给主会话」查看全文/);
});

test('redactDiagnosticText and all 5 setup.failed tool prompts stay credential-free, fence-safe, and Han-free in English', () => {
  const dirty = 'GET https://alice:s3cret-pass@mirror.example.com/pkg Authorization: Bearer sk-live-1234567890abcdef api_key="tok_abcdef123456"';
  const clean = uiMod.redactDiagnosticText(dirty);
  assert.ok(!clean.includes('s3cret-pass') && !clean.includes('sk-live-1234567890abcdef') && !clean.includes('tok_abcdef123456'), clean);
  assert.match(clean, /https:\/\/\*\*\*@mirror\.example\.com\/pkg/);

  const bundles = [
    uiMod.mineruDiagnostic({
      plan: { platform: 'win32' },
      shown: { state: 'error', code: 'not-writable', origin: 'install' },
      install: { step: 5, stage: 'enable', folder: 'D:\\StudyHub\\MinerU', tier: 'basic', source: { id: 'mainland' }, log: [dirty] },
      summary: 'Permission denied on home folder',
      stageLabel: 'Enable local service',
    }),
    uiMod.markerDiagnostic({
      plan: { platform: 'win32', maxPython: '3.13', tooNewPython: '3.14.2' },
      install: { status: 'failed', stage: 'install', folder: 'D:\\StudyHub\\Marker', mirror: 'tsinghua', error: { code: 'pip-build', message: 'Build failed' }, log: [dirty] },
      summary: 'Pillow wheel build failed',
      stageLabel: 'Install marker-pdf',
    }),
    uiMod.liveLocalDiagnostic({
      plan: { platform: 'win32', arch: 'x64' },
      shown: { state: 'error', code: 'vc-runtime' },
      status: { step: 3, of: 3, stage: 'check', folder: 'D:\\StudyHub\\LiveLocal', engineVersion: '1.13.8', log: [dirty] },
      modelId: 'sense-voice',
      summary: 'Missing Microsoft VC++ runtime',
      stageLabel: 'Check engine',
    }),
    uiMod.liveLoopbackDiagnostic({
      plan: { platform: 'win32', arch: 'x64' },
      shown: { state: 'error', code: 'not-writable' },
      status: { step: 1, of: 2, stage: 'compile', folder: 'D:\\StudyHub\\LiveLoopback', helperVersion: '1.0.0', log: [dirty] },
      summary: 'Folder cannot be written to',
      stageLabel: 'Build audio helper',
    }),
    uiMod.extensionDiagnostic({
      status: { extension: { version: '2.1.2', outdated: true, expected: '2.1.3' }, companion: { id: 'mcp:rag', notStarted: true, reset: { reason: 'corrupt' } } },
      run: { status: 'failed', stage: 'model', errorCode: 'retrieval-model-download', error: dirty, failed: [{ id: 'p1', message: 'timeout' }] },
      course: 'OS',
      summary: 'Model download timed out',
    }),
  ];

  for (const { input, text } of bundles) {
    assert.ok(!text.includes('s3cret-pass') && !input.log.includes('s3cret-pass'), `${input.tool} redacts secrets`);
    const zh = uiMod.handOffText('setup.failed', input, 'zh');
    const en = uiMod.handOffText('setup.failed', input, 'en');
    assert.match(zh, /^我在 StudyHub 的「.+」想排查/);
    assert.match(en, /^In StudyHub’s .+ I want to find out why/);
    assert.doesNotMatch(en, han, `${input.tool} English prompt contains Han: ${en}`);
  }
});

test('LiveLocalCard, LiveLoopbackCard, ExtensionPanel, ExtensionNotStarted, and MarkerSettings wire 复制诊断信息 + setup.failed without extra primary buttons or Chinese in English', () => {
  const callStub = async () => ({});
  const localBase = {
    status: 'failed', stage: 'check', stages: ['engine', 'model', 'check'], done: ['engine', 'model'], step: 3, of: 3,
    folder: 'D:\\StudyHub\\LiveLocal', installedFolder: '', installed: false, ready: false, supported: true, tested: true,
    engineVersion: '1.13.8', downloadMb: 239, diskMb: 253, modelMb: 228, log: ['vcruntime140.dll missing'],
    error: { code: 'vc-runtime', message: LIVE_LOCAL_MESSAGES.vcRuntime },
  };
  const localPlan = { ok: true, problems: [], warnings: [], folder: 'D:\\StudyHub\\LiveLocal', defaultFolder: 'D:\\StudyHub\\LiveLocal', platform: 'win32', supported: true, tested: true, drives: [], disk: { freeMb: 50_000, neededMb: 600, drive: 'D:' }, estimate: { downloadMb: 239, diskMb: 253 }, files: [] };

  const vcZh = render(h(uiMod.LiveLocalCard, { call: callStub, initialStatus: localBase, initialPlan: localPlan }));
  assert.equal(primaries(vcZh), 1);
  assert.match(textOf(vcZh), /下载 VC\+\+ 运行库[\s\S]*重试[\s\S]*复制诊断信息[\s\S]*发给主会话/);
  assert.match(vcZh, /data-hand-off="setup\.failed"/);
  assert.doesNotMatch(textOf(render(h(uiMod.LiveLocalCard, { call: callStub, initialStatus: localBase, initialPlan: localPlan }), 'en')), han);

  const longPathLocalZh = render(h(uiMod.LiveLocalCard, {
    call: callStub,
    initialStatus: { ...localBase, error: { code: 'path-too-long', message: LIVE_LOCAL_MESSAGES.pathTooLong } },
    initialPlan: localPlan,
  }));
  assert.match(textOf(longPathLocalZh), /换位置/);
  assert.doesNotMatch(textOf(render(h(uiMod.LiveLocalCard, {
    call: callStub,
    initialStatus: { ...localBase, error: { code: 'path-too-long', message: LIVE_LOCAL_MESSAGES.pathTooLong } },
    initialPlan: localPlan,
  }), 'en')), han);

  const loopbackFailed = {
    status: 'failed', stage: 'compile', stages: ['compile', 'check'], done: [], step: 1, of: 2,
    folder: 'D:\\StudyHub\\LiveLoopback', installedFolder: '', installed: false, ready: false, supported: true, tested: true,
    helperVersion: '1.0.0', downloadMb: 0, diskMb: 1, log: ['CS0016'],
    error: { code: 'path-too-long', message: LIVE_LOOPBACK_MESSAGES.pathTooLong },
  };
  const loopZh = render(h(uiMod.LiveLoopbackCard, { call: callStub, initialStatus: loopbackFailed, initialPlan: localPlan }));
  assert.equal(primaries(loopZh), 1);
  assert.match(textOf(loopZh), /换位置[\s\S]*复制诊断信息[\s\S]*发给主会话/);
  assert.match(loopZh, /data-hand-off="setup\.failed"/);
  assert.doesNotMatch(textOf(render(h(uiMod.LiveLoopbackCard, { call: callStub, initialStatus: loopbackFailed, initialPlan: localPlan }), 'en')), han);

  const extRunning = { selected: 'builtin', effective: 'builtin', hostCanSearch: true, providers: [], otherTools: [], extension: { canInstall: true, installed: true, enabled: true, version: '2.1.1', desktop: false }, companion: { id: 'mcp:q', running: true } };
  const extFailedZh = render(h(uiMod.ExtensionPanel, {
    status: extRunning, courses: ['OS'], defaultCourse: 'OS',
    initialPlan: { course: 'OS', pages: 10, toIndex: 10, unchanged: 0, toRemove: 0, chars: 5000, firstRun: true, modelMb: 90, canIndex: true },
    initialRun: { status: 'failed', error: 'network reset', errorCode: 'retrieval-model-download' },
  }));
  assert.match(textOf(extFailedZh), /复制诊断信息[\s\S]*发给主会话/);
  assert.match(extFailedZh, /data-hand-off="setup\.failed"/);

  const notStartedStatus = { ...extRunning, companion: { id: 'mcp:q', running: false, notStarted: true } };
  const notStartedZh = render(h(uiMod.ExtensionNotStarted, { status: notStartedStatus, refresh: callStub, repair: callStub }));
  assert.match(textOf(notStartedZh), /复制诊断信息[\s\S]*发给主会话/);
  assert.doesNotMatch(textOf(render(h(uiMod.ExtensionNotStarted, { status: notStartedStatus, refresh: callStub, repair: callStub }), 'en')), han);

  const markerSettingsEn = render(h(uiMod.MarkerSettings, { available: true }), 'en');
  assert.doesNotMatch(textOf(markerSettingsEn), han);
});
