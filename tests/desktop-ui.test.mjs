import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';

const h = React.createElement;
const m = await loadUi(`
  export { DESKTOP_PARTS, desktopGuideUrl } from './ui/desktop/parts.jsx';
  export { default as DesktopCliCard } from './ui/desktop/DesktopCliCard.jsx';
  export { createDesktopConfigActions, DesktopSetupBody } from './ui/desktop/DesktopModelSetup.jsx';
  export { recheckSentence } from './ui/first-run/recheck.js';
  export { normalizeAppearance } from './ui/appearance-prefs.js';
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
  export { bindingNotice } from './ui/app/binding-notice.js';
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

const READY_AGY = { id: 'agy', name: 'Antigravity CLI (agy)', supported: true, status: 'ready', executablePath: 'C:\\agy.exe', version: '1.5.12', reason: '' };
const READY_CODEX = { id: 'codex', name: 'Codex CLI', supported: true, status: 'ready', executablePath: 'C:\\codex.cmd', version: '0.170.0', reason: '' };
const setupConfig = (providers) => ({ mode: 'openai', openai: { providerId: 'deepseek', baseUrl: '', model: '', hasKey: false, keyLast4: '' }, agy: {}, codex: {}, providers });
const setupBody = (props) => render(h(m.DesktopSetupBody, { actions: { saveCli: () => {}, testCli: () => {}, scan: () => {} }, working: '', error: '', onDismissError: () => {}, compact: true, ...props }));

test('the first-run step offers the detected local CLI alone: one card with 一键启用, no API Key form, nothing when no CLI is ready', () => {
  assert.equal(typeof m.DESKTOP_PARTS.ModelQuickEnable, 'function');
  const quick = setupBody({ config: setupConfig([READY_AGY, READY_CODEX]), quick: true });
  assert.match(quick, /data-desktop-cli-card="ready"/);
  assert.match(quick, /一键启用本机 agy/);
  assert.match(quick, /data-desktop-cli-switcher/, 'two ready CLIs can be told apart right there');
  assert.doesNotMatch(quick, /data-desktop-openai-card/, 'the API Key form stays in the settings');
  assert.equal(setupBody({ config: setupConfig([{ ...READY_AGY, status: 'not-installed' }]), quick: true }), '', 'no ready CLI: the step keeps its link to the settings and draws nothing more');
  // The gate before a model step keeps both ways, as before.
  assert.match(setupBody({ config: setupConfig([READY_AGY]) }), /data-desktop-openai-card/);
});

test('重新检查 on the desktop says where a model is set up here (the settings), not DSH', () => {
  assert.match(m.recheckSentence('still'), /在 DSH 里配好后/);
  m.registerHostParts({ recheckNote: m.DESKTOP_PARTS.recheckNote });
  try {
    const zh = m.recheckSentence('still');
    assert.match(zh, /^已重新检查，还没有读到可用的模型。/);
    assert.match(zh, /一键启用本机 CLI/);
    assert.doesNotMatch(zh, /DSH/);
    assert.equal(m.recheckSentence('failed'), '没能重新检查。再点一次「重新检查」试试。', 'a failed read says the same everywhere');
    m.setUiLanguage('en');
    try { assert.doesNotMatch(m.recheckSentence('still'), /[㐀-鿿]|DSH/); } finally { m.setUiLanguage('zh'); }
  } finally { m.registerHostParts({ recheckNote: undefined }); }
});

test('the desktop makes 跟随窗口 the default 界面大小; a chosen percent still wins and DSH keeps 100%', () => {
  assert.deepEqual({ ...m.DESKTOP_PARTS.appearanceDefaults }, { scale: 'auto' });
  assert.equal(m.normalizeAppearance(null).scale, 100);
  m.registerHostParts({ appearanceDefaults: m.DESKTOP_PARTS.appearanceDefaults });
  try {
    assert.equal(m.normalizeAppearance(null).scale, 'auto');
    assert.equal(m.normalizeAppearance({ scale: 110 }).scale, 110);
  } finally { m.registerHostParts({ appearanceDefaults: undefined }); }
});

test('DESKTOP_PARTS exposes its host-part slots and renders upgrade & library notices cleanly in zh and en', () => {
  assert.deepEqual(Object.keys(m.DESKTOP_PARTS).sort(), [
    'LibraryNotice', 'ModelGateForm', 'ModelQuickEnable', 'ModelSetup', 'UpgradeGuide', 'appearanceDefaults', 'modelFact', 'modelSetupSteps', 'recheckNote', 'runningNote',
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

test('DesktopCliCard renders primary ready card when agy or codex is ready, dual switcher when both are ready, and quiet strip otherwise', () => {
  const noopActions = { saveCli: () => {}, testCli: () => {}, scan: () => {} };
  const readyHtml = render(h(m.DesktopCliCard, {
    providers: [
      { id: 'agy', name: 'Antigravity CLI (agy)', supported: true, status: 'ready', executablePath: 'C:\\agy.exe', version: '1.5.5', reason: '' },
      { id: 'claude', name: 'Claude Code', supported: false, status: 'coming-soon', executablePath: null, version: null, reason: 'Coming soon' },
    ],
    mode: 'openai',
    agy: { model: '', effort: '' },
    codex: { model: '', effort: '' },
    actions: noopActions,
    working: '',
  }));
  assert.match(readyHtml, /data-desktop-cli-card="ready"/);
  assert.match(readyHtml, /data-desktop-cli-selected="agy"/);
  assert.doesNotMatch(readyHtml, /data-desktop-cli-switcher/);
  assert.match(readyHtml, /一键启用本机 agy/);
  assert.match(readyHtml, /1\.5\.5/);

  const codexOnlyHtml = render(h(m.DesktopCliCard, {
    providers: [
      { id: 'agy', name: 'Antigravity CLI (agy)', supported: true, status: 'not-installed', executablePath: null, version: null, reasonCode: 'not-installed' },
      { id: 'codex', name: 'Codex CLI (codex)', supported: true, status: 'ready', executablePath: 'C:\\codex.exe', version: '0.170.0', reason: '' },
      { id: 'claude', name: 'Claude Code', supported: false, status: 'coming-soon', executablePath: null, version: null, reasonCode: 'coming-soon' },
    ],
    mode: 'openai',
    agy: {},
    codex: { model: 'gpt-5', effort: 'high' },
    actions: noopActions,
    working: '',
  }));
  assert.match(codexOnlyHtml, /data-desktop-cli-card="ready"/);
  assert.match(codexOnlyHtml, /data-desktop-cli-selected="codex"/);
  assert.match(codexOnlyHtml, /一键启用本机 codex/);
  assert.match(codexOnlyHtml, /0\.170\.0/);
  assert.match(codexOnlyHtml, /value="gpt-5"/);
  assert.match(codexOnlyHtml, /data-desktop-provider="agy"/);

  const dualReadyHtml = render(h(m.DesktopCliCard, {
    providers: [
      {
        id: 'agy',
        name: 'Antigravity CLI (agy)',
        supported: true,
        status: 'ready',
        executablePath: 'C:\\agy.exe',
        version: '1.5.11',
        models: [{ id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' }],
        reason: '',
      },
      { id: 'codex', name: 'Codex CLI (codex)', supported: true, status: 'ready', executablePath: 'C:\\codex.exe', version: '0.170.0', reason: '' },
      { id: 'claude', name: 'Claude Code', supported: false, status: 'coming-soon', executablePath: null, version: '2.1.327', reasonCode: 'coming-soon-detected', reasonParams: { version: '2.1.327' } },
    ],
    mode: 'codex',
    agy: { model: 'gemini-2.5-pro', effort: 'medium' },
    codex: { model: 'o3', effort: 'low' },
    actions: noopActions,
    working: '',
  }));
  assert.match(dualReadyHtml, /data-desktop-cli-card="ready"/);
  assert.match(dualReadyHtml, /data-desktop-cli-selected="codex"/);
  assert.match(dualReadyHtml, /data-desktop-cli-switcher/);
  assert.match(dualReadyHtml, /本机 CLI 引擎/);
  assert.match(dualReadyHtml, /Antigravity CLI \(agy\)/);
  assert.match(dualReadyHtml, /Codex CLI \(codex\)（当前）/);
  assert.match(dualReadyHtml, /已启用本机 codex/);
  assert.match(dualReadyHtml, /当前通过本机 codex 执行 AI 任务/);
  assert.match(dualReadyHtml, /data-desktop-provider="claude"/);
  assert.doesNotMatch(dualReadyHtml, /data-desktop-provider="agy"/);

  const dualReadyEn = render(h(m.DesktopCliCard, {
    providers: [
      { id: 'agy', name: 'Antigravity CLI (agy)', supported: true, status: 'ready', executablePath: 'C:\\agy.exe', version: '1.5.11', reason: '' },
      { id: 'codex', name: 'Codex CLI (codex)', supported: true, status: 'ready', executablePath: 'C:\\codex.exe', version: '0.170.0', reason: '' },
      { id: 'claude', name: 'Claude Code', supported: false, status: 'coming-soon', executablePath: null, version: '2.1.327', reasonCode: 'coming-soon-detected', reasonParams: { version: '2.1.327' } },
    ],
    mode: 'codex',
    agy: {},
    codex: { model: '', effort: 'high' },
    actions: noopActions,
    working: '',
  }), 'en');
  assert.doesNotMatch(dualReadyEn.replace(/<[^>]+>/g, ' '), /[㐀-鿿]/, 'English dual CLI card has zero untranslated Han text');
  assert.match(dualReadyEn, /Local CLI engine/);
  assert.match(dualReadyEn, /Local codex enabled/);

  const quietHtml = render(h(m.DesktopCliCard, {
    providers: [
      { id: 'agy', name: 'Antigravity CLI (agy)', supported: true, status: 'not-installed', executablePath: null, version: null, reason: 'Not found' },
      { id: 'codex', name: 'Codex CLI (codex)', supported: true, status: 'unauthenticated', executablePath: 'C:\\codex.exe', version: '0.170.0', reasonCode: 'unauthenticated' },
    ],
    mode: 'openai',
    agy: {},
    codex: {},
    actions: noopActions,
    working: '',
  }));
  assert.match(quietHtml, /data-desktop-cli-card="quiet"/);
  assert.match(quietHtml, /<details/);
  assert.match(quietHtml, /重新扫描本机 CLI/);
  assert.match(quietHtml, /agy \/ codex/);
});

test('Settings offers 「在学习库里打开 CLI」 for the ready local CLI; the short first-run and gate cards do not, and the page sends only the CLI name', async () => {
  const noopActions = { saveCli: () => {}, testCli: () => {}, scan: () => {}, openCli: () => {} };
  const providers = [
    { id: 'agy', name: 'Antigravity CLI (agy)', supported: true, status: 'ready', executablePath: 'C:\\agy.exe', version: '1.5.12', reason: '' },
  ];
  const card = (props, language) => render(h(m.DesktopCliCard, { providers, mode: 'openai', agy: {}, codex: {}, actions: noopActions, working: '', ...props }), language);

  const settings = card({});
  assert.match(settings, /data-desktop-cli-open="agy"/);
  assert.match(settings, /在学习库里打开 agy/);
  assert.match(settings, /不经过 StudyHub 的检查/, 'says plainly that the CLI can change library files directly');
  assert.doesNotMatch(card({ compact: true }), /data-desktop-cli-open/, 'the compact card (first run, model gate) stays short');
  const english = card({}, 'en');
  assert.match(english, /Open agy in the library/);
  assert.doesNotMatch(english.replace(/Antigravity CLI \(agy\)/g, ''), /[㐀-鿿]/, 'the English card has no untranslated text');

  const calls = [];
  const errors = [];
  const actions = m.createDesktopConfigActions({
    call: async (action, args) => { calls.push({ action, args }); return { ok: true, provider: args.provider, cwd: 'D:\\Study' }; },
    refresh: async () => {}, setConfig: () => {}, setError: (text) => errors.push(text), setWorking: () => {},
  });
  assert.deepEqual(await actions.openCli('codex'), { ok: true, provider: 'codex', cwd: 'D:\\Study' });
  assert.deepEqual(calls, [{ action: 'desktop.cli.open', args: { provider: 'codex' } }]);

  const failing = m.createDesktopConfigActions({
    call: async () => { throw new Error('路径里有特殊字符'); },
    refresh: async () => {}, setConfig: () => {}, setError: (text) => errors.push(text), setWorking: () => {},
  });
  assert.equal(await failing.openCli('agy'), null);
  assert.equal(errors.at(-1), '路径里有特殊字符', 'a refusal is shown where the other setup errors are');
});

test('createDesktopConfigActions saves & tests codex mode and syncs effective concurrency cap cleanly', async (t) => {
  t.after(() => {
    m.syncDesktopConcurrency(null);
    m.registerHostConcurrencyCap(null);
  });
  const calls = [];
  let savedConfig = null;
  let lastError = '';
  const workingLog = [];
  const actions = m.createDesktopConfigActions({
    call: async (action, args) => {
      calls.push({ action, args });
      if (action === 'desktop.config.save' && args.mode === 'codex') {
        return {
          mode: 'codex',
          codex: args.codex,
          effective: { ready: true, maxConcurrency: 2, defaultConcurrency: 1 },
        };
      }
      if (action === 'desktop.config.test' && args.mode === 'codex') {
        return { ok: true, latencyMs: 420, message: 'PONG' };
      }
      if (action === 'desktop.config.save' && args.mode === 'openai') {
        return { mode: 'openai', openai: args.openai, effective: { ready: true } };
      }
      return {};
    },
    refresh: async () => {},
    setConfig: (next) => { savedConfig = next; },
    setError: (msg) => { lastError = msg; },
    setWorking: (tag) => { workingLog.push(tag); },
  });

  const payload = { executablePath: 'C:\\codex.exe', model: 'o3', effort: 'high' };
  const result = await actions.saveCli('codex', payload);
  assert.equal(lastError, '');
  assert.equal(savedConfig?.mode, 'codex');
  assert.deepEqual(result?.codex, payload);
  assert.deepEqual(calls[0], { action: 'desktop.config.save', args: { mode: 'codex', codex: payload } });
  assert.deepEqual(m.readDesktopConcurrency(), { maxConcurrency: 2, defaultConcurrency: 1 });
  assert.deepEqual(m.effectiveConcurrencyLimit(), { min: 1, max: 2 });

  const testResult = await actions.testCli('codex', payload);
  assert.deepEqual(calls[1], { action: 'desktop.config.test', args: { mode: 'codex', codex: payload } });
  assert.equal(testResult?.ok, true);

  await actions.saveOpenAi({ providerId: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', apiKey: 'sk-test' });
  assert.deepEqual(m.readDesktopConcurrency(), { maxConcurrency: undefined, defaultConcurrency: undefined });
  assert.deepEqual(m.effectiveConcurrencyLimit(), { min: 1, max: 8 });
  assert.ok(workingLog.includes('save-codex'));
  assert.ok(workingLog.includes('test-codex'));

  m.setUiLanguage('en');
  try {
    const stepsEn = m.DESKTOP_PARTS.modelSetupSteps();
    const stepText = stepsEn.map((step) => step.text).join(' ');
    assert.match(stepText, /agy/);
    assert.match(stepText, /codex/);
    assert.doesNotMatch(stepText, /[㐀-鿿]/, 'English modelSetupSteps has zero untranslated Han text');
  } finally {
    m.setUiLanguage('zh');
  }
});

test('the desktop guide link follows the UI language and lands on a heading the guide really has', async () => {
  const { readFile } = await import('node:fs/promises');
  const githubAnchor = (heading) => heading.trim().toLowerCase().replace(/[^\p{L}\p{N} -]/gu, '').replace(/ /g, '-');
  for (const [language, file] of [['zh', 'desktop.zh-CN.md'], ['en', 'desktop.md']]) {
    m.setUiLanguage(language);
    try {
      const url = new URL(m.desktopGuideUrl());
      assert.equal(url.pathname, `/EricWang1358/dsh-web-studyhub/blob/main/docs/${file}`, `${language} opens its own guide`);
      const guide = await readFile(new URL(`../docs/${file}`, import.meta.url), 'utf8');
      const anchors = guide.split(/\r?\n/).filter((line) => /^#{1,6} /.test(line)).map((line) => githubAnchor(line.replace(/^#+ /, '')));
      assert.ok(url.hash.length > 1, `${language} lands on the model section, not the top of the guide`);
      assert.ok(anchors.includes(decodeURIComponent(url.hash.slice(1))), `${file} has the heading ${decodeURIComponent(url.hash)}`);
      const hint = renderToStaticMarkup(m.DESKTOP_PARTS.modelSetupSteps()[0].hint);
      assert.ok(hint.includes(`href="${m.desktopGuideUrl()}"`), 'step 1 links to that address');
    } finally { m.setUiLanguage('zh'); }
  }
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
  // While STUDYHUB_LIBRARY decides the folder, a pick here cannot apply: the button is off and the row says what to do.
  const changeButton = (markup) => markup.match(/<button[^>]*>(?:(?!<\/button>).)*更换目录…/s)?.[0] || '';
  assert.match(changeButton(desktopBinding), /disabled/);
  assert.match(desktopBinding, /STUDYHUB_LIBRARY/);
  const custom = fakeApp(DESKTOP_HOST);
  custom.connection.binding.rootSource = 'custom';
  const customBinding = render(h(m.AppContext.Provider, { value: custom }, h(m.WorkspaceBindingPanel)));
  assert.doesNotMatch(changeButton(customBinding), /disabled/);
  assert.doesNotMatch(customBinding, /STUDYHUB_LIBRARY/);
  assert.doesNotMatch(changeButton(render(h(m.AppContext.Provider, { value: fakeApp(DSH_HOST) }, h(m.WorkspaceBindingPanel)))), /disabled/, 'DSH keeps its own rule');

  // What a saved binding change says: a folder that was asked for and did not move never reads 已更新生成模型.
  assert.equal(m.bindingNotice({ patch: { root: 'D:\\lib' }, moved: true, value: { rootSource: 'custom' }, host: DESKTOP_HOST }), '已切换学习库');
  assert.match(m.bindingNotice({ patch: { root: 'D:\\lib' }, moved: false, value: { rootSource: 'config' }, host: DESKTOP_HOST }), /STUDYHUB_LIBRARY.*没有生效/);
  assert.equal(m.bindingNotice({ patch: { root: 'D:\\lib' }, moved: false, value: { rootSource: 'custom' }, host: DESKTOP_HOST }), '学习库目录没有变化。');
  assert.equal(m.bindingNotice({ patch: { root: '/lib' }, moved: false, value: { rootSource: 'config' }, host: DSH_HOST }), '学习库目录没有变化。');
  assert.equal(m.bindingNotice({ patch: { reasoningEffort: 'high' }, moved: false, value: {}, host: DSH_HOST }), '已更新推理程度');
  assert.equal(m.bindingNotice({ patch: { provider: 'p', model: 'm' }, moved: false, value: {}, host: DSH_HOST }), '已更新生成模型');

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
    codex: {},
    actions: { saveCli: () => {}, testCli: () => {}, scan: () => {} },
    working: '',
  }), 'en');
  assert.doesNotMatch(enCliHtml.replace(/<[^>]+>/g, ' '), /[㐀-鿿]/, 'English CLI strip has zero untranslated Han text');
  assert.match(enCliHtml, /Broken launch shim or missing target \(coming soon\)/);
  assert.doesNotMatch(enCliHtml, /Launcher shim target is missing:\s*</);
});
