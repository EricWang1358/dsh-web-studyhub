// Cross-platform fast-path CLI `--export [path]` / `--export --json` tests:
// `node --test tests/round73-cli-export.test.mjs`
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { tsImport } from 'tsx/esm/api';

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const binPath = resolve(pkgRoot, 'bin', 'studyhub-tui.mjs');

const cliArgsMod = await tsImport('../src/cli-args.ts', import.meta.url);
const hostMod = await tsImport('../src/host/tui-host.ts', import.meta.url);
const atomicWriteMod = await tsImport('../src/host/atomic-write.ts', import.meta.url);
const { parseCliArgs, cliHelpText } = cliArgsMod;
const { createTuiHost } = hostMod;
const { todayLocalYmd } = atomicWriteMod;

const tempRoots = [];
async function makeTempDir(label) {
  const dir = await mkdtemp(join(tmpdir(), `studyhub-tui-export-${label}-`));
  tempRoots.push(dir);
  return dir;
}

after(async () => {
  await Promise.all(
    tempRoots.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })),
  );
});

async function seedSampleLibrary(baseDir, label) {
  const fakeDshHome = join(baseDir, `${label}-dsh`);
  const tempLib = join(baseDir, `${label}-lib`);
  await mkdir(fakeDshHome, { recursive: true });
  await mkdir(tempLib, { recursive: true });

  const seedHost = await createTuiHost({
    libraryRoot: tempLib,
    env: { ...process.env, DSH_HOME: fakeDshHome },
    skipAutoProbe: true,
    language: 'en',
  });
  try {
    const sampleRes = await seedHost.call('sample.load', { language: 'en' });
    assert.equal(sampleRes.ok, true, `sample.load failed: ${sampleRes.error?.message ?? ''}`);
  } finally {
    await seedHost.dispose();
  }
  return { fakeDshHome, tempLib };
}

describe('Round 73 CLI --export headless atomic library backup', () => {
  test('1. parseCliArgs handles --export, --export <path>, --export=<path> --json, and preserves empty-argv equality', () => {
    const def = parseCliArgs([]);
    assert.equal(def.exportBackup, false);
    assert.equal(def.exportPath, undefined);
    assert.deepEqual(def, {
      help: false,
      version: false,
      altScreen: true,
      autoLaunchpad: true,
      skipAutoProbe: false,
    });

    const expDefault = parseCliArgs(['--export']);
    assert.equal(expDefault.exportBackup, true);
    assert.equal(expDefault.exportPath, undefined);
    assert.equal(expDefault.json, false);
    assert.equal(expDefault.error, undefined);

    const expPath = parseCliArgs(['--export', 'out.json']);
    assert.equal(expPath.exportBackup, true);
    assert.equal(expPath.exportPath, 'out.json');
    assert.equal(expPath.json, false);
    assert.equal(expPath.error, undefined);

    const expEqJson = parseCliArgs(['--export=backup.json', '--json']);
    assert.equal(expEqJson.exportBackup, true);
    assert.equal(expEqJson.exportPath, 'backup.json');
    assert.equal(expEqJson.json, true);
    assert.equal(expEqJson.error, undefined);

    const expThenFlag = parseCliArgs(['--export', '--json']);
    assert.equal(expThenFlag.exportBackup, true);
    assert.equal(expThenFlag.exportPath, undefined);
    assert.equal(expThenFlag.json, true);
    assert.equal(expThenFlag.error, undefined);

    const help = cliHelpText('1.0.0');
    assert.ok(help.includes('--export [path]'), 'help text documents --export [path]');
    assert.ok(help.includes('--export --json'), 'help text documents --export --json');
  });

  test('2. bin/studyhub-tui.mjs --export <outPath> --json --library <tempLib> writes atomic JSON backup & receipt with zero .tmp leftovers', async () => {
    const base = await makeTempDir('json');
    const { fakeDshHome, tempLib } = await seedSampleLibrary(base, 'seed');
    const outDir = join(base, 'exports');
    const outPath = join(outDir, 'my-backup.json');

    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [binPath, '--export', outPath, '--json', '--library', tempLib],
      {
        timeout: 15_000,
        env: {
          ...process.env,
          DSH_HOME: fakeDshHome,
        },
      },
    );

    assert.equal(stderr, '');
    const receipt = JSON.parse(stdout);
    assert.equal(receipt.ok, true);
    assert.equal(receipt.path, outPath);
    assert.equal(receipt.libraryRoot, tempLib);
    assert.ok(receipt.bytes > 0, `expected bytes > 0, got ${receipt.bytes}`);
    assert.ok(receipt.decks >= 1, `expected decks >= 1, got ${receipt.decks}`);
    assert.ok(receipt.cards >= 1, `expected cards >= 1, got ${receipt.cards}`);
    assert.ok(typeof receipt.generatedAt === 'string' && !Number.isNaN(Date.parse(receipt.generatedAt)));

    const backupRaw = await readFile(outPath, 'utf8');
    assert.equal(Buffer.byteLength(backupRaw, 'utf8'), receipt.bytes);
    const backup = JSON.parse(backupRaw);
    assert.ok(Array.isArray(backup.decks) && backup.decks.length >= 1, 'backup payload contains decks');

    const filesInOutDir = await readdir(outDir);
    assert.deepEqual(filesInOutDir, ['my-backup.json'], 'zero .tmp leftovers in export directory');
  });

  test('3. bin/studyhub-tui.mjs --export --ascii --library <tempLib> exits 0 with pure ASCII summary and default dated backup file', async () => {
    const base = await makeTempDir('ascii');
    const { fakeDshHome, tempLib } = await seedSampleLibrary(base, 'seed');

    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [binPath, '--export', '--ascii', '--library', tempLib],
      {
        timeout: 15_000,
        env: {
          ...process.env,
          DSH_HOME: fakeDshHome,
        },
      },
    );

    assert.equal(stderr, '');
    assert.ok(!/[^\x00-\x7f]/.test(stdout), '--export --ascii output must contain zero non-ASCII characters');
    assert.match(stdout, /StudyHub TUI Export \(v1\.0\.0\)/);
    assert.match(stdout, /\[ok\] Exported library backup/);

    const expectedName = `studyhub-backup-${todayLocalYmd()}.json`;
    const backupsDir = join(tempLib, 'backups');
    const expectedPath = join(backupsDir, expectedName);
    assert.ok(stdout.includes(expectedPath), `stdout mentions default backup path ${expectedPath}`);

    const backupRaw = await readFile(expectedPath, 'utf8');
    const backup = JSON.parse(backupRaw);
    assert.ok(Array.isArray(backup.decks) && backup.decks.length >= 1, 'default backup contains seeded decks');

    const backupFiles = await readdir(backupsDir);
    assert.ok(
      !backupFiles.some((name) => name.endsWith('.tmp')),
      `expected zero .tmp leftovers in backups dir, found: ${backupFiles.join(', ')}`,
    );
  });
});
