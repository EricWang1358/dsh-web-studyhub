import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';

const h = React.createElement;
const m = await loadUi(`
  export { DESKTOP_PARTS } from './ui/desktop/parts.jsx';
  export { default as DesktopCliCard } from './ui/desktop/DesktopCliCard.jsx';
  export { default as DesktopOpenAiForm } from './ui/desktop/DesktopOpenAiForm.jsx';
  export { default as DesktopLibraryNotice } from './ui/desktop/DesktopLibraryNotice.jsx';
  export { default as DesktopUpgradeGuide } from './ui/desktop/DesktopUpgradeGuide.jsx';
  export { MODEL_PRESETS, presetOf } from './ui/desktop/presets.js';
  export { createDesktopHost, loadBootstrapInfo, safeExternalUrl, syncDesktopConcurrency, readDesktopConcurrency } from './ui/desktop/ipc.js';
  export { effectiveConcurrencyLimit, registerHostConcurrencyCap } from './lib/generation-settings.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { AppContext } from './ui/app/app-context.js';
  export { registerHostParts } from './ui/host-parts.js';
  export { modelFact } from './ui/ModelSetupGate.jsx';
  export { HandOffButton } from './ui/hand-off/HandOff.jsx';
  export { default as HandOffSheet } from './ui/hand-off/HandOffSheet.jsx';
  export { deliverToChat, COPY_PROMPT_LABEL, COPY_PROMPT_RECEIPT_LINE, HAND_OFF_LABEL } from './ui/hand-off/use-hand-off.js';
  export { default as GuidancePane } from './ui/settings/GuidancePane.jsx';
  export { GenerationSettingsForm } from './ui/GenerationSettings.jsx';
  export { default as WorkspaceBindingPanel } from './ui/app/WorkspaceBindingPanel.jsx';
  export { UpdateSettings } from './ui/UpdateCenter.jsx';
  export { DiagnosticBar } from './ui/install/DiagnosticActions.jsx';
  export { availableTourSteps, TOUR_STEPS } from './ui/tour/steps.js';
  export { FINDER_ENTRIES } from './ui/finder/entries.js';
  export { finderAvailability, withAvailability } from './ui/finder/availability.js';
  export { diagnosticText } from './ui/diagnostics.js';
  export { setUiLanguage } from './ui/i18n.js';
`);

const DESKTOP_HOST = { capabilities: { edition: 'desktop', chat: false, agentTasks: false, landing: false } };
const DSH_HOST = { capabilities: { edition: 'dsh', chat: true, agentTasks: true, landing: true } };

const withHost = (host, node) => h(m.StudyServicesContext.Provider, {
  value: { call: async () => ({}), act: async () => undefined, busy: false, notify: () => {}, askInChat: () => {}, host, openSettings: () => {}, navigate: () => {}, openModal: () => {} },
}, node);

const render = (node, language = 'zh') => {
  m.setUiLanguage(language);
  try { return renderToStaticMarkup(node); } finally { m.setUiLanguage('zh'); }
};

test('DESKTOP_PARTS exposes all 6 host-part slots and renders upgrade & library notices cleanly in zh and en', () => {
  assert.deepEqual(Object.keys(m.DESKTOP_PARTS).sort(), [
    'LibraryNotice', 'ModelGateForm', 'ModelSetup', 'UpgradeGuide', 'modelFact', 'modelSetupSteps', 'runningNote',
  ]);
  const upgradeZh = render(h(m.DesktopUpgradeGuide, { update: { assetUrl: 'https://example.com/StudyHub.msi', assetName: 'StudyHub.msi' } }), 'zh');
  assert.match(upgradeZh, /SmartScreen/);
  assert.match(upgradeZh, /SHA256SUMS/);
  assert.match(upgradeZh, /update-release-link/);
  const upgradeEn = render(h(m.DesktopUpgradeGuide, { update: { assetUrl: 'https://example.com/StudyHub.msi', assetName: 'StudyHub.msi' } }), 'en');
  assert.doesNotMatch(upgradeEn.replace(/<[^>]+>/g, ' '), /[㐀-鿿]/, 'English upgrade guide has zero untranslated Han text');

  const noticeZh = render(h(m.DesktopLibraryNotice, { binding: { libraryProblem: { message: 'Folder unreadable' } } }), 'zh');
  assert.match(noticeZh, /Folder unreadable/);
  assert.match(noticeZh, /文件锁/);
  const noticeReasonFallback = render(h(m.DesktopLibraryNotice, { binding: { libraryProblem: { reason: 'Permission denied' } } }), 'zh');
  assert.match(noticeReasonFallback, /Permission denied/);
  const noticeEn = render(h(m.DesktopLibraryNotice, { binding: {} }), 'en');
  assert.doesNotMatch(noticeEn.replace(/<[^>]+>/g, ' '), /[㐀-鿿]/, 'English library notice has zero untranslated Han text');
});

test('DesktopCliCard renders primary ready card when agy is ready and quiet collapsible strip when no ready CLI exists', () => {
  const noopActions = { saveAgy: () => {}, testAgy: () => {}, scan: () => {} };
  const readyHtml = render(h(m.DesktopCliCard, {
    providers: [
      { id: 'agy', name: 'Antigravity CLI (agy)', supported: true, status: 'ready', executablePath: 'C:\\agy.exe', version: '1.5.5', reason: '' },
      { id: 'claude', name: 'Claude Code', supported: false, status: 'coming-soon', executablePath: null, version: null, reason: 'Coming soon' },
    ],
    mode: 'openai',
    agy: { model: '', effort: '' },
    actions: noopActions,
    working: '',
  }));
  assert.match(readyHtml, /data-desktop-cli-card="ready"/);
  assert.match(readyHtml, /一键启用本机 agy/);
  assert.match(readyHtml, /1\.5\.5/);

  const quietHtml = render(h(m.DesktopCliCard, {
    providers: [
      { id: 'agy', name: 'Antigravity CLI (agy)', supported: true, status: 'not-installed', executablePath: null, version: null, reason: 'Not found' },
    ],
    mode: 'openai',
    agy: {},
    actions: noopActions,
    working: '',
  }));
  assert.match(quietHtml, /data-desktop-cli-card="quiet"/);
  assert.match(quietHtml, /<details/);
  assert.match(quietHtml, /重新扫描本机 CLI/);
});

test('DesktopOpenAiForm exposes domestic presets (智谱, 硅基流动, DeepSeek, 自定义) cleanly', () => {
  assert.deepEqual(m.MODEL_PRESETS.map((p) => p.id), ['zhipu', 'siliconflow', 'deepseek']);
  assert.equal(m.presetOf('https://api.deepseek.com/'), 'deepseek');
  assert.equal(m.presetOf('https://custom.example.com/v1'), 'custom');
  const html = render(h(m.DesktopOpenAiForm, {
    openai: { providerId: 'zhipu', baseUrl: '', model: '', hasKey: false, keyLast4: '' },
    active: true,
    actions: { saveOpenAi: () => {}, testOpenAi: () => {} },
    working: '',
  }));
  assert.match(html, /智谱 GLM/);
  assert.match(html, /硅基流动/);
  assert.match(html, /DeepSeek/);
  assert.match(html, /其他（OpenAI 兼容接口）/);
});

test('createDesktopHost enforces 4-field PLUGIN_HOST capabilities, conditional pickDirectory, safeExternalUrl, and concurrency sync', async (t) => {
  t.after(() => {
    delete globalThis.__TAURI_INTERNALS__;
    m.syncDesktopConcurrency(null);
    m.registerHostConcurrencyCap(null);
  });

  // Browser fallback (no Tauri bridge)
  const browserHost = m.createDesktopHost(async () => ({ ok: true }));
  assert.deepEqual(browserHost.capabilities, { edition: 'desktop', chat: false, agentTasks: false, landing: false });
  assert.equal('pickDirectory' in browserHost, false, 'pickDirectory omitted when Tauri invoke is absent');
  const fallbackBoot = await m.loadBootstrapInfo();
  assert.equal(fallbackBoot.baseUrl, '');

  // Tauri bridge present
  globalThis.__TAURI_INTERNALS__ = {
    invoke: async (cmd) => (cmd === 'get_bootstrap_info' ? { baseUrl: 'http://127.0.0.1:4321/', token: 'abc' } : 'D:\\Lib'),
  };
  const tauriBoot = await m.loadBootstrapInfo();
  assert.deepEqual(tauriBoot, { baseUrl: 'http://127.0.0.1:4321', token: 'abc' });
  const tauriHost = m.createDesktopHost(async () => ({ ok: true }));
  assert.equal(typeof tauriHost.pickDirectory, 'function');
  assert.equal(await tauriHost.pickDirectory(), 'D:\\Lib');

  // External URL validation
  assert.equal(m.safeExternalUrl('https://github.com/EricWang1358'), 'https://github.com/EricWang1358');
  assert.equal(m.safeExternalUrl('javascript:alert(1)'), null);
  assert.equal(m.safeExternalUrl('file:///C:/Windows/win.ini'), null);

  // Concurrency sync
  m.syncDesktopConcurrency({ maxConcurrency: 2, defaultConcurrency: 1 });
  assert.deepEqual(m.readDesktopConcurrency(), { maxConcurrency: 2, defaultConcurrency: 1 });
  assert.deepEqual(m.effectiveConcurrencyLimit(), { min: 1, max: 2 });
  m.syncDesktopConcurrency({});
  assert.deepEqual(m.effectiveConcurrencyLimit(), { min: 1, max: 8 });
});

test('chat: false degradation cleanly updates HandOff, GuidancePane, DiagnosticBar, Tour, Finder, and Diagnostics without altering DSH', async () => {
  // HandOffButton relabels to 复制提示词 in Desktop, keeps 发给主会话 in DSH
  const desktopBtn = render(withHost(DESKTOP_HOST, h(m.HandOffButton, { onClick: () => {} })));
  assert.match(desktopBtn, new RegExp(m.COPY_PROMPT_LABEL));
  assert.doesNotMatch(desktopBtn, new RegExp(m.HAND_OFF_LABEL));

  const dshBtn = render(withHost(DSH_HOST, h(m.HandOffButton, { onClick: () => {} })));
  assert.match(dshBtn, new RegExp(m.HAND_OFF_LABEL));

  // deliverToChat receipt in Desktop says COPY_PROMPT_RECEIPT_LINE instead of 没找到主会话
  let received = null;
  await m.deliverToChat({
    host: DESKTOP_HOST,
    prompt: 'Explain Bayes theorem',
    notify: (notice) => { received = notice; },
    clipboard: { writeText: async () => {} },
  });
  assert.equal(received?.receipt, 'copied');
  assert.match(received?.text || '', new RegExp(m.COPY_PROMPT_RECEIPT_LINE));

  // GuidancePane hides AI 带学 when chat: false, keeps it in DSH
  const memory = () => { const map = new Map(); return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, v), removeItem: (k) => map.delete(k) }; };
  const desktopGuidance = render(withHost(DESKTOP_HOST, h(m.GuidancePane, { storages: { local: memory(), session: memory() } })));
  assert.doesNotMatch(desktopGuidance, /data-guidance="guided-study"/);
  const dshGuidance = render(withHost(DSH_HOST, h(m.GuidancePane, { storages: { local: memory(), session: memory() } })));
  assert.match(dshGuidance, /data-guidance="guided-study"/);

  // DiagnosticBar hides DSH permission hint when chat: false
  const desktopDiag = render(withHost(DESKTOP_HOST, h(m.DiagnosticBar, { diagnostic: () => ({ text: 'r', input: { tool: 'mineru', code: 'not-writable' } }), resetKey: 'a' })));
  assert.doesNotMatch(desktopDiag, /完全权限/);
  const dshDiag = render(withHost(DSH_HOST, h(m.DiagnosticBar, { diagnostic: () => ({ text: 'r', input: { tool: 'mineru', code: 'not-writable' } }), resetKey: 'a' })));
  assert.match(dshDiag, /完全权限/);

  // Tour omits guided-study when canChat === false
  const desktopTour = m.availableTourSteps(m.TOUR_STEPS, { full: true, sample: { loaded: true, deckId: 'd1', sourceId: 's1', draftId: 'dr1' }, canChat: false });
  assert.equal(desktopTour.some((step) => step.id === 'guided-study'), false);
  const dshTour = m.availableTourSteps(m.TOUR_STEPS, { full: true, sample: { loaded: true, deckId: 'd1', sourceId: 's1', draftId: 'dr1' }, canChat: true });
  assert.equal(dshTour.some((step) => step.id === 'guided-study'), true);

  // Finder marks guided-study unavailable when canChat === false
  const guidedEntry = m.FINDER_ENTRIES.find((entry) => entry.id === 'guided-study');
  assert.ok(m.finderAvailability(guidedEntry, { contexts: ['study'] }, { canChat: false }));
  assert.equal(m.finderAvailability(guidedEntry, { contexts: ['study'] }, { canChat: true }), '');

  // Diagnostics line identifies Desktop host cleanly
  assert.match(m.diagnosticText({ edition: 'desktop' }), /Host: StudyHub Desktop/);
  assert.match(m.diagnosticText({}), /DSH version: \(fill in by hand\)/);

  // Desktop modelFact hostPart removes DSH wording in both zh and en
  m.registerHostParts({ modelFact: m.DESKTOP_PARTS.modelFact });
  try {
    assert.equal(m.modelFact({ reason: 'no-credential', label: '智谱 GLM · glm-4-flash' }), '已选择「智谱 GLM · glm-4-flash」，但还没有填写 API Key。');
    assert.doesNotMatch(m.modelFact({ reason: 'no-credential', label: 'DeepSeek' }), /DSH/);
  } finally {
    m.registerHostParts({ modelFact: undefined });
  }

  // HandOffSheet uses desktop copy-prompt subtitle when chat: false
  const desktopSheet = render(withHost(DESKTOP_HOST, h(m.HandOffSheet, { sheet: { text: 'hello', mode: 'copied', lead: '' }, onClose: () => {} })));
  assert.match(desktopSheet, new RegExp(m.COPY_PROMPT_RECEIPT_LINE));
  assert.doesNotMatch(desktopSheet, /没找到主会话/);

  // GenerationSettings hides DSH-only count field when chat: false
  const desktopGen = render(withHost(DESKTOP_HOST, h(m.GenerationSettingsForm, { root: '/lib', saved: {} })));
  assert.doesNotMatch(desktopGen, /主会话里出题的默认题数/);
  const dshGen = render(withHost(DSH_HOST, h(m.GenerationSettingsForm, { root: '/lib', saved: {} })));
  assert.match(dshGen, /主会话里出题的默认题数/);

  // WorkspaceBindingPanel uses 环境变量指定 for rootSource='config' on Desktop
  const fakeApp = (host) => ({
    host,
    data: { root: '/lib' },
    core: { call: async () => ({}), busy: false, notify: () => {} },
    connection: { binding: { root: '/lib', rootSource: 'config' }, setBinding: () => {}, updateBinding: async () => true },
  });
  const desktopBinding = render(h(m.AppContext.Provider, { value: fakeApp(DESKTOP_HOST) }, h(m.WorkspaceBindingPanel)));
  assert.match(desktopBinding, /环境变量指定/);
  assert.doesNotMatch(desktopBinding, /插件配置指定/);

  // Finder strips AI 带学 from setting-guidance when chat: false
  const desktopMarked = m.withAvailability(m.FINDER_ENTRIES, { contexts: ['study'] }, { canChat: false });
  const guidanceEntry = desktopMarked.find((entry) => entry.id === 'setting-guidance');
  assert.doesNotMatch(guidanceEntry?.what || '', /AI 带学/);

  // UpdateSettings omits DSH version reminder on Desktop
  const desktopUpdate = render(withHost(DESKTOP_HOST, h(m.UpdateSettings, { update: { current: '4.14.0' }, diagnostic: () => 'diag' })));
  assert.doesNotMatch(desktopUpdate, /DSH 版本请自己补上/);
  const dshUpdate = render(withHost(DSH_HOST, h(m.UpdateSettings, { update: { current: '4.14.0' }, diagnostic: () => 'diag' })));
  assert.match(dshUpdate, /DSH 版本请自己补上/);

  // DesktopCliCard localizes reasonCode cleanly in English mode (zero Han characters, zero dangling colon on empty broken-shim params)
  const enCliHtml = render(h(m.DesktopCliCard, {
    providers: [
      { id: 'agy', name: 'Antigravity CLI (agy)', supported: true, status: 'not-installed', reasonCode: 'not-installed', reason: '未检测到本机安装' },
      { id: 'claude', name: 'Claude Code', supported: false, status: 'coming-soon', version: 'v2.1.327', reasonCode: 'coming-soon-detected', reasonParams: { version: 'v2.1.327' }, reason: '已检测到 v2.1.327，即将支持' },
      { id: 'codex', name: 'Codex CLI', supported: false, status: 'broken-shim', reasonCode: 'broken-shim', reasonParams: {}, reason: 'Broken launch shim or missing target (coming soon)' },
    ],
    mode: 'openai',
    agy: {},
    actions: { saveAgy: () => {}, testAgy: () => {}, scan: () => {} },
    working: '',
  }), 'en');
  assert.doesNotMatch(enCliHtml.replace(/<[^>]+>/g, ' '), /[㐀-鿿]/, 'English CLI strip has zero untranslated Han text');
  assert.match(enCliHtml, /Broken launch shim or missing target \(coming soon\)/);
  assert.doesNotMatch(enCliHtml, /Launcher shim target is missing:\s*</);
});
