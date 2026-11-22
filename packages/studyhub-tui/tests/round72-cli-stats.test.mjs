// Cross-platform fast-path CLI `--stats` / `--stats --json` tests:
// `node --test tests/round72-cli-stats.test.mjs`
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
const binPath = resolve(pkgRoot, 'bin', 'studyhub-tui.mjs');

const cliArgsMod = await tsImport('../src/cli-args.ts', import.meta.url);
const hostMod = await tsImport('../src/host/tui-host.ts', import.meta.url);
const { parseCliArgs, cliHelpText, buildStatsSummary, formatStatsSummary } = cliArgsMod;
const { createTuiHost } = hostMod;

const tempRoots = [];
async function makeTempDir(label) {
  const dir = await mkdtemp(join(tmpdir(), `studyhub-tui-stats-${label}-`));
  tempRoots.push(dir);
  return dir;
}

after(async () => {
  await Promise.all(
    tempRoots.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })),
  );
});

describe('Round 72 CLI --stats offline library dashboard summary', () => {
  test('1. parseCliArgs, buildStatsSummary, and formatStatsSummary (Unicode & ASCII)', () => {
    const def = parseCliArgs([]);
    assert.equal(def.stats, false);
    assert.equal(def.json, false);
    assert.deepEqual(def, {
      help: false,
      version: false,
      altScreen: true,
      autoLaunchpad: true,
      skipAutoProbe: false,
    });

    const statsOnly = parseCliArgs(['--stats']);
    assert.equal(statsOnly.stats, true);
    assert.equal(statsOnly.json, false);
    assert.equal(statsOnly.error, undefined);

    const statsJson = parseCliArgs(['--stats', '--json', '--library', '/tmp/study-lib']);
    assert.equal(statsJson.stats, true);
    assert.equal(statsJson.json, true);
    assert.equal(statsJson.libraryRoot, '/tmp/study-lib');
    assert.equal(statsJson.error, undefined);

    const help = cliHelpText('1.0.0');
    assert.ok(help.includes('--stats'), 'help text documents --stats');
    assert.ok(help.includes('--stats --json'), 'help text documents --stats --json');

    const fakeCourses = Array.from({ length: 10 }, (_, idx) => ({
      name: `Course ${String(idx + 1).padStart(2, '0')} · Topic`,
      active: true,
    }));
    const fakeDecks = [
      ...fakeCourses.map((c, idx) => ({
        id: `deck-${idx + 1}`,
        title: `Deck ${idx + 1}`,
        course: c.name,
        archived: false,
        cardCount: (idx + 1) * 3,
        dueCount: idx + 1,
        wrongCount: idx % 3,
      })),
      {
        id: 'deck-archived',
        title: 'Old Deck',
        course: fakeCourses[0].name,
        archived: true,
        cardCount: 99,
        dueCount: 99,
        wrongCount: 99,
      },
    ];

    const summary = buildStatsSummary({
      libraryRoot: '/tmp/study-lib',
      version: '1.0.0',
      generatedAt: '2026-11-22T12:00:00.000Z',
      snapshot: {
        courses: fakeCourses,
        decks: fakeDecks,
        sources: [{ id: 's1' }, { id: 's2' }, { id: 's3' }],
        notes: [{ id: 'n1' }],
        drafts: [{ id: 'dr1' }, { id: 'dr2' }],
      },
    });

    assert.equal(summary.version, '1.0.0');
    assert.equal(summary.libraryRoot, '/tmp/study-lib');
    assert.equal(summary.generatedAt, '2026-11-22T12:00:00.000Z');
    assert.equal(summary.counts.courses, 10);
    assert.equal(summary.counts.activeDecks, 10);
    assert.equal(summary.counts.archivedDecks, 1);
    assert.equal(summary.counts.cards, 165);
    assert.equal(summary.counts.due, 55);
    assert.equal(summary.counts.weak, 9);
    assert.equal(summary.counts.sources, 3);
    assert.equal(summary.counts.notes, 1);
    assert.equal(summary.counts.drafts, 2);
    assert.equal(summary.courses.length, 8, 'courses list capped to top 8');
    assert.equal(summary.courses[0].name, 'Course 10 · Topic');
    assert.equal(summary.courses[0].due, 10);
    assert.equal(summary.courses[0].cards, 30);
    assert.equal(summary.courses[0].decks, 1);

    const unicodeOut = formatStatsSummary(summary, false);
    assert.match(unicodeOut, /StudyHub TUI Stats \(v1\.0\.0\)/);
    assert.match(unicodeOut, /Courses: 10 \| Decks: 10 active \(1 archived\)/);
    assert.match(unicodeOut, /Cards: 165 total \| Due: 55 \| Weak: 9/);
    assert.match(unicodeOut, /Materials: 3 sources \| 1 notes \| 2 drafts/);
    assert.ok(unicodeOut.includes('•'), 'Unicode mode uses bullet chrome');

    const asciiOut = formatStatsSummary(summary, true);
    assert.ok(!/[^\x00-\x7f]/.test(asciiOut), 'ASCII mode output must be 100% pure ASCII');
    assert.match(asciiOut, /StudyHub TUI Stats \(v1\.0\.0\)/);
    assert.match(asciiOut, /Top Courses \(8\)/);
    assert.match(asciiOut, /Course 10 - Topic: 1 decks, 30 cards, 10 due/);
  });

  test('2. bin/studyhub-tui.mjs --stats --json --library <tempLib> exits 0 with valid seeded JSON and no hung handles', async () => {
    const base = await makeTempDir('json');
    const fakeDshHome = join(base, 'dsh');
    const tempLib = join(base, 'lib');
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

    const t0 = performance.now();
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [binPath, '--stats', '--json', '--library', tempLib],
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
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.version, '1.0.0');
    assert.equal(parsed.libraryRoot, tempLib);
    assert.ok(typeof parsed.generatedAt === 'string' && !Number.isNaN(Date.parse(parsed.generatedAt)));
    assert.ok(parsed.counts.activeDecks >= 1, `expected activeDecks >= 1, got ${parsed.counts.activeDecks}`);
    assert.ok(parsed.counts.cards >= 1, `expected cards >= 1, got ${parsed.counts.cards}`);
    assert.ok(parsed.counts.courses >= 1, `expected courses >= 1, got ${parsed.counts.courses}`);
    assert.ok(Array.isArray(parsed.courses) && parsed.courses.length >= 1);
    assert.ok(elapsedMs < 10_000, `--stats --json took ${elapsedMs.toFixed(1)}ms`);
  });

  test('3. bin/studyhub-tui.mjs --stats --ascii --library <tempLib> exits 0 with 100% pure ASCII summary', async () => {
    const base = await makeTempDir('ascii');
    const fakeDshHome = join(base, 'dsh');
    const tempLib = join(base, 'lib');
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

    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [binPath, '--stats', '--ascii', '--library', tempLib],
      {
        timeout: 15_000,
        env: {
          ...process.env,
          DSH_HOME: fakeDshHome,
        },
      },
    );

    assert.equal(stderr, '');
    assert.ok(!/[^\x00-\x7f]/.test(stdout), '--stats --ascii output must contain zero non-ASCII characters');
    assert.match(stdout, /StudyHub TUI Stats \(v1\.0\.0\)/);
    assert.match(stdout, /Overview/);
    assert.match(stdout, /Courses: \d+ \| Decks: \d+ active/);
    assert.match(stdout, /Cards: \d+ total \| Due: \d+ \| Weak: \d+/);
    assert.match(stdout, /Top Courses \(\d+\)/);
  });
});
