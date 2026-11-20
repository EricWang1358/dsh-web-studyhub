import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { withStudy } from './helpers/study-services.mjs';

const m = await loadUi(`
  export { default as ExtensionPanel, ExtensionUpdateNotice } from './ui/ExtensionPanel.jsx';
  export { default as ExtensionNotStarted } from './ui/ExtensionNotStarted.jsx';
  export { default as ExtensionsSettings, endpointSavedMessage } from './ui/ExtensionsSettings.jsx';
  export { default as LargeDocumentCard } from './ui/LargeDocumentCard.jsx';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { setUiLanguage } from './ui/i18n.js';
  export { extensionDiagnostic } from './ui/install/install-diagnostics.js';
`);

const h = React.createElement;
const HAN = /[\u3400-\u9fff]/;
const FORBIDDEN_ZH = /您|请勿|必须|暂无|宿主|插件/;
const DESKTOP_HOST = { capabilities: { edition: 'desktop', chat: false, agentTasks: false, landing: false } };
const DSH_HOST = { capabilities: { edition: 'dsh', chat: true, agentTasks: true, landing: true } };
const COMPANION = 'mcp:mcp__studyhub__query_documents';
const noop = () => {};

const render = (element, { lang = 'zh', host = DESKTOP_HOST } = {}) => {
  m.setUiLanguage(lang);
  try { return renderToStaticMarkup(withStudy(m.StudyServicesContext, element, { host })); }
  finally { m.setUiLanguage('zh'); }
};

const baseStatus = {
  selected: 'builtin',
  effective: 'builtin',
  hostCanSearch: false,
  providers: [],
  otherTools: [],
  companion: { id: COMPANION, running: false },
};

const desktopExt = (over = {}) => ({
  canInstall: true,
  installed: false,
  enabled: false,
  desktop: true,
  desktopHost: true,
  source: 'none',
  canUninstall: false,
  canInstallStandalone: true,
  restartRequired: false,
  ...over,
});

const plan = {
  course: 'Operating Systems',
  pages: 48,
  toIndex: 48,
  unchanged: 0,
  toRemove: 0,
  chars: 24000,
  firstRun: true,
  modelMb: 90,
  canIndex: true,
};

test('StudyHub Desktop not installed: one-click install with desktop copy and zero DSH wording', () => {
  const status = { ...baseStatus, extension: desktopExt() };
  const zh = render(h(m.ExtensionPanel, { status, courses: ['OS'], defaultCourse: 'OS' }));
  assert.match(zh, /data-state="available"/);
  assert.match(zh, /由 StudyHub 桌面版直接运行/);
  assert.match(zh, /sh-btn--primary[^>]*>(?:<svg.*?<\/svg>)?安装检索扩展/);
  assert.equal((zh.match(/sh-btn--primary/g) || []).length, 1);
  assert.doesNotMatch(zh, /DSH|托盘图标|高级：手动配置|cordis\.patch\.yml/);
  assert.doesNotMatch(zh, FORBIDDEN_ZH);
  assert.doesNotMatch(zh, /title="/);

  const en = render(h(m.ExtensionPanel, { status, courses: ['OS'], defaultCourse: 'OS' }), { lang: 'en' });
  assert.match(en, /StudyHub Desktop/);
  assert.match(en, /Install the search extension/);
  assert.doesNotMatch(en, /DSH|tray icon/i);
  assert.doesNotMatch(en, HAN);
});

test('StudyHub Desktop unsupported platform: calm desktop message with zero DSH or manual config wording', () => {
  const status = { ...baseStatus, extension: desktopExt({ canInstall: false, canInstallStandalone: false }) };
  const zh = render(h(m.ExtensionPanel, { status }));
  assert.match(zh, /data-state="unsupported"/);
  assert.match(zh, /当前系统不支持一键安装检索扩展/);
  assert.doesNotMatch(zh, /<button[^>]*>(?:<svg.*?<\/svg>)?安装检索扩展/);
  assert.doesNotMatch(zh, /DSH|高级：手动配置|插件/);
  assert.doesNotMatch(zh, FORBIDDEN_ZH);

  const en = render(h(m.ExtensionPanel, { status }), { lang: 'en' });
  assert.doesNotMatch(en, /DSH|manual setup/i);
  assert.doesNotMatch(en, HAN);
});

test('StudyHub Desktop reusing DSH extension: shows reuse note, hides uninstall, offers secondary standalone install', () => {
  const status = {
    ...baseStatus,
    hostCanSearch: true,
    companion: { id: COMPANION, running: true },
    extension: desktopExt({
      installed: true,
      enabled: true,
      version: '4.15.1',
      source: 'dsh',
      canUninstall: false,
      canInstallStandalone: true,
    }),
  };
  const zh = render(h(m.ExtensionPanel, { status, courses: ['OS'], defaultCourse: 'OS', initialPlan: plan }));
  assert.match(zh, /data-state="running"/);
  assert.match(zh, /正在复用本机 DSH 已安装的检索扩展，已建索引和检索模型通用。/);
  assert.match(zh, /为这门课建立检索索引/);
  assert.doesNotMatch(zh, /卸载检索扩展/, 'Desktop must never pretend it can uninstall DSH packages');
  assert.match(zh, /sh-btn--secondary[^>]*>(?:<svg.*?<\/svg>)?独立安装到桌面版/);
  assert.match(zh, /独立安装后不再依赖本机 DSH/);
  assert.equal((zh.match(/sh-btn--primary/g) || []).length, 1, 'standalone install stays secondary');
  assert.doesNotMatch(zh, FORBIDDEN_ZH);

  const en = render(h(m.ExtensionPanel, { status, courses: ['OS'], defaultCourse: 'OS', initialPlan: plan }), { lang: 'en' });
  assert.match(en, /Reusing the search extension installed in DSH/);
  assert.match(en, /Install standalone copy in Desktop/);
  assert.doesNotMatch(en, /Uninstall the search extension/);
  assert.doesNotMatch(en, HAN);

  // When standalone install is unavailable (e.g. non-Windows desktop reusing DSH), hide both buttons.
  const dshOnly = {
    ...status,
    extension: { ...status.extension, canInstall: false, canInstallStandalone: false },
  };
  const dshOnlyZh = render(h(m.ExtensionPanel, { status: dshOnly, courses: ['OS'], defaultCourse: 'OS', initialPlan: plan }));
  assert.match(dshOnlyZh, /data-state="running"/);
  assert.match(dshOnlyZh, /正在复用本机 DSH 已安装的检索扩展/);
  assert.doesNotMatch(dshOnlyZh, /独立安装到桌面版|卸载检索扩展/);

  // When DSH reused extension is outdated, primary update button takes over without duplicating standalone install.
  const outdatedDsh = {
    ...status,
    extension: { ...status.extension, version: '4.7.0', outdated: true, expected: '4.15.1' },
  };
  const outdatedZh = render(h(m.ExtensionPanel, { status: outdatedDsh, courses: ['OS'], defaultCourse: 'OS', initialPlan: plan }));
  assert.match(outdatedZh, /本机 DSH 里的检索扩展版本较旧/);
  assert.match(outdatedZh, /不影响 DSH/);
  assert.match(outdatedZh, /更新检索扩展/);
  assert.doesNotMatch(outdatedZh, /独立安装到桌面版|卸载检索扩展|托盘图标/);
  assert.doesNotMatch(render(h(m.ExtensionPanel, { status: outdatedDsh, courses: ['OS'], defaultCourse: 'OS', initialPlan: plan }), { lang: 'en' }), HAN);
});

test('StudyHub Desktop standalone installed & running: shows IndexBuilder and uninstall, zero DSH strings', () => {
  const status = {
    ...baseStatus,
    hostCanSearch: true,
    companion: { id: COMPANION, running: true },
    extension: desktopExt({
      installed: true,
      enabled: true,
      version: '4.15.1',
      source: 'desktop',
      canUninstall: true,
      canInstallStandalone: false,
    }),
  };
  const zh = render(h(m.ExtensionPanel, { status, courses: ['OS'], defaultCourse: 'OS', initialPlan: plan }));
  assert.match(zh, /data-state="running"/);
  assert.match(zh, /检索扩展已安装并在运行。/);
  assert.match(zh, /为这门课建立检索索引/);
  assert.match(zh, /卸载检索扩展/);
  assert.doesNotMatch(zh, /独立安装到桌面版/);
  assert.doesNotMatch(zh, /DSH|托盘图标/);
  assert.doesNotMatch(zh, FORBIDDEN_ZH);

  const en = render(h(m.ExtensionPanel, { status, courses: ['OS'], defaultCourse: 'OS', initialPlan: plan }), { lang: 'en' });
  assert.match(en, /The search extension is installed and running/);
  assert.match(en, /Uninstall the search extension/);
  assert.doesNotMatch(en, /DSH|tray icon/i);
  assert.doesNotMatch(en, HAN);
});

test('StudyHub Desktop StartupWait & ExtensionUpdateNotice: hot-restart wording with zero DSH restart or tray instructions', () => {
  const starting = {
    ...baseStatus,
    extension: desktopExt({ installed: true, enabled: true, version: '4.15.1', source: 'desktop', canUninstall: true, canInstallStandalone: false }),
  };
  const startZh = render(h(m.ExtensionPanel, { status: starting }));
  assert.match(startZh, /data-state="starting"/);
  assert.match(startZh, /正在启动检索服务/);
  assert.doesNotMatch(startZh, /DSH|托盘图标|重启/);
  assert.doesNotMatch(startZh, FORBIDDEN_ZH);
  const startEn = render(h(m.ExtensionPanel, { status: starting }), { lang: 'en' });
  assert.match(startEn, /starting the search service/i);
  assert.doesNotMatch(startEn, /DSH|tray icon|restart/i);
  assert.doesNotMatch(startEn, HAN);

  const outdated = {
    ...starting,
    extension: { ...starting.extension, version: '4.14.0', outdated: true, expected: '4.15.1' },
  };
  const outdatedZh = render(h(m.ExtensionUpdateNotice, { status: outdated }));
  assert.match(outdatedZh, /更新后会自动生效，无需重启/);
  assert.match(outdatedZh, /更新检索扩展/);
  assert.doesNotMatch(outdatedZh, /DSH|托盘图标/);
  assert.doesNotMatch(outdatedZh, FORBIDDEN_ZH);
  const outdatedEn = render(h(m.ExtensionUpdateNotice, { status: outdated }), { lang: 'en' });
  assert.match(outdatedEn, /no restart needed/i);
  assert.doesNotMatch(outdatedEn, /DSH|tray icon/i);
  assert.doesNotMatch(outdatedEn, HAN);

  const appliedZh = render(h(m.ExtensionUpdateNotice, { status: starting, initialDone: { restart: false } }));
  assert.match(appliedZh, /已更新并生效，无需重启。/);
  assert.doesNotMatch(appliedZh, /DSH|托盘图标/);
  const appliedEn = render(h(m.ExtensionUpdateNotice, { status: starting, initialDone: { restart: false } }), { lang: 'en' });
  assert.match(appliedEn, /Updated and active, no restart needed/);
  assert.doesNotMatch(appliedEn, /DSH|tray icon/i);
  assert.doesNotMatch(appliedEn, HAN);

  const stuck = {
    ...starting,
    extension: { ...starting.extension, restartFailed: { pending: '4.15.1', running: '4.14.0' } },
  };
  const stuckZh = render(h(m.ExtensionUpdateNotice, { status: stuck }));
  assert.match(stuckZh, /重新安装检索扩展/);
  assert.doesNotMatch(stuckZh, /DSH|托盘图标/);
  assert.doesNotMatch(render(h(m.ExtensionUpdateNotice, { status: stuck }), { lang: 'en' }), HAN);

  // When canInstall === false (e.g. non-Windows desktop reusing outdated DSH extension), hide clickable update/reinstall buttons.
  const dshOutdatedNoInstall = {
    ...starting,
    extension: desktopExt({
      canInstall: false,
      canInstallStandalone: false,
      installed: true,
      enabled: true,
      version: '4.7.0',
      outdated: true,
      expected: '4.15.1',
      source: 'dsh',
    }),
  };
  const dshNoInstallZh = render(h(m.ExtensionUpdateNotice, { status: dshOutdatedNoInstall }));
  assert.match(dshNoInstallZh, /请在 DSH 里更新检索扩展/);
  assert.doesNotMatch(dshNoInstallZh, /<button[^>]*>.*更新检索扩展/);
  assert.doesNotMatch(dshNoInstallZh, FORBIDDEN_ZH);
  assert.doesNotMatch(render(h(m.ExtensionUpdateNotice, { status: dshOutdatedNoInstall }), { lang: 'en' }), HAN);

  const desktopOutdatedNoInstall = {
    ...starting,
    extension: { ...starting.extension, canInstall: false, version: '4.14.0', outdated: true, expected: '4.15.1' },
  };
  const desktopNoInstallZh = render(h(m.ExtensionUpdateNotice, { status: desktopOutdatedNoInstall }));
  assert.match(desktopNoInstallZh, /当前系统不支持应用内一键更新/);
  assert.doesNotMatch(desktopNoInstallZh, /<button[^>]*>.*更新检索扩展|DSH/);
  assert.doesNotMatch(render(h(m.ExtensionUpdateNotice, { status: desktopOutdatedNoInstall }), { lang: 'en' }), HAN);

  const stuckNoInstall = {
    ...starting,
    extension: { ...starting.extension, canInstall: false, restartFailed: { pending: '4.15.1', running: '4.14.0' } },
  };
  const stuckNoInstallZh = render(h(m.ExtensionUpdateNotice, { status: stuckNoInstall }));
  assert.match(stuckNoInstallZh, /不支持一键重新安装/);
  assert.doesNotMatch(stuckNoInstallZh, /<button[^>]*>.*重新安装检索扩展|DSH/);
  assert.doesNotMatch(render(h(m.ExtensionUpdateNotice, { status: stuckNoInstall }), { lang: 'en' }), HAN);
});

test('ExtensionsSettings in StudyHub Desktop hides AdvancedTools/cordis.patch.yml and uses immediate desktop endpoint copy', () => {
  const status = {
    ...baseStatus,
    extension: desktopExt(),
  };
  const zh = render(h(m.ExtensionsSettings, { initialStatus: status, courses: ['OS'] }));
  assert.match(zh, /安装检索扩展/);
  assert.match(zh, /保存后会立即生效/);
  assert.doesNotMatch(zh, /cordis\.patch\.yml|@deepseek-ai\/dsh-mcp-client|RAGFlow|高级：手动配置|高级：其他方式/);
  assert.doesNotMatch(zh, /其他检索工具 · 模型下载地址 · 手动配置/);
  assert.doesNotMatch(zh, /DSH|托盘图标/);
  assert.doesNotMatch(zh, FORBIDDEN_ZH);

  const en = render(h(m.ExtensionsSettings, { initialStatus: status, courses: ['OS'] }), { lang: 'en' });
  assert.match(en, /take effect immediately after saving/i);
  assert.doesNotMatch(en, /cordis\.patch\.yml|manual setup|DSH|tray icon/i);
  assert.doesNotMatch(en, HAN);

  // Even when status has no extension field yet, host.capabilities.edition === 'desktop' still hides AdvancedTools.
  const viaHostOnly = render(h(m.ExtensionsSettings, { initialStatus: baseStatus, courses: [] }), { host: DESKTOP_HOST });
  assert.doesNotMatch(viaHostOnly, /cordis\.patch\.yml|高级：手动配置|DSH/);

  // Missing provider in desktop mode does not mention DSH.
  const missingDesktop = {
    ...status,
    selected: 'mcp:mcp__custom__search',
    missing: 'mcp:mcp__custom__search',
  };
  const missingZh = render(h(m.ExtensionsSettings, { initialStatus: missingDesktop, courses: [] }));
  assert.match(missingZh, /请先安装或启动检索扩展/);
  assert.doesNotMatch(missingZh, /DSH/);
  assert.doesNotMatch(render(h(m.ExtensionsSettings, { initialStatus: missingDesktop, courses: [] }), { lang: 'en' }), HAN);

  // endpointSavedMessage in desktopHost mode says saved/restored immediately with zero DSH.
  const savedZh = m.endpointSavedMessage('https://hf-mirror.com', true, true);
  const clearedZh = m.endpointSavedMessage('', true, true);
  assert.match(savedZh, /立即生效/);
  assert.match(clearedZh, /立即生效/);
  assert.doesNotMatch(`${savedZh}\n${clearedZh}`, /DSH|托盘图标/);
  assert.doesNotMatch(`${savedZh}\n${clearedZh}`, FORBIDDEN_ZH);

  m.setUiLanguage('en');
  try {
    const savedEn = m.endpointSavedMessage('https://hf-mirror.com', true, true);
    const clearedEn = m.endpointSavedMessage('', true, true);
    assert.match(savedEn, /applied immediately/i);
    assert.match(clearedEn, /applied immediately/i);
    assert.doesNotMatch(`${savedEn}\n${clearedEn}`, /DSH|tray icon/i);
    assert.doesNotMatch(`${savedEn}\n${clearedEn}`, HAN);
  } finally { m.setUiLanguage('zh'); }
});

test('ExtensionNotStarted in StudyHub Desktop replaces DSH restart/tray copy with automatic restart copy', () => {
  const stopped = {
    ...baseStatus,
    companion: { id: COMPANION, running: false, notStarted: true },
    extension: desktopExt({ installed: true, enabled: true, version: '4.15.1', source: 'desktop', canUninstall: true, canInstallStandalone: false }),
  };
  const zh = render(h(m.ExtensionNotStarted, { status: stopped, refresh: noop, repair: async () => {}, restart: async () => stopped }));
  assert.match(zh, /检索扩展装好了，但检索服务没有启动/);
  assert.match(zh, /自动重置索引并重启检索服务/);
  assert.equal(zh.match(/>重试启动</g)?.length, 1);
  assert.equal(zh.match(/>修复</g)?.length, 1);
  assert.match(zh, /复制诊断信息/);
  assert.match(zh, /复制提示词/);
  assert.doesNotMatch(zh, /DSH|托盘图标|>发给主会话</);
  assert.doesNotMatch(zh, FORBIDDEN_ZH);
  assert.doesNotMatch(zh, /title="/);

  const en = render(h(m.ExtensionNotStarted, { status: stopped, refresh: noop, repair: async () => {}, restart: async () => stopped }), { lang: 'en' });
  assert.match(en, /Retry startup/);
  assert.match(en, /restart the search service automatically/i);
  assert.match(en, /Copy prompt/);
  assert.doesNotMatch(en, /DSH|tray icon|>Send to the main chat</i);
  assert.doesNotMatch(en, HAN);

  const failedAfterRepair = {
    ...stopped,
    companion: { ...stopped.companion, reset: { at: '2026-11-20T00:00:00.000Z', reason: 'repair', pages: 12, restartedAfterRepair: true } },
  };
  const failedZh = render(h(m.ExtensionNotStarted, { status: failedAfterRepair, refresh: noop, repair: async () => {}, restart: async () => failedAfterRepair }));
  assert.equal(failedZh.match(/>重试启动</g)?.length, 1);
  assert.doesNotMatch(failedZh, />修复</);
  assert.match(failedZh, /已重置索引并尝试重启检索服务/);
  assert.doesNotMatch(failedZh, /DSH|托盘图标|>发给主会话</);
  assert.doesNotMatch(render(h(m.ExtensionNotStarted, { status: failedAfterRepair, refresh: noop, repair: async () => {}, restart: async () => failedAfterRepair }), { lang: 'en' }), HAN);

  const diag = m.extensionDiagnostic({
    status: {
      ...stopped,
      extension: desktopExt({
        installed: true,
        enabled: true,
        version: '4.15.1',
        source: 'desktop',
        error: 'retrieval-start-failed',
        errorDetail: 'onnxruntime load failed with sk-secret12345678901234567890',
      }),
    },
    code: 'companion-not-started',
    summary: '检索扩展装好了，但检索服务没有启动',
  });
  assert.match(diag.text, /source: desktop/);
  assert.match(diag.text, /host: desktop/);
  assert.match(diag.text, /onnxruntime load failed/);
  assert.doesNotMatch(diag.text, /sk-secret12345678901234567890/);
});

test('ExtensionNotStarted repair() awaits refresh() before marking repaired so successful desktop repair never flashes failure', async t => {
  const prevDoc = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { visibilityState: 'visible', addEventListener: () => {}, removeEventListener: () => {} },
  });
  t.after(() => {
    if (prevDoc) Object.defineProperty(globalThis, 'document', prevDoc);
    else delete globalThis.document;
  });
  const states = [], refs = [], cleanups = [];
  let stateAt = 0, refAt = 0, pending = [];
  const hooks = {
    ...React,
    useId: () => 'ens',
    useContext: () => null,
    useSyncExternalStore: (_sub, get) => get(),
    useRef: initial => refs[refAt++] ||= { current: initial },
    useState: initial => {
      const idx = stateAt++;
      if (!(idx in states)) states[idx] = typeof initial === 'function' ? initial() : initial;
      return [states[idx], value => { states[idx] = typeof value === 'function' ? value(states[idx]) : value; }];
    },
    useEffect: effect => { pending.push(() => { cleanups.push(effect()); }); },
  };
  const require = createRequire(import.meta.url);
  const compiled = await build({
    stdin: { contents: `export { default as ExtensionNotStarted } from './ui/ExtensionNotStarted.jsx';`, resolveDir: process.cwd() },
    bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react'],
    loader: { '.css': 'text', '.json': 'json' }, logLevel: 'silent',
  });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(name => (name === 'react' ? hooks : require(name)), mod, mod.exports);

  const find = (node, match) => {
    if (!node || typeof node !== 'object') return null;
    if (match(node)) return node;
    for (const child of [node.props?.children].flat()) { const hit = find(child, match); if (hit) return hit; }
    return null;
  };
  const stopped = {
    ...baseStatus,
    companion: { id: COMPANION, running: false, notStarted: true },
    extension: desktopExt({ installed: true, enabled: true, version: '4.15.1', source: 'desktop', canUninstall: true, canInstallStandalone: false }),
  };

  let unmountOnRefresh = false;
  let repairedDuringRefresh = null;
  const draw = () => {
    stateAt = 0; refAt = 0; pending = [];
    const tree = mod.exports.ExtensionNotStarted({
      status: stopped,
      repair: async () => {},
      refresh: async () => {
        repairedDuringRefresh = states[1];
        if (unmountOnRefresh) cleanups.splice(0).forEach(fn => fn?.());
      },
    });
    pending.forEach(fn => fn());
    return tree;
  };

  // 1. Open confirm dialog -> trigger repair when service comes back (component unmounts during refresh): repaired stays false!
  unmountOnRefresh = true;
  let tree = draw();
  find(tree, n => n.props?.action?.onClick).props.action.onClick();
  tree = draw();
  await find(tree, n => typeof n.props?.onConfirm === 'function').props.onConfirm();
  assert.equal(repairedDuringRefresh, false, 'repaired must remain false while refresh() is in flight');
  assert.equal(states[1], false, 'unmounted component does not flip repaired to true');

  // 2. When component stays mounted after refresh() (service still down), repaired flips to true after refresh().
  states.length = 0; refs.length = 0; cleanups.length = 0;
  unmountOnRefresh = false;
  repairedDuringRefresh = null;
  tree = draw();
  find(tree, n => n.props?.action?.onClick).props.action.onClick();
  tree = draw();
  await find(tree, n => typeof n.props?.onConfirm === 'function').props.onConfirm();
  assert.equal(repairedDuringRefresh, false, 'repaired is still false until refresh() resolves');
  assert.equal(states[1], true, 'still-mounted component marks repaired after refresh() completes');
  cleanups.splice(0).forEach(fn => fn?.());
});

test('LargeDocumentCard in StudyHub Desktop omits DSH manual config and RAGFlow while keeping local converters', () => {
  const status = { ...baseStatus, extension: desktopExt() };
  const zh = render(h(m.LargeDocumentCard, { reason: 'selection', detail: { chars: 700000 }, retrieval: status, runnable: true, courses: ['OS'] }));
  assert.match(zh, /高级：其他转换方式（桌面客户端、命令行）/);
  assert.match(zh, /MinerU/);
  assert.match(zh, /Docling/);
  assert.doesNotMatch(zh, /cordis\.patch\.yml|RAGFlow|DSH/);

  const en = render(h(m.LargeDocumentCard, { reason: 'selection', detail: { chars: 700000 }, retrieval: status, runnable: true, courses: ['OS'] }), { lang: 'en' });
  assert.doesNotMatch(en, /cordis\.patch\.yml|RAGFlow|DSH/);
  assert.doesNotMatch(en, HAN);
});

test('regression: DSH plugin mode (desktopHost absent) keeps DSH web and DSH desktop copy & AdvancedTools unchanged', () => {
  for (const desktop of [false, true]) {
    const ext = { canInstall: true, installed: false, enabled: false, desktop };
    const status = { ...baseStatus, extension: ext };
    const settingsZh = render(h(m.ExtensionsSettings, { initialStatus: status, courses: ['OS'] }), { host: DSH_HOST });
    assert.match(settingsZh, /由 DSH 自己安装并运行/);
    assert.match(settingsZh, /cordis\.patch\.yml/);
    assert.match(settingsZh, /高级：手动配置/);
    assert.match(settingsZh, /其他检索工具 · 模型下载地址 · 手动配置/);
    if (desktop) {
      assert.match(settingsZh, /托盘图标/);
      assert.match(m.endpointSavedMessage('https://hf-mirror.com', true), /托盘图标/);
    } else {
      assert.match(settingsZh, /改动在重启 DSH 后生效/);
      assert.match(m.endpointSavedMessage('https://hf-mirror.com', false), /重启 DSH 后生效/);
    }
  }
});
