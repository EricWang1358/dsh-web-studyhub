// Cross-platform fast-path CLI `--doctor` / `--doctor --json` tests:
// `node --test tests/round65-cli-doctor.test.mjs`
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
const { parseCliArgs, cliHelpText, buildDoctorReport, formatDoctorReport } = cliArgsMod;

const tempRoots = [];
async function makeTempDir(label) {
  const dir = await mkdtemp(join(tmpdir(), `studyhub-tui-doctor-${label}-`));
  tempRoots.push(dir);
  return dir;
}

after(async () => {
  await Promise.all(
    tempRoots.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })),
  );
});

describe('Round 65 CLI --doctor diagnostics', () => {
  test('1. parseCliArgs + buildDoctorReport handles Linux bash, Windows PowerShell conhost, and Windows Terminal without leaking keys', () => {
    const def = parseCliArgs([]);
    assert.equal(def.doctor, false);
    assert.equal(def.json, false);

    const docOnly = parseCliArgs(['--doctor']);
    assert.equal(docOnly.doctor, true);
    assert.equal(docOnly.json, false);
    assert.equal(docOnly.error, undefined);

    const docJson = parseCliArgs(['--doctor', '--json']);
    assert.equal(docJson.doctor, true);
    assert.equal(docJson.json, true);
    assert.equal(docJson.error, undefined);

    const help = cliHelpText('1.0.0');
    assert.ok(help.includes('--doctor'), 'help text documents --doctor');
    assert.ok(help.includes('--doctor --json'), 'help text documents --doctor --json');

    const secretDeepseek = 'sk-deepseek-super-secret-value-123';
    const secretOpenai = 'sk-openai-super-secret-value-456';

    // Simulated Linux bash with COLORTERM=truecolor
    const linuxReport = buildDoctorReport({
      env: {
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        DEEPSEEK_API_KEY: secretDeepseek,
        OPENAI_API_KEY: secretOpenai,
      },
      platform: 'linux',
      arch: 'x64',
      nodeVersion: 'v22.15.0',
      isTty: true,
      stdoutCols: 120,
      stdoutRows: 36,
      version: '1.0.0',
      args: docOnly,
      dshHome: '/home/user/.dsh',
      tuiPrefsPath: '/home/user/.dsh/study/tui.json',
      tuiPrefsExists: true,
      desktopRoot: '/opt/studyhub/packages/studyhub-desktop',
      agyPath: '/usr/local/bin/agy',
    });

    assert.equal(linuxReport.platform, 'linux');
    assert.equal(linuxReport.terminal.colorLevel, 3);
    assert.equal(linuxReport.terminal.colorLabel, 'truecolor');
    assert.equal(linuxReport.terminal.asciiMode, false);
    assert.equal(linuxReport.terminal.cols, 120);
    assert.equal(linuxReport.terminal.rows, 36);
    assert.equal(linuxReport.providers.agyInPath, true);
    assert.equal(linuxReport.providers.agyPath, '/usr/local/bin/agy');
    assert.deepEqual(linuxReport.providers.envKeysPresent, ['DEEPSEEK_API_KEY', 'OPENAI_API_KEY']);

    const linuxJson = JSON.stringify(linuxReport);
    const linuxFormatted = formatDoctorReport(linuxReport, false);
    assert.ok(!linuxJson.includes(secretDeepseek), 'JSON report never embeds DeepSeek key');
    assert.ok(!linuxJson.includes(secretOpenai), 'JSON report never embeds OpenAI key');
    assert.ok(!linuxFormatted.includes(secretDeepseek), 'Formatted report never embeds DeepSeek key');
    assert.ok(!linuxFormatted.includes(secretOpenai), 'Formatted report never embeds OpenAI key');

    // Simulated legacy Windows PowerShell 5.1 conhost (no WT_SESSION)
    const psConhostReport = buildDoctorReport({
      env: {
        ZHIPU_API_KEY: 'zhipu-secret-should-never-appear',
      },
      platform: 'win32',
      arch: 'x64',
      nodeVersion: 'v22.15.0',
      isTty: true,
      stdoutCols: 80,
      stdoutRows: 24,
      version: '1.0.0',
      args: docOnly,
      dshHome: 'C:\\Users\\Alice\\.dsh',
      tuiPrefsPath: 'C:\\Users\\Alice\\.dsh\\study\\tui.json',
      tuiPrefsExists: false,
      desktopRoot: 'C:\\StudyHub\\packages\\studyhub-desktop',
      agyPath: null,
    });

    assert.equal(psConhostReport.platform, 'win32');
    assert.equal(psConhostReport.terminal.wtSession, false);
    assert.equal(psConhostReport.terminal.asciiMode, true);
    assert.equal(psConhostReport.terminal.asciiReason, 'win32-conhost');
    assert.equal(psConhostReport.providers.agyInPath, false);
    assert.deepEqual(psConhostReport.providers.envKeysPresent, ['ZHIPU_API_KEY']);

    const psFormatted = formatDoctorReport(psConhostReport, psConhostReport.terminal.asciiMode);
    assert.ok(!/[^\x00-\x7f]/.test(psFormatted), 'conhost doctor output is 100% pure ASCII');
    assert.ok(!psFormatted.includes('zhipu-secret-should-never-appear'));

    // Simulated Windows Terminal (WT_SESSION set)
    const wtReport = buildDoctorReport({
      env: {
        WT_SESSION: '00000000-1111-2222-3333-444444444444',
        OPENROUTER_API_KEY: 'or-secret-xyz',
      },
      platform: 'win32',
      arch: 'x64',
      nodeVersion: 'v22.15.0',
      isTty: true,
      stdoutCols: 120,
      stdoutRows: 40,
      version: '1.0.0',
      args: docOnly,
      dshHome: 'C:\\Users\\Alice\\.dsh',
      tuiPrefsPath: 'C:\\Users\\Alice\\.dsh\\study\\tui.json',
      tuiPrefsExists: true,
      desktopRoot: 'C:\\StudyHub\\packages\\studyhub-desktop',
      agyPath: 'C:\\Tools\\agy.cmd',
    });

    assert.equal(wtReport.terminal.wtSession, true);
    assert.equal(wtReport.terminal.colorLevel, 3);
    assert.equal(wtReport.terminal.asciiMode, false);
    assert.equal(wtReport.terminal.asciiReason, 'WT_SESSION');
    assert.equal(wtReport.providers.agyInPath, true);
    assert.deepEqual(wtReport.providers.envKeysPresent, ['OPENROUTER_API_KEY']);
    assert.ok(!JSON.stringify(wtReport).includes('or-secret-xyz'));
  });

  test('2. bin/studyhub-tui.mjs --doctor --json exits 0, outputs valid JSON, never leaks API keys, and runs fast', async () => {
    const fakeDshHome = await makeTempDir('json');
    const studyDir = join(fakeDshHome, 'study');
    await mkdir(studyDir, { recursive: true });
    await writeFile(join(studyDir, 'tui.json'), JSON.stringify({ theme: 'dsh-dark' }), 'utf8');

    const secret = 'sk-secret-do-not-leak';
    const t0 = performance.now();
    const { stdout, stderr } = await execFileAsync(process.execPath, [binPath, '--doctor', '--json'], {
      timeout: 10_000,
      env: {
        ...process.env,
        DSH_HOME: fakeDshHome,
        DEEPSEEK_API_KEY: secret,
      },
    });
    const elapsedMs = performance.now() - t0;

    assert.equal(stderr, '');
    assert.ok(!stdout.includes(secret), 'stdout must not leak DEEPSEEK_API_KEY value');
    assert.ok(!stderr.includes(secret), 'stderr must not leak DEEPSEEK_API_KEY value');

    const parsed = JSON.parse(stdout);
    assert.equal(parsed.version, '1.0.0');
    assert.equal(parsed.platform, process.platform);
    assert.equal(parsed.paths.dshHome, fakeDshHome);
    assert.equal(parsed.paths.tuiPrefsPath, join(studyDir, 'tui.json'));
    assert.equal(parsed.paths.tuiPrefsExists, true);
    assert.ok(parsed.paths.desktopRoot && parsed.paths.desktopRoot.endsWith('studyhub-desktop'));
    assert.ok(Array.isArray(parsed.providers.envKeysPresent));
    assert.ok(parsed.providers.envKeysPresent.includes('DEEPSEEK_API_KEY'));
    assert.ok(elapsedMs < 2_000, `cold --doctor --json took ${elapsedMs.toFixed(1)}ms`);
  });

  test('3. bin/studyhub-tui.mjs --doctor --ascii exits 0 with 100% pure ASCII human-readable diagnostics', async () => {
    const fakeDshHome = await makeTempDir('ascii');
    const secret = 'sk-ascii-secret-never-print';
    const { stdout, stderr } = await execFileAsync(process.execPath, [binPath, '--doctor', '--ascii'], {
      timeout: 10_000,
      env: {
        ...process.env,
        DSH_HOME: fakeDshHome,
        OPENAI_API_KEY: secret,
      },
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
});
