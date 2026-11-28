import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { click, loadInteractiveUi, withBrowserGlobals } from './helpers/react-harness.mjs';
import { loadUi } from './helpers/ui-module.mjs';

/* Issue #1765 UI contract:
   1. Settings shows "解析方式：本机（默认）/ 云端（会把文件上传）" with default local, and custom baseUrl + Key when cloud is chosen.
   2. First-use cloud upload is gated by a confirmation dialog showing the destination endpoint; cancel aborts without upload, confirm persists consent and starts cloud import.
   3. Cloud failure cards render a working "改用本机" button that triggers mineru.retry({ jobId, route: 'local' }).
   4. English locale has 0 leaked Han characters across all new cloud states. */

const entry = `
  export { default as MineruSettings } from './ui/MineruSettings.jsx';
  export { default as PdfConversion } from './ui/PdfConversion.jsx';
  export { PdfConvertJobs, PdfDetail, PdfConvertHistory } from './ui/PdfConvertJob.jsx';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { ToastContext } from './ui/components/Feedback.jsx';
  export { setUiLanguage } from './ui/i18n.js';
`;
const ssr = await loadUi(entry);
const ui = await loadInteractiveUi(entry);
const { PdfConversion, PdfConvertJobs, StudyServicesContext, ToastContext } = ui.exports;
const sh = React.createElement;
const h = ui.React.createElement;
const han = /[㐀-鿿]/;

const render = (element, language = 'zh') => {
  ssr.setUiLanguage(language);
  try { return renderToStaticMarkup(element); }
  finally { ssr.setUiLanguage('zh'); }
};

const localMissing = { state: 'not-installed', next: 'install', origin: null };
const localReady = { state: 'ready', next: null, origin: 'search', tier: 'basic', version: '4.0.12', estimates: { basic: 1.6, standard: 2.5 }, windowPages: 50 };
const cloudSettings = (extra = {}) => ({
  mode: 'cloud',
  baseUrl: 'https://parser.example.com/api/v4',
  effectiveBaseUrl: 'https://parser.example.com/api/v4',
  defaultBaseUrl: 'https://mineru.net/api/v4',
  token: { set: true, hint: '••••9876', source: 'file' },
  acknowledged: false,
  acknowledgedAt: '',
  docsUrl: 'https://mineru.net/apiManage/docs',
  settingsFile: '/home/u/.dsh/study/mineru.json',
  ...extra,
});
const localSettings = (extra = {}) => ({
  ...cloudSettings({ mode: 'local', baseUrl: '', effectiveBaseUrl: 'https://mineru.net/api/v4', token: { set: false, hint: '', source: '' } }),
  ...extra,
});
const samplePlan = {
  name: 'Book.pdf',
  pages: 120,
  bytes: 5 * 1024 * 1024,
  windows: [{ index: 1, startPage: 1, endPage: 50, pages: 50 }],
  pieces: [{ index: 1, startPage: 1, endPage: 120, pages: 120, estimatedBytes: 5 * 1024 * 1024, cut: 'whole' }],
};
const sampleFile = { name: 'Book.pdf', size: 5 * 1024 * 1024, path: '/tmp/Book.pdf' };

const noopToast = { show() {}, success() {}, error() {}, info() {}, dismiss() {} };
const wrap = (services, node) => h(StudyServicesContext.Provider, { value: services }, h(ToastContext.Provider, { value: noopToast }, node));

test('MineruSettings labels 解析方式：本机（默认）/ 云端（会把文件上传）, defaults to local, and exposes baseUrl + Key in cloud mode', async () => {
  const localHtml = render(sh(ssr.MineruSettings, { initialLocal: localMissing, initialSettings: localSettings() }));
  assert.match(localHtml, /解析方式/);
  assert.match(localHtml, /本机（默认）/);
  assert.match(localHtml, /云端（会把文件上传）/);
  assert.match(localHtml, /class="mineru-install"/, 'local install card shown by default');

  const cloudHtml = render(sh(ssr.MineruSettings, { initialLocal: localMissing, initialSettings: cloudSettings() }));
  assert.match(cloudHtml, /https:\/\/parser\.example\.com\/api\/v4/);
  assert.match(cloudHtml, /••••9876/);
  assert.match(cloudHtml, /baseUrl|接口地址/);
  assert.match(cloudHtml, /Key|密钥/);
});

test('first-use upload confirmation dialog gates cloud upload: cancel aborts, confirm saves consent and imports', async () => {
  await withBrowserGlobals(async () => {
    const calls = [];
    const started = [];
    const services = {
      call: async (action, args) => {
        calls.push([action, args]);
        if (action === 'mineru.settings.set') return cloudSettings({ acknowledged: true, acknowledgedAt: '2026-11-28T10:00:00Z' });
        if (action === 'mineru.import') return { jobId: 'job-cloud-1', status: 'running', route: 'cloud' };
        return {};
      },
      act: async () => undefined,
      busy: false,
    };

    const mounted = ui.mount(wrap(services, h(PdfConversion, {
      file: sampleFile,
      initialLocal: localMissing,
      initialSettings: cloudSettings({ acknowledged: false }),
      initialPlan: samplePlan,
      onStarted: info => started.push(info),
    })));
    try {
      const startBtn = mounted.find(n => n.type === 'button' && mounted.text(n).includes('开始云端解析'));
      assert.ok(startBtn, 'start cloud conversion button is rendered');
      assert.equal(startBtn.props.disabled, false);

      // 1. Click start -> opens confirmation dialog instead of uploading immediately
      await mounted.act(() => { click(startBtn); });
      assert.equal(calls.filter(([a]) => a === 'mineru.import').length, 0, 'must NOT call mineru.import before confirming');
      assert.match(mounted.text(), /首次使用前确认上传/);
      assert.match(mounted.text(), /parser\.example\.com/, 'dialog clearly displays the destination endpoint');

      // 2. Click cancel -> closes dialog with zero host calls
      const cancelBtn = mounted.find(n => n.type === 'button' && mounted.text(n) === '取消');
      assert.ok(cancelBtn, 'cancel button present in dialog');
      await mounted.act(() => { click(cancelBtn); });
      assert.doesNotMatch(mounted.text(), /首次使用前确认上传/);
      assert.equal(calls.filter(([a]) => a === 'mineru.import' || a === 'mineru.settings.set').length, 0, 'cancel must not upload or persist consent');

      // 3. Click start again, then confirm -> persists acknowledge: true and starts cloud import
      await mounted.act(() => { click(startBtn); });
      const confirmBtn = mounted.find(n => n.type === 'button' && mounted.text(n).includes('确认上传'));
      assert.ok(confirmBtn, 'confirm upload button present');
      await mounted.act(async () => { click(confirmBtn); });
      await mounted.flush(5);

      assert.deepEqual(
        calls.filter(([a]) => a === 'mineru.settings.set' || a === 'mineru.import').map(([a, args]) => [a, args.acknowledge ?? args.route]),
        [['mineru.settings.set', true], ['mineru.import', 'cloud']],
      );
      assert.equal(started.length, 1);
      assert.equal(started[0].route, 'cloud');
    } finally {
      mounted.unmount();
    }
  });
});

test('cloud failure card renders a working "改用本机" button that triggers mineru.retry({ jobId, route: "local" })', async () => {
  await withBrowserGlobals(async () => {
    const calls = [];
    const services = {
      call: async (action, args) => { calls.push([action, args]); return { jobId: args.jobId, route: 'local', status: 'running' }; },
      act: async (action, args) => { calls.push([action, args]); return { jobId: args.jobId, route: 'local', status: 'running' }; },
      busy: false,
    };

    const failedJobs = [
      { id: 'j-auth', type: 'pdf-convert', route: 'cloud', filename: 'AuthFail.pdf', status: 'failed', retryable: true, errorCode: 'invalid-token', stage: 'MinerU 令牌无效', done: 0, total: 50, startedAt: new Date().toISOString() },
      { id: 'j-net', type: 'pdf-convert', route: 'cloud', filename: 'NetFail.pdf', status: 'failed', retryable: true, errorCode: 'network', stage: '连不上 MinerU', done: 10, total: 50, startedAt: new Date().toISOString() },
    ];

    const mounted = ui.mount(wrap(services, h(PdfConvertJobs, {
      jobs: failedJobs,
      act: services.act,
      onOpenSettings() {},
    })));
    try {
      const switchButtons = mounted.findAll(n => n.type === 'button' && mounted.text(n).includes('改用本机'));
      assert.equal(switchButtons.length, 2, 'both auth-failed and network-failed cloud cards offer 改用本机');

      await mounted.act(async () => { click(switchButtons[0]); });
      await mounted.act(async () => { click(switchButtons[1]); });
      await mounted.flush(5);

      assert.deepEqual(calls, [
        ['mineru.retry', { jobId: 'j-auth', route: 'local' }],
        ['mineru.retry', { jobId: 'j-net', route: 'local' }],
      ]);
    } finally {
      mounted.unmount();
    }
  });
});

test('English locale has 0 leaked Han characters across cloud settings, cloud conversion, upload confirmation dialog, and cloud failure cards', () => {
  const failedAuth = { id: 'j-en-1', type: 'pdf-convert', route: 'cloud', filename: 'Book.pdf', status: 'failed', retryable: true, errorCode: 'invalid-token', stage: 'MinerU 令牌无效：请到「设置 › PDF 转换（MinerU）」检查接口地址并重新粘贴有效的密钥。', done: 0, total: 50, env: { kind: 'cloud', endpoint: 'parser.example.com', modelVersion: 'vlm', language: 'ch' }, startedAt: new Date().toISOString() };
  const failedNet = { id: 'j-en-2', type: 'pdf-convert', route: 'cloud', filename: 'Book2.pdf', status: 'failed', retryable: true, errorCode: 'network', stage: '连不上 MinerU：请检查网络或接口地址后重试（已完成的部分会保留）。', done: 20, total: 50, startedAt: new Date().toISOString() };
  const historyRow = { id: 'j-en-2', filename: 'Book2.pdf', bytes: 1024, pages: 50, pieces: 1, route: 'cloud', status: 'failed', phase: 'parse', pagesDone: 20, attempts: 1, elapsedMs: 5000, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), canRetry: true, live: false, env: { kind: 'cloud', endpoint: 'parser.example.com', modelVersion: 'vlm' }, failure: { stage: 'parse', piece: 1, reason: '连不上 MinerU：请检查网络或接口地址后重试（已完成的部分会保留）。', code: 'network' } };
  const elements = [
    sh(ssr.MineruSettings, { initialLocal: localMissing, initialSettings: localSettings() }),
    sh(ssr.MineruSettings, { initialLocal: localReady, initialSettings: cloudSettings() }),
    sh(ssr.MineruSettings, { initialLocal: localReady, initialSettings: cloudSettings({ acknowledged: true, acknowledgedAt: '2026-11-28T10:00:00Z' }) }),
    sh(ssr.PdfConversion, { file: sampleFile, initialLocal: localMissing, initialSettings: cloudSettings({ token: { set: false, hint: '', source: '' } }), initialPlan: samplePlan, onOpenSettings() {} }),
    sh(ssr.PdfConversion, { file: sampleFile, initialLocal: localMissing, initialSettings: cloudSettings({ acknowledged: false }), initialPlan: samplePlan, initialConfirmUpload: true }),
    sh(ssr.PdfConversion, { file: sampleFile, initialLocal: localMissing, initialSettings: cloudSettings({ acknowledged: true }), initialPlan: samplePlan }),
    sh(ssr.PdfConvertJobs, { jobs: [failedAuth, failedNet], onOpenSettings() {} }),
    sh(ssr.PdfDetail, { job: failedAuth }),
    sh(ssr.PdfConvertHistory, { initialRecords: [historyRow], now: Date.now() }),
  ];
  for (const el of elements) {
    const html = render(el, 'en');
    assert.doesNotMatch(html, han, html.slice(0, 300));
  }
});
