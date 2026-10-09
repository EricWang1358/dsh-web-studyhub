/* The update check falls back to the plain github.com "latest release" redirect when the API is
   rate limited, unreachable or failing, and says honestly why when both routes fail. No real
   network: every fetch is injected. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { checkForUpdate, releaseFromLatestLocation, updateStatePath, RELEASES_API_URL, FAILURE_RETRY_MS, CHECK_INTERVAL_MS } from '../lib/update-check.js';
import { githubRelease, REPO } from './helpers/wp15-release.mjs';

const REPO_NAME = 'EricWang1358/dsh-web-studyhub';
const LATEST_PAGE = `https://github.com/${REPO_NAME}/releases/latest`;
const T0 = Date.parse('2026-10-09T10:00:00Z');
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const redirect = (location, status = 302) => new Response(null, { status, headers: location === null ? {} : { location } });
const limited = reset => json({ message: 'API rate limit exceeded' }, 403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(reset / 1000)) });
function route(handlers) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const handler = String(url) === RELEASES_API_URL || String(url).includes('/repos/') ? handlers.api : handlers.page;
    if (!handler) throw new Error(`unexpected request ${url}`);
    return handler();
  };
  return { fetch, calls };
}
async function home(t) {
  const dir = await mkdtemp(join(tmpdir(), 'update-fallback-'));
  const previous = process.env.DSH_HOME, feed = process.env.STUDYHUB_QA_UPDATE_FEED;
  process.env.DSH_HOME = dir;
  delete process.env.STUDYHUB_QA_UPDATE_FEED;
  t.after(async () => {
    if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous;
    if (feed === undefined) delete process.env.STUDYHUB_QA_UPDATE_FEED; else process.env.STUDYHUB_QA_UPDATE_FEED = feed;
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

test('the real redirect target becomes the same release record the API path builds', () => {
  const release = releaseFromLatestLocation(`${REPO}/releases/tag/v3.2.0`);
  assert.deepEqual(release, {
    latest: '3.2.0', publishedAt: null, notes: '', url: `${REPO}/releases/tag/v3.2.0`,
    assetName: 'ericwang1358-dsh-daily-flashcard-3.2.0.tgz',
    assetUrl: `${REPO}/releases/download/v3.2.0/ericwang1358-dsh-daily-flashcard-3.2.0.tgz`,
    sha256Url: `${REPO}/releases/download/v3.2.0/SHA256SUMS-3.2.0.txt` });
  assert.equal(releaseFromLatestLocation(`/${REPO_NAME}/releases/tag/v3.2.0`)?.latest, '3.2.0', 'a relative Location resolves against the request');
  assert.equal(releaseFromLatestLocation(`${REPO}/releases/tag/v99.0.0-rc.1`)?.latest, '99.0.0-rc.1');
});

test('any other redirect target is refused', () => {
  const bad = [
    null, undefined, '', 'not a url',
    `https://evil.example/${REPO_NAME}/releases/tag/v3.2.0`,
    `http://github.com/${REPO_NAME}/releases/tag/v3.2.0`,
    `https://github.com.evil.example/${REPO_NAME}/releases/tag/v3.2.0`,
    `https://user@github.com/${REPO_NAME}/releases/tag/v3.2.0`,
    `https://github.com/Other/repo/releases/tag/v3.2.0`,
    `${REPO}/releases/download/v3.2.0/x.tgz`,
    `${REPO}/releases`,
    `${REPO}/releases/tag/`,
    `${REPO}/releases/tag/nightly`,
    `${REPO}/releases/tag/3.2.0`,
    `${REPO}/releases/tag/v3.2`,
    `${REPO}/releases/tag/v3.2.0/extra`,
    `${REPO}/releases/tag/v3.2.0?x=1`,
    `${REPO}/releases/tag/v3.2.0#x`,
    `${REPO}/releases/tag/v3.2.0%2F..%2Fx`,
    `${REPO}/releases/tag/v3.2.0+build`,
    `${REPO}/releases/tag/v1.0.0/../../../../x`,
  ];
  for (const location of bad) assert.equal(releaseFromLatestLocation(location), null, String(location));
});

test('the QA feed override moves the fallback request and the release addresses to the loopback origin', () => {
  const previous = process.env.STUDYHUB_QA_UPDATE_FEED;
  try {
    process.env.STUDYHUB_QA_UPDATE_FEED = 'http://127.0.0.1:3222';
    const local = releaseFromLatestLocation(`http://127.0.0.1:3222/${REPO_NAME}/releases/tag/v9.9.9`);
    assert.equal(local.assetUrl, `http://127.0.0.1:3222/${REPO_NAME}/releases/download/v9.9.9/ericwang1358-dsh-daily-flashcard-9.9.9.tgz`);
    assert.equal(local.url, `http://127.0.0.1:3222/${REPO_NAME}/releases/tag/v9.9.9`);
    assert.equal(releaseFromLatestLocation(`${REPO}/releases/tag/v9.9.9`), null, 'github.com is not the feed while the override is set');
  } finally { if (previous === undefined) delete process.env.STUDYHUB_QA_UPDATE_FEED; else process.env.STUDYHUB_QA_UPDATE_FEED = previous; }
});

test('API rate limited, redirect answers: the release is found, no error is recorded, and the state says where it came from', async t => {
  await home(t);
  const reset = T0 + 30 * 60e3;
  const net = route({ api: () => limited(reset), page: () => redirect(`${REPO}/releases/tag/v99.0.0`) });
  const view = await checkForUpdate({ force: true, fetch: net.fetch, now: () => T0, current: '3.1.0' });
  assert.equal(view.error, undefined);
  assert.equal(view.latest, '99.0.0');
  assert.equal(view.newer, true);
  assert.equal(view.upgradeAvailable, true);
  assert.equal(view.notes, '');
  assert.equal(view.publishedAt, null);
  assert.equal(view.source, 'fallback');
  assert.equal(view.url, `${REPO}/releases/tag/v99.0.0`);
  assert.equal(view.assetUrl, `${REPO}/releases/download/v99.0.0/ericwang1358-dsh-daily-flashcard-99.0.0.tgz`);
  assert.equal(view.sha256Url, `${REPO}/releases/download/v99.0.0/SHA256SUMS-99.0.0.txt`);
  assert.deepEqual(net.calls.map(call => call.url), [RELEASES_API_URL, LATEST_PAGE]);
  const second = net.calls[1].init;
  assert.equal(second.redirect, 'manual');
  assert.equal(second.method, 'GET');
  assert.equal(second.body, undefined);
  assert.ok(second.signal, 'the fallback request has the same timeout');
  assert.match(new Headers(second.headers).get('user-agent'), /^StudyHub-update-check\/3\.1\.0/);
  const saved = JSON.parse(await readFile(updateStatePath(), 'utf8'));
  assert.equal(saved.error, undefined);
  assert.equal(saved.source, 'fallback');
  assert.equal(saved.nextCheckAt, T0 + CHECK_INTERVAL_MS, 'a success waits the normal window');
});

test('API answers: the fallback is not asked and the source is the API', async t => {
  await home(t);
  const net = route({ api: () => json(githubRelease('v3.2.0')) });
  const view = await checkForUpdate({ force: true, fetch: net.fetch, now: () => T0, current: '3.1.0' });
  assert.equal(net.calls.length, 1);
  assert.equal(view.source, 'api');
  assert.equal(view.notes.length > 0, true);
});

test('API rate limited and the fallback fails: the original error and the same retry time are kept', async t => {
  const reset = T0 + 30 * 60e3;
  const retryOf = async fetch => {
    await home(t);
    const view = await checkForUpdate({ force: true, fetch, now: () => T0, current: '3.1.0' });
    return view;
  };
  const baseline = await retryOf(route({ api: () => limited(reset) }).fetch.bind(null));
  assert.equal(baseline.error, 'rate-limited');
  const failures = {
    'network error': () => { throw new TypeError('fetch failed'); },
    'no redirect': () => new Response('<html>', { status: 200 }),
    'server error': () => new Response('x', { status: 503 }),
    'missing Location': () => redirect(null),
    'foreign Location': () => redirect('https://evil.example/EricWang1358/dsh-web-studyhub/releases/tag/v9.9.9'),
    'non-semver tag': () => redirect(`${REPO}/releases/tag/nightly`),
  };
  for (const [name, page] of Object.entries(failures)) {
    const net = route({ api: () => limited(reset), page });
    const view = await retryOf(net.fetch);
    assert.equal(view.error, 'rate-limited', name);
    assert.equal(view.retryAt, baseline.retryAt, name);
    assert.equal(view.latest, null, name);
    assert.equal(net.calls.length, 2, name);
  }
  assert.equal(baseline.retryAt, T0 + Math.max(30 * 60e3, FAILURE_RETRY_MS), 'a reset sooner than the failure window waits that window');
});

test('a network error or a server error on the API also tries the fallback; a 404 or a bad body does not', async t => {
  for (const [name, api] of [['network', () => { throw new TypeError('fetch failed'); }], ['http-503', () => new Response('x', { status: 503 })],
    ['http-403', () => json({ message: 'forbidden' }, 403)], ['http-429', () => json({}, 429)]]) {
    await home(t);
    const net = route({ api, page: () => redirect(`${REPO}/releases/tag/v3.2.0`, 301) });
    const view = await checkForUpdate({ force: true, fetch: net.fetch, now: () => T0, current: '3.1.0' });
    assert.equal(view.latest, '3.2.0', name);
    assert.equal(view.error, undefined, name);
    assert.equal(net.calls.length, 2, name);
  }
  for (const [name, api, error] of [['404', () => json({ message: 'Not Found' }, 404), 'http-404'], ['invalid', () => new Response('<html>', { status: 200 }), 'invalid']]) {
    await home(t);
    const net = route({ api });
    const view = await checkForUpdate({ force: true, fetch: net.fetch, now: () => T0, current: '3.1.0' });
    assert.equal(view.error, error, name);
    assert.equal(net.calls.length, 1, name);
  }
});

test('a fallback release equal to the running version is not an upgrade', async t => {
  await home(t);
  const net = route({ api: () => { throw new TypeError('fetch failed'); }, page: () => redirect(`${REPO}/releases/tag/v3.2.0`) });
  const view = await checkForUpdate({ force: true, fetch: net.fetch, now: () => T0, current: '3.2.0' });
  assert.equal(view.latest, '3.2.0');
  assert.equal(view.newer, false);
  assert.equal(view.upgradeAvailable, false);
});

test('the QA feed override: the fallback asks the loopback origin, never github.com', async t => {
  await home(t);
  process.env.STUDYHUB_QA_UPDATE_FEED = 'http://127.0.0.1:3222';
  const net = route({ api: () => new Response('x', { status: 503 }), page: () => redirect(`http://127.0.0.1:3222/${REPO_NAME}/releases/tag/v9.9.9`) });
  const view = await checkForUpdate({ force: true, fetch: net.fetch, now: () => T0, current: '3.1.0' });
  assert.deepEqual(net.calls.map(call => call.url), [`http://127.0.0.1:3222/repos/${REPO_NAME}/releases/latest`, `http://127.0.0.1:3222/${REPO_NAME}/releases/latest`]);
  assert.equal(view.latest, '9.9.9');
  assert.equal(view.assetUrl, `http://127.0.0.1:3222/${REPO_NAME}/releases/download/v9.9.9/ericwang1358-dsh-daily-flashcard-9.9.9.tgz`);
});

/* The words the learner sees. */
const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `
  export * from './ui/UpdateCenter.jsx';
  export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
const { UpdateSettings, UpdateDialog, updateErrorText, setUiLanguage } = module.exports;
const h = React.createElement;
const han = /[㐀-鿿]/;
const render = (element, language = 'zh') => { setUiLanguage(language); try { return renderToStaticMarkup(element); } finally { setUiLanguage('zh'); } };
const text = (update, language = 'zh', options) => { setUiLanguage(language); try { return updateErrorText(update, options); } finally { setUiLanguage('zh'); } };
const base = (extra = {}) => ({ current: '3.1.0', latest: '3.1.0', newer: false, upgradeAvailable: false, notes: '', url: `${REPO}/releases`,
  checkedAt: '2026-10-09T10:00:00.000Z', autoCheck: true, snoozed: false, pendingRestart: null, ...extra });
const clock = ms => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

test('each error code has its own honest sentence, in both languages', () => {
  const retryAt = T0 + 45 * 60e3;
  const limitedZh = text(base({ error: 'rate-limited', retryAt }));
  assert.ok(limitedZh.includes('GitHub 对你所在网络的匿名查询次数用完了（每小时 60 次，很多人共用同一个出口地址时会这样）'), limitedZh);
  assert.ok(limitedZh.includes(`约 ${clock(retryAt)} 恢复`), limitedZh);
  assert.doesNotMatch(limitedZh, /检查网络/, 'a rate limit is not a network problem');
  const limitedEn = text(base({ error: 'rate-limited', retryAt }), 'en');
  assert.match(limitedEn, /60 anonymous requests an hour/);
  assert.ok(limitedEn.includes(clock(retryAt)), limitedEn);
  assert.doesNotMatch(limitedEn, han);
  const unknownTime = text(base({ error: 'rate-limited' }));
  assert.match(unknownTime, /匿名查询次数用完了/);
  assert.doesNotMatch(unknownTime, /约 /);
  assert.doesNotMatch(text(base({ error: 'rate-limited' }), 'en'), han);

  assert.equal(text(base({ error: 'network' }), 'zh', { manual: true }), '暂时无法连接 GitHub 检查更新。请检查网络后重试。');
  assert.equal(text(base({ error: 'network' })), '暂时无法连接 GitHub 检查更新，稍后会自动重试。');
  assert.doesNotMatch(text(base({ error: 'network' }), 'en', { manual: true }), han);

  const http = text(base({ error: 'http-503' }));
  assert.match(http, /503/);
  assert.doesNotMatch(http, /网络/, 'an HTTP status does not blame the network');
  assert.match(text(base({ error: 'http-503' }), 'en'), /503/);
  assert.doesNotMatch(text(base({ error: 'http-503' }), 'en'), han);
  const invalid = text(base({ error: 'invalid' }));
  assert.doesNotMatch(invalid, /网络/);
  assert.doesNotMatch(text(base({ error: 'invalid' }), 'en'), han);
  assert.equal(text(base()), '', 'no error, no sentence');
});

test('the settings page shows the rate-limit sentence with the release-page link; a manual check says the same', () => {
  const retryAt = T0 + 45 * 60e3;
  const auto = render(h(UpdateSettings, { update: base({ error: 'rate-limited', retryAt }), call: async () => ({}), onOpen() {} }));
  assert.match(auto, /匿名查询次数用完了/);
  assert.ok(auto.includes(`约 ${clock(retryAt)} 恢复`));
  assert.ok(auto.includes(`href="${REPO}/releases"`), 'links to the release page');
  assert.match(auto, /查看发布页/);
  assert.doesNotMatch(auto, /已是最新版本/);
  assert.doesNotMatch(auto, /请检查网络/);
  const manual = render(h(UpdateSettings, { update: base({ error: 'rate-limited', retryAt }), call: async () => ({}), onOpen() {}, initialCheckError: 'rate-limited' }));
  assert.match(manual, /没能检查更新/);
  assert.match(manual, /匿名查询次数用完了/);
  assert.doesNotMatch(manual, /请检查网络/);
  const en = render(h(UpdateSettings, { update: base({ error: 'rate-limited', retryAt }), call: async () => ({}), onOpen() {}, initialCheckError: 'rate-limited' }), 'en');
  assert.match(en, /Release page/);
  assert.doesNotMatch(en, han);
  const hostDown = render(h(UpdateSettings, { update: base(), call: async () => ({}), onOpen() {}, initialCheckError: 'Study connection is unavailable' }));
  assert.match(hostDown, /暂时无法连接 GitHub 检查更新。请检查网络后重试。/, 'an unknown failure keeps the old sentence');
});

test('a release found by the fallback has no notes box: the dialog points to the release page instead', () => {
  const fallback = base({ latest: '3.2.0', newer: true, upgradeAvailable: true, source: 'fallback', url: `${REPO}/releases/tag/v3.2.0`,
    assetUrl: `${REPO}/releases/download/v3.2.0/ericwang1358-dsh-daily-flashcard-3.2.0.tgz` });
  const html = render(h(UpdateDialog, { update: fallback, call: async () => ({}), onClose() {} }));
  assert.doesNotMatch(html, /update-notes-wrap/);
  assert.match(html, /这次没能取得更新内容，请点「查看发布页」阅读。/);
  assert.ok(html.includes(`href="${REPO}/releases/tag/v3.2.0"`));
  const en = render(h(UpdateDialog, { update: fallback, call: async () => ({}), onClose() {} }), 'en');
  assert.match(en, /Release page/);
  assert.match(en, /release notes could not be fetched/);
  assert.doesNotMatch(en, han);
  const api =render(h(UpdateDialog, { update: { ...fallback, source: 'api', notes: 'calmer update check' }, call: async () => ({}), onClose() {} }));
  assert.match(api, /update-notes-wrap/);
  assert.doesNotMatch(api, /这次没能取得更新内容/);
});
