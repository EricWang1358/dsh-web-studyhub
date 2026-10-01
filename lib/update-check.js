/* Update check (shared core, every edition). One GET to GitHub's "latest release"
   endpoint, at most once per 12 h for all sessions of this DSH home, cached in
   <DSH home>/study/update.json next to the audio settings. Nothing else is sent:
   no telemetry, no identifiers. Mainland-China networks often cannot reach
   api.github.com, so a failure is cached briefly and returned as a quiet
   `error` code, never thrown. The learner can turn automatic checks off. */
import { readFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isNewerVersion, parseVersion } from './semver.js';
import { parseStoredJson } from './util.js';

export const UPDATE_REPOSITORY = 'EricWang1358/dsh-web-studyhub';
export const RELEASES_API_URL = `https://api.github.com/repos/${UPDATE_REPOSITORY}/releases/latest`;
export const RELEASES_PAGE_URL = `https://github.com/${UPDATE_REPOSITORY}/releases`;
/** Only files under this prefix may be downloaded or installed. */
export const RELEASE_DOWNLOAD_PREFIX = `https://github.com/${UPDATE_REPOSITORY}/releases/download/`;
export const PACKAGE_NAME = '@ericwang1358/dsh-daily-flashcard';
export const CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;
export const FAILURE_RETRY_MS = 60 * 60 * 1000;
export const REQUEST_TIMEOUT_MS = 8000;
export const NOTES_LIMIT = 1200;

const studyHome = () => join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'study');
export const updateStatePath = () => join(studyHome(), 'update.json');

let version;
/** The version of the plugin code that is running now. */
export function currentVersion() {
  version ??= JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  return version;
}

const releaseFile = (url, name) => typeof url === 'string' && url.startsWith(RELEASE_DOWNLOAD_PREFIX) && !url.includes('..')
  && url.endsWith(`/${name}`) ? url : null;
const assetUrl = (assets, name) => releaseFile(assets.find(asset => asset?.name === name)?.browser_download_url, name);

/** The fields StudyHub uses from one GitHub release; null for drafts, pre-releases and unusable answers. */
export function releaseFromGithub(release) {
  if (!release || typeof release !== 'object' || release.draft === true || release.prerelease === true) return null;
  const parsed = parseVersion(release.tag_name);
  if (!parsed) return null;
  const latest = parsed.text, assets = Array.isArray(release.assets) ? release.assets : [];
  const assetName = `ericwang1358-dsh-daily-flashcard-${latest}.tgz`;
  const page = typeof release.html_url === 'string' && release.html_url.startsWith(`https://github.com/${UPDATE_REPOSITORY}/releases/`) ? release.html_url : RELEASES_PAGE_URL;
  return { latest, publishedAt: typeof release.published_at === 'string' ? release.published_at : null,
    notes: typeof release.body === 'string' ? release.body.slice(0, NOTES_LIMIT) : '', url: page,
    assetName, assetUrl: assetUrl(assets, assetName), sha256Url: assetUrl(assets, `SHA256SUMS-${latest}.txt`) };
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

/** What the panel sees: the cached release compared with the running version, plus preferences. */
export function updateView(state = {}, current = currentVersion()) {
  const release = state.release && typeof state.release === 'object' ? state.release : null;
  const latest = release?.latest || null, newer = isNewerVersion(latest, current);
  const pending = typeof state.pending === 'string' && isNewerVersion(state.pending, current) ? state.pending : null;
  return { current, latest, newer, publishedAt: release?.publishedAt || null, notes: release?.notes || '',
    url: release?.url || RELEASES_PAGE_URL, assetName: release?.assetName || null, assetUrl: release?.assetUrl || null,
    sha256Url: release?.sha256Url || null, checkedAt: state.checkedAt || null,
    ...(state.error ? { error: state.error } : {}),
    autoCheck: state.autoCheck !== false, snoozed: !!latest && state.snoozed === latest, pendingRestart: pending };
}

export async function readUpdateView({ current = currentVersion() } = {}) {
  return updateView(await readState(), current);
}

async function requestLatest(fetch, current, now) {
  const at = now();
  let response;
  try {
    response = await fetch(RELEASES_API_URL, { method: 'GET', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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

let inflight = null;
/**
 * The cached answer while it is fresh (12 h, or the short failure window),
 * otherwise one request shared by every concurrent caller. `force` (检查更新)
 * always asks. With automatic checks off only a forced check asks.
 */
export async function checkForUpdate({ force = false, fetch = globalThis.fetch, now = Date.now, current = currentVersion() } = {}) {
  const state = await readState();
  if (!force && state.autoCheck === false) return updateView(state, current);
  const due = Number.isFinite(state.nextCheckAt) ? state.nextCheckAt : 0;
  if (!force && now() < due) return updateView(state, current);
  if (!inflight) {
    inflight = (async () => {
      const outcome = await requestLatest(fetch, current, now);
      const latestState = await readState(), at = now();
      const next = { ...latestState, checkedAt: new Date(at).toISOString() };
      if (outcome.error) Object.assign(next, { error: outcome.error, nextCheckAt: outcome.retryAt });
      else { delete next.error; Object.assign(next, { release: outcome.release, nextCheckAt: at + CHECK_INTERVAL_MS }); }
      await writeState(next);
      return next;
    })().finally(() => { inflight = null; });
  }
  return updateView(await inflight, current);
}

/** autoCheck: boolean; snooze: the version to stay quiet about (稍后提醒), or null to forget it. */
export async function setUpdatePreferences(preferences = {}, { current = currentVersion() } = {}) {
  const { autoCheck, snooze } = preferences;
  if (autoCheck !== undefined && typeof autoCheck !== 'boolean') throw new Error('autoCheck must be true or false');
  if (snooze !== undefined && snooze !== null && !parseVersion(snooze)) throw new Error('snooze must be a version');
  const state = await readState();
  if (autoCheck !== undefined) state.autoCheck = autoCheck;
  if (snooze !== undefined) { if (snooze === null) delete state.snoozed; else state.snoozed = parseVersion(snooze).text; }
  await writeState(state);
  return updateView(state, current);
}

/** Remember an installed version until the running code reaches it (DSH needs a restart). */
export async function markUpdateInstalled(installed) {
  const state = await readState();
  state.pending = parseVersion(installed)?.text;
  state.installedAt = new Date().toISOString();
  await writeState(state);
}
