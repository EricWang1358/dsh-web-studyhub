/* Update check (shared core, every edition). One GET to GitHub's "latest release"
   endpoint, at most once per 6 h for all sessions of this DSH home, cached in
   <DSH home>/study/update.json next to the audio settings. Nothing else is sent:
   no telemetry, no identifiers. Mainland-China networks often cannot reach
   api.github.com, and anonymous API calls are limited to 60 an hour per address,
   so when the API fails (rate limit, network, server error) one more GET asks
   github.com/<repo>/releases/latest for its redirect to the newest tag page. If
   that fails too, the first failure is cached briefly and returned as a quiet
   `error` code, never thrown. The learner can turn automatic checks off. */
import { readFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isNewerVersion, parseVersion } from './semver.js';
import { NOTES_LIMIT, clampReleaseNotes, selectReleaseNotes } from './release-notes.js';
import { parseStoredJson } from './util.js';
import { withStoreLock } from './store-lock.js';

export const UPDATE_REPOSITORY = 'EricWang1358/dsh-web-studyhub';
export const RELEASES_API_URL = `https://api.github.com/repos/${UPDATE_REPOSITORY}/releases/latest`;
export const RELEASES_PAGE_URL = `https://github.com/${UPDATE_REPOSITORY}/releases`;
/** Only files under this prefix may be downloaded or installed. */
export const RELEASE_DOWNLOAD_PREFIX = `https://github.com/${UPDATE_REPOSITORY}/releases/download/`;
export const PACKAGE_NAME = '@ericwang1358/dsh-daily-flashcard';
/* QA only (scripts/qa/dsh-upgrade.mjs): a loopback http origin standing in for
   api.github.com and the release download host. Any other value is ignored. */
function qaFeed() {
  try {
    const url = new URL(process.env.STUDYHUB_QA_UPDATE_FEED || '');
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ? url.origin : null;
  } catch { return null; }
}
export const releasesApiUrl = () => qaFeed() ? `${qaFeed()}/repos/${UPDATE_REPOSITORY}/releases/latest` : RELEASES_API_URL;
const releasesLatestPageUrl = () => `${releasePagePrefix()}latest`;
export const releaseDownloadPrefix = () => qaFeed() ? `${qaFeed()}/${UPDATE_REPOSITORY}/releases/download/` : RELEASE_DOWNLOAD_PREFIX;
const releasePagePrefix = () => qaFeed() ? `${qaFeed()}/${UPDATE_REPOSITORY}/releases/` : `https://github.com/${UPDATE_REPOSITORY}/releases/`;
// The default while the plugin is changing quickly (2.6.x): a check every 6 hours. It was 12; put it back when releases become rare (docs/release-policy.md).
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const FAILURE_RETRY_MS = 60 * 60 * 1000;
export const REQUEST_TIMEOUT_MS = 8000;
export { NOTES_LIMIT, clampReleaseNotes, selectReleaseNotes };

const studyHome = () => join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'study');
export const updateStatePath = () => join(studyHome(), 'update.json');

const readManifestVersion = () => JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
// Read when this module loads: the code that runs keeps this version until DSH restarts.
const running = readManifestVersion();
/** The version of the plugin code that is running now. */
export const currentVersion = () => running;
// When this process started: a marker written before it means "restart needed" is not yet answered; one written after it, with older code still running, is a restart that did not take effect.
// Worked out once per process and kept on globalThis, so a module evaluated again in the same process (a plugin reload, a suspend that moved the
// clock against the monotonic uptime) still answers with the start it had before.
const START_KEY = Symbol.for('studyhub.processStartedAt');
globalThis[START_KEY] ??= Date.now() - process.uptime() * 1000;
const PROCESS_STARTED_AT = globalThis[START_KEY];
// Two starts this close are the same process (the start is a clock minus a float; an install stores it and a later read compares it).
const SAME_PROCESS_MS = 5000;
/** The version installed on disk now (DSH's plugin manager or a reinstall may have replaced the files). */
export function installedVersion() {
  try { return readManifestVersion(); } catch { return running; }
}

const releaseFile = (url, name) => typeof url === 'string' && url.startsWith(releaseDownloadPrefix()) && !url.includes('..')
  && url.endsWith(`/${name}`) ? url : null;
const assetUrl = (assets, name) => releaseFile(assets.find(asset => asset?.name === name)?.browser_download_url, name);

/** The fields StudyHub uses from one GitHub release; null for drafts, pre-releases and unusable answers. */
export function releaseFromGithub(release) {
  if (!release || typeof release !== 'object' || release.draft === true || release.prerelease === true) return null;
  const parsed = parseVersion(release.tag_name);
  if (!parsed) return null;
  const latest = parsed.text, assets = Array.isArray(release.assets) ? release.assets : [];
  const assetName = `ericwang1358-dsh-daily-flashcard-${latest}.tgz`;
  const page = typeof release.html_url === 'string' && release.html_url.startsWith(releasePagePrefix()) ? release.html_url : RELEASES_PAGE_URL;
  return { latest, publishedAt: typeof release.published_at === 'string' ? release.published_at : null,
    notes: clampReleaseNotes(release.body, NOTES_LIMIT), url: page,
    assetName, assetUrl: assetUrl(assets, assetName), sha256Url: assetUrl(assets, `SHA256SUMS-${latest}.txt`) };
}

/**
 * The release a `releases/latest` redirect points at, in the shape releaseFromGithub returns (no notes, no
 * date: the redirect carries only the tag). Only this repository's tag page is accepted, and the tag must be
 * exactly v<semver>; the package and checksum addresses are the standard ones under the download prefix, which
 * the installer still downloads and checks against SHA256SUMS. Anything else is null.
 */
export function releaseFromLatestLocation(location) {
  if (typeof location !== 'string' || !location) return null;
  let url;
  try { url = new URL(location, releasesLatestPageUrl()); } catch { return null; }
  const tagPrefix = `${releasePagePrefix()}tag/`;
  if (url.username || url.password || url.search || url.hash || !`${url.origin}${url.pathname}`.startsWith(tagPrefix)) return null;
  const tag = `${url.origin}${url.pathname}`.slice(tagPrefix.length), parsed = parseVersion(tag);
  if (!parsed || tag !== `v${parsed.text}`) return null;
  const latest = parsed.text, assetName = `ericwang1358-dsh-daily-flashcard-${latest}.tgz`, base = `${releaseDownloadPrefix()}v${latest}/`;
  return { latest, publishedAt: null, notes: '', url: `${tagPrefix}${tag}`,
    assetName, assetUrl: releaseFile(`${base}${assetName}`, assetName), sha256Url: releaseFile(`${base}SHA256SUMS-${latest}.txt`, `SHA256SUMS-${latest}.txt`) };
}

async function readState() {
  try {
    const value = parseStoredJson(await readFile(updateStatePath(), 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}
async function writeState(state) {
  const path = updateStatePath(), temporary = `${path}.${randomUUID()}.tmp`;
  await mkdir(studyHome(), { recursive: true });
  await writeFile(temporary, JSON.stringify(state, null, 2) + '\n');
  await rename(temporary, path);
}

const restartConfirmed = (state, current) => !!parseVersion(state.pending) && !!parseVersion(current)
  && !isNewerVersion(state.pending, current);

// Confirmation and install/preference writes share the existing file lock: consuming an old
// marker must never overwrite a newer install receipt while another session is updating.
async function updateState(change, current) {
  return withStoreLock(studyHome(), async () => {
    const state = await readState();
    if (restartConfirmed(state, current)) delete state.pending;
    change?.(state);
    await writeState(state);
    return state;
  });
}
async function readConfirmedState(current) {
  const state = await readState();
  return restartConfirmed(state, current) ? updateState(null, current) : state;
}

/** The address of the package of one release, from the fixed release prefix and the standard asset name only (null unless `version` is a version). Copy text: nothing is installed from it by the plugin. */
function packageAddress(version) {
  const text = parseVersion(version)?.text;
  if (!text) return null;
  const name = `ericwang1358-dsh-daily-flashcard-${text}.tgz`;
  return releaseFile(`${releaseDownloadPrefix()}v${text}/${name}`, name);
}

/**
 * A restart that did not take effect: the marker names a version newer than the running code, was written at a known time, and THIS process
 * started after that time. Only the process start decides it. The files on disk say nothing before a restart: DSH's plugin manager installs through
 * pnpm, and right after a successful install this module's own ../package.json may still be the old version directory. No stamp, or one that is not
 * a time (an older file): not called failed. The marker is left alone: another copy under the same DSH home may really be waiting for its restart.
 * What this proves: the process that runs StudyHub started after the install, and still runs older code. What it assumes: that process is DSH's
 * (the host loads StudyHub in-process), which is why the learner is told "DSH was restarted". The installing process wrote its own start into
 * the marker (`installedBy`); a start that matches it is the same process, never a restart, even if the wall clock moved back after it started.
 */
function failedRestart(state, current, startedAt) {
  const installedAt = typeof state.installedAt === 'string' ? Date.parse(state.installedAt) : NaN;
  if (!isNewerVersion(state.pending, current) || !Number.isFinite(installedAt) || !(startedAt > installedAt)) return null;
  if (Number.isFinite(state.installedBy) && Math.abs(state.installedBy - startedAt) <= SAME_PROCESS_MS) return null;
  return { pending: parseVersion(state.pending).text, running: current, installedAt: state.installedAt, assetUrl: packageAddress(state.pending) };
}

/**
 * Running and known-installed versions are distinct until DSH restarts.
 * `pendingRestart`: an install is on disk or recorded and this process has not been restarted since (restart needed).
 * `restartFailed` ({ pending, running, installedAt } or null): the marker's version never started although this process began after the install;
 * then `pendingRestart` is null, `installed` is this copy's own version (the newer of the running and the on-disk one) and `upgradeAvailable` is
 * worked out against it, so the install is offered again. `startedAt`: when this process started (ms), injectable for tests.
 */
export function updateView(state = {}, current = currentVersion(), installed = installedVersion(), startedAt = PROCESS_STARTED_AT) {
  const release = state.release && typeof state.release === 'object' ? state.release : null;
  const latest = release?.latest || null, newer = isNewerVersion(latest, current);
  const restartFailed = failedRestart(state, current, startedAt);
  // Installed but not running yet: recorded by a completed upgrade, or seen on disk after the page lost the answer.
  const pending = restartFailed ? null : [state.pending, installed].filter(candidate => typeof candidate === 'string' && isNewerVersion(candidate, current))
    .sort((a, b) => (isNewerVersion(a, b) ? -1 : 1))[0] || null;
  const knownInstalled = pending || (restartFailed && isNewerVersion(installed, current) ? installed : current);
  return { current, installed: knownInstalled, latest, newer, upgradeAvailable: isNewerVersion(latest, knownInstalled),
    publishedAt: release?.publishedAt || null, notes: release?.notes || '',
    url: release?.url || RELEASES_PAGE_URL, assetName: release?.assetName || null, assetUrl: release?.assetUrl || null,
    sha256Url: release?.sha256Url || null, checkedAt: state.checkedAt || null,
    ...(state.error ? { error: state.error, retryAt: Number.isFinite(state.nextCheckAt) ? state.nextCheckAt : null } : {}),
    source: state.source === 'fallback' ? 'fallback' : 'api',
    autoCheck: state.autoCheck !== false, snoozed: !!latest && state.snoozed === latest, pendingRestart: pending, restartFailed };
}

export async function readUpdateView({ current = currentVersion(), startedAt } = {}) {
  return updateView(await readConfirmedState(current), current, undefined, startedAt);
}

async function requestApi(fetch, current, now) {
  const at = now();
  let response;
  try {
    response = await fetch(releasesApiUrl(), { method: 'GET', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { 'User-Agent': `StudyHub-update-check/${current}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } });
  } catch { return { error: 'network', retryAt: at + FAILURE_RETRY_MS }; }
  if (!response.ok) {
    const limited = (response.status === 403 || response.status === 429) && (response.headers.get('x-ratelimit-remaining') === '0' || response.status === 429);
    const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000;
    const retryAt = limited && Number.isFinite(reset) && reset > at ? Math.min(reset, at + CHECK_INTERVAL_MS) : at + FAILURE_RETRY_MS;
    try { await response.body?.cancel(); } catch { /* the status is all we need */ }
    return { error: limited ? 'rate-limited' : `http-${response.status}`, retryAt: Math.max(retryAt, at + FAILURE_RETRY_MS) };
  }
  let body;
  try { body = await response.json(); } catch { return { error: 'invalid', retryAt: at + FAILURE_RETRY_MS }; }
  if (body && typeof body === 'object' && (body.draft === true || body.prerelease === true)) return { release: null };
  const release = releaseFromGithub(body);
  return release ? { release } : { error: 'invalid', retryAt: at + FAILURE_RETRY_MS };
}

/* Failures where github.com may still answer: the API is limited, unreachable or failing (not a 404 or a bad body). */
const fallbackWorthTrying = error => error === 'rate-limited' || error === 'network' || /^http-(5\d\d|403|429)$/.test(error);

/** The non-API route: GitHub redirects /releases/latest to the newest tag page; the Location header is all that is read. */
async function requestRedirect(fetch, current) {
  try {
    const response = await fetch(releasesLatestPageUrl(), { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { 'User-Agent': `StudyHub-update-check/${current}`, Accept: 'text/html' } });
    const location = response.headers.get('location');
    try { await response.body?.cancel(); } catch { /* the header is all we need */ }
    return [301, 302, 303, 307, 308].includes(response.status) ? releaseFromLatestLocation(location) : null;
  } catch { return null; }
}

async function requestLatest(fetch, current, now) {
  const outcome = await requestApi(fetch, current, now);
  if (!outcome.error || !fallbackWorthTrying(outcome.error)) return outcome;
  const release = await requestRedirect(fetch, current);
  // Both routes failed: the API's error and retry time stand.
  return release ? { release, source: 'fallback' } : outcome;
}

let inflight = null;
/**
 * The cached answer while it is fresh (12 h, or the short failure window),
 * otherwise one request shared by every concurrent caller. `force` (检查更新)
 * always asks. With automatic checks off only a forced check asks.
 */
export async function checkForUpdate({ force = false, fetch = globalThis.fetch, now = Date.now, current = currentVersion(), startedAt } = {}) {
  const state = await readConfirmedState(current);
  if (!force && state.autoCheck === false) return updateView(state, current, undefined, startedAt);
  const due = Number.isFinite(state.nextCheckAt) ? state.nextCheckAt : 0;
  if (!force && now() < due) return updateView(state, current, undefined, startedAt);
  if (!inflight) {
    inflight = (async () => {
      const outcome = await requestLatest(fetch, current, now);
      const at = now();
      return updateState(next => {
        next.checkedAt = new Date(at).toISOString();
        if (outcome.error) Object.assign(next, { error: outcome.error, nextCheckAt: outcome.retryAt });
        else { delete next.error; Object.assign(next, { release: outcome.release, source: outcome.source || 'api', nextCheckAt: at + CHECK_INTERVAL_MS }); }
      }, current);
    })().finally(() => { inflight = null; });
  }
  return updateView(await inflight, current, undefined, startedAt);
}

/** autoCheck: boolean; snooze: the version to stay quiet about (稍后提醒), or null to forget it. */
export async function setUpdatePreferences(preferences = {}, { current = currentVersion(), startedAt } = {}) {
  const { autoCheck, snooze } = preferences;
  if (autoCheck !== undefined && typeof autoCheck !== 'boolean') throw new Error('autoCheck must be true or false');
  if (snooze !== undefined && snooze !== null && !parseVersion(snooze)) throw new Error('snooze must be a version');
  const state = await updateState(next => {
    if (autoCheck !== undefined) next.autoCheck = autoCheck;
    if (snooze !== undefined) { if (snooze === null) delete next.snoozed; else next.snoozed = parseVersion(snooze).text; }
  }, current);
  return updateView(state, current, undefined, startedAt);
}

/** Remember an installed version until the running code reaches it (DSH needs a restart). `installedAt` and `installedBy` (the installing process's start) tell a restart still to come from one that did not take effect. */
export async function markUpdateInstalled(installed, { now = Date.now, startedAt = PROCESS_STARTED_AT } = {}) {
  await updateState(state => {
    state.pending = parseVersion(installed)?.text;
    state.installedAt = new Date(now()).toISOString();
    // This process's own start: a later read by the same process is never "restarted since", whatever the clock did.
    if (Number.isFinite(startedAt)) state.installedBy = startedAt; else delete state.installedBy;
  });
}
