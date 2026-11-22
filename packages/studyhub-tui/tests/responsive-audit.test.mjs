// 4-Viewport Bilingual & ASCII Visual Regression Audit across all 16 views:
// node --test tests/responsive-audit.test.mjs
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import xtermPkg from '@xterm/headless';
import { render } from 'ink';
import React from 'react';

const { Terminal } = xtermPkg;
const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const distDir = resolve(pkgRoot, 'dist');

const distFiles = (await readdir(distDir)).filter((f) => f.endsWith('.mjs') && f !== 'cli.mjs');
const { StudyHubTuiApp } = await import(pathToFileURL(join(distDir, 'App.mjs')).href);

let H = null;
let R = null;
for (const f of distFiles) {
  if (f === 'host.mjs' || f.startsWith('host-') || f.startsWith('tui-') || f.startsWith('chunk-')) {
    const mod = await import(pathToFileURL(join(distDir, f)).href);
    if (!H && typeof mod.createTuiHost === 'function' && typeof mod.saveTuiPreferences === 'function') H = mod;
    if (!R && typeof mod.displayWidth === 'function') R = mod;
  }
}
assert.ok(H?.createTuiHost, 'dist/ must export createTuiHost');
assert.ok(H?.saveTuiPreferences, 'dist/ must export saveTuiPreferences');
assert.ok(R?.displayWidth, 'dist/ must export displayWidth');

const PREV_DSH_HOME = process.env.DSH_HOME;
const tempDirs = [];
async function makeTempDir(label) {
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-audit-${label}-`));
  tempDirs.push(d);
  return d;
}

const RESOURCE_KINDS = new Set(['FSEventWrap', 'StatWatcher', 'Timeout', 'ProcessWrap', 'TCPWrap', 'PipeWrap']);
function resourceCounts() {
  const counts = {};
  for (const kind of process.getActiveResourcesInfo()) {
    if (RESOURCE_KINDS.has(kind)) counts[kind] = (counts[kind] || 0) + 1;
  }
  return counts;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function createVirtualTty(cols, rows) {
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;

  const stdout = new PassThrough();
  stdout.isTTY = true;
  stdout.columns = cols;
  stdout.rows = rows;
  stdout.getColorDepth = () => 24;

  const stderr = new PassThrough();
  stderr.isTTY = true;
  stderr.columns = cols;
  stderr.rows = rows;

  const term = new Terminal({
    cols,
    rows,
    allowProposedApi: true,
    convertEol: true,
  });

  let pendingWrites = Promise.resolve();
  let firstFrameResolve = null;
  let firstFrameSettled = false;
  const firstFramePromise = new Promise((resolveFn) => {
    firstFrameResolve = resolveFn;
  });

  stdout.on('data', (chunk) => {
    const str = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    pendingWrites = pendingWrites.then(
      () =>
        new Promise((resolveWrite) => {
          term.write(str, () => {
            if (!firstFrameSettled) {
              firstFrameSettled = true;
              firstFrameResolve?.();
            }
            resolveWrite();
          });
        }),
    );
  });

  async function flush() {
    await sleep(20);
    await pendingWrites;
  }

  function readLines() {
    const buf = term.buffer.active;
    const lines = [];
    for (let y = 0; y < term.rows; y += 1) {
      const line = buf.getLine(buf.viewportY + y);
      lines.push(line ? line.translateToString(true) : '');
    }
    return lines;
  }

  function readScreen() {
    return readLines().join('\n');
  }

  function send(data) {
    stdin.write(data);
  }

  async function waitFor(predicate, { timeoutMs = 8_000, label = 'condition' } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await flush();
      const screen = readScreen();
      if (predicate(screen)) return screen;
      await sleep(25);
    }
    const finalScreen = readScreen();
    throw new Error(`Timed out waiting for ${label} after ${timeoutMs}ms.\n--- SCREEN ---\n${finalScreen}\n--------------`);
  }

  function collectScreenIssues(screen, expectedCols, expectedRows, asciiMode, contextLabel) {
    const issues = [];
    const lines = screen.split('\n');

    if (screen.includes('页面渲染异常') || screen.includes('View Error') || /(?:^|\s)Error:\s/m.test(screen)) {
      issues.push(`${contextLabel}: Error boundary or Error: detected`);
    }
    if (screen.includes('TypeError:') || screen.includes('ReferenceError:')) {
      issues.push(`${contextLabel}: Runtime JS error rendered`);
    }
    if (/\bNaN\b/.test(screen)) {
      issues.push(`${contextLabel}: Raw NaN leaked`);
    }
    if (/\bundefined\b/.test(screen)) {
      issues.push(`${contextLabel}: Raw undefined leaked`);
    }
    if (screen.includes('[object Object]')) {
      issues.push(`${contextLabel}: Raw [object Object] leaked`);
    }
    if (screen.includes('\uFFFD')) {
      issues.push(`${contextLabel}: Replacement char U+FFFD found`);
    }
    if (/\x1b\[|\u001b/.test(screen)) {
      issues.push(`${contextLabel}: Unparsed escape sequence leaked into xterm buffer`);
    }

    const bodyLines = lines.slice(1, Math.max(1, expectedRows - 1));
    const nonBlankBody = bodyLines.filter((l) => l.trim().length > 0);
    const bodyTextLen = nonBlankBody.map((l) => l.trim()).join('').length;
    if (nonBlankBody.length < 2 || bodyTextLen < 12) {
      issues.push(`${contextLabel}: Blank or nearly empty body (lines=${nonBlankBody.length}, chars=${bodyTextLen})`);
    }

    for (let i = 0; i < lines.length; i += 1) {
      const w = R.displayWidth(lines[i]);
      if (w > expectedCols) {
        issues.push(`${contextLabel}: Row ${i} exceeds cols (${w} > ${expectedCols}): ${JSON.stringify(lines[i])}`);
      }
    }

    const buf = term.buffer.active;
    for (let y = 0; y < term.rows; y += 1) {
      const line = buf.getLine(buf.viewportY + y);
      if (line && line.isWrapped) {
        issues.push(`${contextLabel}: xterm soft-wrapped row ${y}: ${JSON.stringify(line.translateToString(true))}`);
      }
    }

    if (asciiMode) {
      const boxMatch = screen.match(/[\u2500-\u257f]/g);
      if (boxMatch) {
        issues.push(`${contextLabel}: Unicode box-drawing chars in --ascii mode: ${JSON.stringify([...new Set(boxMatch)])}`);
      }
      const blockMatch = screen.match(/[\u2580-\u259f]/g);
      if (blockMatch) {
        issues.push(`${contextLabel}: Unicode block elements in --ascii mode: ${JSON.stringify([...new Set(blockMatch)])}`);
      }
      const brailleMatch = screen.match(/[\u2800-\u28ff]/g);
      if (brailleMatch) {
        issues.push(`${contextLabel}: Unicode Braille chars in --ascii mode: ${JSON.stringify([...new Set(brailleMatch)])}`);
      }
    }

    return issues;
  }

  return {
    stdin,
    stdout,
    stderr,
    firstFramePromise,
    flush,
    readScreen,
    send,
    waitFor,
    collectScreenIssues,
    dispose: () => {
      term.dispose();
      stdin.destroy();
      stdout.destroy();
      stderr.destroy();
    },
  };
}

function createAuditCompleteStub() {
  return async (_system, prompt, execution = {}) => {
    const p = String(prompt || '');
    if (p.includes('OK?')) return 'OK';
    execution.signal?.throwIfAborted?.();
    const out = 'StudyHub audit stub response.';
    execution.onOutput?.(out);
    return out;
  };
}

const ALL_16_VIEWS = [
  { id: 'library', key: null, zh: /学习库|题组列表/, en: /Library|Decks/ },
  { id: 'sources', key: '2', zh: /资料列表/, en: /Materials/ },
  { id: 'generate', key: '3', zh: /新建出题任务|创建题组/, en: /New Generation|Generate/ },
  { id: 'wrongbook', key: '4', zh: /错题列表|错题本/, en: /Mistakes/ },
  { id: 'exam', key: '5', zh: /组卷设置|模拟考试/, en: /Mock Exam/ },
  { id: 'dashboard', key: '6', zh: /学习统计与掌握度/, en: /Stats|Mastery/ },
  { id: 'book', key: '7', zh: /复习全书/, en: /Book/ },
  { id: 'skeleton', key: '8', zh: /知识层级树|知识骨架/, en: /Skeleton|Hierarchy/ },
  { id: 'examcoach', key: '9', zh: /考试教练/, en: /Coach/ },
  { id: 'examprep', key: '0', zh: /备考补习/, en: /Exam Prep/ },
  { id: 'notes', key: 'n', zh: /学习笔记/, en: /Notes/ },
  { id: 'board', key: 'b', zh: /待办 Todo/, en: /Todo|Board/ },
  { id: 'tasks', key: 't', zh: /后台任务/, en: /Jobs/ },
  { id: 'settings', key: ',', zh: /设置.*模型配置|模型配置/, en: /Settings/ },
  { id: 'audio', key: 'a', zh: /音频转写/, en: /Audio/ },
  { id: 'review', key: '1r', zh: /AI讲解|翻开答案|FSRS|1\/\d+/, en: /AI Tutor|flip card|FSRS|1\/\d+/ },
];

const AUDIT_PASSES = [
  { name: 'Pass 1: 80x24 zh Unicode', cols: 80, rows: 24, language: 'zh', asciiMode: false },
  { name: 'Pass 2: 100x30 en Unicode', cols: 100, rows: 30, language: 'en', asciiMode: false },
  { name: 'Pass 3: 120x36 zh --ascii', cols: 120, rows: 36, language: 'zh', asciiMode: true },
  { name: 'Pass 4: 160x44 en --ascii', cols: 160, rows: 44, language: 'en', asciiMode: true },
];

describe('StudyHub TUI 4-Viewport Bilingual & ASCII Responsive Audit', () => {
  let boxDir;
  let dshHome;
  let libraryRoot;
  let host;
  let baselineResources;

  before(async () => {
    boxDir = await makeTempDir('main');
    dshHome = join(boxDir, 'dsh-home');
    libraryRoot = join(boxDir, 'library');
    process.env.DSH_HOME = dshHome;
    baselineResources = resourceCounts();

    host = await H.createTuiHost({
      env: { DSH_HOME: dshHome },
      home: join(boxDir, 'home'),
      libraryRoot,
      injectedComplete: createAuditCompleteStub(),
      skipAutoProbe: true,
      language: 'zh',
      eventDebounceMs: 30,
    });

    const sampleRes = await host.call('sample.load', { language: 'zh' });
    assert.equal(sampleRes.ok, true, 'sample.load must succeed');
  });

  after(async () => {
    await host?.dispose();
    if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = PREV_DSH_HOME;
    await Promise.all(
      tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })),
    );
  });

  for (const pass of AUDIT_PASSES) {
    test(pass.name, async () => {
      await H.saveTuiPreferences(
        { language: pass.language, asciiMode: pass.asciiMode },
        { env: { DSH_HOME: dshHome } },
      );
      host.setLanguage(pass.language);

      const tty = createVirtualTty(pass.cols, pass.rows);
      let inkInstance = null;
      const failures = [];

      try {
        inkInstance = render(
          React.createElement(StudyHubTuiApp, {
            host,
            initialPage: 'library',
            initialLanguage: pass.language,
            initialAsciiMode: pass.asciiMode,
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

        for (const step of ALL_16_VIEWS) {
          if (step.key) {
            for (const ch of step.key) {
              tty.send(ch);
              await sleep(30);
            }
          }

          const expectedRe = pass.language === 'en' ? step.en : step.zh;
          await tty.waitFor(
            (s) =>
              (expectedRe.test(s) || s.includes('页面渲染异常') || s.includes('View Error')) &&
              !s.includes('正在加载页面…') &&
              !s.includes('Loading view…') &&
              !s.includes('正在打开学习库…') &&
              !s.includes('Opening library…'),
            { timeoutMs: 8_000, label: `${step.id} @ ${pass.name}` },
          );

          await sleep(75);
          await tty.flush();
          const screen = tty.readScreen();

          const viewIssues = tty.collectScreenIssues(
            screen,
            pass.cols,
            pass.rows,
            pass.asciiMode,
            `${step.id} [${pass.cols}x${pass.rows} ${pass.language}${pass.asciiMode ? ' ascii' : ''}]`,
          );
          if (viewIssues.length > 0) {
            failures.push(...viewIssues, `--- SNAPSHOT (${step.id}) ---\n${screen}\n--- END ---`);
          }
        }
      } finally {
        try {
          inkInstance?.unmount();
        } catch {
          // Ignore unmount errors on teardown
        }
        tty.dispose();
      }

      assert.deepEqual(failures, [], `${pass.name} failures:\n${failures.join('\n')}`);
    });
  }

  test('Clean resource teardown with zero leaked handles', async () => {
    await host.dispose();
    await sleep(80);
    const afterRes = resourceCounts();
    for (const kind of ['FSEventWrap', 'StatWatcher', 'ProcessWrap', 'Timeout']) {
      assert.ok(
        (afterRes[kind] || 0) <= (baselineResources[kind] || 0),
        `${kind} leaked: before=${baselineResources[kind] || 0} after=${afterRes[kind] || 0}`,
      );
    }
  });
});
