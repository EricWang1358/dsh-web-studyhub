// Packaging, Out-of-Repo Bin Smoke, and 64-Transition Resize-Storm Soak:
// `node --test tests/packaging-smoke.test.mjs`
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import v8 from 'node:v8';
import vm from 'node:vm';
import { render } from 'ink';
import React from 'react';
import {
  createTempTracker,
  createVirtualTty,
  disposeTerminalPool,
  distDir,
  installNoNetworkGuard,
  loadDistRuntime,
  pkgRoot,
  resolveNpmCommand,
  sanitizedTestEnv,
} from './helpers/virtual-tty.mjs';

const execFileAsync = promisify(execFile);
const binEntry = resolve(pkgRoot, 'bin', 'studyhub-tui.mjs');

const runtime = await loadDistRuntime();
const { StudyHubTuiApp, createTuiHost } = runtime;
assert.ok(StudyHubTuiApp, 'dist/ must export StudyHubTuiApp');
assert.ok(createTuiHost, 'dist/ must export createTuiHost');

const appCode = await readFile(join(distDir, 'App.mjs'), 'utf8');
const cjkImport = appCode.match(/import\s*\{[^}]*\bdisplayWidth\b[^}]*\}\s*from\s*["'](\.\/[^"']+\.mjs)["']/);
assert.ok(cjkImport, 'dist/App.mjs must import displayWidth');
const { displayWidth } = await import(pathToFileURL(resolve(distDir, cjkImport[1])).href);
assert.ok(displayWidth, 'dist/ must export displayWidth');

const PREV_DSH_HOME = process.env.DSH_HOME;
const restoreNetworkGuard = installNoNetworkGuard();
const temps = createTempTracker('studyhub-tui-pkg-soak-');

const RESOURCE_KINDS = ['FSEventWrap', 'StatWatcher', 'ProcessWrap', 'Timeout'];
function resourceCounts() {
  const counts = {};
  for (const kind of process.getActiveResourcesInfo()) {
    if (RESOURCE_KINDS.includes(kind)) counts[kind] = (counts[kind] || 0) + 1;
  }
  return counts;
}

async function waitForResourceTeardown(baselineResources, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  let afterRes = resourceCounts();
  while (
    Date.now() < deadline &&
    RESOURCE_KINDS.some((kind) => (afterRes[kind] || 0) > (baselineResources[kind] || 0))
  ) {
    await new Promise((r) => setTimeout(r, 15));
    afterRes = resourceCounts();
  }
  return afterRes;
}

function assertSoakHealthyScreen(tty, screen, expectedCols, expectedRows, contextLabel) {
  tty.assertHealthyScreen(screen, expectedCols, expectedRows, contextLabel);
  const lines = screen.split('\n');
  assert.ok(lines.length <= expectedRows, `${contextLabel}: Row count ${lines.length} > ${expectedRows}`);
  assert.ok(!/\bNaN\b/.test(screen), `${contextLabel}: NaN leaked`);
  assert.ok(!/\bundefined\b/.test(screen), `${contextLabel}: undefined leaked`);
  assert.ok(!screen.includes('[object Object]'), `${contextLabel}: [object Object] leaked`);
  assert.ok(!screen.includes('\uFFFD'), `${contextLabel}: U+FFFD replacement char found`);

  const bodyLines = lines.slice(1, Math.max(1, expectedRows - 1));
  const nonBlank = bodyLines.filter((l) => l.trim().length > 0);
  assert.ok(nonBlank.length >= 2, `${contextLabel}: body unexpectedly blank`);

  for (let i = 0; i < lines.length; i += 1) {
    const w = displayWidth(lines[i]);
    assert.ok(w <= expectedCols, `${contextLabel}: row ${i} width ${w} > ${expectedCols}: ${JSON.stringify(lines[i])}`);
  }

  const buf = tty.term.buffer.active;
  for (let y = 0; y < tty.term.rows; y += 1) {
    const line = buf.getLine(buf.viewportY + y);
    assert.ok(!line?.isWrapped, `${contextLabel}: xterm soft-wrapped row ${y}`);
  }
}

function createStubComplete() {
  return async (_system, prompt, execution = {}) => {
    if (String(prompt || '').includes('OK?')) return 'OK';
    execution.signal?.throwIfAborted?.();
    const out = 'StudyHub soak stub response.';
    execution.onOutput?.(out);
    return out;
  };
}

const VIEWPORTS = [
  { cols: 80, rows: 24 },
  { cols: 100, rows: 30 },
  { cols: 120, rows: 36 },
  { cols: 160, rows: 44 },
];

const SOAK_VIEWS = [
  { id: 'library', key: '1', match: /题组列表|今日待复习/ },
  { id: 'sources', key: '2', match: /资料列表/ },
  { id: 'generate', key: '3', match: /新建出题任务|草稿箱/ },
  { id: 'wrongbook', key: '4', match: /错题列表|错因分布/ },
  { id: 'exam', key: '5', match: /组卷设置/ },
  { id: 'dashboard', key: '6', match: /学习统计与掌握度/ },
  { id: 'book', key: '7', match: /复习全书/ },
  { id: 'skeleton', key: '8', match: /知识层级树|课程骨架/ },
  { id: 'examcoach', key: '9', match: /考试教练/ },
  { id: 'examprep', key: '0', match: /备考补习/ },
  { id: 'notes', key: 'n', match: /学习笔记/ },
  { id: 'board', key: 'b', match: /待办 Todo/ },
  { id: 'tasks', key: 't', match: /运行中/ },
  { id: 'settings', key: ',', match: /模型配置|学习库路径/ },
  { id: 'audio', key: 'a', match: /音频转写|转写服务/ },
  { id: 'review', key: '1r', match: /AI讲解|翻开答案|FSRS/ },
];

function isViewReady(screen, bodyRe) {
  if (
    screen.includes('正在加载页面…') ||
    screen.includes('Loading view…') ||
    screen.includes('正在打开学习库…')
  ) {
    return false;
  }
  const lines = screen.split('\n');
  // Strip SideNav up to the vertical divider `│` so sidebar labels never false-match.
  const mainLines = lines.slice(1, -1).map((line) => {
    const sepIdx = line.indexOf('│');
    return sepIdx >= 0 ? line.slice(sepIdx + 1) : line;
  });
  return bodyRe.test(mainLines.join('\n'));
}

after(async () => {
  restoreNetworkGuard();
  disposeTerminalPool();
  if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = PREV_DSH_HOME;
  await temps.cleanup();
});

describe('StudyHub TUI Packaging, Out-of-Repo Bin Smoke & 64-Transition Resize Soak', () => {
  test('1. Out-of-repo /tmp bin execution (--version and --help)', async () => {
    const pkgJson = JSON.parse(await readFile(join(pkgRoot, 'package.json'), 'utf8'));
    const workDir = realpathSync(tmpdir());
    const env = sanitizedTestEnv();

    const verRes = await execFileAsync(process.execPath, [binEntry, '--version'], {
      cwd: workDir,
      env,
      timeout: 20_000,
      windowsHide: true,
    });
    assert.equal(verRes.stderr.trim(), '');
    assert.equal(verRes.stdout.trim(), `studyhub-tui ${pkgJson.version}`);

    const helpRes = await execFileAsync(process.execPath, [binEntry, '--help'], {
      cwd: workDir,
      env,
      timeout: 20_000,
      windowsHide: true,
    });
    assert.equal(helpRes.stderr.trim(), '');
    assert.ok(helpRes.stdout.includes(`StudyHub TUI v${pkgJson.version}`), 'help must include version banner');
    assert.ok(helpRes.stdout.includes('Usage:'), 'help must include Usage section');
    assert.ok(helpRes.stdout.includes('Options:'), 'help must include Options section');
    assert.ok(helpRes.stdout.includes('Shortcuts inside TUI:'), 'help must include Shortcuts section');
  });

  test('2. npm pack --dry-run --json ships only runtime artifacts and documentation', async () => {
    const pkgJson = JSON.parse(await readFile(join(pkgRoot, 'package.json'), 'utf8'));
    assert.deepEqual(pkgJson.files, ['bin/', 'dist/', 'README.md', 'docs/GUIDE.md', 'docs/KEYBINDINGS.md', 'docs/ASSISTANT-UX.md']);
    assert.equal(pkgJson.engines?.node, '>=22.19');

    const npmCmd = resolveNpmCommand('npm');
    const { stdout } = await execFileAsync(npmCmd.command, ['pack', '--dry-run', '--json'], {
      ...npmCmd.options,
      cwd: pkgRoot,
      env: sanitizedTestEnv(),
      timeout: 45_000,
      maxBuffer: 4 * 1024 * 1024,
    });

    const parsed = JSON.parse(stdout);
    const packInfo = Array.isArray(parsed) ? parsed[0] : parsed;
    assert.ok(packInfo && Array.isArray(packInfo.files), 'npm pack --json must return files list');

    const packedPaths = packInfo.files.map((f) => String(f.path).replace(/\\/g, '/'));
    const required = [
      'package.json',
      'bin/studyhub-tui.mjs',
      'dist/cli.mjs',
      'dist/App.mjs',
      'README.md',
      'docs/GUIDE.md',
      'docs/KEYBINDINGS.md',
      'docs/ASSISTANT-UX.md',
    ];
    for (const reqPath of required) {
      assert.ok(packedPaths.includes(reqPath), `npm pack must include ${reqPath}`);
    }

    const forbiddenPrefixes = ['tests/', 'scripts/', 'src/', 'node_modules/'];
    const forbiddenExact = new Set(['.DS_Store', 'docs/ROADMAP-21-40.md', 'docs/PR1297-REVIEW.md', 'docs/ci-verify-tui.patch']);
    for (const p of packedPaths) {
      for (const prefix of forbiddenPrefixes) {
        assert.ok(!p.startsWith(prefix), `npm pack must NOT include ${p}`);
      }
      assert.ok(!p.endsWith('.tsbuildinfo'), `npm pack must NOT include tsbuildinfo: ${p}`);
      assert.ok(!p.endsWith('.DS_Store'), `npm pack must NOT include .DS_Store: ${p}`);
      assert.ok(!forbiddenExact.has(p), `npm pack must NOT include non-release doc ${p}`);
    }
  });

  test('3. 64-transition + 4-viewport resize-storm soak keeps heap delta < 40 MB and leaks 0 handles', async () => {
    v8.setFlagsFromString('--expose_gc');
    const gc = vm.runInNewContext('gc');
    assert.equal(typeof gc, 'function', 'V8 gc() must be available');

    const baselineResources = resourceCounts();
    const boxDir = await temps.make('soak');
    const dshHome = join(boxDir, 'dsh-home');
    const libraryRoot = join(boxDir, 'library');
    process.env.DSH_HOME = dshHome;

    const host = await createTuiHost({
      env: sanitizedTestEnv({ DSH_HOME: dshHome }),
      home: join(boxDir, 'home'),
      libraryRoot,
      injectedComplete: createStubComplete(),
      skipAutoProbe: true,
      language: 'zh',
      eventDebounceMs: 30,
    });

    const sampleRes = await host.call('sample.load', { language: 'zh' });
    assert.equal(sampleRes.ok, true, 'sample.load must succeed');

    const tty = createVirtualTty(VIEWPORTS[0].cols, VIEWPORTS[0].rows);
    let inkInstance = null;

    try {
      inkInstance = render(
        React.createElement(StudyHubTuiApp, {
          host,
          initialPage: 'library',
          initialLanguage: 'zh',
          initialAsciiMode: false,
          autoLaunchpad: false,
          onExit: () => inkInstance?.unmount(),
        }),
        {
          stdin: tty.stdin,
          stdout: tty.stdout,
          stderr: tty.stderr,
          interactive: true,
          exitOnCtrlC: false,
          patchConsole: false,
        },
      );

      await tty.firstFramePromise;
      await tty.waitFor(
        (s) => isViewReady(s, SOAK_VIEWS[0].match),
        { timeoutMs: 25_000, label: 'initial library mount' },
      );

      gc();
      await tty.flush();
      gc();
      const baselineHeapBytes = process.memoryUsage().heapUsed;

      let transitions = 0;
      for (let cycle = 0; cycle < 4; cycle += 1) {
        for (let stepIdx = 0; stepIdx < SOAK_VIEWS.length; stepIdx += 1) {
          const step = SOAK_VIEWS[stepIdx];
          const vp = VIEWPORTS[(cycle + stepIdx) % VIEWPORTS.length];
          tty.resize(vp.cols, vp.rows);
          await tty.flush();

          if (step.id === 'review') {
            tty.send('1');
            await tty.waitFor(
              (s) => isViewReady(s, SOAK_VIEWS[0].match),
              { timeoutMs: 15_000, label: `cycle ${cycle + 1} library before review` },
            );
            tty.send('r');
          } else {
            tty.send(step.key);
          }

          const screen = await tty.waitFor(
            (s) => isViewReady(s, step.match),
            { timeoutMs: 15_000, label: `cycle ${cycle + 1} ${step.id} @ ${vp.cols}x${vp.rows}` },
          );
          await tty.flush();
          const settled = tty.readScreen();
          assertSoakHealthyScreen(
            tty,
            settled || screen,
            vp.cols,
            vp.rows,
            `c${cycle + 1}:${step.id}@${vp.cols}x${vp.rows}`,
          );
          transitions += 1;

          if (step.id === 'review' && cycle < 3) {
            tty.send('\u001b');
            await tty.waitFor(
              (s) => isViewReady(s, SOAK_VIEWS[0].match),
              { timeoutMs: 15_000, label: `cycle ${cycle + 1} Esc back to library` },
            );
          }
        }
      }

      assert.equal(transitions, 64, 'expected exactly 64 view/resize transitions');

      gc();
      await tty.flush();
      gc();
      const deltaMb = (process.memoryUsage().heapUsed - baselineHeapBytes) / (1024 * 1024);
      assert.ok(
        deltaMb < 40,
        `retained heapUsed delta after 64 transitions was ${deltaMb.toFixed(2)} MB (budget < 40 MB)`,
      );
    } finally {
      try {
        inkInstance?.unmount();
      } catch {
        // Ignore unmount errors during cleanup
      }
      tty.dispose();
      await host.dispose();
      disposeTerminalPool();
    }

    const afterRes = await waitForResourceTeardown(baselineResources);
    for (const kind of RESOURCE_KINDS) {
      assert.ok(
        (afterRes[kind] || 0) <= (baselineResources[kind] || 0),
        `${kind} leaked after unmount & host.dispose(): before=${baselineResources[kind] || 0}, after=${afterRes[kind] || 0}`,
      );
    }
  });

  test('4. Bidirectional dependency hygiene: package.json dependencies match dist/*.mjs & src/ imports', async () => {
    const pkgJson = JSON.parse(await readFile(join(pkgRoot, 'package.json'), 'utf8'));
    const declaredDeps = new Set(Object.keys(pkgJson.dependencies || {}));
    const nodeBuiltins = new Set(builtinModules);

    function toBarePackageName(spec) {
      if (!spec || spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')) {
        return null;
      }
      if (nodeBuiltins.has(spec) || nodeBuiltins.has(spec.replace(/^node:/, ''))) {
        return null;
      }
      return spec.startsWith('@')
        ? spec.split('/').slice(0, 2).join('/')
        : spec.split('/')[0];
    }

    function extractModuleSpecifiers(code) {
      const specs = [];
      const fromRe = /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?(?:\*|\{[^}]*\}|[\w$]+(?:\s*,\s*(?:\*|\{[^}]*\}))?)\s+from\s*['"]([^'"]+)['"]/g;
      const sideEffectRe = /^\s*import\s*['"]([^'"]+)['"]/gm;
      const dynRe = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
      const reqRe = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
      const inlineCreateReqRe = /\bcreateRequire\s*\([^)]*\)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

      for (const re of [fromRe, sideEffectRe, dynRe, reqRe, inlineCreateReqRe]) {
        for (const m of code.matchAll(re)) specs.push(m[1]);
      }

      const createReqVars = new Set();
      const createReqAssignRe = /\b(?:const|let|var)\s+([\w$]+)\s*=\s*createRequire\s*\(/g;
      for (const m of code.matchAll(createReqAssignRe)) {
        createReqVars.add(m[1]);
      }
      for (const varName of createReqVars) {
        const escaped = varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const varCallRe = new RegExp(`\\b${escaped}\\s*\\(\\s*['"]([^'"]+)['"]\\s*\\)`, 'g');
        for (const m of code.matchAll(varCallRe)) specs.push(m[1]);
      }
      return specs;
    }

    async function collectSourceFiles(dir) {
      const entries = await readdir(dir, { withFileTypes: true });
      const files = [];
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          files.push(...(await collectSourceFiles(full)));
        } else if (/\.(?:ts|tsx|js|mjs|cjs)$/.test(entry.name)) {
          files.push(full);
        }
      }
      return files;
    }

    const allDistFiles = (await readdir(distDir)).filter((f) => f.endsWith('.mjs'));
    assert.ok(allDistFiles.length > 0, 'dist/ must contain built .mjs artifacts');

    const distImportedPackages = new Set();
    for (const file of allDistFiles) {
      const code = await readFile(join(distDir, file), 'utf8');
      for (const spec of extractModuleSpecifiers(code)) {
        const pkgName = toBarePackageName(spec);
        if (pkgName) distImportedPackages.add(pkgName);
      }
    }

    const srcImportedPackages = new Set();
    const srcFiles = await collectSourceFiles(resolve(pkgRoot, 'src'));
    for (const file of srcFiles) {
      const code = await readFile(file, 'utf8');
      for (const spec of extractModuleSpecifiers(code)) {
        const pkgName = toBarePackageName(spec);
        if (pkgName) srcImportedPackages.add(pkgName);
      }
    }

    const combinedImported = new Set([...distImportedPackages, ...srcImportedPackages]);
    for (const dep of declaredDeps) {
      assert.ok(
        combinedImported.has(dep),
        `Declared runtime dependency "${dep}" in package.json is not imported by any file in dist/*.mjs or src/`,
      );
    }

    for (const pkgName of distImportedPackages) {
      assert.ok(
        declaredDeps.has(pkgName),
        `Bare package "${pkgName}" imported in dist/*.mjs is missing from package.json dependencies`,
      );
    }
  });
});
