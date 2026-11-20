import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';

const mod = await loadUi(`
  export { default as AudioSettings } from './ui/AudioSettings.jsx';
  export { default as LiveLocalCard } from './ui/LiveLocalCard.jsx';
  export { default as LiveLoopbackCard } from './ui/LiveLoopbackCard.jsx';
  export { default as MineruPane } from './ui/settings/MineruPane.jsx';
  export { default as MineruInstallCard } from './ui/MineruInstallCard.jsx';
  export { errorHint, retryNote, fixFor } from './ui/mineru-install-flow.js';
  export { default as MarkerSettings } from './ui/MarkerSettings.jsx';
  export { default as MarkerInstall } from './ui/MarkerInstall.jsx';
  export { default as ExtensionsSettings } from './ui/ExtensionsSettings.jsx';
  export { default as ExtensionPanel } from './ui/ExtensionPanel.jsx';
  export { default as IndexNote } from './ui/IndexNote.jsx';
  export { default as LargeDocumentCard, ConverterMain, converterHandOffWhat } from './ui/LargeDocumentCard.jsx';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { setUiLanguage } from './ui/i18n.js';
`);

const h = React.createElement;
const HAN = /[\u3400-\u9fff]/;
const FORBIDDEN_ZH = /[您]|请勿|必须|暂无|宿主|插件/;
const noop = () => {};
const textOf = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/g, ' ').replace(/\s+/g, ' ').trim();
const visibleOf = (html) => textOf(html.replace(/<span[^>]*role="tooltip"[\s\S]*?<\/span>/g, ''));

const DESKTOP_HOST = { capabilities: { edition: 'desktop', chat: false } };
const DSH_HOST = { capabilities: { edition: 'dsh', chat: true } };

function renderWithHost(element, { host = DSH_HOST, language = 'zh' } = {}) {
  const services = { call: noop, act: noop, busy: false, notify: noop, askInChat: noop, host, openSettings: noop, navigate: noop, openModal: noop };
  mod.setUiLanguage(language);
  try {
    return renderToStaticMarkup(h(mod.StudyServicesContext.Provider, { value: services }, element));
  } finally {
    mod.setUiLanguage('zh');
  }
}

const audioView = {
  freeKey: { set: false, hint: '' },
  paidKey: { set: false, hint: '' },
  groqKey: { set: false, hint: '' },
  siliconflowKey: { set: false, hint: '' },
  settingsFile: '',
  textProvider: 'auto',
  mode: 'SMART',
  partMinutes: 45,
  textConcurrency: 3,
  proofreadReasoning: 'default',
  translateReasoning: 'low',
  transcribeModel: 'gemini-2.5-flash',
  textModel: 'gemini-2.5-flash',
  groqTranscribeModel: 'whisper-large-v3',
  groqTextModel: 'openai/gpt-oss-120b',
  siliconflowTranscribeModel: 'FunAudioLLM/SenseVoiceSmall',
  liveModel: 'gemini-2.5-flash-live',
  liveTranslateModel: 'gemini-2.5-flash-lite',
  liveCorrectionReasoning: 'low',
  liveProvider: 'auto',
  liveSentencePause: 'standard',
  dailyLimits: {},
};

test('AudioSettings: removes DSH/main-chat leaks in Desktop, clarifies cloud vs local scope, and explains expert options in zh & en', () => {
  const desktopZh = renderWithHost(h(mod.AudioSettings, { initialView: audioView }), { host: DESKTOP_HOST });
  const visible = visibleOf(desktopZh);
  assert.doesNotMatch(visible, /DSH|主会话|~\/\.dsh\/study\/audio\.json/, 'no DSH or main-chat leak in Desktop audio settings');
  assert.doesNotMatch(visible, FORBIDDEN_ZH);
  assert.match(visible, /导入录音文件需先配置下方任一云端转写密钥.*本地转写引擎，不需要密钥/);
  assert.match(visible, /云端转写密钥（用于导入录音文件）/);
  assert.match(visible, /硅基流动与 Groq 仅用于导入录音文件/);
  assert.match(visible, /仅用于课堂实录边听边转写/);
  assert.match(visible, /校对和翻译仍由 StudyHub 设置的生成模型完成/);
  assert.match(visible, /本机配置目录/);
  assert.match(visible, /StudyHub 设置的生成模型/);
  assert.match(visible, /Gemini 转写模型/);
  assert.match(visible, /一般保持默认即可/);
  assert.match(visible, /课堂实录整理时用来修正专业术语和断句/);
  assert.match(visible, /同时发给生成模型的校对或翻译窗口数/);
  assert.match(visible, /选得太短可能把一句话切成两句/);
  assert.match(visible, /下次点「开始实录」或「接着录」时生效/);

  const dshZh = renderWithHost(h(mod.AudioSettings, { initialView: audioView }), { host: DSH_HOST });
  assert.match(visibleOf(dshZh), /默认跟随主会话/);
  assert.match(visibleOf(dshZh), /贴进主会话的内容会被模型看到/);

  const desktopEn = renderWithHost(h(mod.AudioSettings, { initialView: audioView }), { host: DESKTOP_HOST, language: 'en' });
  assert.doesNotMatch(textOf(desktopEn), HAN);
  assert.doesNotMatch(visibleOf(desktopEn), /\bDSH\b|main chat/i);
  assert.match(visibleOf(desktopEn), /Gemini transcription model/);
  assert.match(visibleOf(desktopEn), /Generation model configured in StudyHub/);
});

test('LiveLocalCard & LiveLoopbackCard: visible privacy boundary, decision-oriented quality tier, scenario lead, and polished unsupported copy', () => {
  const qualityStatus = {
    status: 'complete', stage: 'done', stages: ['engine', 'model', 'check'], done: ['engine', 'model', 'check'],
    step: 3, of: 3, folder: 'D:\\LiveLocal', installedFolder: 'D:\\LiveLocal', installed: true, ready: true,
    supported: true, tested: true, modelId: 'whisper-turbo', selectedModelId: 'sense-voice', modelMb: 989, downloadMb: 1000, diskMb: 1014,
  };
  const localZh = renderWithHost(h(mod.LiveLocalCard, { initialStatus: qualityStatus, settings: true }), { host: DESKTOP_HOST });
  assert.match(visibleOf(localZh), /原文完全在本机离线生成，声音不上传；开启翻译或润色时，转出的文字仍会发给生成模型。/);
  assert.match(visibleOf(localZh), /识别更准，但内存和 CPU 占用更高（峰值约 1\.6 GB），老电脑可能跟不上实时播放/);
  assert.doesNotMatch(visibleOf(localZh), /合成语音测试|1\.6 GiB/);
  assert.doesNotMatch(visibleOf(localZh), FORBIDDEN_ZH);

  const localEn = renderWithHost(h(mod.LiveLocalCard, { initialStatus: qualityStatus, settings: true }), { host: DESKTOP_HOST, language: 'en' });
  assert.doesNotMatch(textOf(localEn), HAN);
  assert.match(visibleOf(localEn), /sent to your generation model/);

  const loopbackUnsupported = {
    status: 'idle', stage: '', stages: ['compile', 'check'], done: [], step: 0, of: 2,
    folder: '', installedFolder: '', installed: false, ready: false, supported: false,
  };
  const loopZh = renderWithHost(h(mod.LiveLoopbackCard, { initialStatus: loopbackUnsupported, settings: true }), { host: DESKTOP_HOST });
  assert.match(visibleOf(loopZh), /上网课或看录播时，直接采集电脑播放的讲课声（不用外放给麦克风）/);
  assert.match(visibleOf(loopZh), /macOS 与 Linux 暂不支持直采系统声音，请改用「麦克风」或在浏览器打开时选「标签页共享」。/);
  assert.doesNotMatch(visibleOf(loopZh), /独立浏览器窗口/);
  assert.doesNotMatch(visibleOf(loopZh), FORBIDDEN_ZH);

  const loopEn = renderWithHost(h(mod.LiveLoopbackCard, { initialStatus: loopbackUnsupported, settings: true }), { host: DESKTOP_HOST, language: 'en' });
  assert.doesNotMatch(textOf(loopEn), HAN);
  assert.match(visibleOf(loopEn), /Captures online classes or recorded lectures/);
});

test('MinerU & Marker: distinguishes primary vs alternative, removes audio-component jargon, branches permission hand-off by canChat, and previews model download', () => {
  const paneZh = renderWithHost(h(mod.MineruPane, { capabilities: { audio: true } }), { host: DESKTOP_HOST });
  assert.match(visibleOf(paneZh), /两套工具二选一即可.*首选推荐下方 MinerU.*Marker 为备选方案/);
  assert.match(visibleOf(paneZh), /备选方案：与上方 MinerU 二选一即可/);
  assert.doesNotMatch(visibleOf(paneZh), FORBIDDEN_ZH);

  const paneEn = renderWithHost(h(mod.MineruPane, { capabilities: { audio: true } }), { host: DESKTOP_HOST, language: 'en' });
  assert.doesNotMatch(textOf(paneEn), HAN);

  const markerOffZh = renderWithHost(h(mod.MarkerSettings, { available: false }), { host: DESKTOP_HOST });
  assert.match(visibleOf(markerOffZh), /当前环境未启用应用内 PDF 解析服务/);
  assert.doesNotMatch(visibleOf(markerOffZh), /音频组件/);
  const markerOffEn = renderWithHost(h(mod.MarkerSettings, { available: false }), { host: DESKTOP_HOST, language: 'en' });
  assert.doesNotMatch(textOf(markerOffEn), HAN);
  assert.doesNotMatch(visibleOf(markerOffEn), /audio component/i);

  // mineru-install-flow branches by canChat
  assert.match(mod.errorHint('home-permissions', { origin: 'service', ours: false, canChat: false }), /复制提示词/);
  assert.doesNotMatch(mod.errorHint('home-permissions', { origin: 'service', ours: false, canChat: false }), /发给主会话/);
  assert.match(mod.errorHint('home-permissions', { origin: 'service', ours: false, canChat: true }), /发给主会话/);
  const permAction = mod.fixFor('home-permissions', { origin: 'service' });
  assert.match(mod.retryNote({ action: permAction, failedTimes: 1, canChat: false }), /复制提示词/);
  assert.doesNotMatch(mod.retryNote({ action: permAction, failedTimes: 1, canChat: false }), /主会话/);
  assert.match(mod.retryNote({ action: permAction, failedTimes: 1, canChat: true }), /发给主会话/);

  mod.setUiLanguage('en');
  try {
    assert.doesNotMatch(mod.errorHint('home-permissions', { origin: 'service', ours: false, canChat: false }), HAN);
    assert.doesNotMatch(mod.retryNote({ action: permAction, failedTimes: 1, canChat: false }), HAN);
  } finally {
    mod.setUiLanguage('zh');
  }

  // MinerU tier subtitles & old-tier disk note
  const readyBasic = {
    state: 'ready', origin: 'installed', folder: 'D:\\MinerU', version: '4.0.12', tier: 'basic', running: true,
    install: { status: 'complete', stage: 'done', done: ['tools', 'python', 'package', 'models', 'enable', 'check'], installed: true, installedFolder: 'D:\\MinerU', installedTier: 'basic', tier: 'basic' },
  };
  const mineruPlan = {
    ok: true, problems: [], warnings: [], folder: 'D:\\MinerU', defaultFolder: 'D:\\MinerU', platform: 'win32',
    drives: [], disk: { freeMb: 50000, neededMb: 4000, drive: 'D:' }, estimate: { downloadMb: 1300, minutes: [10, 30] },
    tier: 'basic', ramMb: 16384, source: { id: 'mainland', chosenBy: 'auto', reason: 'faster' }, pythons: [], commands: [],
  };
  const cardZh = renderWithHost(h(mod.MineruInstallCard, { initialLocal: readyBasic, initialPlan: mineruPlan, initialMore: true }), { host: DESKTOP_HOST });
  assert.match(visibleOf(cardZh), /basic · 速度优先（推荐）/);
  assert.match(visibleOf(cardZh), /standard · 复杂版面更准/);
  assert.match(visibleOf(cardZh), /适合以文字、公式、表格为主/);
  assert.match(visibleOf(cardZh), /复杂多栏版面理解更好/);
  const cardEn = renderWithHost(h(mod.MineruInstallCard, { initialLocal: readyBasic, initialPlan: mineruPlan, initialMore: true }), { host: DESKTOP_HOST, language: 'en' });
  assert.doesNotMatch(textOf(cardEn), HAN);

  // Marker pre-install offer mentions first-conversion model download
  const idleMarker = { status: 'idle', stage: '', stages: ['create-venv', 'install', 'verify', 'configure'], folder: '', log: [], error: null, installed: false, installedFolder: '', defaultFolder: 'D:\\Marker' };
  const markerPlan = { ok: true, problems: [], folder: 'D:\\Marker', defaultFolder: 'D:\\Marker', platform: 'win32', python: { version: '3.12.0' }, minPython: '3.10', recommendedPython: '3.12', disk: { freeMb: 50000, neededMb: 4000 }, estimate: { downloadMb: 1500, minutes: [5, 15] }, commands: [] };
  const markerOfferZh = renderWithHost(h(mod.MarkerInstall, { initialInstall: idleMarker, initialPlan: markerPlan }), { host: DESKTOP_HOST });
  assert.match(visibleOf(markerOfferZh), /第一次解析 PDF 时会自动联网下载 Marker 模型.*之后可离线使用/);
  const markerOfferEn = renderWithHost(h(mod.MarkerInstall, { initialInstall: idleMarker, initialPlan: markerPlan }), { host: DESKTOP_HOST, language: 'en' });
  assert.doesNotMatch(textOf(markerOfferEn), HAN);
});

test('Retrieval UX: removes duplicate ConverterMain, documents 15万字 threshold & mirror example, shows visible IndexNote/page-count cues, and branches Desktop copy', () => {
  const running = {
    selected: 'builtin', effective: 'builtin', hostCanSearch: true, providers: [], otherTools: [],
    companion: { id: 'mcp:mcp__studyhub__query_documents', running: true },
    extension: { canInstall: true, installed: true, enabled: true, version: '2.1.1', desktop: false },
  };
  const plan = { course: 'OS', pages: 148, toIndex: 10, unchanged: 138, toRemove: 0, chars: 200000, firstRun: true, modelMb: 90, canIndex: true, documents: 5 };
  const doneRun = { status: 'complete', course: 'OS', added: 10, removed: 0, unchanged: 138, skipped: 0, failedCount: 0, done: 10, total: 10 };

  const extDesktopZh = renderWithHost(h(mod.ExtensionsSettings, { initialStatus: running, courses: ['OS'], defaultCourse: 'OS', initialPlan: plan, initialRun: doneRun }), { host: DESKTOP_HOST });
  assert.match(extDesktopZh, /<legend class="settings-section__title">检索扩展<\/legend>/);
  assert.doesNotMatch(extDesktopZh, /data-role="converter"/, 'no duplicate ConverterMain block in ExtensionsSettings');
  const extVis = visibleOf(extDesktopZh);
  assert.match(extVis, /15 万字/);
  assert.match(extVis, /不超过 15 万字时默认直接发全文/);
  assert.match(extVis, /设置 › PDF 转换（MinerU \/ Marker）/);
  assert.doesNotMatch(extVis, /不会替你改任何配置文件/, 'omitted in Desktop edition');
  assert.match(extVis, /https:\/\/hf-mirror\.com/);
  assert.match(extVis, /保存后会立即生效/);
  assert.match(extVis, /页数按课程累计，含 PDF 页、笔记与录音分段/);
  assert.match(extVis, /默认检索模型偏英文；中文教材结合关键词匹配/);
  assert.match(extVis, /出题时现在会用它挑选相关页面/);
  assert.doesNotMatch(extVis, /出题和 AI 带学/, 'Desktop hides AI guided learning in index-complete notice');

  const extDshZh = renderWithHost(h(mod.ExtensionsSettings, { initialStatus: running, courses: ['OS'], defaultCourse: 'OS', initialPlan: plan, initialRun: doneRun }), { host: DSH_HOST });
  assert.match(visibleOf(extDshZh), /StudyHub 不会替你改任何配置文件/);
  assert.match(visibleOf(extDshZh), /出题和 AI 带学现在会用它挑选相关页面/);

  const extDesktopEn = renderWithHost(h(mod.ExtensionsSettings, { initialStatus: running, courses: ['OS'], defaultCourse: 'OS', initialPlan: plan, initialRun: doneRun }), { host: DESKTOP_HOST, language: 'en' });
  assert.doesNotMatch(textOf(extDesktopEn), HAN);
  assert.match(visibleOf(extDesktopEn), /150,000 characters/);
  assert.match(visibleOf(extDesktopEn), /https:\/\/hf-mirror\.com/);
  assert.doesNotMatch(visibleOf(extDesktopEn), /guided learning/i);

  // ApprovalDialog branches by isDesktopApp
  const fresh = { ...running, companion: { id: 'x', running: false }, extension: { canInstall: true, installed: false, enabled: false, desktop: false } };
  const approvalDesktopZh = renderWithHost(h(mod.ExtensionPanel, { status: fresh, initialApproval: ['onnxruntime-node'] }), { host: DESKTOP_HOST });
  assert.match(visibleOf(approvalDesktopZh), /StudyHub 桌面版默认会先征得你确认/);
  assert.doesNotMatch(visibleOf(approvalDesktopZh), /DSH 默认会拦下它们/);
  const approvalDesktopEn = renderWithHost(h(mod.ExtensionPanel, { status: fresh, initialApproval: ['onnxruntime-node'] }), { host: DESKTOP_HOST, language: 'en' });
  assert.doesNotMatch(textOf(approvalDesktopEn), HAN);
  assert.match(visibleOf(approvalDesktopEn), /StudyHub Desktop asks for your confirmation/);

  // converterHandOffWhat branches by canChat & LargeDocumentCard updates MinerU / Marker path
  assert.match(mod.converterHandOffWhat(true, false), /复制提示词/);
  assert.doesNotMatch(mod.converterHandOffWhat(true, false), /主会话|@/);
  assert.match(mod.converterHandOffWhat(false, false), /复制提示词/);
  assert.doesNotMatch(mod.converterHandOffWhat(false, false), /主会话|@/);
  const converterDesktopEn = renderWithHost(h(mod.ConverterMain, { why: 'too big', scanned: true }), { host: DESKTOP_HOST, language: 'en' });
  assert.doesNotMatch(textOf(converterDesktopEn), HAN);
  assert.match(textOf(converterDesktopEn), /PDF conversion \(MinerU \/ Marker\)/);
  assert.match(textOf(converterDesktopEn), /Copy a prompt/);
});
