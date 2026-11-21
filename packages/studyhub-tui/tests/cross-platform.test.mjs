// Cross-platform & static audit tests: node --test tests/cross-platform.test.mjs
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
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
const terminalMod = await tsImport('../src/terminal.ts', import.meta.url);
const pathCompleteMod = await tsImport('../src/views/sources/path-complete.ts', import.meta.url);
const contractsMod = await tsImport('../src/types/contracts.ts', import.meta.url);

const { parseCliArgs, cliHelpText } = cliArgsMod;
const { enterTerminalSession } = terminalMod;
const { completeFsPath, expandHomePath } = pathCompleteMod;
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

// ---------------------------------------------------------------------------
// 1. parseCliArgs & cliHelpText
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
    for (const theme of ['dsh-dark', 'warm-paper', 'nord', 'high-contrast']) {
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
      '--version',
      '--help',
    ]) {
      assert.ok(help.includes(flag), `help text includes ${flag}`);
    }
    assert.match(help, /agy CLI/);
    assert.match(help, /DEEPSEEK_API_KEY/);
  });
});

// ---------------------------------------------------------------------------
// 2. enterTerminalSession
// ---------------------------------------------------------------------------

describe('enterTerminalSession', () => {
  function makeMockTty({ stdoutTty = true, stdinTty = true, isRaw = true } = {}) {
    const written = [];
    const rawCalls = [];
    let defaultEncoding = null;

    const stdout = new EventEmitter();
    stdout.isTTY = stdoutTty;
    stdout.setDefaultEncoding = (enc) => {
      defaultEncoding = enc;
    };
    stdout.write = (chunk) => {
      written.push(String(chunk));
      return true;
    };

    const stdin = new EventEmitter();
    stdin.isTTY = stdinTty;
    stdin.isRaw = isRaw;
    stdin.setRawMode = (mode) => {
      rawCalls.push(mode);
      stdin.isRaw = mode;
      return stdin;
    };

    return { stdout, stdin, written, rawCalls, getEncoding: () => defaultEncoding };
  }

  test('enters alt-screen on TTY and restores idempotently', () => {
    const mock = makeMockTty({ stdoutTty: true, stdinTty: true, isRaw: true });
    const session = enterTerminalSession({ stdout: mock.stdout, stdin: mock.stdin, altScreen: true });

    assert.equal(session.isTty, true);
    assert.equal(session.altScreenActive, true);
    assert.equal(mock.getEncoding(), 'utf8');
    assert.equal(mock.written.length, 1);
    assert.ok(mock.written[0].includes('\x1b[?1049h'), 'emits alt-screen enter sequence');

    session.restore();
    assert.equal(mock.written.length, 2);
    assert.equal(mock.written[1], '\x1b[0m\x1b[?25h\x1b[?1049l');
    assert.deepEqual(mock.rawCalls, [false]);
    assert.equal(mock.stdin.isRaw, false);

    // Idempotent second restore
    session.restore();
    assert.equal(mock.written.length, 2);
    assert.deepEqual(mock.rawCalls, [false]);
  });

  test('respects altScreen: false on TTY', () => {
    const mock = makeMockTty({ stdoutTty: true, stdinTty: true, isRaw: false });
    const session = enterTerminalSession({ stdout: mock.stdout, stdin: mock.stdin, altScreen: false });

    assert.equal(session.isTty, true);
    assert.equal(session.altScreenActive, false);
    assert.deepEqual(mock.written, []);

    session.restore();
    assert.deepEqual(mock.written, ['\x1b[0m\x1b[?25h']);
    assert.deepEqual(mock.rawCalls, []);
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
    assert.deepEqual(mock.rawCalls, []);
  });
});

// ---------------------------------------------------------------------------
// 3. bin/studyhub-tui.mjs CLI execution
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
// 4. completeFsPath cross-platform path completion
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
});

// ---------------------------------------------------------------------------
// 5. Static cross-platform audit across src/**/*.ts(x) and bin/*.mjs
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

  test('runtime dynamic imports of file paths use pathToFileURL', async () => {
    const depsText = await readFile(join(pkgRoot, 'src', 'host', 'desktop-deps.ts'), 'utf8');
    assert.match(depsText, /pathToFileURL\(/, 'desktop-deps.ts uses pathToFileURL for dynamic imports');

    const binText = await readFile(binPath, 'utf8');
    assert.match(binText, /pathToFileURL\(/, 'bin/studyhub-tui.mjs uses pathToFileURL for dynamic imports');
  });
});
