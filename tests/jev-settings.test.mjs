import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JEV_FEATURES, JEV_NOTICE_VERSION, jevGate, jevSettingsPath, publicJevSettings, readJevSettings, saveJevSettings } from '../lib/jev-settings.js';
import { createJevUsage } from '../lib/jev-usage.js';

/* The Jev key and switches live in the DSH home next to the audio keys: never in the library, a backup, a panel snapshot or a log.
   Everything is off until the learner turns it on, one feature at a time. */

const KEY = 'tsk_live_looking_JEV_key_00000000000000000001';

async function withHome(t) {
  const home = await mkdtemp(join(tmpdir(), 'study-jev-home-'));
  const before = { DSH_HOME: process.env.DSH_HOME, JEV_API_KEY: process.env.JEV_API_KEY };
  process.env.DSH_HOME = home; delete process.env.JEV_API_KEY;
  t.after(async () => {
    for (const [key, value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await rm(home, { recursive: true, force: true });
  });
  return home;
}

test('nothing is on by default: no key, no confirmation, every switch off, threshold 0.8', async t => {
  await withHome(t);
  const settings = await readJevSettings();
  assert.equal(settings.key, '');
  assert.equal(settings.enabled, false);
  assert.equal(settings.confirmedAt, '');
  assert.equal(settings.threshold, 0.8);
  assert.deepEqual(JEV_FEATURES, ['courseSuggest', 'preReview', 'outlineNoise', 'levelCheck']);
  for (const feature of JEV_FEATURES) assert.equal(settings.features[feature], false, feature);
});

test('the key is stored under the DSH home with owner-only access, trimmed, and shown back only as its last four characters', async t => {
  const home = await withHome(t);
  await saveJevSettings({ key: `  ${KEY}  ` });
  assert.equal(jevSettingsPath(), join(home, 'study', 'jev.json'));
  assert.equal(JSON.parse(await readFile(jevSettingsPath(), 'utf8')).key, KEY);
  if (process.platform !== 'win32') assert.equal((await stat(jevSettingsPath())).mode & 0o777, 0o600);
  const view = publicJevSettings(await readJevSettings());
  assert.deepEqual(view.key, { set: true, hint: `••••${KEY.slice(-4)}`, source: 'file', envName: 'JEV_API_KEY', envFound: false });
  assert.ok(!JSON.stringify(view).includes(KEY));
  assert.ok(!JSON.stringify(view).includes(KEY.slice(0, 20)), 'not even a long prefix');
  assert.equal(view.noticeVersion, JEV_NOTICE_VERSION);
});

test('JEV_API_KEY fills in a key the file lacks; the file wins when both exist', async t => {
  await withHome(t);
  process.env.JEV_API_KEY = `${KEY}-env`;
  assert.deepEqual(publicJevSettings(await readJevSettings()).key, { set: true, hint: '', source: 'env', envName: 'JEV_API_KEY', envFound: true }, 'a key from the environment shows no character of its value');
  await saveJevSettings({ key: KEY });
  assert.equal(publicJevSettings(await readJevSettings()).key.source, 'file');
  assert.equal((await readJevSettings()).key, KEY);
  await saveJevSettings({ key: '' });
  assert.equal((await readJevSettings()).key, `${KEY}-env`, 'clearing the file key leaves the environment one');
});

test('a malformed key is refused with a plain message that does not echo it; other fields stay when only one changes', async t => {
  await withHome(t);
  await saveJevSettings({ key: KEY, features: { courseSuggest: true } });
  await assert.rejects(saveJevSettings({ key: 'bad key with spaces' }), error => !error.message.includes('bad key') && /Jev/.test(error.message));
  await assert.rejects(saveJevSettings({ key: 'short' }), /Jev/);
  await assert.rejects(saveJevSettings(null), /对象/);
  const after = await readJevSettings();
  assert.equal(after.key, KEY);
  assert.equal(after.features.courseSuggest, true);
});

test('the confirmation is one explicit step, tied to the version of the notice, and can be withdrawn', async t => {
  await withHome(t);
  await assert.rejects(saveJevSettings({ confirm: 'yes' }), /true 或 false/);
  const confirmed = await saveJevSettings({ confirm: true });
  assert.ok(confirmed.confirmedAt);
  const first = confirmed.confirmedAt;
  assert.equal((await saveJevSettings({ confirm: true })).confirmedAt, first, 'confirming again keeps the first time');
  assert.equal(JSON.parse(await readFile(jevSettingsPath(), 'utf8')).noticeVersion, JEV_NOTICE_VERSION);
  // A confirmation written for an older notice no longer counts.
  const { writeFile } = await import('node:fs/promises');
  await writeFile(jevSettingsPath(), JSON.stringify({ version: 1, key: KEY, enabled: true, features: { courseSuggest: true }, confirmedAt: first, noticeVersion: JEV_NOTICE_VERSION - 1 }));
  assert.equal(jevGate(await readJevSettings(), 'courseSuggest').reason, 'not-confirmed');
  await saveJevSettings({ confirm: true });
  assert.equal(jevGate(await readJevSettings(), 'courseSuggest').ok, true);
  assert.equal((await saveJevSettings({ confirm: false })).confirmedAt, '');
});

test('features are toggled one by one; unknown ones and non-booleans are refused; the master switch is separate', async t => {
  await withHome(t);
  let settings = await saveJevSettings({ features: { preReview: true } });
  assert.deepEqual(JEV_FEATURES.filter(feature => settings.features[feature]), ['preReview']);
  settings = await saveJevSettings({ features: { courseSuggest: true } });
  assert.deepEqual(JEV_FEATURES.filter(feature => settings.features[feature]), ['courseSuggest', 'preReview']);
  await assert.rejects(saveJevSettings({ features: { surprise: true } }), /不认识/);
  await assert.rejects(saveJevSettings({ features: { courseSuggest: 'yes' } }), /true 或 false/);
  settings = await saveJevSettings({ enabled: true });
  assert.equal(settings.enabled, true);
  assert.equal(settings.features.preReview, true, 'the switches are remembered under the master switch');
  settings = await saveJevSettings({ enabled: false });
  assert.equal(settings.features.preReview, true);
});

test('the confidence threshold is a number from 0.5 to 0.99', async t => {
  await withHome(t);
  assert.equal((await saveJevSettings({ threshold: 0.9 })).threshold, 0.9);
  for (const bad of [0.4, 1, 'high', NaN]) await assert.rejects(saveJevSettings({ threshold: bad }), /0\.5/, String(bad));
  assert.equal((await readJevSettings()).threshold, 0.9);
});

test('the gate opens only with the master switch, the feature switch, a key and the confirmation, and says which one is missing', async t => {
  await withHome(t);
  const gate = async feature => jevGate(await readJevSettings(), feature);
  assert.deepEqual(await gate('courseSuggest'), { ok: false, reason: 'off' });
  await saveJevSettings({ enabled: true });
  assert.deepEqual(await gate('courseSuggest'), { ok: false, reason: 'feature-off' });
  await saveJevSettings({ features: { courseSuggest: true } });
  assert.deepEqual(await gate('courseSuggest'), { ok: false, reason: 'no-key' });
  await saveJevSettings({ key: KEY });
  assert.deepEqual(await gate('courseSuggest'), { ok: false, reason: 'not-confirmed' });
  await saveJevSettings({ confirm: true });
  assert.deepEqual(await gate('courseSuggest'), { ok: true });
  assert.deepEqual(await gate('preReview'), { ok: false, reason: 'feature-off' });
  // The kill switch closes everything at once.
  await saveJevSettings({ enabled: false });
  assert.deepEqual(await gate('courseSuggest'), { ok: false, reason: 'off' });
  // Testing the key needs only a key and the confirmation, not a feature.
  assert.deepEqual(jevGate(await readJevSettings(), null), { ok: true });
  await saveJevSettings({ confirm: false });
  assert.deepEqual(jevGate(await readJevSettings(), null), { ok: false, reason: 'not-confirmed' });
  await assert.rejects(async () => jevGate(await readJevSettings(), 'unknown'), /feature/);
});

test('usage counters add up per day and feature, count calls and tokens, and survive a restart', async t => {
  const home = await withHome(t);
  const clock = { time: Date.UTC(2026, 9, 2, 10) };
  const usage = createJevUsage({ now: () => clock.time });
  await usage.record({ feature: 'courseSuggest', usage: { inputTokens: 300, outputTokens: 30 } });
  await usage.record({ feature: 'courseSuggest', usage: { inputTokens: 200, outputTokens: 20 } });
  await usage.record({ feature: 'preReview', usage: { inputTokens: 1000, outputTokens: 80 }, calls: 2 });
  await usage.record({ feature: 'not-a-feature', usage: { inputTokens: 1, outputTokens: 1 } });
  clock.time += 86400000;
  await usage.record({ feature: 'preReview', usage: { inputTokens: 500, outputTokens: 10 } });
  await usage.record({ feature: 'courseSuggest', usage: { inputTokens: -5, outputTokens: 'x' } });
  const summary = await createJevUsage({ now: () => clock.time }).summary();
  assert.deepEqual(summary.today, { calls: 1, inputTokens: 500, outputTokens: 10 });
  assert.deepEqual(summary.total, { calls: 6, inputTokens: 2000 + 1, outputTokens: 140 + 1 });
  assert.deepEqual(summary.byFeature.courseSuggest, { calls: 2, inputTokens: 500, outputTokens: 50 });
  assert.deepEqual(summary.byFeature.preReview, { calls: 3, inputTokens: 1500, outputTokens: 90 });
  assert.equal(summary.daily.length, 2);
  assert.ok(!JSON.stringify(summary).match(/\$|price|cost|usd|¥/i), 'tokens only, never money');
  const raw = await readFile(join(home, 'study', 'jev-usage.json'), 'utf8');
  assert.ok(!raw.includes(KEY));
});

test('a damaged usage file starts afresh and recording never throws into the caller', async t => {
  const home = await withHome(t);
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(join(home, 'study'), { recursive: true });
  await writeFile(join(home, 'study', 'jev-usage.json'), '{ not json');
  const usage = createJevUsage();
  assert.equal((await usage.summary()).total.calls, 0);
  await usage.record({ feature: 'preReview', usage: { inputTokens: 5, outputTokens: 1 } });
  assert.equal((await usage.summary()).total.calls, 1);
});
