import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { inApp } from './helpers/fake-app.mjs';

const h = React.createElement;
const m = await loadUi(`
  export { DESKTOP_PARTS, desktopGuideUrl } from './ui/desktop/parts.jsx';
  export { default as DesktopCliCard } from './ui/desktop/DesktopCliCard.jsx';
  export { createDesktopConfigActions, DesktopSetupBody } from './ui/desktop/DesktopModelSetup.jsx';
  export { recheckSentence } from './ui/first-run/recheck.js';
  export { normalizeAppearance } from './ui/appearance-prefs.js';
  export { default as DesktopOpenAiForm } from './ui/desktop/DesktopOpenAiForm.jsx';
  export { default as DesktopLibraryNotice } from './ui/desktop/DesktopLibraryNotice.jsx';
  export { default as DesktopLibraryPlace, confirmLibraryPlace } from './ui/desktop/DesktopLibraryPlace.jsx';
  export { chooseLibraryFolder } from './ui/app/ChangeFolderButton.jsx';
  export { default as DesktopUpgradeGuide } from './ui/desktop/DesktopUpgradeGuide.jsx';
  export { MODEL_PRESETS, presetOf } from './ui/desktop/presets.js';
  export { createDesktopHost, createDesktopCall, createDesktopEventSubscription, createSidecarConnection, installExternalLinkHandler, loadBootstrapInfo, safeExternalUrl, syncDesktopConcurrency, readDesktopConcurrency, checkDesktopUpdate, installDesktopUpdate } from './ui/desktop/ipc.js';
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
    'HomeLead', 'LibraryNotice', 'ModelGateForm', 'ModelQuickEnable', 'ModelSetup', 'UpgradeGuide', 'appearanceDefaults', 'modelCostNote', 'modelFact', 'modelSetupSteps', 'recheckNote', 'runningNote',
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

  // A DSH workspace was picked: the page says the library in use is the plugin's, inside it. A plain folder says nothing extra.
  const inWorkspace = { root: 'D:\\notes\\.dsh-study', pickedRoot: 'D:\\notes' };
  const workspaceZh = render(h(m.DesktopLibraryNotice, { binding: inWorkspace }), 'zh');
  assert.match(workspaceZh, /data-desktop-library-in-workspace/);
  assert.match(workspaceZh, /你选的「D:\\notes」里已有 DSH 插件的学习库/);
  const workspaceEn = render(h(m.DesktopLibraryNotice, { binding: inWorkspace }), 'en');
  assert.match(workspaceEn, /already holds a library from the DSH plugin/);
  assert.doesNotMatch(workspaceEn.replace(/<[^>]+>/g, ' '), /[㐀-鿿]/, 'the workspace note has zero untranslated Han text in English');
  assert.doesNotMatch(render(h(m.DesktopLibraryNotice, { binding: { root: 'D:\\lib', pickedRoot: 'D:\\lib' } }), 'zh'), /data-desktop-library-in-workspace/);
});

test('DesktopCliCard offers the models a ready codex lists as a dropdown, and takes free text when it lists none', () => {
  const card = (codexProvider, model) => render(h(m.DesktopCliCard, {
    providers: [{ id: 'codex', name: 'Codex CLI', supported: true, status: 'ready', executablePath: 'C:\\codex.exe', version: '0.170.0', reason: '', ...codexProvider }],
    mode: 'codex',
    agy: {},
    codex: { model, effort: '' },
    actions: { saveCli: () => {}, testCli: () => {}, scan: () => {} },
    working: '',
  }));
  const listed = card({ models: [{ id: 'gpt-6-luna', name: 'GPT-6-Luna' }, { id: 'gpt-5.6-terra', name: 'GPT-5.6-Terra' }] }, 'gpt-6-luna');
  assert.match(listed, /GPT-6-Luna/, 'the chosen model shows by the name codex gives it');
  assert.doesNotMatch(listed, /留空使用默认模型/, 'no free-text field when codex lists its models');
  assert.match(card({ models: [] }, ''), /留空使用默认模型/, 'a codex that lists nothing keeps the free-text field');
  assert.match(card({}, ''), /留空使用默认模型/);
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

/* The first-use card (HomeLead): where the library lives. Drawn by the home through ui/host-parts.js, only on the desktop, until the learner has settled it. */
const PLACE_ROOT = 'C:\\Users\\me\\Documents\\StudyHub';
const placeCard = ({ binding = {}, data = { decks: [], sources: [] }, language = 'zh' } = {}) => render(inApp(m, h(m.DesktopLibraryPlace, { data }), {
  data, host: DESKTOP_HOST,
  app: { connection: { binding: { root: PLACE_ROOT, pickedRoot: PLACE_ROOT, rootSource: 'default', ...binding }, setBinding: () => {}, updateBinding: async () => true } },
}), language);
const primaryLabels = (html) => [...html.matchAll(/<button[^>]*sh-btn--primary[^>]*>([\s\S]*?)<\/button>/g)].map((hit) => hit[1].replace(/<[^>]+>/g, ''));
const buttonLabels = (html) => [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((hit) => hit[1].replace(/<[^>]+>/g, ''));

test('the library-place card shows until the learner settles it: hidden when confirmed or when the host says nothing', () => {
  assert.equal(typeof m.DESKTOP_PARTS.HomeLead, 'function');
  assert.equal(placeCard({ binding: { libraryPlace: { confirmed: true, onSystemDrive: true } } }), '', 'confirmed: nothing');
  assert.equal(placeCard(), '', 'a host with no libraryPlace (an older sidecar) draws nothing');
  const html = placeCard({ binding: { libraryPlace: { confirmed: false, onSystemDrive: false } } });
  assert.match(html, /data-desktop-library-place/);
  assert.match(html, /先确认学习库放在哪/);
  assert.match(html, /资料、题组和复习记录都存在这个文件夹：/);
  assert.doesNotMatch(html, /练习记录/, 'Settings and the finder say 复习记录: one name');
  assert.ok(html.includes(PLACE_ROOT), 'the folder in use is named');
  assert.match(html, /在 DSH 里用过 StudyHub？选那个工作区文件夹，原来的题组和记录都会出现。/);
  assert.doesNotMatch(html, /它在系统盘/, 'no warning off the system drive');
  assert.doesNotMatch(html, /换文件夹不会搬动已有内容/, 'nothing to move in an empty library');
});

test('the library-place card warns about the system drive and says what a move needs only when the library has content', () => {
  const onSystem = placeCard({ binding: { libraryPlace: { confirmed: false, onSystemDrive: true } } });
  assert.match(onSystem, /它在系统盘（C:）。学习库会越用越大，建议放到其他盘。/);
  const withDecks = placeCard({ binding: { libraryPlace: { confirmed: false, onSystemDrive: false } }, data: { decks: [{ id: 'd' }], sources: [] } });
  assert.match(withDecks, /换文件夹不会搬动已有内容；要搬，先退出 StudyHub，把整个文件夹移到新位置，再回来选它。/);
  assert.match(placeCard({ binding: { libraryPlace: { confirmed: false, onSystemDrive: false } }, data: { decks: [], sources: [{ id: 's' }] } }), /换文件夹不会搬动已有内容/);
  // The DSH workspace note is the one wording of that fact (DesktopLibraryNotice's), not a second sentence.
  const picked = placeCard({ binding: { libraryPlace: { confirmed: false, onSystemDrive: false }, root: 'D:\\notes\\.dsh-study', pickedRoot: 'D:\\notes' } });
  assert.match(picked, /你选的「D:\\notes」里已有 DSH 插件的学习库/);
  assert.doesNotMatch(picked, /在 DSH 里用过 StudyHub/, 'a learner already on the DSH workspace is not told to go and pick it');
  assert.doesNotMatch(placeCard({ binding: { libraryPlace: { confirmed: false, onSystemDrive: false } } }), /你选的/);
});

test('an existing install (a saved folder, no confirmation yet) gets the card, and a library problem keeps it away until the problem is gone', () => {
  const unconfirmed = { libraryPlace: { confirmed: false, onSystemDrive: false } };
  const existing = placeCard({ binding: { ...unconfirmed, root: 'D:\\Study', pickedRoot: 'D:\\Study', rootSource: 'custom' }, data: { decks: [{ id: 'd' }], sources: [] } });
  assert.match(existing, /data-desktop-library-place/);
  assert.match(existing, /换文件夹不会搬动已有内容/);
  // The saved folder cannot be opened and a fallback is in use: 「就用这里」 would confirm the fallback, so the card waits (the library notice reports the problem).
  const problem = { root: 'E:\\Study', source: 'custom', reason: 'gone', message: '无法打开学习库目录「E:\\Study」（gone），已暂时改用「D:\\Fallback」' };
  assert.equal(placeCard({ binding: { ...unconfirmed, libraryProblem: problem } }), '');
  assert.match(placeCard({ binding: { ...unconfirmed, libraryProblem: null } }), /data-desktop-library-place/, 'back once the problem is gone');
});

test('the library-place card has two buttons and at most one primary: choosing a folder on the system drive, using this place elsewhere', () => {
  const place = (onSystemDrive) => placeCard({ binding: { libraryPlace: { confirmed: false, onSystemDrive } } });
  assert.deepEqual(buttonLabels(place(true)), ['更换目录…', '就用这里'], 'the same action is named the same as in Settings');
  assert.deepEqual(primaryLabels(place(true)), ['更换目录…']);
  assert.deepEqual(buttonLabels(place(false)), ['更换目录…', '就用这里']);
  assert.deepEqual(primaryLabels(place(false)), ['就用这里']);
});

test('in English the library-place card has no Chinese and keeps its sentences', () => {
  const html = placeCard({ binding: { libraryPlace: { confirmed: false, onSystemDrive: true } }, data: { decks: [{ id: 'd' }], sources: [] }, language: 'en' });
  assert.doesNotMatch(html.replace(/<[^>]+>/g, ' '), /[㐀-鿿]/);
  assert.match(html, /Confirm where your library lives/);
  assert.match(html, /It is on the system drive \(C:\)/);
  assert.deepEqual(buttonLabels(html), ['Change folder…', 'Use this folder']);
});

test('「就用这里」 confirms through the host and takes the binding that comes back; a failure keeps the card and says why', async () => {
  const seen = [], bindings = [], errors = [], busy = [];
  const base = { setBinding: (value) => bindings.push(value), setError: (text) => errors.push(text), setBusy: (flag) => busy.push(flag) };
  await m.confirmLibraryPlace({ ...base, call: async (action, args) => { seen.push([action, args]); return { root: PLACE_ROOT, libraryPlace: { confirmed: true, onSystemDrive: true } }; } });
  assert.deepEqual(seen, [['desktop.library.confirm', {}]]);
  assert.deepEqual(bindings.map((value) => value.libraryPlace.confirmed), [true]);
  assert.deepEqual(busy, [true, false]);
  await m.confirmLibraryPlace({ ...base, call: async () => { throw new Error('写不进配置文件'); } });
  assert.equal(bindings.length, 1, 'a failure changes no binding: the card stays');
  assert.equal(errors.at(-1), '写不进配置文件');
  assert.deepEqual(busy.slice(-2), [true, false]);
});

test('「选择文件夹…」 is the Settings picker: a picked folder goes to updateBinding, a cancel does nothing, no picker or a broken one falls back', async () => {
  const log = [];
  const run = (host) => m.chooseLibraryFolder({ host, updateBinding: async (patch) => { log.push(['update', patch]); return true; }, notify: (text) => log.push(['notify', text]), onUnavailable: () => log.push(['fallback']) });
  await run({ pickDirectory: async () => 'D:\\Study' });
  await run({ pickDirectory: async () => null });
  await run({});
  await run({ pickDirectory: async () => { throw new Error('no dialog'); } });
  assert.deepEqual(log, [['update', { root: 'D:\\Study' }], ['fallback'], ['fallback'], ['notify', '无法打开目录选择器，请直接输入路径。']]);
});

test('the desktop says how the model is paid for: its own key, the account of the CLI, a CLI signed in with a key, or that it cannot tell', () => {
  const note = (modelVia) => m.DESKTOP_PARTS.modelCostNote({ modelVia });
  const cli = (billing) => ({ kind: 'cli', name: 'Codex CLI', billing });
  assert.equal(note({ kind: 'api', name: 'DeepSeek', billing: 'per-use' }), '通过你填的 API Key 调用，按用量计费。');
  assert.equal(note(cli('account')), '通过本机 Codex CLI 调用，用的是它登录账号的额度。');
  assert.equal(note(cli('per-use')), '通过本机 Codex CLI 调用，它登录用的是 API Key，按用量计费。');
  const unknown = note(cli('unknown'));
  assert.equal(unknown, '通过本机 Codex CLI 调用；用的是它登录账号的额度，还是它登录时用的 API Key（按用量计费），要看它的登录方式。');
  assert.equal(note({ kind: 'cli', name: 'Codex CLI' }), unknown, 'a host that sends no billing promises neither');
  assert.equal(note(undefined), '', 'a host that says nothing is not guessed at');
  assert.equal(m.DESKTOP_PARTS.modelCostNote({}), '');
  m.setUiLanguage('en');
  try {
    assert.equal(note({ kind: 'api', name: 'DeepSeek', billing: 'per-use' }), 'Called through the API key you entered and billed by usage.');
    assert.equal(note(cli('account')), 'Called through Codex CLI on this computer, using the quota of the account it is signed in to.');
    assert.equal(note(cli('per-use')), 'Called through Codex CLI on this computer, which is signed in with an API key and billed by usage.');
    assert.equal(note(cli('unknown')), 'Called through Codex CLI on this computer; whether that uses its account quota or the API key it signed in with depends on how it is logged in.');
    for (const billing of ['account', 'per-use', 'unknown']) assert.doesNotMatch(note(cli(billing)), /[㐀-鿿]/);
  } finally { m.setUiLanguage('zh'); }
});

test('DesktopUpgradeGuide shows one-click signed auto-update when host.updater is present, and IPC wires updater events cleanly', async (t) => {
  t.after(() => { delete globalThis.__TAURI_INTERNALS__; });

  const update = {
    latest: '5.2.0',
    setupName: 'StudyHub-Desktop-5.2.0-win-x64-setup.exe',
    setupUrl: 'https://example.com/StudyHub-Desktop-5.2.0-win-x64-setup.exe',
    installerUrl: 'https://example.com/StudyHub-Desktop-5.2.0-win-x64.msi',
    zipUrl: 'https://example.com/StudyHub-Desktop-5.2.0-win-x64.zip',
  };
  const autoHost = { ...DESKTOP_HOST, updater: { check: async () => ({ available: true }), install: async () => ({ status: 'up-to-date' }) } };

  const autoZh = render(h(m.DesktopUpgradeGuide, { update, host: autoHost }), 'zh');
  assert.match(autoZh, /data-desktop-auto-update="idle"/);
  assert.match(autoZh, /立即下载并更新到 5\.2\.0/);
  assert.match(autoZh, /Ed25519/);
  assert.match(autoZh, /改用手动下载/);
  assert.match(autoZh, /以管理员身份运行/);
  assert.match(autoZh, /StudyHub-Desktop-5\.2\.0-win-x64-setup\.exe/);

  const autoEn = render(h(m.DesktopUpgradeGuide, { update, host: autoHost }), 'en');
  assert.match(autoEn, /Download and update to 5\.2\.0/);
  assert.match(autoEn, /Run as administrator/);
  assert.doesNotMatch(autoEn.replace(/<[^>]+>/g, ' '), /[㐀-鿿]/, 'English auto-update guide has zero untranslated Han text');

  // IPC bridge: exposes updater only when Tauri bridge is present, listens & cleans up progress events
  assert.equal('updater' in m.createDesktopHost(async () => ({})), false);

  const listeners = new Map();
  let nextCbId = 1;
  const invokeCalls = [];
  const unregistered = [];
  globalThis.__TAURI_INTERNALS__ = {
    transformCallback: (fn) => {
      const id = nextCbId++;
      listeners.set(id, fn);
      return id;
    },
    unregisterCallback: (id) => {
      unregistered.push(id);
      listeners.delete(id);
    },
    invoke: async (cmd, args) => {
      invokeCalls.push({ cmd, args });
      if (cmd === 'plugin:event|listen') return 42;
      if (cmd === 'desktop_check_update') return { available: true, currentVersion: '5.1.0', version: '5.2.0' };
      if (cmd === 'desktop_install_update') {
        for (const fn of listeners.values()) fn({ payload: { phase: 'downloading', downloaded: 50, total: 100, percent: 50 } });
        return { status: 'up-to-date', version: '5.2.0' };
      }
      return null;
    },
  };

  const tauriHost = m.createDesktopHost(async () => ({}));
  assert.equal(typeof tauriHost.updater?.check, 'function');
  assert.equal(typeof tauriHost.updater?.install, 'function');
  const checked = await tauriHost.updater.check();
  assert.equal(checked.available, true);

  const progressEvents = [];
  const receipt = await tauriHost.updater.install((evt) => progressEvents.push(evt));
  assert.equal(receipt.status, 'up-to-date');
  assert.deepEqual(progressEvents, [{ phase: 'downloading', downloaded: 50, total: 100, percent: 50 }]);
  assert.ok(invokeCalls.some((c) => c.cmd === 'plugin:event|listen' && c.args.event === 'desktop-update-progress'));
  assert.ok(invokeCalls.some((c) => c.cmd === 'plugin:event|unlisten' && c.args.eventId === 42));
  assert.deepEqual(unregistered, [1]);
});

test('DesktopUpgradeGuide disables NSIS auto-update for MSI/portable flavors and IPC handles sidecar restart, details, pickFile, warmKey, and window.open cleanup', async (t) => {
  const origFetch = globalThis.fetch;
  const origWindow = globalThis.window;
  const origDocument = globalThis.document;
  t.after(() => {
    delete globalThis.__TAURI_INTERNALS__;
    globalThis.fetch = origFetch;
    if (origWindow === undefined) delete globalThis.window; else globalThis.window = origWindow;
    if (origDocument === undefined) delete globalThis.document; else globalThis.document = origDocument;
  });

  // 1. MSI & portable flavors hide one-click NSIS auto-update in both zh and en
  const update = { latest: '5.3.0', setupName: 'StudyHub-setup.exe', setupUrl: 'https://example.com/setup.exe' };
  for (const flavor of ['msi', 'portable']) {
    const host = { ...DESKTOP_HOST, updater: { check: async () => ({}), install: async () => ({}), installFlavor: flavor } };
    const zh = render(h(m.DesktopUpgradeGuide, { update, host }), 'zh');
    assert.doesNotMatch(zh, /data-desktop-auto-update/);
    assert.match(zh, /MSI 或便携版/);
    const en = render(h(m.DesktopUpgradeGuide, { update, host }), 'en');
    assert.doesNotMatch(en, /data-desktop-auto-update/);
    assert.doesNotMatch(en.replace(/<[^>]+>/g, ' '), /[㐀-鿿]/, `${flavor} English guide has zero Han characters`);
  }

  // 2. Reactive sidecar connection updates RPC endpoint/token & preserves error.details
  const seenFetch = [];
  globalThis.fetch = async (url, init) => {
    seenFetch.push({ url, token: init.headers['X-Study-Token'] });
    if (seenFetch.length === 1) {
      return {
        status: 200,
        async json() { return { ok: false, error: 'conflict', code: 'CONFLICT', details: { id: 'x1' } }; },
      };
    }
    return { status: 200, async json() { return { ok: true, value: { ok: 1 } }; } };
  };
  const conn = m.createSidecarConnection({ baseUrl: 'http://127.0.0.1:4100', token: 'tok-1' });
  const rpc = m.createDesktopCall(conn, { timeoutMs: 5000 });
  await assert.rejects(() => rpc('state.get', {}), (err) => {
    assert.equal(err.code, 'CONFLICT');
    assert.deepEqual(err.details, { id: 'x1' });
    return true;
  });
  conn.update({ baseUrl: 'http://127.0.0.1:4200/', token: 'tok-2' });
  assert.deepEqual(await rpc('state.get', {}), { ok: 1 });
  assert.deepEqual(seenFetch, [
    { url: 'http://127.0.0.1:4100/api/call', token: 'tok-1' },
    { url: 'http://127.0.0.1:4200/api/call', token: 'tok-2' },
  ]);

  // 3. SSE subscription follows connection.update immediately to the new port/token
  const sseUrls = [];
  let firstAbortResolve;
  const sub = m.createDesktopEventSubscription({
    connection: conn,
    reconnectBaseMs: 5000,
    fetchImpl: async (url, init) => {
      sseUrls.push({ url, token: init.headers['X-Study-Token'] });
      if (sseUrls.length === 1) {
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            firstAbortResolve?.();
            reject(new Error('aborted'));
          }, { once: true });
        });
      }
      const frame = Buffer.from('event: study:library-changed\ndata: {"root":"D:/Lib","revision":2}\n\n', 'utf8');
      let sent = false;
      return {
        ok: true,
        status: 200,
        body: {
          getReader: () => ({
            read: async () => (sent ? new Promise(() => {}) : ((sent = true), { value: frame, done: false })),
          }),
        },
      };
    },
  });
  const gotEvents = [];
  const aborted = new Promise((resolve) => { firstAbortResolve = resolve; });
  const unsub = sub((evt) => gotEvents.push(evt));
  await new Promise((r) => setTimeout(r, 10));
  conn.update({ baseUrl: 'http://127.0.0.1:4300', token: 'tok-3' });
  await aborted;
  await new Promise((r) => setTimeout(r, 20));
  unsub();
  assert.deepEqual(sseUrls, [
    { url: 'http://127.0.0.1:4200/api/events', token: 'tok-2' },
    { url: 'http://127.0.0.1:4300/api/events', token: 'tok-3' },
  ]);
  assert.deepEqual(gotEvents, [{ root: 'D:/Lib', revision: 2 }]);

  // 4. installExternalLinkHandler restores window.open & passes through non-http URLs
  const origOpenCalls = [];
  const fakeOrigOpen = (...args) => { origOpenCalls.push(args); return { closed: false }; };
  const docListeners = new Map();
  globalThis.window = { open: fakeOrigOpen, location: { origin: 'http://tauri.localhost', href: 'http://tauri.localhost/' } };
  globalThis.document = {
    addEventListener: (k, fn) => docListeners.set(k, fn),
    removeEventListener: (k) => docListeners.delete(k),
  };
  const openedExternal = [];
  const cleanup = m.installExternalLinkHandler(async (_action, args) => { openedExternal.push(args.url); return { ok: true }; });
  assert.notEqual(globalThis.window.open, fakeOrigOpen);
  assert.deepEqual(globalThis.window.open(''), { closed: false });
  assert.deepEqual(globalThis.window.open('blob:http://tauri.localhost/abc'), { closed: false });
  assert.equal(globalThis.window.open('https://example.com/docs'), null);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(openedExternal, ['https://example.com/docs']);
  assert.equal(origOpenCalls.length, 2);
  cleanup();
  assert.equal(globalThis.window.open, fakeOrigOpen);

  // 5. createDesktopHost exposes warmKey, pickFile, and installFlavor
  const invokes = [];
  globalThis.__TAURI_INTERNALS__ = {
    invoke: async (cmd, args) => {
      invokes.push({ cmd, args });
      if (cmd === 'pick_file') return { path: 'D:\\book.pdf', size: 1234 };
      return null;
    },
  };
  const cliPath = 'C:\\StudyHub\\resources\\runtime\\scripts\\study-cli.mjs';
  const host = m.createDesktopHost(async () => ({}), {}, null, { installFlavor: 'nsis', studyCliPath: `  ${cliPath}  ` });
  assert.equal(host.warmKey, 'studyhub-desktop');
  assert.equal(host.updater.installFlavor, 'nsis');
  assert.equal(host.studyCliPath, cliPath);
  assert.deepEqual(host.capabilities, DESKTOP_HOST.capabilities);
  assert.equal('studyCliPath' in m.createDesktopHost(async () => ({}), {}, null, { studyCliPath: '   ' }), false);
  assert.deepEqual(await host.pickFile({ extensions: ['pdf'] }), { path: 'D:\\book.pdf', size: 1234 });
  assert.deepEqual(invokes, [{ cmd: 'pick_file', args: { extensions: ['pdf'] } }]);
});
