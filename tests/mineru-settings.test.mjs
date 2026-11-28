import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { MINERU } from '../lib/mineru-api.js';
import { hasMineruToken, mineruSettingsPath, publicMineruSettings, readMineruSettings, saveMineruSettings } from '../lib/mineru-settings.js';

/* MinerU cloud/local settings: default is always local (no upload), custom baseUrl + Key support,
   secret masking, upload acknowledgement tied to endpoint, and 3.5.4 / future-version compatibility [C38]. */

async function withHome(t) {
  const home = await mkdtemp(join(tmpdir(), 'study-mineru-settings-'));
  const before = { DSH_HOME: process.env.DSH_HOME, MINERU_API_KEY: process.env.MINERU_API_KEY };
  process.env.DSH_HOME = home;
  delete process.env.MINERU_API_KEY;
  t.after(async () => {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(home, { recursive: true, force: true });
  });
  return home;
}

test('default mode is local with empty baseUrl (defaulting to official MINERU.baseUrl) and no upload acknowledgement', async t => {
  await withHome(t);
  const settings = await readMineruSettings();
  assert.equal(settings.mode, 'local');
  assert.equal(settings.baseUrl, '');
  assert.equal(settings.effectiveBaseUrl, MINERU.baseUrl);
  assert.equal(hasMineruToken(settings), false);
  assert.equal(settings.acknowledgedAt, '');
  const pub = publicMineruSettings(settings);
  assert.equal(pub.mode, 'local');
  assert.equal(pub.baseUrl, '');
  assert.equal(pub.effectiveBaseUrl, MINERU.baseUrl);
  assert.equal(pub.defaultBaseUrl, MINERU.baseUrl);
  assert.deepEqual(pub.token, { set: false, hint: '', source: '' });
  assert.equal(pub.acknowledged, false);
});

test('saves mode, custom baseUrl, and Key (official JWT or third-party key) while masking Key in public view', async t => {
  await withHome(t);
  const key = 'sk-custom-provider-key-9876';
  const saved = await saveMineruSettings({ mode: 'cloud', baseUrl: 'https://parser.example.com/v4///', token: key, acknowledge: true });
  assert.equal(saved.mode, 'cloud');
  assert.equal(saved.baseUrl, 'https://parser.example.com/v4');
  assert.equal(saved.effectiveBaseUrl, 'https://parser.example.com/v4');
  assert.equal(saved.token, key);
  assert.ok(saved.acknowledgedAt);
  if (process.platform !== 'win32') {
    const info = await stat(mineruSettingsPath());
    assert.equal(info.mode & 0o777, 0o600, 'settings file with Key is owner-only (0600)');
  }

  const pub = publicMineruSettings(saved);
  assert.equal(pub.mode, 'cloud');
  assert.equal(pub.baseUrl, 'https://parser.example.com/v4');
  assert.equal(pub.effectiveBaseUrl, 'https://parser.example.com/v4');
  assert.deepEqual(pub.token, { set: true, hint: '••••9876', source: 'file' });
  assert.equal(pub.acknowledged, true);
  assert.ok(!JSON.stringify(pub).includes(key), 'raw key never appears in public settings');

  // Clearing baseUrl restores the official default AND resets upload acknowledgement for the changed destination.
  const resetBase = await saveMineruSettings({ baseUrl: '' });
  assert.equal(resetBase.baseUrl, '');
  assert.equal(resetBase.effectiveBaseUrl, MINERU.baseUrl);
  assert.equal(resetBase.acknowledgedAt, '', 'changing destination endpoint requires re-confirming upload');

  // Clearing token removes it from disk.
  const cleared = await saveMineruSettings({ token: '' });
  assert.equal(hasMineruToken(cleared), false);
});

test('rejects invalid mode, invalid baseUrl scheme, and invalid key format', async t => {
  await withHome(t);
  await assert.rejects(saveMineruSettings({ mode: 'hybrid' }), /mode/);
  await assert.rejects(saveMineruSettings({ baseUrl: 'file:///tmp/x' }), /http:\/\/|https:\/\//);
  await assert.rejects(saveMineruSettings({ baseUrl: 'javascript:alert(1)' }), /http:\/\/|https:\/\//);
  await assert.rejects(saveMineruSettings({ token: 'has spaces inside' }), /格式/);
  await assert.rejects(saveMineruSettings({ token: 'abc' }), /格式/);
});

test('3.5.4 compatibility [C38]: reads legacy mineru.json with token + acknowledgedAt and keeps default mode local', async t => {
  await withHome(t);
  const target = mineruSettingsPath();
  await mkdir(dirname(target), { recursive: true });
  // Real 3.5.4 mineru.json shape (no `mode`, no `baseUrl`, no `acknowledgedBaseUrl`).
  await writeFile(target, JSON.stringify({ version: 1, token: 'eyJhbGciOiJIUzI1NiJ9.legacy.token9999', acknowledgedAt: '2026-01-15T10:00:00.000Z' }, null, 2));
  const settings = await readMineruSettings();
  assert.equal(settings.mode, 'local', 'never silently switches to cloud upload from a 3.5.4 file');
  assert.equal(settings.baseUrl, '');
  assert.equal(settings.effectiveBaseUrl, MINERU.baseUrl);
  assert.equal(settings.token, 'eyJhbGciOiJIUzI1NiJ9.legacy.token9999');
  assert.equal(settings.acknowledgedAt, '2026-01-15T10:00:00.000Z', 'official consent from 3.5.4 is preserved');

  // Changing to a third-party baseUrl invalidates the 3.5.4 official consent so the user confirms the new host.
  const custom = await saveMineruSettings({ baseUrl: 'https://third-party.example.com/api/v4' });
  assert.equal(custom.acknowledgedAt, '');
});

test('unknown future version in mineru.json is refused and left untouched [C38]', async t => {
  await withHome(t);
  const target = mineruSettingsPath();
  await mkdir(dirname(target), { recursive: true });
  const future = JSON.stringify({ version: 99, mode: 'cloud', futureField: true });
  await writeFile(target, future);
  await assert.rejects(readMineruSettings(), { code: 'unsupported-store-version' });
  await assert.rejects(saveMineruSettings({ mode: 'local' }), { code: 'unsupported-store-version' });
  assert.equal(await readFile(target, 'utf8'), future, 'future file bytes untouched');
});
