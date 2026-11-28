// Authoritative 16-View x 4-Viewport Responsive & Empty-Library Onboarding Audit Suite:
// - 4-Viewport (80x24, 100x30, 120x36, 160x44) Bilingual & ASCII Audit across all 16 views
// - Empty-Library Launchpad & 16-View Onboarding / Bilingual Consistency Audit (120x36 & 80x24)
// node --test tests/responsive-audit.test.mjs
import assert from 'node:assert/strict';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { render } from 'ink';
import React from 'react';
import { register } from 'tsx/esm/api';
import {
  createTempTracker,
  createVirtualTty,
  disposeTerminalPool,
  distDir,
  loadDistRuntime,
} from './helpers/virtual-tty.mjs';

const unregisterTsx = register();

const runtime = await loadDistRuntime();
const { StudyHubTuiApp, createTuiHost, saveTuiPreferences } = runtime;
assert.ok(StudyHubTuiApp, 'dist/ must export StudyHubTuiApp');
assert.ok(createTuiHost, 'dist/ must export createTuiHost');
assert.ok(saveTuiPreferences, 'dist/ must export saveTuiPreferences');

const storeFile = (await readdir(distDir)).find((f) => f.startsWith('store-') && f.endsWith('.mjs'));
assert.ok(storeFile, 'dist/ must include store-*.mjs');
const { useTuiStore, DEFAULT_PREFERENCES } = await import(
  pathToFileURL(join(distDir, storeFile)).href
);
assert.ok(useTuiStore, 'dist/ must export useTuiStore');
assert.ok(DEFAULT_PREFERENCES, 'dist/ must export DEFAULT_PREFERENCES');

const { displayWidth } = await import('../src/render/cjk.ts');
assert.ok(displayWidth, 'src/render/cjk.ts must export displayWidth');

const PREV_DSH_HOME = process.env.DSH_HOME;
const CJK_RE = /[\u4e00-\u9fff]/;
const temps = createTempTracker('studyhub-tui-responsive-');

after(async () => {
  disposeTerminalPool();
  unregisterTsx?.();
  if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = PREV_DSH_HOME;
  await temps.cleanup();
});

const RESOURCE_KINDS = new Set(['FSEventWrap', 'StatWatcher', 'Timeout', 'ProcessWrap', 'TCPWrap', 'PipeWrap']);
function resourceCounts() {
  const counts = {};
  for (const kind of process.getActiveResourcesInfo()) {
    if (RESOURCE_KINDS.has(kind)) counts[kind] = (counts[kind] || 0) + 1;
  }
  return counts;
}

async function waitForResourceTeardown(baselineResources, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  let afterRes = resourceCounts();
  while (
    Date.now() < deadline &&
    ['FSEventWrap', 'StatWatcher', 'ProcessWrap', 'Timeout'].some(
      (kind) => (afterRes[kind] || 0) > (baselineResources[kind] || 0),
    )
  ) {
    await new Promise((r) => setTimeout(r, 15));
    afterRes = resourceCounts();
  }
  return afterRes;
}

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
    preferences: {
      ...DEFAULT_PREFERENCES,
      recentCommands: [...DEFAULT_PREFERENCES.recentCommands],
      language,
      asciiMode,
    },
  });
}

function collectScreenIssues(tty, screen, expectedCols, expectedRows, { language, checkEnglishNoCjk = false, asciiMode }, contextLabel) {
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
  if (screen.includes('\u001b')) {
    issues.push(`${contextLabel}: Unparsed escape sequence leaked into xterm buffer`);
  }

  const bodyLines = lines.slice(1, Math.max(1, expectedRows - 1));
  const nonBlankBody = bodyLines.filter((l) => l.trim().length > 0);
  const bodyTextLen = nonBlankBody.map((l) => l.trim()).join('').length;
  if (nonBlankBody.length < 2 || bodyTextLen < 12) {
    issues.push(`${contextLabel}: Blank or nearly empty body (lines=${nonBlankBody.length}, chars=${bodyTextLen})`);
  }

  for (let i = 0; i < lines.length; i += 1) {
    const w = displayWidth(lines[i]);
    if (w > expectedCols) {
      issues.push(`${contextLabel}: Row ${i} exceeds cols (${w} > ${expectedCols}): ${JSON.stringify(lines[i])}`);
    }
  }

  const buf = tty.term.buffer.active;
  for (let y = 0; y < tty.term.rows; y += 1) {
    const line = buf.getLine(buf.viewportY + y);
    if (line && line.isWrapped) {
      issues.push(`${contextLabel}: xterm soft-wrapped row ${y}: ${JSON.stringify(line.translateToString(true))}`);
    }
  }

  if (checkEnglishNoCjk && language === 'en') {
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

const SAMPLE_16_VIEWS = [
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
    boxDir = await temps.make('responsive');
    dshHome = join(boxDir, 'dsh-home');
    libraryRoot = join(boxDir, 'library');
    process.env.DSH_HOME = dshHome;
    baselineResources = resourceCounts();

    host = await createTuiHost({
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
    if (boxDir) {
      await rm(boxDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
    }
  });

  for (const pass of AUDIT_PASSES) {
    test(pass.name, async () => {
      resetTuiStore(pass.language, pass.asciiMode);
      await saveTuiPreferences(
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

        for (const step of SAMPLE_16_VIEWS) {
          if (step.key) {
            for (const ch of step.key) {
              tty.send(ch);
              await tty.flush();
            }
          }

          const expectedRe = pass.language === 'en' ? step.en : step.zh;
          await tty.waitFor(
            (s) =>
              useTuiStore.getState().page === step.id &&
              (expectedRe.test(s) || s.includes('页面渲染异常') || s.includes('View Error')) &&
              !STILL_LOADING_RE.test(s),
            { timeoutMs: 20_000, label: `${step.id} @ ${pass.name}` },
          );

          await tty.flush();
          const screen = tty.readScreen();

          const viewIssues = collectScreenIssues(
            tty,
            screen,
            pass.cols,
            pass.rows,
            { language: pass.language, checkEnglishNoCjk: false, asciiMode: pass.asciiMode },
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

  test('Populated responsive audit teardown leaves zero leaked handles', async () => {
    await host.dispose();
    disposeTerminalPool();
    const afterRes = await waitForResourceTeardown(baselineResources);
    for (const kind of ['FSEventWrap', 'StatWatcher', 'ProcessWrap', 'Timeout']) {
      assert.ok(
        (afterRes[kind] || 0) <= (baselineResources[kind] || 0),
        `${kind} leaked: before=${baselineResources[kind] || 0} after=${afterRes[kind] || 0}`,
      );
    }
  });
});

// -----------------------------------------------------------------------------
// Empty-Library 16-View Onboarding & Bilingual Consistency Audit
// -----------------------------------------------------------------------------

const EMPTY_16_VIEWS = [
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
  {
    id: 'audio',
    key: 'a',
    zh: /暂无音频转写记录|暂无记录（未配置转写服务）|按 \[s\] 配置转写服务/,
    en: /No transcripts yet|No results \(provider unconfigured\)|Press \[s\] to configure/,
  },
  { id: 'review', key: '1r', zh: /当前没有待复习题目/, en: /No questions due for review/ },
];

const EMPTY_VIEWPORTS = [
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
    boxDir = await temps.make('empty');
    dshHome = join(boxDir, 'dsh-home');
    libraryRoot = join(boxDir, 'library');
    await mkdir(libraryRoot, { recursive: true });
    process.env.DSH_HOME = dshHome;
    baselineResources = resourceCounts();

    host = await createTuiHost({
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
    if (boxDir) {
      await rm(boxDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
    }
  });

  for (const lang of ['zh', 'en']) {
    for (const vp of EMPTY_VIEWPORTS) {
      test(`Test 1: Empty-library Launchpad (${lang}, ${vp.cols}x${vp.rows})`, async () => {
        resetTuiStore(lang, false);
        await saveTuiPreferences({ language: lang, asciiMode: false }, { env: { DSH_HOME: dshHome } });
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
            { timeoutMs: 20_000, label: `Launchpad ${lang} ${vp.cols}x${vp.rows}` },
          );

          await tty.flush();
          const finalScreen = tty.readScreen();

          const issues = collectScreenIssues(
            tty,
            finalScreen,
            vp.cols,
            vp.rows,
            { language: lang, checkEnglishNoCjk: true, asciiMode: false },
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

  for (const vp of EMPTY_VIEWPORTS) {
    test(`Test 2: All 16 views empty-library sweep in en (${vp.cols}x${vp.rows})`, async () => {
      resetTuiStore('en', false);
      await saveTuiPreferences({ language: 'en', asciiMode: false }, { env: { DSH_HOME: dshHome } });
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

        for (const step of EMPTY_16_VIEWS) {
          if (step.key) {
            for (const ch of step.key) {
              tty.send(ch);
              await tty.flush();
            }
          }

          await tty.waitFor(
            (s) =>
              useTuiStore.getState().page === step.id &&
              (step.en.test(s) || s.includes('页面渲染异常') || s.includes('View Error')) &&
              !STILL_LOADING_RE.test(s),
            { timeoutMs: 20_000, label: `${step.id} @ en ${vp.cols}x${vp.rows}` },
          );

          await tty.flush();
          const screen = tty.readScreen();

          const viewIssues = collectScreenIssues(
            tty,
            screen,
            vp.cols,
            vp.rows,
            { language: 'en', checkEnglishNoCjk: true, asciiMode: false },
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

  for (const vp of EMPTY_VIEWPORTS) {
    test(`Test 3: Chinese (zh) empty-library responsive audit (${vp.cols}x${vp.rows})`, async () => {
      resetTuiStore('zh', true);
      await saveTuiPreferences({ language: 'zh', asciiMode: true }, { env: { DSH_HOME: dshHome } });
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

        for (const step of EMPTY_16_VIEWS) {
          if (step.key) {
            for (const ch of step.key) {
              tty.send(ch);
              await tty.flush();
            }
          }

          await tty.waitFor(
            (s) =>
              useTuiStore.getState().page === step.id &&
              (step.zh.test(s) || s.includes('页面渲染异常') || s.includes('View Error')) &&
              !STILL_LOADING_RE.test(s),
            { timeoutMs: 20_000, label: `${step.id} @ zh ${vp.cols}x${vp.rows}` },
          );

          await tty.flush();
          const screen = tty.readScreen();

          const viewIssues = collectScreenIssues(
            tty,
            screen,
            vp.cols,
            vp.rows,
            { language: 'zh', checkEnglishNoCjk: false, asciiMode: true },
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

  test('Empty-library responsive audit teardown leaves zero leaked handles', async () => {
    await host.dispose();
    disposeTerminalPool();
    const afterRes = await waitForResourceTeardown(baselineResources);
    for (const kind of ['FSEventWrap', 'StatWatcher', 'ProcessWrap', 'Timeout']) {
      assert.ok(
        (afterRes[kind] || 0) <= (baselineResources[kind] || 0),
        `${kind} leaked: before=${baselineResources[kind] || 0} after=${afterRes[kind] || 0}`,
      );
    }
  });
});
