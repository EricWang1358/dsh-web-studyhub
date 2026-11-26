import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { inApp } from './helpers/fake-app.mjs';
import { click, loadInteractiveUi } from './helpers/react-harness.mjs';

const h = React.createElement;
const noop = () => {};
const han = /[㐀-鿿]/;
const words = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim();

const m = await loadUi(`
  export { default as Settings } from './ui/Settings.jsx';
  export { withAvailability } from './ui/finder/availability.js';
  export { FINDER_ENTRIES } from './ui/finder/entries.js';
  export { default as AppearanceSection } from './ui/settings/AppearanceSection.jsx';
  export { default as AppearanceTransfer } from './ui/settings/AppearanceTransfer.jsx';
  export { default as ScienceSettings } from './ui/ScienceSettings.jsx';
  export { default as ModelStatus } from './ui/settings/ModelStatus.jsx';
  export { default as WorkspaceBindingPanel } from './ui/app/WorkspaceBindingPanel.jsx';
  export { default as DesktopLibraryNotice } from './ui/desktop/DesktopLibraryNotice.jsx';
  export { default as DesktopCliCard } from './ui/desktop/DesktopCliCard.jsx';
  export { default as DesktopOpenAiForm } from './ui/desktop/DesktopOpenAiForm.jsx';
  export { DesktopSetupBody } from './ui/desktop/DesktopModelSetup.jsx';
  export { default as WebGeminiSection } from './ui/settings/WebGeminiSection.jsx';
  export { default as ExamPrepPane } from './ui/settings/ExamPrepPane.jsx';
  export { AppContext } from './ui/app/app-context.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { setUiLanguage, ui } from './ui/i18n.js';
`);

const DESKTOP_HOST = { capabilities: { edition: 'desktop', chat: false, agentTasks: false, landing: false } };
const DSH_HOST = { capabilities: { edition: 'dsh', chat: true, agentTasks: true, landing: true } };

const render = (node, { language = 'zh', host = DSH_HOST, app = {} } = {}) => {
  m.setUiLanguage(language);
  try {
    return renderToStaticMarkup(inApp(m, node, { language, host, app }));
  } finally {
    m.setUiLanguage('zh');
  }
};

test('Settings header replaces engineering term 调度 with 复习节奏 in zh and translates cleanly in en', () => {
  const baseProps = {
    data: { root: '/lib', contexts: ['study'], sources: [], decks: [] },
    settings: {},
    setSettings: noop,
    legacy: {},
    setLegacy: noop,
    exportData: noop,
    onRestored: noop,
  };
  const zh = render(h(m.Settings, baseProps));
  assert.match(words(zh), /资料、题库、复习节奏与模型，由你掌控。/);
  assert.doesNotMatch(words(zh), /资料、题库、调度与模型/);
  const en = render(h(m.Settings, baseProps), { language: 'en' });
  assert.match(words(en), /review pace/i);
  assert.doesNotMatch(words(en), han);
});

test('Finder overrides setting-model description on Desktop so it never points to DSH Settings › Models', () => {
  const desktopEntries = m.withAvailability(m.FINDER_ENTRIES, { contexts: ['study'] }, { canChat: false });
  const desktopModel = desktopEntries.find((entry) => entry.id === 'setting-model');
  assert.ok(desktopModel);
  assert.doesNotMatch(desktopModel.what, /DSH/);
  assert.match(desktopModel.what, /本机 CLI/);
  assert.match(desktopModel.what, /API Key/);

  m.setUiLanguage('en');
  try {
    const enWhat = m.ui(desktopModel.what);
    assert.doesNotMatch(enWhat, han);
    assert.doesNotMatch(enWhat, /DSH/);
    assert.match(enWhat, /local CLI/i);
  } finally {
    m.setUiLanguage('zh');
  }

  const dshEntries = m.withAvailability(m.FINDER_ENTRIES, { contexts: ['study'] }, { canChat: true });
  const dshModel = dshEntries.find((entry) => entry.id === 'setting-model');
  assert.match(dshModel.what, /DSH/);
});

test('AppearanceSection & AppearanceTransfer add plain-language hints, heading-font guidance, reset scope, and drop 浏览器 from clipboard error', async () => {
  const baseAppearance = {
    language: 'zh', onLanguage: noop,
    theme: 'dark', onTheme: noop,
    accent: 'cinnabar', onAccent: noop,
    scale: 100, onScale: noop,
    sound: 'off', onSound: noop,
    font: 'system', onFont: noop,
    fontCustom: '', onFontCustom: noop,
    fontTitle: 'follow', onFontTitle: noop,
    motion: 'auto', onMotion: noop,
    contrast: 'auto', onContrast: noop,
    density: 'standard', onDensity: noop,
    radius: 'standard', onRadius: noop,
    craft: 'standard', onCraft: noop,
    onReset: noop,
    onExport: () => '{"studyhubAppearance":1}',
    onImport: () => true,
  };

  const zhSystem = render(h(m.AppearanceSection, { appearance: baseAppearance }));
  assert.match(words(zhSystem), /恢复外观与音效（含折叠内选项），不改界面语言/);
  assert.match(words(zhSystem), /更偏紧凑工具风格：按钮更矮、顶栏和说明字稍小/);
  assert.doesNotMatch(words(zhSystem), /圆角比例|较小字阶|浅色灰阶与禁用态对比/);
  assert.match(words(zhSystem), /修改上方「界面字体」后生效/);

  const zhNonSystem = render(h(m.AppearanceSection, { appearance: { ...baseAppearance, font: 'serif' } }));
  assert.match(words(zhNonSystem), /可让标题跟随上方所选的界面字体/);

  const enSystem = render(h(m.AppearanceSection, { appearance: baseAppearance }), { language: 'en' });
  const enNonSystem = render(h(m.AppearanceSection, { appearance: { ...baseAppearance, font: 'serif' } }), { language: 'en' });
  assert.doesNotMatch(words(enSystem).replace(/中文/g, ''), han);
  assert.doesNotMatch(words(enNonSystem).replace(/中文/g, ''), han);

  const transferUi = await loadInteractiveUi(`
    export { default as AppearanceTransfer } from './ui/settings/AppearanceTransfer.jsx';
    export { setUiLanguage } from './ui/i18n.js';
  `);
  const attemptedWrites = [];
  const prevNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    writable: true,
    value: {
      clipboard: {
        writeText: async (text) => {
          attemptedWrites.push(text);
          throw new Error('clipboard denied');
        },
      },
    },
  });
  try {
    for (const [language, buttonLabel] of [['zh', '复制外观设置'], ['en', 'Copy appearance settings']]) {
      transferUi.exports.setUiLanguage(language);
      const mounted = transferUi.mount(() => transferUi.React.createElement(
        transferUi.exports.AppearanceTransfer,
        { appearance: { ...baseAppearance, language } },
      ));
      try {
        const copyBtn = mounted.find((node) => node.type === 'button' && mounted.text(node).includes(buttonLabel));
        assert.ok(copyBtn, `copy button renders in ${language}`);
        await mounted.act(() => click(copyBtn));
        await mounted.flush(5);
        const rendered = mounted.text();
        if (language === 'zh') {
          assert.match(rendered, /没能写入剪贴板，可以改用「下载为文件」。/);
          assert.doesNotMatch(rendered, /浏览器不让写剪贴板/);
        } else {
          assert.match(rendered, /Could not write to the clipboard\. Try Save as file instead\./);
          assert.doesNotMatch(rendered, han);
        }
      } finally {
        mounted.unmount();
      }
    }
    assert.deepEqual(attemptedWrites, ['{"studyhubAppearance":1}', '{"studyhubAppearance":1}']);
  } finally {
    transferUi.exports.setUiLanguage('zh');
    if (prevNavigator) Object.defineProperty(globalThis, 'navigator', prevNavigator);
    else delete globalThis.navigator;
  }
});

test('ScienceSettings uses 当前设备, clarifies all 5 checkboxes with hints, and renames the two local tool toggles', () => {
  const zh = render(h(m.ScienceSettings, { onChange: noop }));
  assert.match(words(zh), /保存在当前设备/);
  assert.doesNotMatch(words(zh), /当前浏览器/);
  assert.match(words(zh), /在本页显示化学配平工具/);
  assert.match(words(zh), /在本页显示代数恒等式验证工具/);
  assert.doesNotMatch(words(zh), /启用化学自动配平|启用代数恒等式证明/);
  assert.match(words(zh), /在草稿编题和学习笔记里显示插入图片按钮；关掉不影响已插入的图片/);
  assert.match(words(zh), /只在当前设置页底部展开或收起本地化学方程式配平工具/);
  assert.match(words(zh), /只在当前设置页底部展开或收起本地代数恒等式验证工具/);
  assert.equal((zh.match(/class="sh-check"/g) || []).length, 5);
  assert.ok((zh.match(/\bsh-hint\b/g) || []).length >= 5, 'every checkbox carries a visible hint');

  const en = render(h(m.ScienceSettings, { onChange: noop }), { language: 'en' });
  assert.match(words(en), /saved on this device/i);
  assert.match(words(en), /Show chemical balancing tool on this page/);
  assert.match(words(en), /Show algebraic identity verification tool on this page/);
  assert.doesNotMatch(words(en), han);
});

test('ModelStatus adapts copy for Desktop without contradicting local CLI or leaking 这个 DSH', () => {
  const okData = { model: { ready: true, reason: 'ok', label: 'Antigravity CLI' } };
  const unknownData = { model: { ready: true, reason: 'unknown', label: 'Antigravity CLI' } };

  const desktopOkZh = render(h(m.ModelStatus, { data: okData, host: DESKTOP_HOST }), { host: DESKTOP_HOST });
  assert.match(words(desktopOkZh), /测试连通/);
  assert.doesNotMatch(words(desktopOkZh), /密钥是否有效/);

  const desktopUnknownZh = render(h(m.ModelStatus, { data: unknownData, host: DESKTOP_HOST }), { host: DESKTOP_HOST });
  assert.match(words(desktopUnknownZh), /当前暂时无法提前确认模型可用/);
  assert.doesNotMatch(words(desktopUnknownZh), /DSH/);

  const desktopOkEn = render(h(m.ModelStatus, { data: okData, host: DESKTOP_HOST }), { language: 'en', host: DESKTOP_HOST });
  const desktopUnknownEn = render(h(m.ModelStatus, { data: unknownData, host: DESKTOP_HOST }), { language: 'en', host: DESKTOP_HOST });
  assert.doesNotMatch(words(desktopOkEn), han);
  assert.doesNotMatch(words(desktopUnknownEn), han);

  const dshOkZh = render(h(m.ModelStatus, { data: okData, host: DSH_HOST }), { host: DSH_HOST });
  assert.match(words(dshOkZh), /密钥是否有效，要到真正用的时候才会知道/);
});

test('WorkspaceBindingPanel removes native title in favor of Tooltip layer and DesktopLibraryNotice includes folder-move guidance', () => {
  const app = {
    host: DSH_HOST,
    data: { root: 'D:\\StudyLib' },
    core: { call: async () => ({}), busy: false, notify: noop },
    connection: { binding: { root: 'D:\\StudyLib', rootSource: 'custom' }, setBinding: noop, updateBinding: async () => true },
  };
  const bindingZh = render(h(m.AppContext.Provider, { value: app }, h(m.WorkspaceBindingPanel)));
  assert.doesNotMatch(bindingZh, /\btitle="/, 'no native HTML title attribute on library path');
  assert.match(bindingZh, /role="tooltip"/, 'full path is carried by Tooltip');
  assert.match(words(bindingZh), /更换目录只切换读取位置，不会搬动原文件夹里的内容/);

  const bindingEn = render(h(m.AppContext.Provider, { value: app }, h(m.WorkspaceBindingPanel)), { language: 'en' });
  assert.doesNotMatch(words(bindingEn), han);

  const noticeZh = render(h(m.DesktopLibraryNotice, { binding: { root: 'D:\\StudyLib' } }), { host: DESKTOP_HOST });
  assert.match(noticeZh, /data-desktop-library-move/);
  assert.match(words(noticeZh), /换文件夹不会搬动已有内容；要搬，先退出 StudyHub，把整个文件夹移到新位置，再回来选它。/);

  const noticeEn = render(h(m.DesktopLibraryNotice, { binding: { root: 'D:\\StudyLib' } }), { language: 'en', host: DESKTOP_HOST });
  assert.match(words(noticeEn), /Choosing another folder does not move what is already there/);
  assert.doesNotMatch(words(noticeEn), han);
});

test('DesktopCliCard, DesktopOpenAiForm and DesktopModelSetup polish effort hint, active disable, incomplete notice, and quiet config path', () => {
  const readyAgy = { id: 'agy', name: 'Antigravity CLI (agy)', supported: true, status: 'ready', executablePath: 'C:\\agy.exe', version: '1.5.12', reason: '' };
  const noopActions = { saveCli: noop, testCli: noop, scan: noop, openCli: noop, saveOpenAi: noop, testOpenAi: noop };

  const activeCliZh = render(h(m.DesktopCliCard, {
    providers: [readyAgy], mode: 'agy', agy: { model: '', effort: '' }, codex: {}, actions: noopActions, working: '',
  }), { host: DESKTOP_HOST });
  assert.match(words(activeCliZh), /档位越高思考越深，速度越慢、耗额度也越多/);
  const activeBtn = activeCliZh.match(/<button[^>]*>(?:(?!<\/button>).)*已启用本机 agy<\/button>/s)?.[0] || '';
  assert.match(activeBtn, /\bdisabled\b/, 'active and clean CLI activate button is disabled');

  const idleCliZh = render(h(m.DesktopCliCard, {
    providers: [readyAgy], mode: 'openai', agy: { model: '', effort: '' }, codex: {}, actions: noopActions, working: '',
  }), { host: DESKTOP_HOST });
  const idleBtn = idleCliZh.match(/<button[^>]*>(?:(?!<\/button>).)*一键启用本机 agy<\/button>/s)?.[0] || '';
  assert.doesNotMatch(idleBtn, /\bdisabled\b/, 'inactive CLI activate button stays clickable');

  const incompleteOpenAiZh = render(h(m.DesktopOpenAiForm, {
    openai: { providerId: 'custom', baseUrl: 'https://custom.example.com/v1', model: '', hasKey: false, keyLast4: '' },
    active: false, actions: noopActions, working: '',
  }), { host: DESKTOP_HOST });
  assert.match(incompleteOpenAiZh, /data-desktop-openai-incomplete/);
  assert.match(words(incompleteOpenAiZh), /先填好上面的接口地址和模型，再保存 API Key。/);

  const incompleteOpenAiEn = render(h(m.DesktopOpenAiForm, {
    openai: { providerId: 'custom', baseUrl: 'https://custom.example.com/v1', model: '', hasKey: false, keyLast4: '' },
    active: false, actions: noopActions, working: '',
  }), { language: 'en', host: DESKTOP_HOST });
  assert.match(words(incompleteOpenAiEn), /Fill in the endpoint address and model above before saving your API key/);
  assert.doesNotMatch(words(incompleteOpenAiEn), han);

  const setupZh = render(h(m.DesktopSetupBody, {
    config: {
      mode: 'agy',
      providers: [readyAgy],
      agy: {},
      codex: {},
      openai: { providerId: 'zhipu', baseUrl: '', model: '', hasKey: false, keyLast4: '' },
      effective: { ready: true },
      configPath: 'C:\\Users\\me\\.studyhub\\desktop.json',
    },
    actions: noopActions,
    working: '',
    error: '',
    onDismissError: noop,
    compact: false,
  }), { host: DESKTOP_HOST });
  assert.match(setupZh, /<p[^>]*data-desktop-config-path=""[^>]*>[\s\S]*desktop\.json/);
  assert.doesNotMatch(setupZh, /sh-inline[^>]*>[\s\S]*配置文件位置：/);
});

test('WebGeminiSection explains plain-language purpose & no-fallback behavior, uses secondary test button, and folds MCP tool/timeout when off', () => {
  const offStatus = {
    enabled: false, toolName: '', waitSeconds: 600, minWaitSeconds: 30, maxWaitSeconds: 1800,
    effectiveTool: null, missing: null, available: false, hasToolRegistry: true, tools: [], active: false,
  };
  const offZh = render(h(m.WebGeminiSection, { initialStatus: offStatus }));
  assert.match(words(offZh), /用浏览器里已登录的网页版 Gemini/);
  assert.match(words(offZh), /不会自动退回原模型/);
  assert.doesNotMatch(words(offZh), /非并发单次无工具子代理任务|Extended Thinking/);
  const testBtn = offZh.match(/<button[^>]*>(?:(?!<\/button>).)*手动测试连通与回答<\/button>/s)?.[0] || '';
  assert.match(testBtn, /sh-btn--secondary/);
  assert.doesNotMatch(testBtn, /sh-btn--primary/);
  const detailsTagOff = offZh.match(/<details[^>]*web-gemini__advanced[^>]*>/)?.[0] || '';
  assert.ok(detailsTagOff, 'MCP tool and timeout controls are wrapped in Disclosure');
  assert.doesNotMatch(detailsTagOff, /\bopen\b/, 'collapsed by default when disabled');

  const onZh = render(h(m.WebGeminiSection, { initialStatus: { ...offStatus, enabled: true, available: true, effectiveTool: 'mcp__g__ask_gemini_web' } }));
  const detailsTagOn = onZh.match(/<details[^>]*web-gemini__advanced[^>]*>/)?.[0] || '';
  assert.match(detailsTagOn, /\bopen\b/, 'expanded by default when enabled');

  const offEn = render(h(m.WebGeminiSection, { initialStatus: offStatus }), { language: 'en' });
  assert.match(words(offEn), /Tool selection & timeout settings/);
  assert.doesNotMatch(words(offEn), han);
});

test('ExamPrepPane drops forbidden word 插件, internal param, and DSH hardcoding, explains reopen, and disables extra keywords when autoRoles is off', () => {
  const onZh = render(h(m.ExamPrepPane, { data: { settings: { examPrep: { enabled: true, autoRoles: true } }, features: { examBlueprint: true } }, busy: false, act: noop }));
  assert.doesNotMatch(words(onZh), /runtime\.pilot\.examBlueprint|插件|DSH/);
  assert.match(words(onZh), /已保存的考点清单不会删除，重新开启后可继续查看/);

  const hostZh = render(h(m.ExamPrepPane, { data: { settings: {}, features: { examBlueprint: true, examBlueprintByHost: true } }, busy: false, act: noop }));
  assert.match(words(hostZh), /备考补习已由当前环境开启/);
  assert.doesNotMatch(words(hostZh), /DSH|插件/);

  const manualZh = render(h(m.ExamPrepPane, { data: { settings: { examPrep: { enabled: true, autoRoles: false, paperWords: ['mock'] } }, features: { examBlueprint: true } }, busy: false, act: noop }));
  assert.match(words(manualZh), /开启「自动识别资料用途」后生效/);
  const wordInput = manualZh.match(/<input[^>]*name="paperWord"[^>]*>/)?.[0] || '';
  assert.match(wordInput, /\bdisabled\b/);

  const manualEn = render(h(m.ExamPrepPane, { data: { settings: { examPrep: { enabled: true, autoRoles: false, paperWords: ['mock'] } }, features: { examBlueprint: true } }, busy: false, act: noop }), { language: 'en' });
  assert.match(words(manualEn), /Takes effect when/);
  assert.doesNotMatch(words(manualEn), han);
});
