/* WP15 · update check: one GET to the GitHub "latest release" endpoint, cached in
   the DSH study home for 12 h, silent on failure, and nothing at all when the
   learner turned automatic checks off. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkForUpdate, setUpdatePreferences, readUpdateView, currentVersion, releaseFromGithub, updateStatePath,
  RELEASES_API_URL, RELEASES_PAGE_URL, CHECK_INTERVAL_MS, FAILURE_RETRY_MS, NOTES_LIMIT } from '../lib/update-check.js';
import { StudyService } from '../lib/service.js';
import { githubRelease, REPO } from './helpers/wp15-release.mjs';

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
function github(reply) {
  const calls = [];
  const fetch = async (url, init = {}) => { calls.push({ url: String(url), init }); return reply(calls.length); };
  return { fetch, calls };
}
async function home(t) {
  const dir = await mkdtemp(join(tmpdir(), 'wp15-update-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = dir;
  t.after(async () => { if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous; await rm(dir, { recursive: true, force: true }); });
  return dir;
}
const T0 = Date.parse('2026-10-06T00:00:00Z');

test('the running version comes from package.json', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(currentVersion(), pkg.version);
});

test('a newer GitHub release is reported with its notes, page, package and checksum addresses', async t => {
  const dir = await home(t);
  const net = github(() => json(githubRelease('v2.1.1', { body: 'x'.repeat(5000) })));
  const view = await checkForUpdate({ fetch: net.fetch, now: () => T0, current: '2.1.0' });
  assert.equal(net.calls.length, 1);
  assert.equal(net.calls[0].url, RELEASES_API_URL);
  assert.equal(RELEASES_API_URL, 'https://api.github.com/repos/EricWang1358/dsh-web-studyhub/releases/latest');
  const headers = new Headers(net.calls[0].init.headers);
  assert.match(headers.get('user-agent'), /^StudyHub-update-check\/2\.1\.0/, 'GitHub requires a User-Agent');
  assert.match(headers.get('accept'), /github/);
  assert.equal(net.calls[0].init.method ?? 'GET', 'GET');
  assert.equal(net.calls[0].init.body, undefined, 'nothing is sent besides the GET');
  assert.ok(net.calls[0].init.signal, 'the request has a timeout');
  assert.equal(view.current, '2.1.0');
  assert.equal(view.latest, '2.1.1');
  assert.equal(view.newer, true);
  assert.equal(view.publishedAt, '2026-10-05T08:00:00Z');
  assert.equal(view.url, `${REPO}/releases/tag/v2.1.1`);
  assert.equal(view.assetUrl, `${REPO}/releases/download/v2.1.1/ericwang1358-dsh-daily-flashcard-2.1.1.tgz`);
  assert.equal(view.assetName, 'ericwang1358-dsh-daily-flashcard-2.1.1.tgz');
  assert.equal(view.sha256Url, `${REPO}/releases/download/v2.1.1/SHA256SUMS-2.1.1.txt`);
  assert.equal(view.notes.length, NOTES_LIMIT);
  assert.equal(view.checkedAt, new Date(T0).toISOString());
  assert.equal(view.error, undefined);
  assert.equal(view.autoCheck, true);
  const saved = JSON.parse(await readFile(join(dir, 'study', 'update.json'), 'utf8'));
  assert.equal(updateStatePath(), join(dir, 'study', 'update.json'));
  assert.equal(saved.release.latest, '2.1.1');
});

test('the same or an older release is not newer', async t => {
  await home(t);
  const same = await checkForUpdate({ fetch: github(() => json(githubRelease('v2.1.0'))).fetch, now: () => T0, current: '2.1.0' });
  assert.equal(same.newer, false);
  assert.equal(same.latest, '2.1.0');
  const older = await checkForUpdate({ force: true, fetch: github(() => json(githubRelease('v2.0.3'))).fetch, now: () => T0, current: '2.1.0' });
  assert.equal(older.newer, false);
  assert.equal(older.latest, '2.0.3');
});

test('drafts and pre-releases are ignored; a pre-release build of this plugin sees the final release as newer', async t => {
  await home(t);
  for (const flag of [{ prerelease: true }, { draft: true }]) {
    const view = await checkForUpdate({ force: true, fetch: github(() => json(githubRelease('v2.2.0-beta.1', flag))).fetch, now: () => T0, current: '2.1.0' });
    assert.equal(view.newer, false, JSON.stringify(flag));
    assert.equal(view.latest, null);
  }
  assert.equal(releaseFromGithub(githubRelease('v2.2.0', { prerelease: true })), null);
  const view = await checkForUpdate({ force: true, fetch: github(() => json(githubRelease('v2.1.0'))).fetch, now: () => T0, current: '2.1.0-rc.1' });
  assert.equal(view.newer, true);
});

test('only release-page addresses of this repository are accepted for the package and the checksum file', () => {
  const foreign = githubRelease('v2.1.1');
  foreign.assets[0].browser_download_url = 'https://evil.example/ericwang1358-dsh-daily-flashcard-2.1.1.tgz';
  foreign.assets[1].browser_download_url = 'http://github.com/EricWang1358/dsh-web-studyhub/releases/download/v2.1.1/SHA256SUMS-2.1.1.txt';
  const release = releaseFromGithub(foreign);
  assert.equal(release.latest, '2.1.1');
  assert.equal(release.assetUrl, null);
  assert.equal(release.sha256Url, null);
  const page = releaseFromGithub({ ...githubRelease('v2.1.1'), html_url: 'https://evil.example/x' });
  assert.equal(page.url, RELEASES_PAGE_URL);
  assert.equal(releaseFromGithub({ tag_name: 'nightly' }), null);
});

test('network errors and GitHub rate limits are cached briefly, never thrown, and keep the last good answer', async t => {
  await home(t);
  const good = await checkForUpdate({ fetch: github(() => json(githubRelease('v2.1.1'))).fetch, now: () => T0, current: '2.1.0' });
  assert.equal(good.newer, true);
  const offline = github(() => { throw new TypeError('fetch failed'); });
  const failed = await checkForUpdate({ force: true, fetch: offline.fetch, now: () => T0 + 1000, current: '2.1.0' });
  assert.equal(failed.error, 'network');
  assert.equal(failed.newer, true, 'the last good release is still offered');
  assert.equal(failed.latest, '2.1.1');
  // Inside the short failure window nothing is asked again.
  const quiet = github(() => json(githubRelease('v2.1.2')));
  await checkForUpdate({ fetch: quiet.fetch, now: () => T0 + 1000 + FAILURE_RETRY_MS - 1, current: '2.1.0' });
  assert.equal(quiet.calls.length, 0);
  const retried = await checkForUpdate({ fetch: quiet.fetch, now: () => T0 + 1000 + FAILURE_RETRY_MS, current: '2.1.0' });
  assert.equal(quiet.calls.length, 1, 'retried after the failure window');
  assert.equal(retried.latest, '2.1.2');
  assert.equal(retried.error, undefined);

  const limited = github(() => json({ message: 'API rate limit exceeded' }, 403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor((T0 + 3 * 3600e3) / 1000)) }));
  const rate = await checkForUpdate({ force: true, fetch: limited.fetch, now: () => T0 + 2 * FAILURE_RETRY_MS, current: '2.1.0' });
  assert.equal(rate.error, 'rate-limited');
  assert.equal(rate.latest, '2.1.2');
  const waiting = github(() => json(githubRelease('v2.1.3')));
  await checkForUpdate({ fetch: waiting.fetch, now: () => T0 + 3 * 3600e3 - 1, current: '2.1.0' });
  assert.equal(waiting.calls.length, 0, 'waits for the rate-limit reset');

  for (const reply of [() => json({ message: 'Not Found' }, 404), () => new Response('<html>', { status: 200 }), () => json({ tag_name: 'nightly' })]) {
    const view = await checkForUpdate({ force: true, fetch: github(reply).fetch, now: () => T0, current: '2.1.0' });
    assert.ok(['http-404', 'invalid'].includes(view.error), view.error);
  }
});

test('one request per check window across concurrent callers; force asks again', async t => {
  await home(t);
  let release;
  const net = github(async () => { await new Promise(done => setTimeout(done, 20)); return json(githubRelease(release)); });
  release = 'v2.1.1';
  const [a, b, c] = await Promise.all([1, 2, 3].map(() => checkForUpdate({ fetch: net.fetch, now: () => T0, current: '2.1.0' })));
  assert.equal(net.calls.length, 1, 'concurrent sessions share one request');
  assert.deepEqual([a.latest, b.latest, c.latest], ['2.1.1', '2.1.1', '2.1.1']);
  release = 'v2.1.2';
  assert.equal((await checkForUpdate({ fetch: net.fetch, now: () => T0 + CHECK_INTERVAL_MS - 1, current: '2.1.0' })).latest, '2.1.1');
  assert.equal(net.calls.length, 1, 'cached inside the window');
  assert.equal((await checkForUpdate({ force: true, fetch: net.fetch, now: () => T0 + 5, current: '2.1.0' })).latest, '2.1.2');
  assert.equal(net.calls.length, 2, 'force bypasses the cache');
  assert.equal((await checkForUpdate({ fetch: net.fetch, now: () => T0 + 5 + CHECK_INTERVAL_MS, current: '2.1.0' })).latest, '2.1.2');
  assert.equal(net.calls.length, 3, 'asked again once the window has passed');
});

test('with automatic checks off nothing is fetched unless the learner asks', async t => {
  await home(t);
  const net = github(() => json(githubRelease('v2.1.1')));
  const off = await setUpdatePreferences({ autoCheck: false }, { current: '2.1.0' });
  assert.equal(off.autoCheck, false);
  const view = await checkForUpdate({ fetch: net.fetch, now: () => T0, current: '2.1.0' });
  assert.equal(net.calls.length, 0);
  assert.equal(view.autoCheck, false);
  assert.equal(view.newer, false);
  const manual = await checkForUpdate({ force: true, fetch: net.fetch, now: () => T0, current: '2.1.0' });
  assert.equal(net.calls.length, 1, '检查更新 still works');
  assert.equal(manual.newer, true);
  assert.equal((await setUpdatePreferences({ autoCheck: true }, { current: '2.1.0' })).autoCheck, true);
});

test('稍后提醒 is remembered per version and an installed update waits for a restart', async t => {
  await home(t);
  await checkForUpdate({ fetch: github(() => json(githubRelease('v2.1.1'))).fetch, now: () => T0, current: '2.1.0' });
  const snoozed = await setUpdatePreferences({ snooze: '2.1.1' }, { current: '2.1.0' });
  assert.equal(snoozed.snoozed, true);
  assert.equal((await readUpdateView({ current: '2.1.0' })).snoozed, true);
  const next = await checkForUpdate({ force: true, fetch: github(() => json(githubRelease('v2.1.2'))).fetch, now: () => T0, current: '2.1.0' });
  assert.equal(next.snoozed, false, 'a later version is offered again');
  await assert.rejects(setUpdatePreferences({ snooze: 'soon' }), /version/);
  await assert.rejects(setUpdatePreferences({ autoCheck: 'yes' }), /autoCheck/);
});

test('a broken cache file is ignored, and update.check / update.preferences are library-independent study actions', async t => {
  const dir = await home(t);
  await mkdir(join(dir, 'study'), { recursive: true });
  await writeFile(join(dir, 'study', 'update.json'), '{not json');
  const library = await mkdtemp(join(tmpdir(), 'wp15-library-'));
  t.after(() => rm(library, { recursive: true, force: true }));
  const net = github(() => json(githubRelease('v9.9.9')));
  const service = new StudyService(library, { fetch: net.fetch });
  const view = await service.call('update.check', {});
  assert.equal(net.calls.length, 1);
  assert.equal(view.latest, '9.9.9');
  assert.equal(view.newer, true);
  assert.equal(view.current, currentVersion());
  assert.equal((await service.call('update.preferences', { autoCheck: false })).autoCheck, false);
  assert.equal((await service.call('update.check', {})).autoCheck, false);
  assert.equal(net.calls.length, 1);
});

test('package files on disk newer than the running code mean a restart is pending, however they got there', async () => {
  const { updateView, installedVersion } = await import('../lib/update-check.js');
  assert.equal(installedVersion(), currentVersion(), 'read fresh from this package on disk');
  assert.equal(updateView({}, '2.1.0', '2.1.1-test').pendingRestart, '2.1.1-test');
  assert.equal(updateView({}, '2.1.0', '2.1.0').pendingRestart, null);
  assert.equal(updateView({ pending: '2.1.1' }, '2.1.0', '2.1.0').pendingRestart, '2.1.1');
  assert.equal(updateView({}, '2.1.1', '2.1.0').pendingRestart, null);
});

test('a pending restart separates running, installed and available versions without reinstalling the same release', async () => {
  const { updateView } = await import('../lib/update-check.js');
  const state = { pending: '2.5.10', release: releaseFromGithub(githubRelease('v2.5.11')) };
  const next = updateView(state, '2.5.8', '2.5.10');
  assert.equal(next.current, '2.5.8');
  assert.equal(next.installed, '2.5.10');
  assert.equal(next.latest, '2.5.11');
  assert.equal(next.pendingRestart, '2.5.10');
  assert.equal(next.upgradeAvailable, true);
  for (const latest of ['2.5.9', '2.5.10']) {
    const waiting = updateView({ ...state, release: releaseFromGithub(githubRelease('v' + latest)) }, '2.5.8', '2.5.10');
    assert.equal(waiting.newer, true, 'newer still compares the release with running code');
    assert.equal(waiting.upgradeAvailable, false, 'already installed or older releases cannot be installed again');
  }
  const remembered = updateView(state, '2.5.8', '2.5.8');
  assert.equal(remembered.installed, '2.5.10', 'a recorded install survives the old package path');
  const replaced = updateView(state, '2.5.8', '2.5.11');
  assert.equal(replaced.installed, '2.5.11');
  assert.equal(replaced.upgradeAvailable, false);
  const restarted = updateView(state, '2.5.11', '2.5.11');
  assert.equal(restarted.pendingRestart, null);
  assert.equal(restarted.installed, '2.5.11');
  assert.equal(restarted.upgradeAvailable, false);
});

test('a loopback QA feed (STUDYHUB_QA_UPDATE_FEED) may stand in for GitHub; any other address is ignored', async t => {
  await home(t);
  const previous = process.env.STUDYHUB_QA_UPDATE_FEED;
  t.after(() => { if (previous === undefined) delete process.env.STUDYHUB_QA_UPDATE_FEED; else process.env.STUDYHUB_QA_UPDATE_FEED = previous; });
  const local = 'http://127.0.0.1:3222';
  const localRelease = { ...githubRelease('v2.1.1'), html_url: `${local}/EricWang1358/dsh-web-studyhub/releases/tag/v2.1.1`,
    assets: githubRelease('v2.1.1').assets.map(asset => ({ ...asset, browser_download_url: asset.browser_download_url.replace('https://github.com', local) })) };
  process.env.STUDYHUB_QA_UPDATE_FEED = local;
  const net = github(() => json(localRelease));
  const view = await checkForUpdate({ force: true, fetch: net.fetch, now: () => T0, current: '2.1.0' });
  assert.equal(net.calls[0].url, `${local}/repos/EricWang1358/dsh-web-studyhub/releases/latest`);
  assert.equal(view.assetUrl, `${local}/EricWang1358/dsh-web-studyhub/releases/download/v2.1.1/ericwang1358-dsh-daily-flashcard-2.1.1.tgz`);
  assert.equal(view.url, localRelease.html_url);
  for (const ignored of ['https://evil.example', 'http://192.168.1.5:3222', 'file:///C:/x', 'not a url']) {
    process.env.STUDYHUB_QA_UPDATE_FEED = ignored;
    const other = github(() => json(githubRelease('v2.1.1')));
    const result = await checkForUpdate({ force: true, fetch: other.fetch, now: () => T0, current: '2.1.0' });
    assert.equal(other.calls[0].url, RELEASES_API_URL, ignored);
    assert.equal(result.assetUrl, `${REPO}/releases/download/v2.1.1/ericwang1358-dsh-daily-flashcard-2.1.1.tgz`);
  }
});
