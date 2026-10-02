import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MINERU_DOCS_URL, hasMineruToken, mineruSettingsPath, publicMineruSettings, readMineruSettings, saveMineruSettings, NO_MINERU_TOKEN } from '../lib/mineru-settings.js';

/* The MinerU token lives in the DSH home next to the audio keys: never in the library, a backup or a panel snapshot. */

const TOKEN = 'eyJ0eXBlIjoiSldUIn0.mineru_TOKEN_000000000000000001.sig-abc';

async function withHome(t) {
  const home = await mkdtemp(join(tmpdir(), 'study-mineru-home-'));
  const before = { DSH_HOME: process.env.DSH_HOME, MINERU_API_KEY: process.env.MINERU_API_KEY };
  process.env.DSH_HOME = home; delete process.env.MINERU_API_KEY;
  t.after(async () => {
    for (const [key, value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await rm(home, { recursive: true, force: true });
  });
  return home;
}

test('nothing is configured by default, and the learner is told where to start', async t => {
  await withHome(t);
  const settings = await readMineruSettings();
  assert.equal(settings.token, '');
  assert.equal(settings.acknowledgedAt, '');
  assert.equal(hasMineruToken(settings), false);
  assert.match(NO_MINERU_TOKEN, /MinerU/);
  assert.match(NO_MINERU_TOKEN, /设置/);
  assert.equal(MINERU_DOCS_URL, 'https://mineru.net/apiManage/docs');
});

test('the token is stored under the DSH home with owner-only access, trimmed, and shown back only as its last four characters', async t => {
  const home = await withHome(t);
  const saved = await saveMineruSettings({ token: `  ${TOKEN}  ` });
  assert.equal(saved.token, TOKEN);
  assert.equal(mineruSettingsPath(), join(home, 'study', 'mineru.json'));
  assert.equal(JSON.parse(await readFile(mineruSettingsPath(), 'utf8')).token, TOKEN);
  if (process.platform !== 'win32') assert.equal((await stat(mineruSettingsPath())).mode & 0o777, 0o600);
  const view = publicMineruSettings(await readMineruSettings());
  assert.deepEqual(view.token, { set: true, hint: `••••${TOKEN.slice(-4)}`, source: 'file' });
  assert.ok(!JSON.stringify(view).includes(TOKEN), 'the panel never sees the token');
  assert.ok(!JSON.stringify(view).includes(TOKEN.slice(0, 20)), 'not even a long prefix');
  assert.equal(view.docsUrl, MINERU_DOCS_URL);
});

test('MINERU_API_KEY fills in a token the file lacks; the file wins when both exist', async t => {
  await withHome(t);
  process.env.MINERU_API_KEY = `${TOKEN}-env`;
  let view = publicMineruSettings(await readMineruSettings());
  assert.equal(view.token.set, true);
  assert.equal(view.token.source, 'env');
  await saveMineruSettings({ token: TOKEN });
  view = publicMineruSettings(await readMineruSettings());
  assert.equal(view.token.source, 'file');
  assert.equal((await readMineruSettings()).token, TOKEN);
});

test('a malformed token is refused with a plain message that does not echo it', async t => {
  await withHome(t);
  const bad = 'short token with spaces';
  await assert.rejects(saveMineruSettings({ token: bad }), error => {
    assert.match(error.message, /令牌|token/i);
    assert.ok(!error.message.includes(bad));
    return true;
  });
  assert.equal((await readMineruSettings()).token, '');
});

test('an empty string clears the token; leaving it out keeps it', async t => {
  await withHome(t);
  await saveMineruSettings({ token: TOKEN });
  await saveMineruSettings({ acknowledge: true });
  assert.equal((await readMineruSettings()).token, TOKEN, 'a patch without a token keeps it');
  await saveMineruSettings({ token: '' });
  assert.equal((await readMineruSettings()).token, '');
});

test('the privacy acknowledgement is one explicit step: recorded once with its time, and cleared with false', async t => {
  await withHome(t);
  assert.equal(publicMineruSettings(await readMineruSettings()).acknowledged, false);
  const first = await saveMineruSettings({ acknowledge: true });
  assert.ok(Date.parse(first.acknowledgedAt) > 0);
  const again = await saveMineruSettings({ acknowledge: true });
  assert.equal(again.acknowledgedAt, first.acknowledgedAt, 'a second confirmation does not move the date');
  assert.equal(publicMineruSettings(again).acknowledged, true);
  const cleared = await saveMineruSettings({ acknowledge: false });
  assert.equal(cleared.acknowledgedAt, '');
});

test('a corrupted settings file reads as empty instead of crashing', async t => {
  const home = await withHome(t);
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(join(home, 'study'), { recursive: true });
  await writeFile(mineruSettingsPath(), '{not json');
  assert.equal((await readMineruSettings()).token, '');
});
