import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { defaults } from '../lib/sm2.js';
import { CHECK_INTERVAL_MS } from '../lib/update-check.js';

const h = React.createElement;
const han = /[\u3400-\u9fff]/;

const m = await loadUi(`
  export { CoachSection } from './ui/settings/CoachSection.jsx';
  export { default as GuidancePane } from './ui/settings/GuidancePane.jsx';
  export { guidanceItemsFor, GUIDANCE_ITEMS } from './ui/guidance/registry.js';
  export { default as DataPane } from './ui/settings/DataPane.jsx';
  export { BackupSection } from './ui/settings/BackupSection.jsx';
  export { ScheduleSection } from './ui/settings/ScheduleSection.jsx';
  export { default as LegacyImportSection } from './ui/settings/LegacyImportSection.jsx';
  export { UpdateSettings, UpdateDialog, UpdateChip, updateErrorText, failureMessage } from './ui/UpdateCenter.jsx';
  export { default as DesktopUpgradeGuide } from './ui/desktop/DesktopUpgradeGuide.jsx';
  export { UsageSettingsView, usagePrivacyPoints } from './ui/UsageSettings.jsx';
  export { ExperimentalSection } from './ui/ExperimentalSettings.jsx';
  export { default as JevSettings, JevSettingsView } from './ui/JevSettings.jsx';
  export { keySourceText } from './ui/jev-flow.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { setUiLanguage } from './ui/i18n.js';
`);

const DESKTOP_HOST = { capabilities: { edition: 'desktop', chat: false, agentTasks: false, landing: false } };
const DSH_HOST = { capabilities: { edition: 'dsh', chat: true, agentTasks: true, landing: true } };
const noop = () => {};

const withHost = (host, node) => h(m.StudyServicesContext.Provider, {
  value: { call: async () => ({}), act: async () => undefined, busy: false, notify: noop, askInChat: noop, host, openSettings: noop, navigate: noop, openModal: noop },
}, node);

const render = (node, language = 'zh') => {
  m.setUiLanguage(language);
  try { return renderToStaticMarkup(node); } finally { m.setUiLanguage('zh'); }
};

const stripTags = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    get length() { return map.size; },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}

test('CoachSection removes internal jargon, branches main-chat wording by canChat, aligns title, and explains background variants in zh & en', () => {
  const profile = { consent: true, goal: 'exam', preferences: [], summary: '', signals: { got: 1, confused: 0, up: 0, down: 0 }, ready: 0 };
  const desktopZh = render(withHost(DESKTOP_HOST, h(m.CoachSection, { profile, setProfile: noop })));
  assert.match(desktopZh, /<legend class="settings-section__title">学习画像与陪学<\/legend>/);
  assert.doesNotMatch(desktopZh, /数据围栏/);
  assert.doesNotMatch(desktopZh, /主会话/);
  assert.match(desktopZh, /答错或出现薄弱点时，在后台用最低推理档位预备 1–2 道变式题（消耗少量模型用量），出现在复盘与错题本里；关掉后仅手动触发。/);

  const dshZh = render(withHost(DSH_HOST, h(m.CoachSection, { profile, setProfile: noop })));
  assert.doesNotMatch(dshZh, /数据围栏/);
  assert.match(dshZh, /以及发给主会话的消息/);
  assert.match(dshZh, /也可以随时在主会话里直接告诉 AI 你想怎么学/);

  for (const host of [DESKTOP_HOST, DSH_HOST]) {
    const en = render(withHost(host, h(m.CoachSection, { profile, setProfile: noop })), 'en');
    assert.match(en, /Study profile &amp; coach/);
    assert.doesNotMatch(stripTags(en), han);
  }
});

test('GuidancePane & registry omit Archify and browser/main-chat wording in Desktop, remove forbidden 插件, and shorten master hint in zh & en', () => {
  const desktopItems = m.guidanceItemsFor({ canChat: false, isDesktop: true });
  assert.equal(desktopItems.some((item) => item.id === 'skeleton.archify'), false);
  assert.equal(desktopItems.find((item) => item.id === 'reader.page-presets')?.title, '预设问题和复制提示词');
  assert.match(desktopItems.find((item) => item.id === 'practice.chapter-basics')?.trigger || '', /复制提示词/);

  const dshItems = m.guidanceItemsFor({ canChat: true, isDesktop: false });
  const archify = dshItems.find((item) => item.id === 'skeleton.archify');
  assert.ok(archify);
  assert.doesNotMatch(archify.trigger, /插件/);

  const desktopZh = render(withHost(DESKTOP_HOST, h(m.GuidancePane, { storages: { local: null, session: null } })));
  assert.doesNotMatch(desktopZh, /skeleton\.archify|Archify/);
  assert.doesNotMatch(desktopZh, /发给主会话|这个浏览器|无痕窗口/);
  assert.match(desktopZh, /这台电脑的本地设置/);
  assert.match(desktopZh, /预设问题和复制提示词/);
  assert.match(desktopZh, /关掉后，下方标有「主动出现」的提示与提醒都不再自动出现/);

  const dshZh = render(withHost(DSH_HOST, h(m.GuidancePane, { storages: { local: memoryStorage(), session: memoryStorage() } })));
  assert.match(dshZh, /skeleton\.archify/);
  assert.doesNotMatch(dshZh, /开源插件/);
  assert.match(dshZh, /这个浏览器/);

  for (const [host, storages] of [[DESKTOP_HOST, { local: null, session: null }], [DSH_HOST, { local: memoryStorage(), session: memoryStorage() }]]) {
    const en = render(withHost(host, h(m.GuidancePane, { storages })), 'en');
    assert.doesNotMatch(stripTags(en), han);
  }
});

test('DataPane, LegacyImportSection, ScheduleSection, and BackupSection polish hierarchy, hints, Desktop path, and remove title attribute', () => {
  const data = { root: 'D:\\Study\\lib', settings: { ...defaults }, jobs: [] };
  const samplePoints = {
    retention: { daily: 7, weekly: 4 },
    totalExtraBytes: 1024,
    points: [{ id: '2026-11-16', date: '2026-11-16', tier: 'daily', extraBytes: 1024, summary: { revision: 7, courses: 1, sources: 2, decks: 1, cards: 10, attempts: 20 } }],
  };

  const paneZh = render(withHost(DESKTOP_HOST, h(m.DataPane, { data, settings: { ...defaults }, setSettings: noop, legacy: '', setLegacy: noop, exportData: noop, onRestored: noop })));
  assert.ok(paneZh.indexOf('间隔复习 · FSRS-6') < paneZh.indexOf('数据备份与恢复'), 'Schedule before Backup');
  assert.ok(paneZh.indexOf('数据备份与恢复') < paneZh.indexOf('从旧版 study-lib-spar 导入'), 'Legacy import at bottom of DataPane');
  assert.match(paneZh, /<details[^>]*class="[^"]*legacy-import-disclosure[^"]*"(?![^>]*\bopen\b)/, 'Legacy import collapsed by default');
  assert.match(paneZh, /仅限早期 study-lib-spar 工具老用户；导入会合并进当前库，不覆盖现有内容/);
  assert.match(paneZh, /placeholder="例如：D:\\study-lib-spar 或 ~\/study-lib-spar"/);

  // ScheduleSection visible hints
  assert.match(paneZh, /默认 90%（70%–97%），超过 93% 每日题量会明显增加/);
  assert.match(paneZh, /默认不设上限，仅影响之后作答；备考请在「课程」填考试日期，无需调小这里/);

  // BackupSection Desktop vs DSH & no title attribute
  const backupDesktop = render(withHost(DESKTOP_HOST, h(m.BackupSection, { root: 'D:\\Study\\lib', exportData: noop, onRestored: noop, initialRestorePoints: samplePoints })));
  assert.doesNotMatch(backupDesktop, /<code class="backup-path"[^>]*\stitle=/);
  assert.match(backupDesktop, /系统下载文件夹（或你选择的保存位置）/);
  assert.doesNotMatch(backupDesktop, /浏览器的下载文件夹/);
  assert.match(backupDesktop, /API 密钥与外观设置不在备份内/);
  assert.match(backupDesktop, /前一天的题库与进度快照/);
  assert.match(backupDesktop, /保存次数 7/);
  assert.doesNotMatch(backupDesktop, /前一日清单快照|修订 7/);

  const backupDsh = render(withHost(DSH_HOST, h(m.BackupSection, { root: 'D:\\Study\\lib', exportData: noop, onRestored: noop, initialRestorePoints: samplePoints })));
  assert.match(backupDsh, /浏览器的下载文件夹/);

  for (const host of [DESKTOP_HOST, DSH_HOST]) {
    const enPane = render(withHost(host, h(m.DataPane, { data, settings: { ...defaults }, setSettings: noop, legacy: '', setLegacy: noop, exportData: noop, onRestored: noop })), 'en');
    assert.doesNotMatch(stripTags(enPane).replace(/D:\\Study\\lib|D:\\study-lib-spar/g, ''), han);
    const enBackup = render(withHost(host, h(m.BackupSection, { root: 'D:\\Study\\lib', exportData: noop, onRestored: noop, initialRestorePoints: samplePoints })), 'en');
    assert.doesNotMatch(stripTags(enBackup).replace(/D:\\Study\\lib/g, ''), han);
  }
});

test('UpdateCenter & DesktopUpgradeGuide align 6h TTL, remove 必须, hide duplicate installed row on Desktop, and shorten diagnostic hint', () => {
  assert.equal(CHECK_INTERVAL_MS, 6 * 60 * 60 * 1000, 'backend auto-check interval is 6 hours (host cache behavior covered in tests/wp15-update-check.test.mjs)');

  const sampleUpdate = { current: '4.15.1', installed: '4.15.1', latest: '4.16.0', newer: true, url: 'https://github.com/EricWang1358/dsh-web-studyhub/releases', assetUrl: 'https://github.com/EricWang1358/dsh-web-studyhub/releases/download/v4.16.0/pkg.tgz', checkedAt: '2026-11-20T00:00:00Z', autoCheck: true };
  const desktopSettings = render(withHost(DESKTOP_HOST, h(m.UpdateSettings, { update: sampleUpdate, diagnostic: () => 'diag' })));
  assert.match(desktopSettings, /自动检查通常间隔 6 小时/);
  assert.match(desktopSettings, /<dt>当前版本<\/dt>/);
  assert.doesNotMatch(desktopSettings, /<dt>已安装版本<\/dt>/, 'Desktop hides duplicate installed version row');
  assert.match(desktopSettings, /只含版本、页面、报错摘要与基础计数，不含资料与题目内容。/);
  assert.doesNotMatch(desktopSettings, /出错位置的函数名|DSH 版本请自己补上/);

  const dshSettings = render(withHost(DSH_HOST, h(m.UpdateSettings, { update: sampleUpdate, diagnostic: () => 'diag' })));
  assert.match(dshSettings, /<dt>已安装版本<\/dt>/);
  assert.match(dshSettings, /DSH 版本请自己补上/);

  const guided = render(withHost(DSH_HOST, h(m.UpdateDialog, { update: sampleUpdate, onClose: noop })));
  assert.match(guided, /请先完全退出桌面版/);

  const desktopGuide = render(h(m.DesktopUpgradeGuide, { update: sampleUpdate }));
  assert.match(desktopGuide, /请先点左下角「查看发布页」对照 SHA256SUMS 核对校验值/);

  // Behavioral copy check across UpdateSettings, UpdateDialog, UpdateChip, updateErrorText, and failureMessage: never use 必须.
  const inAppUpdate = { ...sampleUpdate, install: { available: true, desktop: true }, source: 'fallback' };
  const pendingUpdate = { ...sampleUpdate, newer: false, pendingRestart: '4.16.0', install: { available: true, desktop: false } };
  const stuckUpdate = {
    ...sampleUpdate,
    newer: false,
    restartFailed: { pending: '4.16.0', running: '4.15.1', installedAt: '2026-11-20T00:00:00Z', assetUrl: sampleUpdate.assetUrl },
  };
  const renderedZhSurfaces = [
    desktopSettings,
    dshSettings,
    guided,
    desktopGuide,
    render(withHost(DSH_HOST, h(m.UpdateSettings, { update: pendingUpdate, diagnostic: () => 'diag' }))),
    render(withHost(DSH_HOST, h(m.UpdateSettings, { update: stuckUpdate, diagnostic: () => 'diag' }))),
    render(withHost(DSH_HOST, h(m.UpdateSettings, { update: { ...sampleUpdate, newer: false, checkedAt: null }, initialCheckError: 'network', initialSaveError: 'failed' }))),
    render(withHost(DSH_HOST, h(m.UpdateSettings, { update: { ...sampleUpdate, error: 'rate-limited' } }))),
    render(withHost(DSH_HOST, h(m.UpdateDialog, { update: inAppUpdate, onClose: noop, initialPhase: { phase: 'idle' } }))),
    render(withHost(DSH_HOST, h(m.UpdateDialog, { update: inAppUpdate, onClose: noop, initialPhase: { phase: 'confirm' } }))),
    render(withHost(DSH_HOST, h(m.UpdateDialog, { update: inAppUpdate, onClose: noop, initialPhase: { phase: 'working' } }))),
    render(withHost(DSH_HOST, h(m.UpdateDialog, { update: inAppUpdate, onClose: noop, initialPhase: { phase: 'jobs', jobs: 2 } }))),
    render(withHost(DSH_HOST, h(m.UpdateDialog, { update: inAppUpdate, onClose: noop, initialPhase: { phase: 'error', code: 'UPDATE_DOWNLOAD' } }))),
    render(withHost(DSH_HOST, h(m.UpdateDialog, { update: inAppUpdate, onClose: noop, initialPhase: { phase: 'installed', version: '4.16.0', restartRequired: true, desktop: true } }))),
    render(withHost(DSH_HOST, h(m.UpdateDialog, { update: pendingUpdate, onClose: noop, initialPhase: { phase: 'installed', version: '4.16.0', restartRequired: true, desktop: false } }))),
    render(withHost(DSH_HOST, h(m.UpdateDialog, { update: stuckUpdate, onClose: noop }))),
    render(h(m.UpdateChip, { update: sampleUpdate, onOpen: noop })),
    render(h(m.UpdateChip, { update: pendingUpdate, onOpen: noop })),
    render(h(m.UpdateChip, { update: { ...pendingUpdate, install: { desktop: true } }, onOpen: noop, compact: true })),
    render(h(m.UpdateChip, { update: stuckUpdate, onOpen: noop })),
  ];
  for (const html of renderedZhSurfaces) {
    assert.doesNotMatch(stripTags(html), /必须/);
  }
  for (const manual of [false, true]) {
    for (const errUpdate of [
      { error: 'network' },
      { error: 'rate-limited' },
      { error: 'rate-limited', retryAt: '2026-11-20T01:00:00Z' },
      { error: 'http-503' },
      { error: 'invalid' },
    ]) {
      const msg = m.updateErrorText(errUpdate, { manual });
      assert.ok(msg.length > 0);
      assert.doesNotMatch(msg, /必须/);
    }
  }
  for (const [code, extra] of [
    ['UPDATE_STALE', {}],
    ['UPDATE_NO_INSTALLER', {}],
    ['UPDATE_UNAVAILABLE', {}],
    ['UPDATE_DOWNLOAD', {}],
    ['UPDATE_DOWNLOAD', { detail: 'timeout' }],
    ['UPDATE_DOWNLOAD', { savedBytes: 512 }],
    ['UPDATE_DOWNLOAD', { detail: 'timeout', savedBytes: 512 }],
    ['UPDATE_DOWNLOAD', { detail: 'http', httpStatus: 502 }],
    ['UPDATE_CHECKSUM', {}],
    ['UPDATE_INSTALL', {}],
    ['UNKNOWN', {}],
  ]) {
    const msg = m.failureMessage(code, extra);
    assert.ok(msg.length > 0);
    assert.doesNotMatch(msg, /必须/);
  }

  for (const node of [
    withHost(DESKTOP_HOST, h(m.UpdateSettings, { update: sampleUpdate, diagnostic: () => 'diag' })),
    withHost(DSH_HOST, h(m.UpdateSettings, { update: sampleUpdate, diagnostic: () => 'diag' })),
    withHost(DSH_HOST, h(m.UpdateDialog, { update: sampleUpdate, onClose: noop })),
    h(m.DesktopUpgradeGuide, { update: sampleUpdate }),
  ]) {
    assert.doesNotMatch(stripTags(render(node, 'en')), han);
  }
});

test('UsageSettings clarifies main switch vs temporary pause and avoids engineering term 控件 in zh & en', () => {
  const privacyZh = m.usagePrivacyPoints().join('\n');
  assert.doesNotMatch(privacyZh, /控件/);
  assert.match(privacyZh, /功能与操作/);

  const baseProps = {
    status: { enabled: true, paused: false, hasData: false, daysWithData: 0, since: '', file: 'usage-frequency.json', limits: {} },
    report: null, period: 30, onSwitch: noop, onPause: noop, onPeriod: noop, onExport: noop, onCopy: noop, onAskClear: noop, onCancelClear: noop, onClear: noop,
  };
  const activeZh = render(withHost(DESKTOP_HOST, h(m.UsageSettingsView, baseProps)));
  assert.doesNotMatch(activeZh, /控件/);
  assert.match(activeZh, /临时不想记录/);
  assert.match(activeZh, /彻底关闭后不再记录/);

  const pausedZh = render(withHost(DESKTOP_HOST, h(m.UsageSettingsView, { ...baseProps, status: { ...baseProps.status, paused: true } })));
  assert.match(pausedZh, /当前为临时暂停状态/);

  for (const paused of [false, true]) {
    const en = render(withHost(DESKTOP_HOST, h(m.UsageSettingsView, { ...baseProps, status: { ...baseProps.status, paused } })), 'en');
    assert.doesNotMatch(stripTags(en), han);
  }
});

test('ExperimentalSettings & JevSettings preview Jev, place master switch above sub-switches, collapse caveats/dev tools, and remove 插件/DSH leaks', () => {
  const expZh = render(withHost(DESKTOP_HOST, h(m.ExperimentalSection, { enabled: false, onChange: noop })));
  assert.match(expZh, /目前包含：Jev 第三方判断服务（需另配密钥，普通学习无需开启）/);
  assert.doesNotMatch(stripTags(render(withHost(DESKTOP_HOST, h(m.ExperimentalSection, { enabled: false, onChange: noop })), 'en')), han);

  const settings = {
    provider: 'opencode-zen-free',
    providers: [{ id: 'opencode-zen-free', model: 'jev-1.13-free', host: 'opencode.ai', family: 'opencode', defaultKeyEnv: 'OPENCODE_GO_API_KEY_2' }],
    key: { set: false, hint: '', source: '', envName: 'OPENCODE_GO_API_KEY_2', envFound: false },
    confirmed: true, confirmedAt: '2026-11-20T00:00:00Z', enabled: false,
    features: { courseSuggest: false, preReview: false, outlineNoise: false, levelCheck: false },
    replace: { cardReview: false, courseOrganize: false }, threshold: 0.8,
    privacyUrl: 'https://opencode.ai/docs/zen/', docsUrl: 'https://opencode.ai/docs/zen/', settingsFile: 'C:\\Users\\a\\.studyhub\\jev.json',
  };

  const desktopJev = render(withHost(DESKTOP_HOST, h(m.JevSettings, { initial: { settings, usage: null, failure: null } })));
  assert.doesNotMatch(desktopJev, /本插件|插件进程|DSH 主目录|System One/);
  assert.match(desktopJev, /普通学习完全不需要开启/);
  assert.match(desktopJev, /Jev 主要针对英文优化，对中文支持较弱/);
  assert.match(desktopJev, /这台电脑的配置目录/);
  assert.match(desktopJev, /StudyHub 桌面版可能没有读到这个环境变量/);
  // Master switch above both replace switches and developer switches
  assert.ok(desktopJev.indexOf('jev-switches__master') < desktopJev.indexOf('jev-replace'), 'master switch appears above JevReplaceList');
  assert.ok(desktopJev.indexOf('jev-switches__master') < desktopJev.indexOf('jev-dev-tools'), 'master switch appears above developer disclosure');
  // Provider caveat wall and developer items are tucked inside collapsed disclosures
  assert.match(desktopJev, /<details[^>]*class="[^"]*jev-provider-notes[^"]*"(?![^>]*\bopen\b)/);
  assert.match(desktopJev, /<details[^>]*class="[^"]*jev-dev-tools[^"]*"(?![^>]*\bopen\b)/);
  assert.ok(desktopJev.indexOf('jev-dev-tools') < desktopJev.indexOf('data-feature="outlineNoise"'));
  assert.ok(desktopJev.indexOf('jev-dev-tools') < desktopJev.indexOf('data-feature="levelCheck"'));
  assert.ok(desktopJev.indexOf('jev-dev-tools') < desktopJev.indexOf('node scripts/eval-jev.mjs'));

  assert.match(m.keySourceText(settings, { isDesktop: true }).note, /StudyHub 桌面版/);
  assert.doesNotMatch(m.keySourceText(settings, { isDesktop: false }).note, /插件/);

  for (const host of [DESKTOP_HOST, DSH_HOST]) {
    const en = render(withHost(host, h(m.JevSettings, { initial: { settings, usage: null, failure: null } })), 'en');
    assert.doesNotMatch(stripTags(en).replace(/C:\\Users[^ ]*/g, ''), han);
  }
});
