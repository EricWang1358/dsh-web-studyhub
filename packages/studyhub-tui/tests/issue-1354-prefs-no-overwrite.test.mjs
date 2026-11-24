// Regression test for #1354 (D11):
// Failed reads of tui.json (corrupt JSON or unreadable/locked file) must NEVER silently
// overwrite the user's original settings file with defaults on passive saves; explicit
// user preference changes over a corrupt file must back up the corrupt file first.
// node --test tests/issue-1354-prefs-no-overwrite.test.mjs
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { register } from 'tsx/esm/api';

const unregisterTsx = register();
after(() => {
  unregisterTsx?.();
});

const prefsMod = await import('../src/host/tui-prefs.ts');
const { loadTuiPreferences, saveTuiPreferences } = prefsMod;

test('#1354 D11: passive saves never overwrite a corrupt tui.json with defaults', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'studyhub-1354-prefs-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'tui.json');
  const corruptRaw = '{"theme":"nord","language":"en", BROKEN';
  await writeFile(filePath, corruptRaw, 'utf8');

  // Passive background save (e.g., recentCommands / lastReadPages / lastPracticeContext)
  await saveTuiPreferences({ recentCommands: ['nav:stats'] }, { filePath });
  const afterPassive = await readFile(filePath, 'utf8');
  assert.equal(afterPassive, corruptRaw, 'passive save must NOT overwrite corrupt tui.json with defaults');

  // Explicit user preference change backs up the corrupt file before writing
  const saved = await saveTuiPreferences({ theme: 'warm-paper' }, { filePath });
  assert.equal(saved.theme, 'warm-paper');
  const files = await readdir(dir);
  const backup = files.find((f) => f.startsWith('tui.json.corrupt-') && f.endsWith('.bak'));
  assert.ok(backup, `expected backup of corrupt tui.json before explicit overwrite; files=${files.join(', ')}`);
  const backupContent = await readFile(path.join(dir, backup), 'utf8');
  assert.equal(backupContent, corruptRaw, 'backup file must preserve original corrupt contents');
  const loaded = await loadTuiPreferences({ filePath });
  assert.equal(loaded.theme, 'warm-paper');
});

test('#1354 D11: unreadable tui.json (e.g. EACCES/directory) refuses overwrite instead of clobbering with defaults', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'studyhub-1354-unreadable-'));
  t.after(async () => {
    await chmod(path.join(dir, 'tui.json'), 0o600).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });
  const filePath = path.join(dir, 'tui.json');
  const original = JSON.stringify({ theme: 'nord', language: 'en' });
  await writeFile(filePath, original, 'utf8');

  // On POSIX (non-root), chmod 0o000 makes readFile fail with EACCES
  if (process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() !== 0) {
    await chmod(filePath, 0o000);
    await assert.rejects(
      saveTuiPreferences({ theme: 'dsh-dark' }, { filePath }),
      /could not be read|EACCES|permission/i,
      'saveTuiPreferences must refuse to overwrite an unreadable tui.json',
    );
    await chmod(filePath, 0o600);
    const preserved = await readFile(filePath, 'utf8');
    assert.equal(preserved, original, 'original tui.json must remain intact after failed read');
  }
});
