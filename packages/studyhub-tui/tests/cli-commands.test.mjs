// Consolidated fast-path CLI subprocess tests sharing ONE seeded sample library:
// `node --test tests/cli-commands.test.mjs`
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import {
  exportFilenameRegex,
  installNoNetworkGuard,
  sanitizedTestEnv,
} from './helpers/virtual-tty.mjs';

const execFileAsync = promisify(execFile);
const restoreNetworkGuard = installNoNetworkGuard();
const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const binPath = resolve(pkgRoot, 'bin', 'studyhub-tui.mjs');
const distCliPath = resolve(pkgRoot, 'dist', 'cli.mjs');

const hostMod = await import(pathToFileURL(resolve(pkgRoot, 'dist', 'host.mjs')).href);
const { createTuiHost } = hostMod;

function todayLocalYmd() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

let baseDir = '';
let fakeDshHome = '';
let doctorJsonDshHome = '';
let doctorStudyDir = '';
let tempLib = '';
let exportDefaultLib = '';
let exportOutDir = '';

before(async () => {
  baseDir = await mkdtemp(join(tmpdir(), 'studyhub-tui-cli-cmds-'));
  fakeDshHome = join(baseDir, 'dsh');
  doctorJsonDshHome = join(baseDir, 'doctor-json-dsh');
  doctorStudyDir = join(doctorJsonDshHome, 'study');
  tempLib = join(baseDir, 'lib');
  exportDefaultLib = join(baseDir, 'lib-export-default');
  exportOutDir = join(baseDir, 'exports');

  await Promise.all([
    mkdir(fakeDshHome, { recursive: true }),
    mkdir(doctorStudyDir, { recursive: true }),
    mkdir(tempLib, { recursive: true }),
  ]);
  await writeFile(join(doctorStudyDir, 'tui.json'), JSON.stringify({ theme: 'dsh-dark' }), 'utf8');

  const seedHost = await createTuiHost({
    libraryRoot: tempLib,
    env: sanitizedTestEnv({ DSH_HOME: fakeDshHome }),
    skipAutoProbe: true,
    language: 'en',
  });
  try {
    const sampleRes = await seedHost.call('sample.load', { language: 'en' });
    assert.equal(sampleRes.ok, true, `sample.load failed: ${sampleRes.error?.message ?? ''}`);
  } finally {
    await seedHost.dispose();
  }
  await cp(tempLib, exportDefaultLib, { recursive: true });
});

after(async () => {
  restoreNetworkGuard();
  if (baseDir) {
    await rm(baseDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

function assertNoUnexpectedStderr(stderr) {
  const unexpected = String(stderr ?? '')
    .split('\n')
    .filter((line) => line.trim() !== '' && !/^\[study-workspace\] \S+ took \d+ms /.test(line));
  assert.deepEqual(unexpected, [], `unexpected stderr:\n${unexpected.join('\n')}`);
}

describe('CLI fast-path subprocess suite (--doctor / --stats / --search / --export)', () => {
  // Keep internal subprocess concurrency capped at 2 so running alongside other [tier:unit]
  // files on a 4-core machine never oversubscribes CPU or starves event-loop timers.
  describe('concurrent read-only & isolated-output CLI commands', { concurrency: 2 }, () => {
  test('1. --doctor --json exits 0, outputs valid JSON, never leaks API keys, and runs fast', async () => {
    const secret = 'sk-secret-do-not-leak';
    const t0 = performance.now();
    const { stdout, stderr } = await execFileAsync(process.execPath, [binPath, '--doctor', '--json'], {
      timeout: 15_000,
      env: sanitizedTestEnv({
        DSH_HOME: doctorJsonDshHome,
        DEEPSEEK_API_KEY: secret,
      }),
    });
    const elapsedMs = performance.now() - t0;

    assert.equal(stderr, '');
    assert.ok(!stdout.includes(secret), 'stdout must not leak DEEPSEEK_API_KEY value');
    assert.ok(!stderr.includes(secret), 'stderr must not leak DEEPSEEK_API_KEY value');

    const parsed = JSON.parse(stdout);
    assert.equal(parsed.version, '1.0.0');
    assert.equal(parsed.platform, process.platform);
    assert.equal(parsed.paths.dshHome, doctorJsonDshHome);
    assert.equal(parsed.paths.tuiPrefsPath, join(doctorStudyDir, 'tui.json'));
    assert.equal(parsed.paths.tuiPrefsExists, true);
    assert.ok(parsed.paths.desktopRoot && parsed.paths.desktopRoot.endsWith('studyhub-desktop'));
    assert.ok(Array.isArray(parsed.providers.envKeysPresent));
    assert.ok(parsed.providers.envKeysPresent.includes('DEEPSEEK_API_KEY'));
    assert.ok(typeof parsed.terminal.colorLevel === 'number');
    assert.ok(elapsedMs < 4_000, `cold --doctor --json took ${elapsedMs.toFixed(1)}ms`);
  });

  test('2. --doctor --ascii exits 0 with 100% pure ASCII human-readable diagnostics', async () => {
    const secret = 'sk-ascii-secret-never-print';
    const { stdout, stderr } = await execFileAsync(process.execPath, [binPath, '--doctor', '--ascii'], {
      timeout: 15_000,
      env: sanitizedTestEnv({
        DSH_HOME: fakeDshHome,
        OPENAI_API_KEY: secret,
      }),
    });

    assert.equal(stderr, '');
    assert.ok(!stdout.includes(secret), 'human-readable doctor output must not leak API key');
    assert.ok(!/[^\x00-\x7f]/.test(stdout), 'doctor --ascii output must contain zero non-ASCII characters');
    assert.match(stdout, /StudyHub TUI Doctor \(v1\.0\.0\)/);
    assert.match(stdout, /Terminal/);
    assert.match(stdout, /Charset: ASCII \(--ascii\)/);
    assert.match(stdout, /Paths/);
    assert.match(stdout, /Providers/);
    assert.match(stdout, /OPENAI_API_KEY/);
  });

  test('3. --stats --json --library <tempLib> exits 0 with valid seeded JSON and no hung handles', async () => {
    const t0 = performance.now();
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [binPath, '--stats', '--json', '--library', tempLib],
      {
        timeout: 25_000,
        env: sanitizedTestEnv({
          DSH_HOME: fakeDshHome,
        }),
      },
    );
    const elapsedMs = performance.now() - t0;

    assertNoUnexpectedStderr(stderr);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.version, '1.0.0');
    assert.equal(parsed.libraryRoot, tempLib);
    assert.ok(typeof parsed.generatedAt === 'string' && !Number.isNaN(Date.parse(parsed.generatedAt)));
    assert.ok(parsed.counts.activeDecks >= 1, `expected activeDecks >= 1, got ${parsed.counts.activeDecks}`);
    assert.ok(parsed.counts.cards >= 1, `expected cards >= 1, got ${parsed.counts.cards}`);
    assert.ok(parsed.counts.courses >= 1, `expected courses >= 1, got ${parsed.counts.courses}`);
    assert.ok(parsed.counts.sources >= 1, `expected sources >= 1, got ${parsed.counts.sources}`);
    assert.ok(parsed.counts.notes >= 1, `expected notes >= 1, got ${parsed.counts.notes}`);
    assert.equal(typeof parsed.counts.due, 'number');
    assert.ok(parsed.counts.cards >= parsed.counts.due, 'total cards >= due cards');
    assert.equal(typeof parsed.counts.archivedDecks, 'number');
    assert.ok(Array.isArray(parsed.courses) && parsed.courses.length >= 1);
    assert.ok(elapsedMs < 15_000, `--stats --json took ${elapsedMs.toFixed(1)}ms`);
  });

  test('4. --stats --ascii --library <tempLib> exits 0 with 100% pure ASCII summary', async () => {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [binPath, '--stats', '--ascii', '--library', tempLib],
      {
        timeout: 25_000,
        env: sanitizedTestEnv({
          DSH_HOME: fakeDshHome,
        }),
      },
    );

    assertNoUnexpectedStderr(stderr);
    assert.ok(!/[^\x00-\x7f]/.test(stdout), '--stats --ascii output must contain zero non-ASCII characters');
    assert.match(stdout, /StudyHub TUI Stats \(v1\.0\.0\)/);
    assert.match(stdout, /Overview/);
    assert.match(stdout, /Courses: \d+ \| Decks: \d+ active/);
    assert.match(stdout, /Cards: \d+ total \| Due: \d+ \| Weak: \d+/);
    assert.match(stdout, /Top Courses \(\d+\)/);
  });

  test('5. dist/cli.mjs --search Memento --json --limit 2 --library <tempLib> returns bounded JSON hits', async () => {
    const t0 = performance.now();
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [distCliPath, '--search', 'Memento', '--json', '--limit', '2', '--library', tempLib],
      {
        timeout: 25_000,
        env: sanitizedTestEnv({
          DSH_HOME: fakeDshHome,
        }),
      },
    );
    const elapsedMs = performance.now() - t0;

    assertNoUnexpectedStderr(stderr);
    const report = JSON.parse(stdout);
    assert.equal(report.version, '1.0.0');
    assert.equal(report.libraryRoot, tempLib);
    assert.equal(report.query, 'Memento');
    assert.equal(report.limit, 2);
    assert.ok(typeof report.generatedAt === 'string' && !Number.isNaN(Date.parse(report.generatedAt)));
    assert.ok(Array.isArray(report.cards) && report.cards.length >= 1 && report.cards.length <= 2);
    assert.ok(Array.isArray(report.passages) && report.passages.length >= 1 && report.passages.length <= 2);
    assert.equal(report.totals.cards, report.cards.length);
    assert.equal(report.totals.passages, report.passages.length);
    assert.ok(report.totals.cards >= 1, 'expected >= 1 matched card');
    assert.ok(report.cards[0].deckId && report.cards[0].cardId && report.cards[0].prompt);
    assert.ok(typeof report.cards[0].deckTitle === 'string' && report.cards[0].deckTitle.length > 0);
    assert.ok(report.passages[0].sourceId && report.passages[0].title);
    assert.equal(typeof report.passages[0].snippet, 'string');
    assert.ok(elapsedMs < 15_000, `--search --json took ${elapsedMs.toFixed(1)}ms`);
  });

  test('6. dist/cli.mjs --search Memento --ascii and zero-match query work cleanly', async () => {
    const { stdout: hitOut, stderr: hitErr } = await execFileAsync(
      process.execPath,
      [distCliPath, '--search=Memento', '--ascii', '--limit', '3', '--library', tempLib],
      {
        timeout: 25_000,
        env: sanitizedTestEnv({
          DSH_HOME: fakeDshHome,
        }),
      },
    );
    const { stdout: emptyOut, stderr: emptyErr } = await execFileAsync(
      process.execPath,
      [distCliPath, '--search', 'zzzznonexistentquery99999', '--json', '--library', tempLib],
      {
        timeout: 25_000,
        env: sanitizedTestEnv({
          DSH_HOME: fakeDshHome,
        }),
      },
    );
    assertNoUnexpectedStderr(hitErr);
    assert.ok(!/[^\x00-\x7f]/.test(hitOut), '--search --ascii must output pure ASCII');
    assert.match(hitOut, /StudyHub TUI Search \(v1\.0\.0\)/);
    assert.match(hitOut, /Query: "Memento" \(limit 3\)/);
    assert.match(hitOut, /Matches: [1-3] cards, [1-3] passages/);

    assertNoUnexpectedStderr(emptyErr);
    const emptyReport = JSON.parse(emptyOut);
    assert.equal(emptyReport.totals.cards, 0);
    assert.equal(emptyReport.totals.passages, 0);
    assert.deepEqual(emptyReport.cards, []);
    assert.deepEqual(emptyReport.passages, []);
  });

  test('7. dist/cli.mjs --search with missing/empty query exits with code 2', async () => {
    for (const argv of [['--search'], ['--search', '   '], ['--limit', '0']]) {
      let exitCode = 0;
      let stderrText = '';
      try {
        await execFileAsync(process.execPath, [distCliPath, ...argv], { timeout: 15_000 });
      } catch (err) {
        exitCode = err.code;
        stderrText = String(err.stderr ?? '');
      }
      assert.equal(exitCode, 2, `expected exit code 2 for ${JSON.stringify(argv)}`);
      assert.match(stderrText, /^Error:/);
    }
  });

  test('8. --export <relName> writes atomic JSON inside <tempLib>/backups/ and rejects absolute / traversal escapes', async () => {
    const backupsDir = join(tempLib, 'backups');
    const expectedOutPath = join(backupsDir, 'my-backup.json');

    try {
      const { stdout, stderr } = await execFileAsync(
        process.execPath,
        [binPath, '--export', 'my-backup.json', '--json', '--library', tempLib],
        {
          timeout: 25_000,
          env: sanitizedTestEnv({
            DSH_HOME: fakeDshHome,
          }),
        },
      );

      assertNoUnexpectedStderr(stderr);
      const receipt = JSON.parse(stdout);
      assert.equal(receipt.ok, true);
      assert.equal(receipt.path, expectedOutPath);
      assert.equal(receipt.libraryRoot, tempLib);
      assert.ok(receipt.bytes > 0, `expected bytes > 0, got ${receipt.bytes}`);
      assert.ok(receipt.decks >= 1, `expected decks >= 1, got ${receipt.decks}`);
      assert.ok(receipt.cards >= 1, `expected cards >= 1, got ${receipt.cards}`);
      assert.ok(typeof receipt.generatedAt === 'string' && !Number.isNaN(Date.parse(receipt.generatedAt)));

      const backupRaw = await readFile(expectedOutPath, 'utf8');
      assert.equal(Buffer.byteLength(backupRaw, 'utf8'), receipt.bytes);
      const backup = JSON.parse(backupRaw);
      assert.ok(Array.isArray(backup.decks) && backup.decks.length >= 1, 'backup payload contains decks');
      assert.ok(Array.isArray(backup.sources) && backup.sources.length >= 1, 'backup payload contains sources');
      assert.ok(Array.isArray(backup.courses) && backup.courses.length >= 1, 'backup payload contains courses');

      const filesInBackups = await readdir(backupsDir);
      assert.deepEqual(filesInBackups, ['my-backup.json'], 'zero .tmp leftovers in backups directory');

      for (const unsafePath of [join(exportOutDir, 'escape.json'), '../escape.json']) {
        let failedCode = 0;
        let errText = '';
        try {
          await execFileAsync(
            process.execPath,
            [binPath, '--export', unsafePath, '--json', '--library', tempLib],
            {
              timeout: 15_000,
              env: sanitizedTestEnv({ DSH_HOME: fakeDshHome }),
            },
          );
        } catch (err) {
          failedCode = err.code ?? 1;
          errText = String(err.stderr ?? err.message ?? '');
        }
        assert.notEqual(failedCode, 0, `unsafe --export "${unsafePath}" must exit non-zero`);
        assert.match(errText, /Unsafe export path|backups/i);
      }
    } finally {
      await rm(backupsDir, { recursive: true, force: true });
    }
  });

  test('9. --export --ascii --library <exportDefaultLib> exits 0 with pure ASCII summary and default timestamped backup file', async () => {
    const todayYmd = todayLocalYmd();
    const expectedRe = exportFilenameRegex('studyhub-backup', 'json', todayYmd);
    const backupsDir = join(exportDefaultLib, 'backups');

    try {
      const { stdout, stderr } = await execFileAsync(
        process.execPath,
        [binPath, '--export', '--ascii', '--library', exportDefaultLib],
        {
          timeout: 25_000,
          env: sanitizedTestEnv({
            DSH_HOME: fakeDshHome,
          }),
        },
      );

      assertNoUnexpectedStderr(stderr);
      assert.ok(!/[^\x00-\x7f]/.test(stdout), '--export --ascii output must contain zero non-ASCII characters');
      assert.match(stdout, /StudyHub TUI Export \(v1\.0\.0\)/);
      assert.match(stdout, /\[ok\] Exported library backup/);

      const backupFiles = await readdir(backupsDir);
      assert.ok(
        !backupFiles.some((name) => name.endsWith('.tmp')),
        `expected zero .tmp leftovers in backups dir, found: ${backupFiles.join(', ')}`,
      );
      const matchedName = backupFiles.find((name) => expectedRe.test(name));
      assert.ok(matchedName, `expected file matching ${expectedRe} in ${JSON.stringify(backupFiles)}`);
      const expectedPath = join(backupsDir, matchedName);
      assert.ok(stdout.includes(expectedPath), `stdout mentions default backup path ${expectedPath}`);

      const backupRaw = await readFile(expectedPath, 'utf8');
      const backup = JSON.parse(backupRaw);
      assert.ok(Array.isArray(backup.decks) && backup.decks.length >= 1, 'default backup contains seeded decks');
    } finally {
      await rm(backupsDir, { recursive: true, force: true });
    }
  });

  test('10. --due --json, --due --ascii, and --course / --limit filtering work offline with zero model calls', async () => {
    const { stdout: jsonOut, stderr: jsonErr } = await execFileAsync(
      process.execPath,
      [distCliPath, '--due', '--json', '--library', tempLib],
      {
        timeout: 25_000,
        env: sanitizedTestEnv({ DSH_HOME: fakeDshHome }),
      },
    );
    assertNoUnexpectedStderr(jsonErr);
    const report = JSON.parse(jsonOut);
    assert.equal(report.version, '1.0.0');
    assert.equal(report.libraryRoot, tempLib);
    assert.equal(report.courseFilter, null);
    assert.ok(report.totals.decks >= 1, `expected decks >= 1, got ${report.totals.decks}`);
    assert.ok(report.totals.totalCards >= 1, `expected totalCards >= 1, got ${report.totals.totalCards}`);
    assert.ok(Array.isArray(report.decks) && report.decks.length >= 1);
    assert.ok(report.decks[0].id && report.decks[0].title);
    assert.equal(typeof report.decks[0].mastery, 'number');

    const sampleCourse = report.decks[0].course;
    const { stdout: filteredOut, stderr: filteredErr } = await execFileAsync(
      process.execPath,
      [distCliPath, '--due', '--json', '--course', sampleCourse, '--limit', '1', '--library', tempLib],
      {
        timeout: 25_000,
        env: sanitizedTestEnv({ DSH_HOME: fakeDshHome }),
      },
    );
    assertNoUnexpectedStderr(filteredErr);
    const filtered = JSON.parse(filteredOut);
    assert.equal(filtered.courseFilter, sampleCourse);
    assert.equal(filtered.limit, 1);
    assert.equal(filtered.decks.length, 1);
    assert.equal(filtered.decks[0].course, sampleCourse);

    const { stdout: asciiOut, stderr: asciiErr } = await execFileAsync(
      process.execPath,
      [distCliPath, '--due', '--ascii', '--library', tempLib],
      {
        timeout: 25_000,
        env: sanitizedTestEnv({ DSH_HOME: fakeDshHome }),
      },
    );
    assertNoUnexpectedStderr(asciiErr);
    assert.ok(!/[^\x00-\x7f]/.test(asciiOut), '--due --ascii output must be 100% pure ASCII');
    assert.match(asciiOut, /StudyHub TUI Due Queue \(v1\.0\.0\)/);
    assert.match(asciiOut, /Queue: \d+ due \| \d+ weak \| \d+ new/);
    assert.match(asciiOut, /Decks \(\d+\/\d+\)/);

    const { stdout: emptyOut, stderr: emptyErr } = await execFileAsync(
      process.execPath,
      [distCliPath, '--due', '--json', '--course=NoSuchCourse99999', '--library', tempLib],
      {
        timeout: 25_000,
        env: sanitizedTestEnv({ DSH_HOME: fakeDshHome }),
      },
    );
    assertNoUnexpectedStderr(emptyErr);
    const emptyReport = JSON.parse(emptyOut);
    assert.equal(emptyReport.totals.decks, 0);
    assert.deepEqual(emptyReport.decks, []);
  });

  test('11. --course with missing/empty value exits with code 2', async () => {
    for (const argv of [['--due', '--course'], ['--due', '--course=']]) {
      let exitCode = 0;
      let stderrText = '';
      try {
        await execFileAsync(process.execPath, [distCliPath, ...argv], { timeout: 15_000 });
      } catch (err) {
        exitCode = err.code;
        stderrText = String(err.stderr ?? '');
      }
      assert.equal(exitCode, 2, `expected exit code 2 for ${JSON.stringify(argv)}`);
      assert.match(stderrText, /Missing value for --course/);
    }
  });
  });
});
