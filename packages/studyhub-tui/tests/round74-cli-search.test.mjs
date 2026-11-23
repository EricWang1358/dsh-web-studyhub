// Cross-platform fast-path CLI `--search <query>` / `--limit <n>` tests:
// `node --test tests/round74-cli-search.test.mjs`
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { tsImport } from 'tsx/esm/api';

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const distCliPath = resolve(pkgRoot, 'dist', 'cli.mjs');

const cliArgsMod = await tsImport('../src/cli-args.ts', import.meta.url);
const cliCommandsMod = await tsImport('../src/cli-commands.ts', import.meta.url);
const hostMod = await tsImport('../src/host/tui-host.ts', import.meta.url);
const { parseCliArgs, cliHelpText } = cliArgsMod;
const { formatSearchReport } = cliCommandsMod;
const { createTuiHost } = hostMod;

const tempRoots = [];
async function makeTempDir(label) {
  const dir = await mkdtemp(join(tmpdir(), `studyhub-tui-search-${label}-`));
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

describe('Round 74 CLI --search headless search fast-path', () => {
  test('1. parseCliArgs handles --search, --search=..., --limit, errors, and preserves empty-argv equality', () => {
    const def = parseCliArgs([]);
    assert.equal(Object.prototype.hasOwnProperty.call(def, 'searchQuery'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(def, 'searchLimit'), false);
    assert.deepEqual(def, {
      help: false,
      version: false,
      altScreen: true,
      autoLaunchpad: true,
      skipAutoProbe: false,
    });

    const basic = parseCliArgs(['--search', 'Memento']);
    assert.equal(basic.searchQuery, 'Memento');
    assert.equal(basic.searchLimit, undefined);
    assert.equal(basic.error, undefined);

    const eq = parseCliArgs(['--search=  Bridge Pattern  ', '--limit=15', '--json']);
    assert.equal(eq.searchQuery, 'Bridge Pattern');
    assert.equal(eq.searchLimit, 15);
    assert.equal(eq.json, true);
    assert.equal(eq.error, undefined);

    const minMax = parseCliArgs(['--search', 'Adapter', '--limit', '1']);
    assert.equal(minMax.searchLimit, 1);
    assert.equal(minMax.error, undefined);

    const maxLim = parseCliArgs(['--search', 'Adapter', '--limit', '100']);
    assert.equal(maxLim.searchLimit, 100);
    assert.equal(maxLim.error, undefined);

    for (const badSearch of [
      ['--search'],
      ['--search', ''],
      ['--search', '   '],
      ['--search='],
      ['--search=   '],
      ['--search', '--json'],
    ]) {
      const parsed = parseCliArgs(badSearch);
      assert.match(parsed.error ?? '', /Missing value for --search/, `expected error for ${JSON.stringify(badSearch)}`);
    }

    for (const badLimit of [
      ['--limit'],
      ['--limit', '0'],
      ['--limit', '101'],
      ['--limit', '-1'],
      ['--limit=-5'],
      ['--limit', 'abc'],
      ['--limit', '1.5'],
      ['--limit='],
    ]) {
      const parsed = parseCliArgs(badLimit);
      assert.match(parsed.error ?? '', /Invalid --limit/, `expected error for ${JSON.stringify(badLimit)}`);
    }

    const help = cliHelpText('1.0.0');
    assert.ok(help.includes('--search <query>'), 'help text documents --search <query>');
    assert.ok(help.includes('--search <query> --json'), 'help text documents --search <query> --json');
    assert.ok(help.includes('--limit <n>'), 'help text documents --limit <n>');
  });

  test('2. formatSearchReport renders Unicode and strict 100% ASCII outputs cleanly', () => {
    const sampleReport = {
      version: '1.0.0',
      libraryRoot: '/tmp/study-lib',
      query: 'Memento · “Snapshot”',
      limit: 5,
      generatedAt: '2026-11-22T23:40:00.000Z',
      totals: { cards: 1, passages: 1 },
      cards: [
        {
          deckId: 'd1',
          cardId: 'c1',
          prompt: 'Explain Memento — state capture & restore…',
          topic: 'Memento · Basics',
          deckTitle: 'Sample · Patterns',
          course: 'Design Patterns',
        },
      ],
      passages: [
        {
          sourceId: 's1',
          title: 'Notes · Chapter 1 — Overview',
          course: 'Design Patterns',
          page: 3,
          snippet: '“Memento” captures internal state without violating encapsulation…',
        },
      ],
    };

    const unicodeOut = formatSearchReport(sampleReport, false);
    assert.match(unicodeOut, /StudyHub TUI Search \(v1\.0\.0\)/);
    assert.match(unicodeOut, /Matches: 1 cards, 1 passages/);
    assert.match(unicodeOut, /Cards \(1\)/);
    assert.match(unicodeOut, /Passages \(1\)/);
    assert.ok(unicodeOut.includes('•'), 'Unicode mode uses bullet glyph');
    assert.ok(unicodeOut.includes('─'), 'Unicode mode uses rule glyph');

    const asciiOut = formatSearchReport(sampleReport, true);
    assert.ok(!/[^\x00-\x7f]/.test(asciiOut), 'ASCII mode output must contain zero non-ASCII bytes');
    assert.match(asciiOut, /StudyHub TUI Search \(v1\.0\.0\)/);
    assert.match(asciiOut, /Query: "Memento - "Snapshot"" \(limit 5\)/);
    assert.match(asciiOut, /Cards \(1\)/);
    assert.match(asciiOut, /Passages \(1\)/);
    assert.match(asciiOut, /Notes - Chapter 1 - Overview \(p\.3\)/);

    const emptyOut = formatSearchReport(
      {
        version: '1.0.0',
        libraryRoot: '/tmp/study-lib',
        query: 'nope',
        limit: 10,
        generatedAt: '2026-11-22T23:40:00.000Z',
        totals: { cards: 0, passages: 0 },
        cards: [],
        passages: [],
      },
      true,
    );
    assert.ok(!/[^\x00-\x7f]/.test(emptyOut));
    assert.match(emptyOut, /Matches: 0 cards, 0 passages/);
    assert.match(emptyOut, /Cards \(0\)\n  - \(none\)/);
    assert.match(emptyOut, /Passages \(0\)\n  - \(none\)/);
  });

  test('3. dist/cli.mjs --search Memento --json --limit 2 --library <tempLib> returns bounded JSON hits', async () => {
    const base = await makeTempDir('json');
    const { fakeDshHome, tempLib } = await seedSampleLibrary(base, 'seed');

    const t0 = performance.now();
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [distCliPath, '--search', 'Memento', '--json', '--limit', '2', '--library', tempLib],
      {
        timeout: 15_000,
        env: {
          ...process.env,
          DSH_HOME: fakeDshHome,
        },
      },
    );
    const elapsedMs = performance.now() - t0;

    assert.equal(stderr, '');
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
    assert.ok(report.cards[0].deckId && report.cards[0].cardId && report.cards[0].prompt);
    assert.ok(report.passages[0].sourceId && report.passages[0].title);
    assert.ok(elapsedMs < 10_000, `--search --json took ${elapsedMs.toFixed(1)}ms`);
  });

  test('4. dist/cli.mjs --search Memento --ascii and zero-match query work cleanly', async () => {
    const base = await makeTempDir('ascii');
    const { fakeDshHome, tempLib } = await seedSampleLibrary(base, 'seed');

    const { stdout: hitOut, stderr: hitErr } = await execFileAsync(
      process.execPath,
      [distCliPath, '--search=Memento', '--ascii', '--limit', '3', '--library', tempLib],
      {
        timeout: 15_000,
        env: {
          ...process.env,
          DSH_HOME: fakeDshHome,
        },
      },
    );
    assert.equal(hitErr, '');
    assert.ok(!/[^\x00-\x7f]/.test(hitOut), '--search --ascii must output pure ASCII');
    assert.match(hitOut, /StudyHub TUI Search \(v1\.0\.0\)/);
    assert.match(hitOut, /Query: "Memento" \(limit 3\)/);
    assert.match(hitOut, /Matches: [1-3] cards, [1-3] passages/);

    const { stdout: emptyOut, stderr: emptyErr } = await execFileAsync(
      process.execPath,
      [distCliPath, '--search', 'zzzznonexistentquery99999', '--json', '--library', tempLib],
      {
        timeout: 15_000,
        env: {
          ...process.env,
          DSH_HOME: fakeDshHome,
        },
      },
    );
    assert.equal(emptyErr, '');
    const emptyReport = JSON.parse(emptyOut);
    assert.equal(emptyReport.totals.cards, 0);
    assert.equal(emptyReport.totals.passages, 0);
    assert.deepEqual(emptyReport.cards, []);
    assert.deepEqual(emptyReport.passages, []);
  });

  test('5. dist/cli.mjs --search with missing/empty query exits with code 2', async () => {
    for (const argv of [['--search'], ['--search', '   '], ['--limit', '0']]) {
      let exitCode = 0;
      let stderrText = '';
      try {
        await execFileAsync(process.execPath, [distCliPath, ...argv], { timeout: 10_000 });
      } catch (err) {
        exitCode = err.code;
        stderrText = String(err.stderr ?? '');
      }
      assert.equal(exitCode, 2, `expected exit code 2 for ${JSON.stringify(argv)}`);
      assert.match(stderrText, /^Error:/);
    }
  });
});
