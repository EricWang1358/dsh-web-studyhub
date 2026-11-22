// Empty-Library 16-View Onboarding & Bilingual Consistency Audit:
// node --test tests/empty-state-audit.test.mjs
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
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
let StoreMod = null;
for (const f of distFiles) {
  if (f === 'host.mjs' || f.startsWith('host-') || f.startsWith('tui-') || f.startsWith('store-') || f.startsWith('chunk-')) {
    const mod = await import(pathToFileURL(join(distDir, f)).href);
    if (!H && typeof mod.createTuiHost === 'function' && typeof mod.saveTuiPreferences === 'function') H = mod;
    if (!R && typeof mod.displayWidth === 'function') R = mod;
    if (!StoreMod && mod.useTuiStore && mod.DEFAULT_PREFERENCES) StoreMod = mod;
  }
}
assert.ok(H?.createTuiHost, 'dist/ must export createTuiHost');
assert.ok(H?.saveTuiPreferences, 'dist/ must export saveTuiPreferences');
assert.ok(R?.displayWidth, 'dist/ must export displayWidth');
assert.ok(StoreMod?.useTuiStore, 'dist/ must export useTuiStore');

const { useTuiStore, DEFAULT_PREFERENCES } = StoreMod;

function resetTuiStore(language, asciiMode) {
  useTuiStore.setState({
    page: 'library',
    navContext: {},
    history: [],
    inputCaptured: false,
    commandPaletteOpen: false,
    helpOpen: false,
    coursePickerOpen: false,
    voicePackOpen: false,
    inboxOpen: false,
    showLaunchpad: false,
    snapshot: null,
    binding: null,
    desktopConfig: null,
    loading: true,
    refreshing: false,
    lastError: null,
    activeRunId: null,
    toasts: [],
    footerHints: [],
    preferences: { ...DEFAULT_PREFERENCES, language, asciiMode },
  });
}

const PREV_DSH_HOME = process.env.DSH_HOME;
const CJK_RE = /[\u4e00-\u9fff]/;
const tempDirs = [];

async function makeTempDir(label) {
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-empty-${label}-`));
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

  function collectScreenIssues(screen, expectedCols, expectedRows, language, asciiMode, contextLabel) {
    const issues = [];
    const lines = screen.split('\n');

    if (lines.length > expectedRows) {
      issues.push(`${contextLabel}: Line count exceeds rows (${lines.length} > ${expectedRows})`);
    }
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

    if (language === 'en') {
      const cjkLines = lines
        .map((line, idx) => ({ idx, line }))
        .filter((entry) => CJK_RE.test(entry.line));
      if (cjkLines.length > 0) {
        const preview = cjkLines.map((entry) => `L${entry.idx}: ${entry.line.trim()}`).join(' | ');
        issues.push(`${contextLabel}: Stray CJK characters in en mode: ${preview}`);
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

const STILL_LOADING_RE =
  /正在加载页面|Loading view|正在打开学习库|Opening library|正在准备复习队列|Preparing review queue|正在加载错题本|Loading mistakes|正在加载知识骨架|Loading knowledge skeleton|正在加载考试教练|Loading Exam Coach|正在加载备考重点|Loading exam prep|载入笔记中|Loading notes|载入看板|Loading board/;

const ALL_16_VIEWS = [
  { id: 'library', key: null, zh: /当前范围暂无题组/, en: /No decks in this scope/ },
  { id: 'sources', key: '2', zh: /暂无匹配资料/, en: /No matching materials/ },
  { id: 'generate', key: '3', zh: /暂无可用资料/, en: /No materials/ },
  { id: 'wrongbook', key: '4', zh: /暂无错题记录/, en: /No mistakes recorded/ },
  { id: 'exam', key: '5', zh: /当前课程暂无可用考题/, en: /No eligible exam questions/ },
  { id: 'dashboard', key: '6', zh: /暂无课程掌握度数据/, en: /No course mastery data yet/ },
  { id: 'book', key: '7', zh: /请先选择一门课程/, en: /Select a course first/ },
  { id: 'skeleton', key: '8', zh: /还没有知识骨架/, en: /No knowledge skeletons yet/ },
  { id: 'examcoach', key: '9', zh: /尚未建立考法校准方案/, en: /No Exam Calibration Profile Yet/ },
  { id: 'examprep', key: '0', zh: /尚未添加本课程考纲重点/, en: /No Exam Focus Points Yet/ },
  { id: 'notes', key: 'n', zh: /还没有学习笔记/, en: /No study notes yet/ },
  { id: 'board', key: 'b', zh: /空列/, en: /Empty/ },
  { id: 'tasks', key: 't', zh: /当前筛选下无任务/, en: /No jobs in this filter/ },
  { id: 'settings', key: ',', zh: /当前生效模型|未配置模型|提供方与预设/, en: /Active Model Route|No model configured|Routes & Presets/ },
  { id: 'audio', key: 'a', zh: /暂无音频转写记录/, en: /No transcripts yet/ },
  { id: 'review', key: '1r', zh: /当前没有待复习题目/, en: /No questions due for review/ },
];

const VIEWPORTS = [
  { cols: 120, rows: 36 },
  { cols: 80, rows: 24 },
];

describe('StudyHub TUI Empty-Library 16-View Onboarding & Bilingual Audit', () => {
  let boxDir;
  let dshHome;
  let libraryRoot;
  let host;
  let baselineResources;

  before(async () => {
    boxDir = await makeTempDir('main');
    dshHome = join(boxDir, 'dsh-home');
    libraryRoot = join(boxDir, 'library');
    await mkdir(libraryRoot, { recursive: true });
    process.env.DSH_HOME = dshHome;
    baselineResources = resourceCounts();

    host = await H.createTuiHost({
      env: { DSH_HOME: dshHome },
      home: join(boxDir, 'home'),
      libraryRoot,
      injectedComplete: createAuditCompleteStub(),
      skipAutoProbe: true,
      language: 'en',
      eventDebounceMs: 30,
    });
  });

  after(async () => {
    await host?.dispose();
    if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = PREV_DSH_HOME;
    await Promise.all(
      tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })),
    );
  });

  for (const lang of ['zh', 'en']) {
    for (const vp of VIEWPORTS) {
      test(`Test 1: Empty-library Launchpad (${lang}, ${vp.cols}x${vp.rows})`, async () => {
        resetTuiStore(lang, false);
        await H.saveTuiPreferences({ language: lang, asciiMode: false }, { env: { DSH_HOME: dshHome } });
        host.setLanguage(lang);

        const tty = createVirtualTty(vp.cols, vp.rows);
        let inkInstance = null;

        try {
          inkInstance = render(
            React.createElement(StudyHubTuiApp, {
              host,
              initialPage: 'library',
              initialLanguage: lang,
              initialAsciiMode: false,
              autoLaunchpad: true,
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
            (s) =>
              lang === 'en'
                ? s.includes('Load the sample course')
                : s.includes('载入示例课程体验'),
            { timeoutMs: 8_000, label: `Launchpad ${lang} ${vp.cols}x${vp.rows}` },
          );

          await sleep(60);
          await tty.flush();
          const finalScreen = tty.readScreen();

          const issues = tty.collectScreenIssues(
            finalScreen,
            vp.cols,
            vp.rows,
            lang,
            false,
            `Launchpad [${lang} ${vp.cols}x${vp.rows}]`,
          );
          assert.deepEqual(issues, [], `Launchpad issues:\n${issues.join('\n')}\n${finalScreen}`);

          if (lang === 'en') {
            assert.match(finalScreen, /\bs\b.*Load the sample course/);
            assert.match(finalScreen, /\bi\b.*Import your first material/);
            assert.match(finalScreen, /\bm\b.*Configure model/);
            assert.match(finalScreen, /Enter.*Enter library/);
            assert.equal(CJK_RE.test(finalScreen), false, `CJK leak in en Launchpad:\n${finalScreen}`);
          } else {
            assert.match(finalScreen, /\bs\b.*载入示例课程体验/);
            assert.match(finalScreen, /\bi\b.*导入第一份资料/);
            assert.match(finalScreen, /\bm\b.*配置模型/);
            assert.match(finalScreen, /Enter.*进入学习库/);
          }
        } finally {
          try {
            inkInstance?.unmount();
          } catch {
            // Ignore unmount errors on teardown
          }
          tty.dispose();
        }
      });
    }
  }

  for (const vp of VIEWPORTS) {
    test(`Test 2: All 16 views empty-library sweep in en (${vp.cols}x${vp.rows})`, async () => {
      resetTuiStore('en', false);
      await H.saveTuiPreferences({ language: 'en', asciiMode: false }, { env: { DSH_HOME: dshHome } });
      host.setLanguage('en');

      const tty = createVirtualTty(vp.cols, vp.rows);
      let inkInstance = null;
      const failures = [];

      try {
        inkInstance = render(
          React.createElement(StudyHubTuiApp, {
            host,
            initialPage: 'library',
            initialLanguage: 'en',
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

        for (const step of ALL_16_VIEWS) {
          if (step.key) {
            for (const ch of step.key) {
              tty.send(ch);
              await sleep(30);
            }
          }

          await tty.waitFor(
            (s) =>
              useTuiStore.getState().page === step.id &&
              (step.en.test(s) || s.includes('页面渲染异常') || s.includes('View Error')) &&
              !STILL_LOADING_RE.test(s),
            { timeoutMs: 8_000, label: `${step.id} @ en ${vp.cols}x${vp.rows}` },
          );

          await sleep(100);
          await tty.flush();
          const screen = tty.readScreen();

          const viewIssues = tty.collectScreenIssues(
            screen,
            vp.cols,
            vp.rows,
            'en',
            false,
            `${step.id} [${vp.cols}x${vp.rows} en]`,
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

      assert.deepEqual(failures, [], `en empty sweep (${vp.cols}x${vp.rows}) failures:\n${failures.join('\n')}`);
    });
  }

  for (const vp of VIEWPORTS) {
    test(`Test 3: All 16 views empty-library sweep in zh (${vp.cols}x${vp.rows})`, async () => {
      resetTuiStore('zh', true);
      await H.saveTuiPreferences({ language: 'zh', asciiMode: true }, { env: { DSH_HOME: dshHome } });
      host.setLanguage('zh');

      const tty = createVirtualTty(vp.cols, vp.rows);
      let inkInstance = null;
      const failures = [];

      try {
        inkInstance = render(
          React.createElement(StudyHubTuiApp, {
            host,
            initialPage: 'library',
            initialLanguage: 'zh',
            initialAsciiMode: true,
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

          await tty.waitFor(
            (s) =>
              useTuiStore.getState().page === step.id &&
              (step.zh.test(s) || s.includes('页面渲染异常') || s.includes('View Error')) &&
              !STILL_LOADING_RE.test(s),
            { timeoutMs: 8_000, label: `${step.id} @ zh ${vp.cols}x${vp.rows}` },
          );

          await sleep(100);
          await tty.flush();
          const screen = tty.readScreen();

          const viewIssues = tty.collectScreenIssues(
            screen,
            vp.cols,
            vp.rows,
            'zh',
            true,
            `${step.id} [${vp.cols}x${vp.rows} zh ascii]`,
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

      assert.deepEqual(failures, [], `zh empty sweep (${vp.cols}x${vp.rows}) failures:\n${failures.join('\n')}`);
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
