// Consolidated unit & CLI arg-parsing tests:
// `node --test tests/cli-args.test.mjs`
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { tsImport } from 'tsx/esm/api';

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const binPath = resolve(pkgRoot, 'bin', 'studyhub-tui.mjs');

const [
  cliArgsMod,
  cliCommandsMod,
  textInputMod,
  terminalMod,
  pathCompleteMod,
  sampleActionsMod,
  contractsMod,
] = await Promise.all([
  tsImport('../src/cli-args.ts', import.meta.url),
  tsImport('../src/cli-commands.ts', import.meta.url),
  tsImport('../src/components/TextInput.tsx', import.meta.url),
  tsImport('../src/terminal.ts', import.meta.url),
  tsImport('../src/views/sources/path-complete.ts', import.meta.url),
  tsImport('../src/host/sample-actions.ts', import.meta.url),
  tsImport('../src/types/contracts.ts', import.meta.url),
]);

const {
  parseCliArgs,
  cliHelpText,
  resolveColorCapability,
  shouldAutoAscii,
  shouldEnableMouse,
  buildDoctorReport,
  formatDoctorReport,
  buildStatsSummary,
  formatStatsSummary,
} = cliArgsMod;
const { formatSearchReport } = cliCommandsMod;
const { sanitizePastedText } = textInputMod;
const { enterTerminalSession, isHeadlessOrSsh } = terminalMod;
const { completeFsPath, expandHomePath } = pathCompleteMod;
const { cleanPathInput } = sampleActionsMod;
const { PAGE_REGISTRY } = contractsMod;

const tempRoots = [];
async function makeTempDir(label) {
  const dir = await mkdtemp(join(tmpdir(), `studyhub-tui-xplat-${label}-`));
  tempRoots.push(dir);
  return dir;
}

after(async () => {
  await Promise.all(
    tempRoots.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })),
  );
});

function makeMockTty({ stdoutTty = true, stdinTty = true, isRaw = true } = {}) {
  const written = [];
  const calls = [];

  const stdout = new EventEmitter();
  stdout.isTTY = stdoutTty;
  stdout.defaultEncoding = null;
  stdout.setDefaultEncoding = (enc) => {
    stdout.defaultEncoding = enc;
  };
  stdout.write = (chunk) => {
    written.push(String(chunk));
    return true;
  };

  const stdin = new EventEmitter();
  stdin.isTTY = stdinTty;
  stdin.isRaw = isRaw;
  stdin.setRawMode = (mode) => {
    calls.push(mode);
    stdin.isRaw = mode;
    return stdin;
  };

  return { stdout, stdin, written, calls };
}

// ---------------------------------------------------------------------------
// 1. sanitizePastedText
// ---------------------------------------------------------------------------

describe('sanitizePastedText', () => {
  test('strips full bracketed-paste ANSI wrappers and preserves Windows paths', () => {
    const raw = '\u001b[200~C:\\Users\\Alice\\StudyHub Notes\\lecture1.pdf\u001b[201~';
    assert.equal(sanitizePastedText(raw), 'C:\\Users\\Alice\\StudyHub Notes\\lecture1.pdf');
  });

  test('strips orphaned 200~/201~ wrappers when ESC was split by input parser', () => {
    assert.equal(sanitizePastedText('200~D:\\Work\\notes201~'), 'D:\\Work\\notes');
    assert.equal(sanitizePastedText('[200~D:\\Work\\notes[201~'), 'D:\\Work\\notes');
    assert.equal(sanitizePastedText('200~chapter1'), 'chapter1');
    assert.equal(sanitizePastedText('chapter1201~'), 'chapter1');
    assert.equal(sanitizePastedText('200~'), '');
    assert.equal(sanitizePastedText('201~'), '');
  });

  test('normalizes Windows CRLF and lone CR line breaks cleanly', () => {
    assert.equal(sanitizePastedText('line1\r\nline2\rline3\nline4'), 'line1 line2 line3 line4');
    assert.equal(sanitizePastedText('first\r\n\r\nsecond'), 'first second');
    assert.equal(
      sanitizePastedText('line1\r\nline2\rline3', { multiline: true }),
      'line1\nline2\nline3',
    );
  });

  test('removes control characters while preserving CJK, emoji, quotes, backslashes, and spaces', () => {
    const raw = '\u001b[31m"C:\\学习资料\\笔记 📚"\u001b[0m\u0000\u0007\u000b\u000c\u001f\u007f  ok';
    assert.equal(sanitizePastedText(raw), '"C:\\学习资料\\笔记 📚"  ok');
  });
});

// ---------------------------------------------------------------------------
// 2. resolveColorCapability & shouldAutoAscii
// ---------------------------------------------------------------------------

describe('resolveColorCapability', () => {
  test('honors NO_COLOR when non-empty and ignores empty NO_COLOR', () => {
    const disabled = resolveColorCapability(
      { NO_COLOR: '1', FORCE_COLOR: '3', COLORTERM: 'truecolor' },
      { isTTY: true },
    );
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.level, 0);

    const emptyNoColor = resolveColorCapability(
      { NO_COLOR: '', COLORTERM: 'truecolor' },
      { isTTY: true },
    );
    assert.equal(emptyNoColor.enabled, true);
    assert.equal(emptyNoColor.level, 3);
  });

  test('honors FORCE_COLOR=0/1/2/3/true/false even on non-TTY', () => {
    assert.deepEqual(
      { enabled: resolveColorCapability({ FORCE_COLOR: '0' }, { isTTY: true }).enabled, level: resolveColorCapability({ FORCE_COLOR: '0' }, { isTTY: true }).level },
      { enabled: false, level: 0 },
    );
    assert.deepEqual(
      { enabled: resolveColorCapability({ FORCE_COLOR: 'false' }, { isTTY: true }).enabled, level: resolveColorCapability({ FORCE_COLOR: 'false' }, { isTTY: true }).level },
      { enabled: false, level: 0 },
    );
    assert.equal(resolveColorCapability({ FORCE_COLOR: '1' }, { isTTY: false }).level, 1);
    assert.equal(resolveColorCapability({ FORCE_COLOR: '2' }, { isTTY: false }).level, 2);
    assert.equal(resolveColorCapability({ FORCE_COLOR: '3' }, { isTTY: false }).level, 3);
    assert.equal(resolveColorCapability({ FORCE_COLOR: 'true' }, { isTTY: false }).level, 3);
  });

  test('detects TERM=dumb and non-TTY as level 0', () => {
    const dumb = resolveColorCapability({ TERM: 'dumb', COLORTERM: 'truecolor' }, { isTTY: true });
    assert.equal(dumb.enabled, false);
    assert.equal(dumb.level, 0);

    const nonTty = resolveColorCapability({ COLORTERM: 'truecolor' }, { isTTY: false });
    assert.equal(nonTty.enabled, false);
    assert.equal(nonTty.level, 0);
  });

  test('detects truecolor via WT_SESSION, COLORTERM, and TERM_PROGRAM', () => {
    const wt = resolveColorCapability({ WT_SESSION: 'guid-123' }, { isTTY: true, platform: 'win32' });
    assert.equal(wt.enabled, true);
    assert.equal(wt.level, 3);

    const ct = resolveColorCapability({ COLORTERM: 'truecolor' }, { isTTY: true });
    assert.equal(ct.enabled, true);
    assert.equal(ct.level, 3);

    const ct24 = resolveColorCapability({ COLORTERM: '24bit' }, { isTTY: true });
    assert.equal(ct24.enabled, true);
    assert.equal(ct24.level, 3);

    for (const tp of ['WezTerm', 'iTerm.app', 'vscode', 'Hyper', 'Alacritty', 'kitty']) {
      const cap = resolveColorCapability({ TERM_PROGRAM: tp }, { isTTY: true });
      assert.equal(cap.enabled, true);
      assert.equal(cap.level, 3);
    }
  });

  test('detects 256-color TERM as level 2 and basic TTY as level 1', () => {
    const xterm256 = resolveColorCapability({ TERM: 'xterm-256color' }, { isTTY: true });
    assert.equal(xterm256.enabled, true);
    assert.equal(xterm256.level, 2);

    const basic = resolveColorCapability({ TERM: 'xterm' }, { isTTY: true });
    assert.equal(basic.enabled, true);
    assert.equal(basic.level, 1);
  });
});

describe('shouldAutoAscii (cross-platform & simulated win32)', () => {
  test('falls back to ASCII on legacy Windows PowerShell 5.1 conhost', () => {
    assert.equal(shouldAutoAscii({}, 'win32'), true);
  });

  test('keeps Unicode enabled on modern win32 terminals', () => {
    assert.equal(shouldAutoAscii({ WT_SESSION: 'guid-123' }, 'win32'), false);
    assert.equal(shouldAutoAscii({ TERM_PROGRAM: 'vscode' }, 'win32'), false);
    assert.equal(shouldAutoAscii({ MSYSTEM: 'MINGW64' }, 'win32'), false);
    assert.equal(shouldAutoAscii({ ConEmuANSI: 'ON' }, 'win32'), false);
    assert.equal(shouldAutoAscii({ ANSICON: '180x50' }, 'win32'), false);
    assert.equal(shouldAutoAscii({ TERM: 'xterm-256color' }, 'win32'), false);
    assert.equal(shouldAutoAscii({ TERM: 'vt100' }, 'win32'), false);
  });

  test('respects explicit STUDYHUB_TUI_ASCII overrides on win32 and TERM=dumb', () => {
    assert.equal(shouldAutoAscii({ STUDYHUB_TUI_ASCII: '0' }, 'win32'), false);
    assert.equal(shouldAutoAscii({ STUDYHUB_TUI_ASCII: 'false' }, 'win32'), false);
    assert.equal(shouldAutoAscii({ STUDYHUB_TUI_ASCII: '1', WT_SESSION: 'guid' }, 'win32'), true);
    assert.equal(shouldAutoAscii({ STUDYHUB_TUI_ASCII: 'true', WT_SESSION: 'guid' }, 'win32'), true);
    assert.equal(shouldAutoAscii({ WT_SESSION: 'guid', TERM: 'dumb' }, 'win32'), true);
  });
});

// ---------------------------------------------------------------------------
// 3. parseCliArgs, cliHelpText, mouse/doctor/stats/export/search unit tests
// ---------------------------------------------------------------------------

describe('parseCliArgs & cliHelpText', () => {
  test('parses defaults on empty argv', () => {
    const parsed = parseCliArgs([]);
    assert.deepEqual(parsed, {
      help: false,
      version: false,
      altScreen: true,
      autoLaunchpad: true,
      skipAutoProbe: false,
    });
  });

  test('parses all supported flags and positional library root', () => {
    const parsed = parseCliArgs([
      '--root',
      '/tmp/my-lib',
      '--theme=nord',
      '--lang',
      'en',
      '--page',
      'review',
      '--no-alt-screen',
      '--no-launchpad',
      '--skip-probe',
    ]);
    assert.equal(parsed.error, undefined);
    assert.equal(parsed.libraryRoot, '/tmp/my-lib');
    assert.equal(parsed.theme, 'nord');
    assert.equal(parsed.language, 'en');
    assert.equal(parsed.initialPage, 'review');
    assert.equal(parsed.altScreen, false);
    assert.equal(parsed.autoLaunchpad, false);
    assert.equal(parsed.skipAutoProbe, true);
  });

  test('supports short flags, equals syntax, and all themes/pages', () => {
    for (const theme of ['dsh-dark', 'warm-paper', 'warm-amber', 'soft-sage', 'nord', 'high-contrast']) {
      const p = parseCliArgs(['--theme', theme]);
      assert.equal(p.theme, theme);
      assert.equal(p.error, undefined);
    }
    for (const page of PAGE_REGISTRY.map((x) => x.id)) {
      const p = parseCliArgs(['-p', page]);
      assert.equal(p.initialPage, page);
      assert.equal(p.error, undefined);
    }
    assert.equal(parseCliArgs(['-h']).help, true);
    assert.equal(parseCliArgs(['--help']).help, true);
    assert.equal(parseCliArgs(['-v']).version, true);
    assert.equal(parseCliArgs(['--version']).version, true);
    assert.equal(parseCliArgs(['-r', 'C:\\Study\\Lib']).libraryRoot, 'C:\\Study\\Lib');
    assert.equal(parseCliArgs(['--root=D:\\Notes', '--lang=zh']).libraryRoot, 'D:\\Notes');
    assert.equal(parseCliArgs(['./positional-lib']).libraryRoot, './positional-lib');
    assert.equal(parseCliArgs(['--ascii']).asciiMode, true);
    assert.equal(parseCliArgs(['--unicode']).asciiMode, false);
    assert.equal(parseCliArgs(['--ascii', '--unicode']).asciiMode, false);
    assert.equal(parseCliArgs(['--unicode', '--ascii']).asciiMode, true);
  });

  test('shouldAutoAscii respects STUDYHUB_TUI_ASCII override, TERM=dumb, and platform', () => {
    assert.equal(shouldAutoAscii({ STUDYHUB_TUI_ASCII: '1' }), true);
    assert.equal(shouldAutoAscii({ TERM: 'dumb' }), true);
    assert.equal(shouldAutoAscii({ STUDYHUB_TUI_ASCII: '0', TERM: 'dumb' }), false);
    assert.equal(shouldAutoAscii({ TERM: 'xterm-256color' }), false);
    assert.equal(shouldAutoAscii({}, 'linux'), false);
    assert.equal(shouldAutoAscii({}, 'win32'), true);
    assert.equal(shouldAutoAscii({ WT_SESSION: '1' }, 'win32'), false);
  });

  test('reports errors for invalid flags and missing values', () => {
    assert.match(parseCliArgs(['--root']).error, /Missing value for --root/);
    assert.match(parseCliArgs(['-r', '--help']).error, /Missing value for --root/);
    assert.match(parseCliArgs(['--theme', 'solarized']).error, /Invalid --theme/);
    assert.match(parseCliArgs(['--lang', 'fr']).error, /Invalid --lang/);
    assert.match(parseCliArgs(['--page', 'unknown-page']).error, /Invalid --page/);
    assert.match(parseCliArgs(['--unknown-flag']).error, /Unknown option: --unknown-flag/);
  });

  test('cliHelpText documents version, flags, models, and shortcuts', () => {
    const help = cliHelpText('1.2.3');
    assert.match(help, /StudyHub TUI v1\.2\.3/);
    for (const flag of [
      '--root',
      '--page',
      '--theme',
      '--lang',
      '--no-alt-screen',
      '--no-launchpad',
      '--skip-probe',
      '--ascii',
      '--version',
      '--help',
    ]) {
      assert.ok(help.includes(flag), `help text includes ${flag}`);
    }
    assert.match(help, /agy CLI/);
    assert.match(help, /DEEPSEEK_API_KEY/);
  });
});

describe('parseCliArgs & shouldEnableMouse (--mouse / --no-mouse / STUDYHUB_TUI_MOUSE)', () => {
  test('parseCliArgs leaves mouse undefined by default and supports --mouse / --no-mouse', () => {
    const def = parseCliArgs([]);
    assert.equal(def.mouse, undefined);
    assert.equal(def.error, undefined);

    const enabled = parseCliArgs(['--mouse']);
    assert.equal(enabled.mouse, true);
    assert.equal(enabled.error, undefined);

    const disabled = parseCliArgs(['--no-mouse']);
    assert.equal(disabled.mouse, false);
    assert.equal(disabled.error, undefined);

    assert.equal(parseCliArgs(['--mouse', '--no-mouse']).mouse, false);
    assert.equal(parseCliArgs(['--no-mouse', '--mouse']).mouse, true);
  });

  test('shouldEnableMouse is opt-in and parses truthy/falsy env values', () => {
    assert.equal(shouldEnableMouse({}), false);
    assert.equal(shouldEnableMouse({ STUDYHUB_TUI_MOUSE: '' }), false);
    assert.equal(shouldEnableMouse({ STUDYHUB_TUI_MOUSE: '   ' }), false);

    for (const val of ['1', 'true', 'yes', 'on', ' TRUE ', 'On', 'Yes']) {
      assert.equal(shouldEnableMouse({ STUDYHUB_TUI_MOUSE: val }), true, `expected true for ${JSON.stringify(val)}`);
    }

    for (const val of ['0', 'false', 'no', 'off', ' FALSE ', 'Off', 'No', 'invalid']) {
      assert.equal(shouldEnableMouse({ STUDYHUB_TUI_MOUSE: val }), false, `expected false for ${JSON.stringify(val)}`);
    }
  });

  test('cliHelpText documents --mouse, --no-mouse, and STUDYHUB_TUI_MOUSE', () => {
    const help = cliHelpText('1.0.0');
    assert.ok(help.includes('--mouse'), 'help text mentions --mouse');
    assert.ok(help.includes('--no-mouse'), 'help text mentions --no-mouse');
    assert.ok(help.includes('STUDYHUB_TUI_MOUSE'), 'help text mentions STUDYHUB_TUI_MOUSE');
  });
});

describe('CLI fast-path arg parsing & report formatting (--doctor / --stats / --export / --search)', () => {
  test('parseCliArgs + buildDoctorReport handles Linux bash, Windows PowerShell conhost, and Windows Terminal without leaking keys', () => {
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

  test('parseCliArgs, buildStatsSummary, and formatStatsSummary (Unicode & ASCII)', () => {
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

  test('parseCliArgs handles --export, --export <path>, --export=<path> --json, and preserves empty-argv equality', () => {
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

  test('parseCliArgs handles --search, --search=..., --limit, errors, and preserves empty-argv equality', () => {
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

  test('formatSearchReport renders Unicode and strict 100% ASCII outputs cleanly', () => {
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
});

// ---------------------------------------------------------------------------
// 4. enterTerminalSession, SGR 1006 mouse lifecycle, & isHeadlessOrSsh
// ---------------------------------------------------------------------------

describe('enterTerminalSession', () => {
  test('enters alt-screen on TTY and restores idempotently', () => {
    const mock = makeMockTty({ stdoutTty: true, stdinTty: true, isRaw: true });
    const session = enterTerminalSession({ stdout: mock.stdout, stdin: mock.stdin, altScreen: true });

    assert.equal(session.isTty, true);
    assert.equal(session.altScreenActive, true);
    assert.equal(mock.stdout.defaultEncoding, 'utf8');
    assert.equal(mock.written.length, 1);
    assert.ok(mock.written[0].includes('\x1b[?1049h'), 'emits alt-screen enter sequence');

    session.restore();
    assert.equal(mock.written.length, 2);
    assert.equal(mock.written[1], '\x1b[0m\x1b[?25h\x1b[?1049l');
    assert.deepEqual(mock.calls, [false]);
    assert.equal(mock.stdin.isRaw, false);

    // Idempotent second restore
    session.restore();
    assert.equal(mock.written.length, 2);
    assert.deepEqual(mock.calls, [false]);
  });

  test('respects altScreen: false on TTY', () => {
    const mock = makeMockTty({ stdoutTty: true, stdinTty: true, isRaw: false });
    const session = enterTerminalSession({ stdout: mock.stdout, stdin: mock.stdin, altScreen: false });

    assert.equal(session.isTty, true);
    assert.equal(session.altScreenActive, false);
    assert.deepEqual(mock.written, []);

    session.restore();
    assert.deepEqual(mock.written, ['\x1b[0m\x1b[?25h']);
    assert.deepEqual(mock.calls, []);
  });

  test('is a safe no-op on non-TTY streams', () => {
    const mock = makeMockTty({ stdoutTty: false, stdinTty: false, isRaw: false });
    const session = enterTerminalSession({ stdout: mock.stdout, stdin: mock.stdin, altScreen: true });

    assert.equal(session.isTty, false);
    assert.equal(session.altScreenActive, false);
    assert.deepEqual(mock.written, []);

    session.restore();
    session.restore();
    assert.deepEqual(mock.written, []);
    assert.deepEqual(mock.calls, []);
  });
});

describe('enterTerminalSession SGR 1006 mouse lifecycle', () => {
  test('default (mouse omitted or false) writes alt screen ONLY and keeps mouseActive false', () => {
    for (const mouseOpt of [undefined, false]) {
      const mock = makeMockTty();
      const session = enterTerminalSession({
        stdout: mock.stdout,
        stdin: mock.stdin,
        altScreen: true,
        ...(mouseOpt === undefined ? {} : { mouse: mouseOpt }),
      });

      assert.equal(session.isTty, true);
      assert.equal(session.altScreenActive, true);
      assert.equal(session.mouseActive, false);
      assert.equal(mock.written.length, 1);
      assert.ok(mock.written[0].includes('\x1b[?1049h'), 'enters alt screen');
      assert.ok(!mock.written[0].includes('\x1b[?1000h'), 'does not write 1000h');
      assert.ok(!mock.written[0].includes('\x1b[?1006h'), 'does not write 1006h');

      session.restore();
      assert.equal(mock.written.length, 2);
      assert.equal(mock.written[1], '\x1b[0m\x1b[?25h\x1b[?1049l');
      assert.ok(!mock.written[1].includes('\x1b[?1006l'));
      assert.ok(!mock.written[1].includes('\x1b[?1000l'));
    }
  });

  test('opt-in (mouse: true) enables SGR 1006 mouse and disables it BEFORE alt-screen exit idempotently', () => {
    const mock = makeMockTty();
    const session = enterTerminalSession({
      stdout: mock.stdout,
      stdin: mock.stdin,
      altScreen: true,
      mouse: true,
    });

    assert.equal(session.isTty, true);
    assert.equal(session.altScreenActive, true);
    assert.equal(session.mouseActive, true);
    const entryOutput = mock.written.join('');
    assert.ok(entryOutput.includes('\x1b[?1049h'), 'enters alt screen');
    assert.ok(entryOutput.includes('\x1b[?1000h\x1b[?1006h'), 'enables SGR 1006 mouse');

    const countBeforeRestore = mock.written.length;
    session.restore();
    assert.equal(mock.written.length, countBeforeRestore + 1);
    const restoreSeq = mock.written[mock.written.length - 1];
    const disableIdx = restoreSeq.indexOf('\x1b[?1006l\x1b[?1000l');
    const exitAltIdx = restoreSeq.indexOf('\x1b[?1049l');
    const resetIdx = restoreSeq.indexOf('\x1b[0m\x1b[?25h');
    assert.ok(disableIdx >= 0, 'restore writes DISABLE_SGR_MOUSE');
    assert.ok(resetIdx > disableIdx, 'DISABLE_SGR_MOUSE precedes style reset & show cursor');
    assert.ok(exitAltIdx > disableIdx, 'DISABLE_SGR_MOUSE precedes EXIT_ALT_SCREEN');
    assert.deepEqual(mock.calls, [false]);

    // Idempotent second restore()
    session.restore();
    assert.equal(mock.written.length, countBeforeRestore + 1);
    assert.deepEqual(mock.calls, [false]);
  });

  test('opt-in (mouse: true, altScreen: false) enables and restores SGR mouse without alt screen', () => {
    const mock = makeMockTty({ isRaw: false });
    const session = enterTerminalSession({
      stdout: mock.stdout,
      stdin: mock.stdin,
      altScreen: false,
      mouse: true,
    });

    assert.equal(session.altScreenActive, false);
    assert.equal(session.mouseActive, true);
    assert.equal(mock.written.join(''), '\x1b[?1000h\x1b[?1006h');

    session.restore();
    assert.equal(mock.written[mock.written.length - 1], '\x1b[?1006l\x1b[?1000l\x1b[0m\x1b[?25h');
  });

  test('non-TTY streams keep mouseActive false and write nothing even with mouse: true', () => {
    for (const [stdoutTty, stdinTty] of [
      [false, false],
      [false, true],
      [true, false],
    ]) {
      const mock = makeMockTty({ stdoutTty, stdinTty, isRaw: false });
      const session = enterTerminalSession({
        stdout: mock.stdout,
        stdin: mock.stdin,
        altScreen: true,
        mouse: true,
      });

      assert.equal(session.isTty, false);
      assert.equal(session.altScreenActive, false);
      assert.equal(session.mouseActive, false);
      assert.deepEqual(mock.written, []);

      session.restore();
      session.restore();
      assert.deepEqual(mock.written, []);
      assert.deepEqual(mock.calls, []);
    }
  });
});

describe('isHeadlessOrSsh', () => {
  test('detects SSH sessions across Linux, macOS, and Windows', () => {
    assert.equal(isHeadlessOrSsh({ SSH_TTY: '/dev/pts/0', DISPLAY: ':0' }, 'linux'), true);
    assert.equal(isHeadlessOrSsh({ SSH_CONNECTION: '10.0.0.1 1234 10.0.0.2 22' }, 'darwin'), true);
    assert.equal(isHeadlessOrSsh({ SSH_CLIENT: '10.0.0.1 1234 22' }, 'win32'), true);
    assert.equal(isHeadlessOrSsh({ SSH_TTY: '   ', DISPLAY: ':0' }, 'linux'), false);
  });

  test('distinguishes Linux headless, Linux X11/Wayland, WSL2, macOS, and Windows', () => {
    assert.equal(isHeadlessOrSsh({}, 'linux'), true);
    assert.equal(isHeadlessOrSsh({ DISPLAY: '', WAYLAND_DISPLAY: '' }, 'linux'), true);
    assert.equal(isHeadlessOrSsh({ DISPLAY: ':0' }, 'linux'), false);
    assert.equal(isHeadlessOrSsh({ WAYLAND_DISPLAY: 'wayland-0' }, 'linux'), false);
    assert.equal(isHeadlessOrSsh({ WSL_DISTRO_NAME: 'Ubuntu' }, 'linux'), false);
    assert.equal(isHeadlessOrSsh({ WSL_INTEROP: '/run/WSL/100_interop' }, 'linux'), false);
    assert.equal(isHeadlessOrSsh({ WSL_DISTRO_NAME: 'Ubuntu', SSH_TTY: '/dev/pts/1' }, 'linux'), true);
    assert.equal(isHeadlessOrSsh({}, 'darwin'), false);
    assert.equal(isHeadlessOrSsh({}, 'win32'), false);
  });
});

// ---------------------------------------------------------------------------
// 5. bin/studyhub-tui.mjs basic CLI flags
// ---------------------------------------------------------------------------

describe('bin/studyhub-tui.mjs CLI', () => {
  test('--version prints version and exits 0', async () => {
    const { stdout, stderr } = await execFileAsync(process.execPath, [binPath, '--version'], {
      timeout: 15_000,
    });
    assert.equal(stderr, '');
    assert.equal(stdout.trim(), 'studyhub-tui 1.0.0');
  });

  test('--help prints help text and exits 0', async () => {
    const { stdout, stderr } = await execFileAsync(process.execPath, [binPath, '--help'], {
      timeout: 15_000,
    });
    assert.equal(stderr, '');
    assert.match(stdout, /StudyHub TUI v1\.0\.0/);
    assert.match(stdout, /--no-alt-screen/);
    assert.match(stdout, /--skip-probe/);
  });

  test('invalid flag prints error and exits with code 2', async () => {
    await assert.rejects(
      execFileAsync(process.execPath, [binPath, '--definitely-invalid'], { timeout: 15_000 }),
      (err) => err.code === 2 && /Unknown option: --definitely-invalid/.test(err.stderr),
    );
  });
});

// ---------------------------------------------------------------------------
// 6. completeFsPath & cleanPathInput cross-platform path handling
// ---------------------------------------------------------------------------

describe('completeFsPath', () => {
  test('completes POSIX paths, directories before files, and extension filters', async () => {
    const root = await makeTempDir('fs-posix');
    const sub = join(root, 'lectures');
    await mkdir(sub, { recursive: true });
    await writeFile(join(root, 'notes.md'), '# Notes', 'utf8');
    await writeFile(join(root, 'slides.pdf'), '%PDF', 'utf8');
    await writeFile(join(root, 'ignored.exe'), 'MZ', 'utf8');

    const all = await completeFsPath(`${root}/`, { extensions: ['.md', '.pdf'] });
    assert.equal(all.matches.length, 3);
    assert.ok(all.matches[0].endsWith('lectures/'), `directories sort first: ${all.matches[0]}`);
    assert.ok(!all.matches.some((m) => m.endsWith('ignored.exe')), 'filters out unsupported extensions');

    const exact = await completeFsPath(`${root}/no`, { extensions: ['.md', '.pdf'] });
    assert.equal(exact.isExactFile, true);
    assert.equal(exact.completed, `${root}/notes.md`);

    const multi = await completeFsPath(`${root}/`, { extensions: ['.md', '.pdf'] });
    assert.equal(multi.isExactFile, false);
  });

  test('expands ~ and ~/sub cleanly without touching real homedir', async () => {
    const fakeHome = await makeTempDir('fs-home');
    await mkdir(join(fakeHome, 'docs'), { recursive: true });
    await writeFile(join(fakeHome, 'docs', 'chapter1.pdf'), '%PDF', 'utf8');

    assert.equal(expandHomePath('~', fakeHome), fakeHome);
    assert.equal(expandHomePath('~/docs', fakeHome), join(fakeHome, 'docs'));

    const tilde = await completeFsPath('~', { home: fakeHome, platform: 'linux' });
    assert.equal(tilde.completed, '~/');
    assert.equal(tilde.directory, fakeHome);

    const sub = await completeFsPath('~/docs/ch', { home: fakeHome, extensions: ['.pdf'], platform: 'linux' });
    assert.equal(sub.completed, '~/docs/chapter1.pdf');
    assert.equal(sub.isExactFile, true);
  });

  test('returns empty matches cleanly on missing paths without throwing', async () => {
    const missing = await completeFsPath('/definitely/nonexistent/path/prefix');
    assert.deepEqual(missing.matches, []);
    assert.equal(missing.isExactFile, false);

    const winMissing = await completeFsPath('C:\\definitely\\missing\\file.pdf', { platform: 'win32' });
    assert.deepEqual(winMissing.matches, []);
    assert.equal(winMissing.isExactFile, false);
  });

  test('handles Windows-style backslash separators cleanly without throwing', async () => {
    const fakeHome = await makeTempDir('fs-win');
    await mkdir(join(fakeHome, 'materials'), { recursive: true });
    await writeFile(join(fakeHome, 'materials', 'exam.txt'), 'hi', 'utf8');

    const tildeWin = await completeFsPath('~', { home: fakeHome, platform: 'win32' });
    assert.equal(tildeWin.completed, '~\\');

    const relWin = await completeFsPath('~\\mat', { home: fakeHome, platform: 'win32' });
    assert.ok(relWin.completed === '~\\materials\\' || relWin.completed === '~\\materials/', `got ${relWin.completed}`);
    assert.ok(relWin.matches.some((m) => m.startsWith('~\\materials')));

    const nestedWin = await completeFsPath('~\\materials\\ex', {
      home: fakeHome,
      extensions: ['.txt'],
      platform: 'win32',
    });
    assert.equal(nestedWin.completed, '~\\materials\\exam.txt');
    assert.equal(nestedWin.isExactFile, true);
  });

  test('handles UNC prefixes and Windows drive roots cleanly on both linux and win32 without throwing', async () => {
    const inputs = [
      '\\\\server\\share\\notes.pdf',
      '\\\\server\\share\\',
      '\\\\server\\share',
      '\\\\server',
      '\\\\',
      '//server/share/notes.pdf',
      '//server/share/',
      'C:\\',
      'D:/',
      'C:',
    ];
    for (const platform of ['linux', 'win32']) {
      for (const input of inputs) {
        const res = await completeFsPath(input, { platform });
        assert.equal(typeof res.completed, 'string');
        assert.ok(Array.isArray(res.matches));
        assert.equal(res.isExactFile, false);
      }
    }
  });
});

describe('cleanPathInput', () => {
  test('strips PowerShell drag-and-drop prefix when followed by quoted paths', () => {
    assert.equal(cleanPathInput("& 'C:\\Users\\My Docs\\file.pdf'"), 'C:\\Users\\My Docs\\file.pdf');
    assert.equal(cleanPathInput('& "C:\\path\\file.pdf"'), 'C:\\path\\file.pdf');
    assert.equal(cleanPathInput("  &   '\\\\server\\share\\My Notes.pdf'  "), '\\\\server\\share\\My Notes.pdf');
    assert.equal(cleanPathInput('& unquoted.pdf'), '& unquoted.pdf');
  });

  test('preserves Windows UNC paths, drive roots, and WSL2 paths', () => {
    assert.equal(cleanPathInput('\\\\server\\share\\notes.pdf'), '\\\\server\\share\\notes.pdf');
    assert.equal(cleanPathInput('\\\\server\\share\\ My Notes.pdf'), '\\\\server\\share\\ My Notes.pdf');
    assert.equal(cleanPathInput('//server/share/notes.pdf'), '//server/share/notes.pdf');
    assert.equal(cleanPathInput('  //server/share/notes.pdf  '), '//server/share/notes.pdf');
    assert.equal(cleanPathInput('C:\\'), 'C:\\');
    assert.equal(cleanPathInput('D:/'), 'D:/');
    assert.equal(cleanPathInput('/mnt/c/Users/Alice/notes.pdf'), '/mnt/c/Users/Alice/notes.pdf');
    if (process.platform !== 'win32') {
      assert.equal(cleanPathInput('/mnt/c/Users/Alice/My\\ Notes.pdf'), '/mnt/c/Users/Alice/My Notes.pdf');
    }
  });
});

// ---------------------------------------------------------------------------
// 7. Static cross-platform audit across src/**/*.ts(x) and bin/*.mjs
// ---------------------------------------------------------------------------

async function collectFiles(dir, exts) {
  const out = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await collectFiles(full, exts)));
    } else if (exts.some((ext) => entry.name.endsWith(ext))) {
      out.push(full);
    }
  }
  return out;
}

describe('static cross-platform audit (src/**/*.ts(x) & bin/*.mjs)', () => {
  test('contains zero /bin/sh or bash -c spawns, static lib/ imports, or mandatory Alt+ shortcuts', async () => {
    const srcFiles = await collectFiles(join(pkgRoot, 'src'), ['.ts', '.tsx']);
    const binFiles = await collectFiles(join(pkgRoot, 'bin'), ['.mjs']);
    const allFiles = [...srcFiles, ...binFiles];
    assert.ok(allFiles.length > 20, `expected > 20 source files, got ${allFiles.length}`);

    const violations = [];
    for (const file of allFiles) {
      const text = await readFile(file, 'utf8');
      const rel = file.slice(pkgRoot.length + 1);

      // 1. No /bin/sh or bash -c spawns
      if (/\/bin\/sh|bash\s+-c|\bspawn\w*\s*\(\s*['"](?:sh|bash)['"]/.test(text)) {
        violations.push(`${rel}: POSIX shell spawn (/bin/sh or bash -c)`);
      }

      // 2. No static upstream lib/ imports (must use desktop-deps.ts runtime loader)
      if (/(?:import|from)\s+['"][^'"]*\/lib\/[^'"]*['"]/.test(text)) {
        violations.push(`${rel}: static upstream .../lib/... import`);
      }

      // 3. No mandatory Alt+ only shortcuts (outside TextInput word-navigation/multiline Enter optional ergonomics)
      if (/['"]Alt\+[A-Za-z0-9]['"]/.test(text)) {
        violations.push(`${rel}: raw Alt+ shortcut`);
      }
    }

    assert.deepEqual(violations, [], `Cross-platform audit violations:\n${violations.join('\n')}`);
  });

  test('runtime dynamic imports resolve file paths containing # and spaces via file URLs', async () => {
    const sandbox = await makeTempDir('file-url-import');

    // 1. bin/studyhub-tui.mjs dynamically imports dist/cli.mjs from a path containing '#' and spaces.
    //    Without pathToFileURL(), Node ESM truncates at '#' as a URL fragment on every OS and fails on Windows drive letters.
    const fakePkg = join(sandbox, 'tui #1 space');
    await mkdir(join(fakePkg, 'bin'), { recursive: true });
    await mkdir(join(fakePkg, 'dist'), { recursive: true });
    const tempBin = join(fakePkg, 'bin', 'studyhub-tui.mjs');
    await copyFile(binPath, tempBin);
    await writeFile(join(fakePkg, 'dist', 'cli.mjs'), "process.stdout.write('STUB_DIST_CLI_OK\\n');\n", 'utf8');

    const binRun = await execFileAsync(process.execPath, [tempBin], { timeout: 15_000 });
    assert.equal(binRun.stderr, '');
    assert.equal(binRun.stdout.trim(), 'STUB_DIST_CLI_OK');

    // 1b. bin/studyhub-tui.mjs dev fallback (no dist/cli.mjs) passes node_modules/tsx/dist/loader.mjs as a file URL to `--import`.
    const fakeDevPkg = join(sandbox, 'tui dev #3 space');
    await mkdir(join(fakeDevPkg, 'bin'), { recursive: true });
    await mkdir(join(fakeDevPkg, 'node_modules', 'tsx', 'dist'), { recursive: true });
    await mkdir(join(fakeDevPkg, 'src'), { recursive: true });
    const tempDevBin = join(fakeDevPkg, 'bin', 'studyhub-tui.mjs');
    await copyFile(binPath, tempDevBin);
    await writeFile(
      join(fakeDevPkg, 'node_modules', 'tsx', 'dist', 'loader.mjs'),
      "process.stdout.write('STUB_DEV_LOADER_OK\\n'); process.exit(0);\n",
      'utf8',
    );
    await writeFile(join(fakeDevPkg, 'src', 'cli.tsx'), '\n', 'utf8');

    const devBinRun = await execFileAsync(process.execPath, [tempDevBin], { timeout: 15_000 });
    assert.equal(devBinRun.stderr, '');
    assert.equal(devBinRun.stdout.trim(), 'STUB_DEV_LOADER_OK');

    // 2. desktop-deps.ts loadDesktopDeps() dynamically imports all 12 desktop modules from a STUDYHUB_DESKTOP_ROOT containing '#' and spaces.
    const fakeDesktop = join(sandbox, 'desktop #2 space');
    const stubModules = {
      'package.json': '{"type":"module"}\n',
      'application/desktop-host.js': "export const createDesktopHost = () => 'STUB_HOST_OK';\n",
      'application/provider-discovery.js': 'export const createProviderDiscovery = () => ({});\nexport const localizeProviders = () => [];\n',
      'adapters/cli/agy-adapter.mjs': 'export const createAgyCompleteAdapter = () => undefined;\nexport const probeAgyModels = async () => [];\nexport const probeCliVersion = async () => null;\n',
      'adapters/cli/codex-adapter.mjs': 'export const createCodexCompleteAdapter = () => undefined;\nexport const probeCodexAuth = async () => ({});\nexport const probeCodexModels = async () => [];\n',
      'adapters/cli/candidate-paths.mjs': 'export const listCandidatePaths = async () => [];\n',
      'adapters/cli/process-runner.mjs': 'export const createProcessRunner = () => ({});\nexport const spawnDetached = () => {};\n',
      'adapters/http/openai-adapter.mjs': 'export const createOpenAiCompleteAdapter = () => undefined;\n',
      'adapters/runtime/job-executor.mjs': 'export const createInProcessJobExecutor = () => ({});\n',
      'adapters/storage/config-store.mjs': 'export const createConfigStore = () => ({});\n',
      'adapters/storage/library-watcher.mjs': 'export const createDesktopLibraryEvents = () => ({});\n',
      'domain/config-policy.js': 'export const OPENAI_PRESETS = [];\nexport const redactDesktopConfig = () => ({});\nexport const resolveEffectiveModel = () => ({});\nexport const normalizeDesktopConfig = () => ({});\n',
      'domain/shim-parser.js': 'export const openableExternalUrl = () => null;\n',
    };
    for (const [rel, content] of Object.entries(stubModules)) {
      const target = join(fakeDesktop, rel);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, 'utf8');
    }

    const tsxLoaderUrl = pathToFileURL(join(pkgRoot, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
    const desktopDepsUrl = pathToFileURL(join(pkgRoot, 'src', 'host', 'desktop-deps.ts')).href;
    const depsRun = await execFileAsync(
      process.execPath,
      [
        '--import',
        tsxLoaderUrl,
        '--input-type=module',
        '-e',
        'const mod = await import(process.env.TEST_DESKTOP_DEPS_URL); const deps = await mod.loadDesktopDeps(); console.log(JSON.stringify({ desktopRoot: deps.desktopRoot, frozen: Object.isFrozen(deps), host: deps.createDesktopHost(), presets: deps.OPENAI_PRESETS.length }));',
      ],
      {
        cwd: pkgRoot,
        env: {
          ...process.env,
          STUDYHUB_DESKTOP_ROOT: fakeDesktop,
          TEST_DESKTOP_DEPS_URL: desktopDepsUrl,
        },
        timeout: 15_000,
      },
    );
    assert.equal(depsRun.stderr, '');
    const parsed = JSON.parse(depsRun.stdout.trim());
    assert.deepEqual(parsed, {
      desktopRoot: resolve(fakeDesktop),
      frozen: true,
      host: 'STUB_HOST_OK',
      presets: 0,
    });
  });
});
