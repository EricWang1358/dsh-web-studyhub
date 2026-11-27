// Consolidated NFR Performance, Bundle Budget, CJK/Math/Markdown & Scale Guardrails:
// `node --test tests/perf-budget.test.mjs`
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { render, Text } from 'ink';
import { register, tsImport } from 'tsx/esm/api';
import stripAnsi from 'strip-ansi';
import { eastAsianWidth } from 'get-east-asian-width';
import { assertPerfBudget, cpuClock, createJitteredClock, wallClock } from './helpers/perf-gate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..');
const distDir = path.join(pkgRoot, 'dist');

const R = await tsImport('../src/render/index.ts', import.meta.url);
const T = await tsImport('../src/theme/tokens.ts', import.meta.url);
const { fuzzyScore, fuzzyFilter } = await tsImport('../src/shell/fuzzy.ts', import.meta.url);
const { groupSourcesFromSnapshot, normalizeFolderName } = await tsImport(
  '../src/views/sources/source-helpers.ts',
  import.meta.url,
);

const initialColorLevel = T.getColorLevel();

after(() => {
  T.setColorLevel(initialColorLevel);
  R.clearMathCache();
  R.clearMarkdownCache();
});

const SAMPLE_THEME = {
  id: 'dsh-dark',
  label: 'DSH Dark',
  dark: true,
  primary: '#4b6fff',
  accent: '#7da1de',
  success: '#38d39f',
  warning: '#f5b841',
  error: '#f06478',
  ai: '#a78bfa',
  info: '#7da1de',
  text: '#e6edf3',
  muted: '#8b949e',
  dim: '#565f6b',
  border: '#30363d',
  borderActive: '#4b6fff',
  bg: '#0d1117',
  surface: '#161b22',
  selectionBg: '#1f2a4d',
  selectionFg: '#ffffff',
  heading: '#9fb4ff',
  code: '#f5b841',
  codeBg: '#1c2230',
  link: '#7da1de',
  quote: '#8b949e',
  track: '#262c36',
  heat: ['#21262d', '#1d3b6e', '#2f56c4', '#4b6fff', '#9fb4ff'],
};

function extractStaticImportSpecifiers(source) {
  const specs = [];
  const fromRe = /\b(?:import|export)\b[\s\S]*?\bfrom\s*['"]([^'"]+)['"]/g;
  const sideEffectRe = /^\s*import\s*['"]([^'"]+)['"]/gm;
  let m;
  while ((m = fromRe.exec(source)) !== null) specs.push(m[1]);
  while ((m = sideEffectRe.exec(source)) !== null) specs.push(m[1]);
  return specs;
}

function extractDynamicImportSpecifiers(source) {
  const specs = [];
  const dynRe = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  const reqRe = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m;
  while ((m = dynRe.exec(source)) !== null) specs.push(m[1]);
  while ((m = reqRe.exec(source)) !== null) specs.push(m[1]);
  return specs;
}

function collectStaticImportClosure(entryPath) {
  const visited = new Set();
  const queue = [entryPath];
  const externalImports = new Set();
  const staticSpecifiers = [];
  const dynamicSpecifiers = [];

  while (queue.length > 0) {
    const cur = queue.shift();
    if (visited.has(cur) || !fs.existsSync(cur)) continue;
    visited.add(cur);

    const code = fs.readFileSync(cur, 'utf8');
    for (const spec of extractStaticImportSpecifiers(code)) {
      staticSpecifiers.push({ file: path.basename(cur), spec });
      if (spec.startsWith('.')) {
        const target = path.resolve(path.dirname(cur), spec);
        if (fs.existsSync(target)) queue.push(target);
      } else {
        externalImports.add(spec);
      }
    }
    for (const spec of extractDynamicImportSpecifiers(code)) {
      dynamicSpecifiers.push({ file: path.basename(cur), spec });
    }
  }

  return {
    visitedFiles: [...visited].map((p) => path.basename(p)),
    externalImports,
    staticSpecifiers,
    dynamicSpecifiers,
  };
}

function hasPackageImport(externalImports, pkgName) {
  return externalImports.has(pkgName) || [...externalImports].some((s) => s.startsWith(`${pkgName}/`));
}

// Lazy chunks that legitimately render markdown via MarkdownView / render/markdown.ts
const MARKDOWN_CHUNK_STEMS = new Set([
  'AiHelpDrawer',
  'AnswerCardModal',
  'BookQaModal',
  'BookRetellModal',
  'BookView',
  'CompanionsModal',
  'DeckManageModal',
  'DocumentReader',
  'DraftEditor',
  'ExamReportView',
  'ExamRunner',
  'GuidedStudyModal',
  'MarkdownView',
  'NotesView',
  'ReaderNotesDrawer',
  'RetellModal',
  'ReviewView',
  'RoundSummary',
  'SimilarCardsModal',
  'VoicePackModal',
  'WrongBookView',
  'markdown',
  'math',
]);

describe('StudyHub TUI NFR Performance & Bundle Budgets', () => {
  test('1. Bundle size budgets for cli.mjs, boot-frame.mjs, and App.mjs', () => {
    const budgets = [
      { file: 'cli.mjs', maxBytes: 15 * 1024 },
      { file: 'boot-frame.mjs', maxBytes: 5 * 1024 },
      { file: 'App.mjs', maxBytes: 64 * 1024 },
    ];
    for (const { file, maxBytes } of budgets) {
      const full = path.join(distDir, file);
      assert.ok(fs.existsSync(full), `missing dist/${file} (run npm run build first)`);
      const size = fs.statSync(full).size;
      assert.ok(
        size <= maxBytes,
        `dist/${file} is ${size} bytes (${(size / 1024).toFixed(1)} KB), exceeding budget ${maxBytes} bytes (${(maxBytes / 1024).toFixed(0)} KB)`,
      );
    }
  });

  test('2. Markdown LRU cache stays <= 256 and renders 300 mixed documents in < 1500ms CPU', () => {
    R.clearMarkdownCache();
    assert.equal(R.markdownCacheSize(), 0);

    const docs = Array.from({ length: 300 }, (_, i) => [
      `# 知识点 ${i + 1}: 进程调度与页表`,
      `第 **${i + 1}** 节推导：设吞吐率 $\\lambda_${i % 9} = \\frac{1}{\\mu + ${i % 5}}$，且 $\\alpha \\le \\beta$。`,
      '',
      '| 指标 | 数值 | 说明 |',
      '| --- | --- | --- |',
      `| 轮次 ${i} | ${i * 3}ms | CJK混合表 |`,
      '',
      '```js',
      `const step${i % 10} = (x) => x + ${i};`,
      '```',
    ].join('\n'));

    const width = 72;
    const renderBatch = () => {
      const rendered = new Array(docs.length);
      for (let i = 0; i < docs.length; i++) {
        rendered[i] = R.renderMarkdownLines(docs[i], {
          width,
          theme: SAMPLE_THEME,
          mathUnicode: true,
          ascii: i % 2 === 1,
        });
      }
      return rendered;
    };

    // Measure pure render CPU time across multiple cache-cleared samples; verify every line outside the timer.
    const { lastValue: renderedDocs } = assertPerfBudget(
      'rendering 300 markdown docs',
      renderBatch,
      1500,
      {
        warmup: 1,
        samples: 3,
        beforeSample: () => {
          R.clearMathCache();
          R.clearMarkdownCache();
        },
      },
    );

    for (let i = 0; i < renderedDocs.length; i++) {
      const lines = renderedDocs[i];
      assert.ok(Array.isArray(lines) && lines.length > 0, `doc ${i} produced empty output`);
      for (const line of lines) {
        assert.ok(R.displayWidth(line) <= width, `doc ${i} line exceeded width ${width}: ${R.displayWidth(line)}`);
      }
    }

    const cacheSize = R.markdownCacheSize();
    assert.ok(cacheSize > 0 && cacheSize <= 256, `expected markdown cache size in (0, 256], got ${cacheSize}`);
  });

  test('3. CJK & ANSI displayWidth/truncateDisplay 10,000-call throughput < 500ms CPU and width invariant', () => {
    const samples = [
      '操作系统原理：虚拟内存与缺页中断处理流程详解',
      '\u001B[31m重要考点\u001B[39m: Page Table & TLB Hit Ratio 🚀',
      'Mixed ASCII + 日本語 + 한국어 + 😀👍🏽👨‍👩‍👧 end',
      '\u001B]8;;https://example.com\u0007点击查看参考资料\u001B]8;;\u0007 (p.12)',
      'plain ascii diagnostic line for fast-path verification',
      '全角标点，测试换行！ＡＢＣ１２３——省略号…',
    ];
    const widths = [1, 4, 8, 15, 24, 40];

    for (const s of samples) {
      for (const w of widths) {
        const truncated = R.truncateDisplay(s, w);
        const truncW = R.displayWidth(truncated);
        assert.ok(truncW <= w, `truncateDisplay(${JSON.stringify(s)}, ${w}) width ${truncW} > ${w}`);
      }
    }

    const { lastValue: acc } = assertPerfBudget(
      '10,000 displayWidth/truncateDisplay calls',
      () => {
        let total = 0;
        for (let i = 0; i < 5_000; i++) {
          const s = samples[i % samples.length];
          const w = widths[i % widths.length];
          total += R.displayWidth(s);
          total += R.truncateDisplay(s, w).length;
        }
        return total;
      },
      500,
      { warmup: 1, samples: 5 },
    );
    assert.ok(acc > 0);
  });

  test('4. Static import closures of dist/boot-frame.mjs and dist/App.mjs exclude zod, marked, and cli-highlight (plus zero zod anywhere in dist/*.mjs)', () => {
    const bootPath = path.join(distDir, 'boot-frame.mjs');
    const appPath = path.join(distDir, 'App.mjs');
    assert.ok(fs.existsSync(bootPath), 'missing dist/boot-frame.mjs');
    assert.ok(fs.existsSync(appPath), 'missing dist/App.mjs');

    const bootClosure = collectStaticImportClosure(bootPath);
    assert.ok(bootClosure.visitedFiles.length >= 1);
    assert.ok(!hasPackageImport(bootClosure.externalImports, 'zod'), 'dist/boot-frame.mjs static closure must not import zod');
    assert.ok(!hasPackageImport(bootClosure.externalImports, 'marked'), 'dist/boot-frame.mjs static closure must not import marked');
    assert.ok(
      !hasPackageImport(bootClosure.externalImports, 'cli-highlight'),
      'dist/boot-frame.mjs static closure must not import cli-highlight',
    );
    assert.equal(
      bootClosure.visitedFiles.some((f) => f.startsWith('MarkdownView-') || f.startsWith('tui-host-')),
      false,
      'dist/boot-frame.mjs static closure must not pull MarkdownView or tui-host chunks',
    );
    assert.equal(
      bootClosure.dynamicSpecifiers.some(({ spec }) => spec === 'marked' || spec === 'cli-highlight'),
      false,
      'dist/boot-frame.mjs closure must not dynamically import marked or cli-highlight',
    );

    const appClosure = collectStaticImportClosure(appPath);
    assert.ok(appClosure.visitedFiles.length >= 1);
    assert.ok(!hasPackageImport(appClosure.externalImports, 'zod'), 'dist/App.mjs static closure must not import zod');
    assert.ok(!hasPackageImport(appClosure.externalImports, 'marked'), 'dist/App.mjs static closure must not import marked');
    assert.ok(
      !hasPackageImport(appClosure.externalImports, 'cli-highlight'),
      'dist/App.mjs static closure must not import cli-highlight',
    );
    assert.equal(
      appClosure.visitedFiles.some((f) => f.startsWith('MarkdownView-')),
      false,
      'dist/App.mjs static closure must not pull MarkdownView chunk',
    );
    assert.equal(
      appClosure.visitedFiles.some((f) => f === 'host.mjs' || f.startsWith('tui-host-')),
      false,
      'dist/App.mjs static closure must not statically pull host.mjs or tui-host chunk',
    );

    const allDistMjs = fs.readdirSync(distDir).filter((f) => f.endsWith('.mjs'));
    assert.ok(allDistMjs.length > 0, 'dist/ must contain built .mjs chunks');
    for (const file of allDistMjs) {
      const code = fs.readFileSync(path.join(distDir, file), 'utf8');
      const allSpecs = [
        ...extractStaticImportSpecifiers(code),
        ...extractDynamicImportSpecifiers(code),
      ];
      for (const spec of allSpecs) {
        assert.ok(
          spec !== 'zod' && !spec.startsWith('zod/'),
          `dist/${file} must not statically or dynamically import zod (found ${spec})`,
        );
      }
    }
  });

  test('5. Shell overlays (CommandPalette, HelpOverlay, CoursePickerModal, InboxModal) are code-split out of App.mjs and resolve lazily through <Suspense> in AppShell', async () => {
    const appPath = path.join(distDir, 'App.mjs');
    assert.ok(fs.existsSync(appPath), 'missing dist/App.mjs');

    const appClosure = collectStaticImportClosure(appPath);
    const distFiles = fs.readdirSync(distDir).filter((f) => f.endsWith('.mjs'));
    const overlayNames = ['CommandPalette', 'HelpOverlay', 'CoursePickerModal', 'InboxModal'];

    for (const overlayName of overlayNames) {
      // Static import closure of dist/App.mjs must not statically reference the overlay
      for (const { file, spec } of appClosure.staticSpecifiers) {
        assert.equal(
          new RegExp(`\\b${overlayName}\\b`).test(spec),
          false,
          `${file} in App.mjs static closure must not statically import ${overlayName} (${spec})`,
        );
      }

      // Built dist/ must contain a dedicated split chunk, dynamically referenced from App.mjs closure
      const chunkMatches = distFiles.filter((f) => f.startsWith(`${overlayName}-`) && f.endsWith('.mjs'));
      assert.ok(chunkMatches.length > 0, `expected lazy-split chunk ${overlayName}-*.mjs in dist/`);
      assert.ok(fs.statSync(path.join(distDir, chunkMatches[0])).size > 0, `${chunkMatches[0]} must be non-empty`);
      assert.ok(
        appClosure.dynamicSpecifiers.some(({ spec }) => spec.includes(`${overlayName}-`)),
        `dist/App.mjs closure must dynamically import ${overlayName}-*.mjs`,
      );
    }

    // Runtime behavior: mount AppShell inside an outer sentinel <Suspense> and open each lazy overlay,
    // proving AppShell's own <Suspense> boundaries catch suspension without bubbling out and blanking the shell.
    const unregisterTsx = register();
    let useTuiStore = null;
    let savedStore = null;
    let inst = null;
    try {
      const { AppShell } = await import('../src/shell/AppShell.tsx');
      const storeMod = await import('../src/state/store.ts');
      useTuiStore = storeMod.useTuiStore;
      const { DEFAULT_PREFERENCES } = storeMod;

      const prevState = useTuiStore.getState();
      savedStore = {
        page: prevState.page,
        loading: prevState.loading,
        snapshot: prevState.snapshot,
        preferences: prevState.preferences,
        showLaunchpad: prevState.showLaunchpad,
        commandPaletteOpen: prevState.commandPaletteOpen,
        helpOpen: prevState.helpOpen,
        coursePickerOpen: prevState.coursePickerOpen,
        inboxOpen: prevState.inboxOpen,
        notificationHistoryOpen: prevState.notificationHistoryOpen,
        voicePackOpen: prevState.voicePackOpen,
        quitConfirmOpen: prevState.quitConfirmOpen,
        assistantOpen: prevState.assistantOpen,
        assistantFocused: prevState.assistantFocused,
        toasts: prevState.toasts,
      };

      const stdin = new PassThrough();
      stdin.isTTY = true;
      stdin.setRawMode = () => stdin;
      stdin.ref = () => stdin;
      stdin.unref = () => stdin;

      const stdout = new PassThrough();
      stdout.isTTY = true;
      stdout.columns = 100;
      stdout.rows = 30;
      stdout.getColorDepth = () => 1;

      const frames = [];
      stdout.on('data', (chunk) => {
        const plain = stripAnsi(String(chunk));
        if (plain.trim().length > 0) frames.push(plain);
      });

      let outerSuspenseHits = 0;
      function OuterFallback() {
        outerSuspenseHits += 1;
        return React.createElement(Text, null, 'OUTER_SUSPENSE_FALLBACK');
      }

      const waitForOverlay = async (marker, label, timeoutMs = 6000) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const frame = frames.at(-1) ?? '';
          if (frame.includes(marker)) return frame;
          await new Promise((done) => setTimeout(done, 20));
        }
        assert.fail(`Timed out waiting for lazy overlay ${label} (${marker}).\nLast frame:\n${frames.at(-1) ?? ''}`);
      };

      const stubHost = {
        call: async (action) => (action === 'inbox' ? { ok: true, value: { items: [] } } : { ok: true, value: {} }),
        subscribe: () => () => {},
        dispose: async () => {},
        getLibraryRoot: () => '',
      };

      useTuiStore.setState({
        page: 'library',
        loading: false,
        snapshot: {
          decks: [],
          sources: [],
          jobs: [],
          archivedJobs: [],
          focus: { courses: [] },
          inbox: { items: [] },
        },
        preferences: { ...DEFAULT_PREFERENCES, language: 'zh', asciiMode: true, sidebarCollapsed: false, showKeyHints: true },
        showLaunchpad: false,
        commandPaletteOpen: false,
        helpOpen: false,
        coursePickerOpen: false,
        inboxOpen: false,
        notificationHistoryOpen: false,
        voicePackOpen: false,
        quitConfirmOpen: false,
        assistantOpen: false,
        assistantFocused: false,
        toasts: [],
      });

      inst = render(
        React.createElement(
          React.Suspense,
          { fallback: React.createElement(OuterFallback) },
          React.createElement(AppShell, {
            host: stubHost,
            autoLaunchpad: false,
            renderPage: () => React.createElement(Text, null, 'SHELL_OVERLAY_BASE'),
          }),
        ),
        { stdout, stdin, debug: true, exitOnCtrlC: false, patchConsole: false },
      );

      await waitForOverlay('SHELL_OVERLAY_BASE', 'base shell');

      const overlaysToCheck = [
        { name: 'CommandPalette', flag: 'commandPaletteOpen', marker: '命令面板' },
        { name: 'HelpOverlay', flag: 'helpOpen', marker: '快捷键与帮助' },
        { name: 'CoursePickerModal', flag: 'coursePickerOpen', marker: '切换课程' },
        { name: 'InboxModal', flag: 'inboxOpen', marker: '收件箱与通知' },
      ];

      for (const overlay of overlaysToCheck) {
        useTuiStore.setState({ [overlay.flag]: true });
        await waitForOverlay(overlay.marker, overlay.name);
        assert.equal(
          outerSuspenseHits,
          0,
          `${overlay.name} must be caught by AppShell's own <Suspense> rather than bubbling to outer Suspense`,
        );
        assert.equal(
          frames.some((f) => f.includes('OUTER_SUSPENSE_FALLBACK')),
          false,
          `${overlay.name} must not trigger outer Suspense fallback`,
        );
        useTuiStore.setState({ [overlay.flag]: false });
      }
    } finally {
      if (inst) inst.unmount();
      if (useTuiStore && savedStore) useTuiStore.setState(savedStore);
      unregisterTsx?.();
    }
  });

  test('6. Zero barrel imports (render/index.js, components/index.js, host/index.js, shell/index.js, views/*/index.js) across src/', () => {
    const srcDir = path.join(pkgRoot, 'src');
    const renderIndexPath = path.join(srcDir, 'render', 'index.ts');
    const componentsIndexPath = path.join(srcDir, 'components', 'index.ts');
    const hostIndexPath = path.join(srcDir, 'host', 'index.ts');
    const shellIndexPath = path.join(srcDir, 'shell', 'index.ts');
    const srcFiles = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|tsx|js|jsx|mjs)$/.test(entry.name)) srcFiles.push(full);
      }
    };
    walk(srcDir);

    const renderBarrelImporters = [];
    const componentBarrelImporters = [];
    const hostBarrelImporters = [];
    const shellBarrelImporters = [];
    const viewBarrelImporters = [];

    for (const file of srcFiles) {
      const source = fs.readFileSync(file, 'utf8');
      const allSpecs = [
        ...extractStaticImportSpecifiers(source),
        ...extractDynamicImportSpecifiers(source),
      ];
      if (
        file !== renderIndexPath &&
        allSpecs.some((spec) => /(?:^|\/)render\/index(?:\.js|\.ts)?$/.test(spec))
      ) {
        renderBarrelImporters.push(path.relative(pkgRoot, file));
      }
      if (
        file !== componentsIndexPath &&
        allSpecs.some((spec) => /(?:^|\/)components\/index(?:\.js|\.ts)?$/.test(spec))
      ) {
        componentBarrelImporters.push(path.relative(pkgRoot, file));
      }
      if (
        file !== hostIndexPath &&
        allSpecs.some((spec) => /(?:^|\/)host\/index(?:\.js|\.ts)?$/.test(spec))
      ) {
        hostBarrelImporters.push(path.relative(pkgRoot, file));
      }
      if (
        file !== shellIndexPath &&
        allSpecs.some((spec) => /(?:^|\/)shell\/index(?:\.js|\.ts)?$/.test(spec))
      ) {
        shellBarrelImporters.push(path.relative(pkgRoot, file));
      }
      if (
        !/[/\\]src[/\\]views[/\\][^/\\]+[/\\]index\.ts$/.test(file) &&
        allSpecs.some((spec) => /(?:^|\/)views\/[^/]+\/index(?:\.js|\.ts)?$/.test(spec) || /^\.\/index(?:\.js|\.ts)?$/.test(spec) && /[/\\]src[/\\]views[/\\]/.test(file))
      ) {
        viewBarrelImporters.push(path.relative(pkgRoot, file));
      }
    }

    assert.deepEqual(
      renderBarrelImporters,
      [],
      `src/ files must import direct render submodules instead of render/index.js: ${renderBarrelImporters.join(', ')}`,
    );
    assert.deepEqual(
      componentBarrelImporters,
      [],
      `src/ files must import direct component submodules instead of components/index.js: ${componentBarrelImporters.join(', ')}`,
    );
    assert.deepEqual(
      hostBarrelImporters,
      [],
      `src/ files must import direct host submodules instead of host/index.js: ${hostBarrelImporters.join(', ')}`,
    );
    assert.deepEqual(
      shellBarrelImporters,
      [],
      `src/ files must import direct shell submodules instead of shell/index.js: ${shellBarrelImporters.join(', ')}`,
    );
    assert.deepEqual(
      viewBarrelImporters,
      [],
      `src/ files must import direct view submodules instead of views/*/index.js: ${viewBarrelImporters.join(', ')}`,
    );
  });

  test('7. Dynamically discovered non-markdown lazy chunks in dist/ never statically import marked or cli-highlight', () => {
    const distFiles = fs.readdirSync(distDir).filter((f) => f.endsWith('.mjs')).sort();
    const nonMarkdownChunks = distFiles.filter((file) => {
      if (file.startsWith('chunk-')) return false;
      const m = /^([A-Za-z0-9-]+)-[A-Z0-9]+\.mjs$/.exec(file);
      if (!m) return false;
      return !MARKDOWN_CHUNK_STEMS.has(m[1]);
    });

    assert.ok(
      distFiles.some((f) => f.startsWith('MarkdownView-')),
      'expected dedicated MarkdownView-*.mjs lazy chunk in dist/',
    );
    assert.ok(
      nonMarkdownChunks.length >= 40,
      `expected >= 40 dynamically discovered non-markdown split chunks in dist/, found ${nonMarkdownChunks.length}`,
    );

    for (const entryChunk of nonMarkdownChunks) {
      const { externalImports, visitedFiles } = collectStaticImportClosure(path.join(distDir, entryChunk));
      assert.ok(
        !hasPackageImport(externalImports, 'marked'),
        `${entryChunk} static closure must not statically import marked`,
      );
      assert.ok(
        !hasPackageImport(externalImports, 'cli-highlight'),
        `${entryChunk} static closure must not statically import cli-highlight`,
      );
      assert.ok(
        !hasPackageImport(externalImports, 'zod'),
        `${entryChunk} static closure must not statically import zod`,
      );
      assert.ok(
        !visitedFiles.some((f) => f.startsWith('MarkdownView-')),
        `${entryChunk} static closure must not statically import MarkdownView chunk`,
      );
    }
  });
});

// --- Round 69: Bit-exact CJK/emoji/ANSI correctness & fast-path throughput ---

const refSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const REF_ANSI_RE =
  /\u001B\][\s\S]*?(?:\u0007|\u001B\\|\u009C)|[\u001B\u009B][[\]()#;?]*(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]/g;
const REF_UNICODE_ZERO_CAT = /^[\p{Mn}\p{Me}\p{Cf}]$/u;

function isRefZeroWidthCp(ch, includeExtra = false) {
  if (REF_UNICODE_ZERO_CAT.test(ch)) return true;
  const cp = ch.codePointAt(0);
  if (cp >= 0x200b && cp <= 0x200f) return true;
  if (cp >= 0xfe00 && cp <= 0xfe0f) return true;
  if (!includeExtra) return false;
  return (
    (cp >= 0x2028 && cp <= 0x202e) ||
    (cp >= 0x2060 && cp <= 0x2064) ||
    (cp >= 0xe0000 && cp <= 0xe007f)
  );
}

function isRefZeroWidthCluster(g) {
  let hasAny = false;
  for (const ch of g) {
    hasAny = true;
    if (!isRefZeroWidthCp(ch, true)) return false;
  }
  return hasAny;
}

const REF_PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
const REF_EMOJI_PRES = /^\p{Emoji_Presentation}/u;
const REF_REGIONAL = /^\p{Regional_Indicator}/u;

function refGraphemeWidth(g) {
  if (!g) return 0;
  if (isRefZeroWidthCluster(g)) return 0;
  if (REF_REGIONAL.test(g)) return 2;
  if (REF_EMOJI_PRES.test(g)) return 2;
  if (REF_PICTOGRAPHIC.test(g) && (g.includes('\uFE0F') || g.includes('\u200D'))) return 2;
  if (g.includes('\u20E3')) return 2;
  for (const ch of g) {
    if (isRefZeroWidthCp(ch, false)) continue;
    const cp = ch.codePointAt(0);
    if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
    return eastAsianWidth(cp, { ambiguousAsWide: false });
  }
  return 0;
}

function refDisplayWidth(str) {
  if (!str) return 0;
  const plain = stripAnsi(str);
  let w = 0;
  for (const seg of refSegmenter.segment(plain)) w += refGraphemeWidth(seg.segment);
  return w;
}

function refTokenize(str) {
  const out = [];
  const re = new RegExp(REF_ANSI_RE.source, 'g');
  let last = 0;
  let m;
  while ((m = re.exec(str)) !== null) {
    if (m.index > last) {
      for (const seg of refSegmenter.segment(str.slice(last, m.index))) {
        out.push({ s: seg.segment, w: refGraphemeWidth(seg.segment), ansi: false });
      }
    }
    out.push({ s: m[0], w: 0, ansi: true });
    last = re.lastIndex;
    if (m[0].length === 0) re.lastIndex++;
  }
  if (last < str.length) {
    for (const seg of refSegmenter.segment(str.slice(last))) {
      out.push({ s: seg.segment, w: refGraphemeWidth(seg.segment), ansi: false });
    }
  }
  return out;
}

function refTruncateDisplay(str, maxCols, ellipsis = '…') {
  const max = Math.floor(maxCols);
  if (!(max > 0)) return '';
  if (refDisplayWidth(str) <= max) return str;
  let ell = ellipsis;
  let ellW = refDisplayWidth(ell);
  if (ellW > max) {
    ell = '';
    ellW = 0;
  }
  const target = max - ellW;
  let out = '';
  let w = 0;
  let cut = false;
  for (const tok of refTokenize(str)) {
    if (tok.ansi) {
      out += tok.s;
      continue;
    }
    if (cut) continue;
    if (w + tok.w <= target) {
      out += tok.s;
      w += tok.w;
    } else {
      cut = true;
      out += ell;
    }
  }
  if (!cut) out += ell;
  return out;
}

function hasLoneSurrogate(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (next < 0xdc00 || next > 0xdfff) return true;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function assertAnsiClosed(line) {
  const sgrOpen = /(?:\u001B\[|\u009B)(?!(?:0|39|49)m)[\d;:]+m/;
  const oscOpen = /\u001B\]8;[^;]*;[^\u0007\u001B\u009C]+(?:\u0007|\u001B\\|\u009C)/;
  if (sgrOpen.test(line)) {
    assert.ok(
      /(?:\u001B\[|\u009B)(?:0|39|49)m/.test(line),
      `expected closed SGR in wrapped line: ${JSON.stringify(line)}`,
    );
  }
  if (oscOpen.test(line)) {
    assert.ok(
      line.includes('\u001B]8;;\u0007') || line.includes('\u001B]8;;\u001B\\'),
      `expected closed OSC-8 link in wrapped line: ${JSON.stringify(line)}`,
    );
  }
}

const TRICKY_STRINGS = [
  '',
  ' ',
  'plain ascii diagnostic line for fast-path verification',
  '!@#$%^&*()_+-=[]{}|;:\'",.<>?/\\~`',
  '中文',
  '操作系统原理：虚拟内存与缺页中断处理流程详解',
  '简体中文与繁體中文混合測試',
  '日本語ひらがなカタカナ漢字',
  'がぎぐげごパピプペポ',
  'か\u3099き\u3099は\u309A',
  'アイウ\u309B\u309Cヴ',
  '한국어 테스트',
  '가나다라마바사아자차카타파하',
  '\u1100\u1161\u11A8\u1102\u1161',
  '한\u302E글\u302F',
  '中\u302A文\u302D',
  '〿\u3040\u3097\u3098',
  '全角标点，测试换行！ＡＢＣ１２３——省略号…',
  '￥１００％　全角空格',
  'Mixed ASCII + 日本語 + 한국어 + 中文 end',
  '\u001B[31m重要考点\u001B[39m: Page Table & TLB Hit Ratio',
  '\u001B[38;5;196m256色高亮\u001B[0m + plain',
  '\u001B[38;2;75;111;255mTruecolor 色彩文本\u001B[0m end',
  '\u001B[1;4;32mBold+Underline+Green 中文样式\u001B[0m',
  '\u009B33mC1 CSI 黄色警告\u009B0m ok',
  '\u001B]8;;https://example.com\u0007点击查看参考资料\u001B]8;;\u0007 (p.12)',
  '\u001B]8;id=42;https://studyhub.dev\u001B\\ST Hyperlink 中文\u001B]8;;\u001B\\',
  '👨‍👩‍👧‍👦',
  '👩‍💻',
  '🧑‍🔬 + 🏳️‍🌈',
  '🇨🇳',
  '🇺🇸',
  '🇨🇳🇺🇸🇯🇵 flags',
  '1️⃣',
  '#️⃣0️⃣9️⃣',
  '👍🏽',
  '❤️✂️',
  'e\u0301',
  'a\u0300\u0323',
  'x\u20D7 + y\u0302',
  '中\u0301文\u0308',
  'a\u200Bb\u200Cc',
  'a\u200Db',
  'ctrl\x00\x07\x1F\x7Fend',
  'tab\tseparated\t中文',
  '😀👍🏽👨‍👩‍👧混合中文与English尾缀',
  '「中文引号」与（括号）测试，句号。',
];

describe('CJK/ANSI performance & bit-exactness', () => {
  test('1. Bit-exact equivalence & invariants across 45+ tricky strings', () => {
    assert.ok(TRICKY_STRINGS.length >= 40, `expected >= 40 tricky strings, got ${TRICKY_STRINGS.length}`);
    const widths = [0, 1, 2, 3, 4, 5, 8, 12, 20, 40];

    for (const s of TRICKY_STRINGS) {
      assert.equal(
        R.displayWidth(s),
        refDisplayWidth(s),
        `displayWidth mismatch for ${JSON.stringify(s)}`,
      );

      if (!s.includes('\u001B') && !s.includes('\u009B')) {
        assert.deepEqual(
          R.splitGraphemes(s),
          [...refSegmenter.segment(s)].map((seg) => seg.segment),
          `splitGraphemes mismatch for ${JSON.stringify(s)}`,
        );
      }

      for (const w of widths) {
        const actualTrunc = R.truncateDisplay(s, w);
        const expectedTrunc = refTruncateDisplay(s, w);
        assert.equal(
          actualTrunc,
          expectedTrunc,
          `truncateDisplay(${JSON.stringify(s)}, ${w}) mismatch`,
        );
        assert.ok(
          R.displayWidth(actualTrunc) <= w,
          `truncateDisplay(${JSON.stringify(s)}, ${w}) exceeded width`,
        );
        assert.equal(hasLoneSurrogate(actualTrunc), false, `lone surrogate in ${JSON.stringify(actualTrunc)}`);
        assert.equal(stripAnsi(actualTrunc).includes('\uFFFD'), false);

        for (const align of ['left', 'right', 'center']) {
          const padded = R.padDisplay(s, w, align);
          const expectedMinW = w === 0 && R.displayWidth(s) === 0 ? 0 : w;
          assert.equal(
            R.displayWidth(padded),
            expectedMinW,
            `padDisplay(${JSON.stringify(s)}, ${w}, ${align}) width mismatch`,
          );
          assert.equal(hasLoneSurrogate(padded), false);
        }

        if (w >= 2) {
          const wrapped = R.wrapDisplay(s, w);
          assert.ok(wrapped.length >= 1);
          for (const line of wrapped) {
            assert.ok(
              R.displayWidth(line) <= w,
              `wrapDisplay(${JSON.stringify(s)}, ${w}) line exceeded width: ${JSON.stringify(line)}`,
            );
            assert.equal(hasLoneSurrogate(line), false);
            assertAnsiClosed(line);
          }
        }
      }
    }

    for (const ell of ['', '...', '…', '··']) {
      for (const s of ['操作系统原理：虚拟内存', 'plain ascii line', '👨‍👩‍👧‍👦中文test', '\u001B[31m红色文本\u001B[0m']) {
        for (const w of [0, 1, 2, 5, 10]) {
          assert.equal(
            R.truncateDisplay(s, w, ell),
            refTruncateDisplay(s, w, ell),
            `truncateDisplay(${JSON.stringify(s)}, ${w}, ${JSON.stringify(ell)})`,
          );
        }
      }
    }

    // Differential check for every code point in the expanded fast-path BMP width-1 ranges
    // (box drawing, Latin-1, Greek, punctuation, super/sub, math operators) + SGR-styled variants.
    const fastBmpRanges = [
      [0x2500, 0x257f],
      [0x00b0, 0x00ff],
      [0x0391, 0x03c9],
      [0x2010, 0x2027],
      [0x2070, 0x209f],
      [0x2200, 0x22ff],
    ];
    for (const [lo, hi] of fastBmpRanges) {
      let chunk = '';
      for (let cp = lo; cp <= hi; cp++) {
        const ch = String.fromCharCode(cp);
        assert.equal(R.displayWidth(ch), refDisplayWidth(ch), `displayWidth mismatch at U+${cp.toString(16)}`);
        assert.equal(R.graphemeWidth(ch), refGraphemeWidth(ch), `graphemeWidth mismatch at U+${cp.toString(16)}`);
        chunk += ch;
      }
      const styled = `\u001B[38;2;75;111;255m${chunk}\u001B[0m中文`;
      assert.equal(R.displayWidth(styled), refDisplayWidth(styled), `styled SGR displayWidth mismatch for 0x${lo.toString(16)}`);
      assert.equal(R.truncateDisplay(chunk, 12), refTruncateDisplay(chunk, 12), `truncateDisplay mismatch for 0x${lo.toString(16)}`);
    }
  });

  test('2. 10,000 mixed ASCII+CJK displayWidth + truncateDisplay calls complete in < 200ms CPU', () => {
    const samples = [
      '操作系统原理：虚拟内存与缺页中断处理流程详解',
      'plain ascii diagnostic line for fast-path verification',
      'Mixed ASCII + 日本語 + 한국어 + 中文性能测试 Line 123',
      '全角标点，测试换行！ＡＢＣ１２３ａｂｃｄｅｆｇｈｉｊ',
      'CS162 Lecture 12: 进程调度 Scheduling & 页表 Translation',
      'アルゴリズムとデータ構造：二分探索木と平衡木',
    ];
    const widths = [4, 8, 15, 24, 32, 48];

    const { lastValue: acc } = assertPerfBudget(
      '10,000 mixed ASCII+CJK displayWidth/truncateDisplay calls',
      () => {
        let total = 0;
        for (let i = 0; i < 5_000; i++) {
          const s = samples[i % samples.length];
          const w = widths[i % widths.length];
          total += R.displayWidth(s);
          total += R.truncateDisplay(s, w).length;
        }
        return total;
      },
      200,
      { warmup: 2, samples: 7 },
    );
    assert.ok(acc > 0);
  });
});

// --- Round 70: Math & Markdown fast-path correctness, edge cases & NFR throughput ---

const THEME = T.getTheme('dsh-dark');
const MD_ANSI_RE =
  /\u001B\][\s\S]*?(?:\u0007|\u001B\\|\u009C)|[\u001B\u009B][[\]()#;?]*(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]/g;
const stripMdAnsi = (s) => s.replace(MD_ANSI_RE, '');

describe('Math & Markdown fast-path equivalence and NFR throughput', () => {
  test('1. Equivalence & edge-case coverage across prose, LaTeX delimiters, escapes, code, CJK tables, ascii, and NO_COLOR', () => {
    T.setColorLevel(3);
    R.clearMathCache();
    R.clearMarkdownCache();

    const plainProse = 'The quick brown fox jumps over 42 lazy dogs in StudyHub TUI.';
    assert.equal(
      R.replaceMath(plainProse, () => {
        throw new Error('replaceMath callback must not run on plain prose');
      }),
      plainProse,
    );
    assert.equal(R.renderInlineMath(plainProse), plainProse);
    assert.equal(R.renderMath('plain text 123'), 'plain text 123');
    assert.equal(
      R.replaceMath('C:\\Users\\studyhub\\notes.md', () => {
        throw new Error('replaceMath callback must not run on path without math delimiters');
      }),
      'C:\\Users\\studyhub\\notes.md',
    );

    assert.equal(R.renderMath('x^2 + \\alpha'), 'x² + α');
    assert.equal(R.renderMath('\\sum_{i=1}^n \\frac{1}{i}'), '∑ᵢ₌₁ⁿ 1/i');
    assert.equal(
      R.renderInlineMath('Inline $x^2 + \\alpha$ and display $$\\sum_{i=1}^n \\frac{1}{i}$$'),
      'Inline x² + α and display ∑ᵢ₌₁ⁿ 1/i',
    );

    assert.equal(
      R.renderInlineMath('Parens \\(\\beta + \\gamma\\) and brackets \\[\\sqrt{a^2 + b^2}\\]'),
      'Parens β + γ and brackets √(a² + b²)',
    );
    const mdParenBracket = R.renderMarkdownLines(
      'Inline \\(x^2 + \\alpha\\) here.\n\n\\[\n\\sum_{i=1}^n \\frac{1}{i}\n\\]',
      { width: 60, theme: THEME },
    ).map(stripMdAnsi).join('\n');
    assert.ok(mdParenBracket.includes('x² + α'), mdParenBracket);
    assert.ok(mdParenBracket.includes('∑ᵢ₌₁ⁿ 1/i'), mdParenBracket);

    assert.equal(R.renderInlineMath('Item costs \\$50 and $5 or $6.'), 'Item costs \\$50 and $5 or $6.');
    assert.equal(R.renderInlineMath('Price \\$50 with math $x^2$.'), 'Price \\$50 with math x².');
    const mdEscaped = R.renderMarkdownLines('Price is \\$50 today, and $x^2 + \\alpha$ is math.', {
      width: 60,
      theme: THEME,
    }).map(stripMdAnsi).join('\n');
    assert.ok(mdEscaped.includes('$50'), mdEscaped);
    assert.ok(mdEscaped.includes('x² + α'), mdEscaped);

    const mdCode = [
      'Inline code `$x^2 + \\alpha$` stays literal.',
      '',
      '```js',
      'const expr = "$x^2 + \\alpha$";',
      'const block = "$$\\\\sum_{i=1}^n \\\\frac{1}{i}$$";',
      '```',
      '',
      'Outside $x^2 + \\alpha$ converts.',
    ].join('\n');
    const codePlain = R.renderMarkdownLines(mdCode, { width: 70, theme: THEME }).map(stripMdAnsi).join('\n');
    assert.ok(codePlain.includes('$x^2 + \\alpha$'), 'inline codespan kept literal');
    assert.ok(codePlain.includes('const expr = "$x^2 + \\alpha$";'), 'fenced code block kept literal');
    assert.ok(codePlain.includes('Outside x² + α converts.'), 'prose math still converted');

    const rawMathLines = R.renderMarkdownLines('Check $x^2 + \\alpha$ and \\(\\beta\\).', {
      width: 60,
      theme: THEME,
      mathUnicode: false,
    }).map(stripMdAnsi).join('\n');
    assert.ok(rawMathLines.includes('$x^2 + \\alpha$') && rawMathLines.includes('\\(\\beta\\)'), rawMathLines);

    const cjkTableMd = [
      '| 章节 | 公式 | 状态 |',
      '|:--|:--:|--:|',
      '| 虚拟内存 | $x^2 + \\alpha$ | 95% |',
      '| 调度算法 | 吞吐率分析 | 100% |',
    ].join('\n');
    for (const width of [24, 40, 72]) {
      const lines = R.renderMarkdownLines(cjkTableMd, { width, theme: THEME });
      for (const l of lines) {
        assert.ok(R.displayWidth(l) <= width, `CJK table line exceeded width ${width}: ${stripMdAnsi(l)}`);
      }
      const plain = lines.map(stripMdAnsi);
      const gridRows = plain.filter((l) => /^[┌├└│]/.test(l));
      assert.equal(gridRows.length, 6);
      const rowWidth = R.displayWidth(gridRows[0]);
      for (const gr of gridRows) assert.equal(R.displayWidth(gr), rowWidth);
    }

    const asciiMd = [
      '# 标题 Heading',
      '',
      '> 引用 quote',
      '',
      '- item',
      '  - nested',
      '- [x] done',
      '',
      '| ColA | ColB |',
      '|---|---|',
      '| val | $x^2$ |',
      '',
      '```ts',
      'const a = 1;',
      '```',
    ].join('\n');
    const asciiLines = R.renderMarkdownLines(asciiMd, { width: 32, theme: THEME, ascii: true });
    const asciiForbidden = /[\u2500-\u257F\u2580-\u259F•◦☑☐▎…]/;
    for (const l of asciiLines) {
      assert.ok(R.displayWidth(l) <= 32);
      assert.equal(asciiForbidden.test(stripMdAnsi(l)), false, `unexpected non-ASCII glyph in ${JSON.stringify(stripMdAnsi(l))}`);
    }

    R.clearMarkdownCache();
    T.setColorLevel(0);
    const noColorMd = [
      '# Heading',
      '',
      'Plain prose and **bold** `code` [link](https://example.com).',
      '',
      'Inline math $x^2 + \\alpha$ and display:',
      '',
      '> quote',
      '',
      '$$\\sum_{i=1}^n \\frac{1}{i}$$',
      '',
      '| 科目 | 进度 |',
      '|---|---|',
      '| 数学 | 80% |',
      '',
      '```js',
      'const x = 1;',
      '```',
    ].join('\n');
    const noColorLines = R.renderMarkdownLines(noColorMd, { width: 60, theme: THEME });
    for (const l of noColorLines) {
      assert.equal(/\u001B|\u009B/.test(l), false, `NO_COLOR mode emitted ANSI escape: ${JSON.stringify(l)}`);
      assert.ok(R.displayWidth(l) <= 60);
    }
    const noColorJoined = noColorLines.join('\n');
    assert.ok(noColorJoined.includes('x² + α'));
    assert.ok(noColorJoined.includes('∑ᵢ₌₁ⁿ 1/i'));
    assert.ok(noColorJoined.includes('const x = 1;'));
  });

  test('2. NFR throughput: 5,000 plain-prose replaceMath < 25ms CPU and 300 mixed docs < 700ms CPU', () => {
    T.setColorLevel(3);
    const plainSamples = [
      'Operating systems manage virtual memory using multi-level page tables and TLB caches.',
      'Plain prose without any dollar signs or backslashes should hit the immediate return path.',
      'StudyHub flashcard spaced repetition schedules reviews based on recall confidence.',
      'Summary: read chapter 4, solve practice problems 1 through 12, and review notes.',
      '中文纯文本段落测试：不包含任何数学公式定界符，直接跳过正则扫描。',
    ];

    const { lastValue: plainAcc } = assertPerfBudget(
      '5,000 plain-prose replaceMath calls',
      () => {
        let acc = 0;
        for (let i = 0; i < 5_000; i++) {
          const out = R.replaceMath(plainSamples[i % plainSamples.length], () => '');
          acc += out.length;
        }
        return acc;
      },
      25,
      { warmup: 3, samples: 9, batch: 5 },
    );
    assert.ok(plainAcc > 0);

    R.renderMarkdownLines('```js\nconst warmup = 1;\n```', { width: 72, theme: THEME });

    const docs = Array.from({ length: 300 }, (_, i) => [
      `# 章节 ${i + 1}: 虚拟内存与调度`,
      `普通段落 ${i}: 介绍 **页面置换**、*TLB 命中率* 与 \`page_table[${i % 16}]\` 机制。`,
      `公式推导：设 $x^2 + \\alpha_${i % 7}$ 且 $$\\sum_{k=1}^{${(i % 5) + 2}} \\frac{1}{k}$$，价格 \\$50。`,
      '',
      '| 指标 | 数值 | 备注 |',
      '|:--|:--:|--:|',
      `| 轮次 ${i} | ${i * 2}ms | 中文表格 |`,
      '',
      '```js',
      `const step${i % 8} = "$x$" + ${i};`,
      '```',
    ].join('\n'));

    const width = 72;
    const { lastValue: renderedDocs } = assertPerfBudget(
      '300 mixed Markdown+LaTeX+table docs',
      () => {
        const rendered = new Array(docs.length);
        for (let i = 0; i < docs.length; i++) {
          rendered[i] = R.renderMarkdownLines(docs[i], {
            width,
            theme: THEME,
            mathUnicode: true,
            ascii: i % 2 === 1,
          });
        }
        return rendered;
      },
      700,
      {
        warmup: 1,
        samples: 3,
        beforeSample: () => {
          R.clearMathCache();
          R.clearMarkdownCache();
        },
      },
    );

    for (let i = 0; i < renderedDocs.length; i++) {
      const lines = renderedDocs[i];
      assert.ok(lines.length > 0, `doc ${i} produced empty lines`);
      for (const line of lines) {
        assert.ok(
          R.displayWidth(line) <= width,
          `doc ${i} line exceeded width ${width}: ${R.displayWidth(line)}`,
        );
      }
    }

    assert.ok(R.markdownCacheSize() > 0 && R.markdownCacheSize() <= 256);
    assert.ok(R.mathCacheSize() > 0 && R.mathCacheSize() <= 512);
  });
});

// --- Round 71: Bit-exact equivalence & large-library NFR benchmarks for fuzzy.ts & source-helpers.ts ---

const REF_BOUNDARY = /[\s\-_/.:·|()[\]]/;
const REF_SURROGATE_RE = /[\uD800-\uDFFF]/;

function refPrepareQuery(query) {
  const joined = query.toLowerCase().trim();
  if (joined.length === 0) return null;
  const hasSurrogate = REF_SURROGATE_RE.test(joined);
  const chars = [];
  if (!hasSurrogate) {
    for (let i = 0; i < joined.length; i++) {
      const ch = joined[i];
      if (ch !== ' ') chars.push(ch);
    }
  } else {
    for (const ch of joined) {
      if (ch !== ' ') chars.push(ch);
    }
  }
  return { joined, chars, hasSurrogate };
}

function refScorePrepared(pq, text) {
  const chars = pq.chars;
  if (chars.length === 0) return { score: 0, positions: [] };
  if (text.length === 0) return null;
  const lower = text.toLowerCase();
  if (!pq.hasSurrogate && !REF_SURROGATE_RE.test(lower)) {
    const positions = new Array(chars.length);
    let score = 0;
    let ti = 0;
    let prev = -2;
    for (let i = 0; i < chars.length; i++) {
      const found = lower.indexOf(chars[i], ti);
      if (found < 0) return null;
      let s = 1;
      if (found === prev + 1) s += 4;
      if (found === 0 || REF_BOUNDARY.test(lower[found - 1])) s += 3;
      if (found === 0) s += 2;
      score += s;
      positions[i] = found;
      prev = found;
      ti = found + 1;
    }
    const idx = lower.indexOf(pq.joined);
    if (idx >= 0) score += 8 + (idx === 0 ? 6 : 0);
    score -= Math.min(10, Math.floor(lower.length / 12));
    return { score, positions };
  }
  const t = Array.from(lower);
  const positions = [];
  let score = 0;
  let ti = 0;
  let prev = -2;
  for (let i = 0; i < chars.length; i++) {
    const qc = chars[i];
    let found = -1;
    while (ti < t.length) {
      if (t[ti] === qc) {
        found = ti;
        break;
      }
      ti += 1;
    }
    if (found < 0) return null;
    let s = 1;
    if (found === prev + 1) s += 4;
    if (found === 0 || REF_BOUNDARY.test(t[found - 1] ?? '')) s += 3;
    if (found === 0) s += 2;
    score += s;
    positions.push(found);
    prev = found;
    ti = found + 1;
  }
  const idx = lower.indexOf(pq.joined);
  if (idx >= 0) score += 8 + (idx === 0 ? 6 : 0);
  score -= Math.min(10, Math.floor(t.length / 12));
  return { score, positions };
}

function refFuzzyScore(query, text) {
  const pq = refPrepareQuery(query);
  if (!pq) return { score: 0, positions: [] };
  return refScorePrepared(pq, text);
}

function refFuzzyFilter(items, query, getText, getKeywords, limit = 200) {
  const pq = refPrepareQuery(query);
  if (!pq) return items.slice(0, limit).map((item) => ({ item, score: 0, positions: [] }));
  const out = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const label = getText(item);
    let best = refScorePrepared(pq, label);
    if (!best && getKeywords) {
      const kws = getKeywords(item);
      if (kws) {
        for (let j = 0; j < kws.length; j++) {
          const r = refScorePrepared(pq, kws[j]);
          if (r && (!best || r.score - 2 > best.score)) {
            best = { score: r.score - 2, positions: [] };
          }
        }
      }
    }
    if (best) out.push({ item, score: best.score, positions: best.positions });
  }
  out.sort((a, b) => b.score - a.score);
  return out.length > limit ? out.slice(0, limit) : out;
}

function buildScalePerfLibrary() {
  const docCount = 400;
  const pagesPerDoc = 5;
  const sources = [];
  const docFormats = ['pdf', 'pptx', 'md'];
  for (let d = 0; d < docCount; d++) {
    const fmt = docFormats[d % docFormats.length];
    const course = `COURSE-${d % 8}`;
    const hashHex = String(d).padStart(64, 'a');
    for (let p = pagesPerDoc; p >= 1; p--) {
      const isEn = d % 2 === 0;
      const baseTitle = isEn
        ? `Lecture ${String(d).padStart(3, '0')} Virtual Memory`
        : `讲义 ${String(d).padStart(3, '0')} 虚拟内存与页表`;
      sources.push({
        id: `src-doc-${d}-p${p}`,
        title: `${baseTitle} · p.${p}`,
        course,
        courses: [course],
        chars: 1400 + p * 25,
        pinned: d < 4 && p === 1,
        archived: d >= 380,
        folder: d % 5 === 0 ? `Module-${d % 4}` : undefined,
        updatedAt: '2026-11-20T08:00:00Z',
        document:
          fmt === 'pdf'
            ? {
                id: hashHex,
                materialId: `document-${hashHex}-pdf`,
                format: 'pdf',
                page: p,
                bookTitle: baseTitle,
              }
            : fmt === 'pptx'
              ? {
                  materialId: `mat-${fmt}-${d}`,
                  format: fmt,
                  page: p,
                  filename: `${baseTitle}.${fmt}`,
                }
              : {
                  materialId: `mat-${fmt}-${d}`,
                  format: fmt,
                  filename: `${baseTitle}.${fmt}`,
                },
      });
    }
  }
  for (let h = 0; h < 20; h++) {
    sources.push({
      id: `src-hist-${h}`,
      title: `Superseded Lecture ${h}`,
      course: `COURSE-${h % 8}`,
      historical: true,
      chars: 900,
    });
  }
  sources.push({
    id: 'src-list-blueprint',
    title: 'Exam Blueprint',
    course: 'COURSE-0',
    provenance: 'exam-blueprint',
    blueprint: { points: [] },
  });

  const decks = [];
  const searchableCards = [];
  for (let dIdx = 0; dIdx < 250; dIdx++) {
    const cards = [];
    for (let cIdx = 0; cIdx < 20; cIdx++) {
      const g = dIdx * 20 + cIdx;
      const srcDocIdx = g % docCount;
      const isEn = g % 2 === 0;
      const prompt = isEn
        ? `Explain virtual memory page table lookup #${g}`
        : `解析虚拟内存与多级页表地址转换机制 #${g}`;
      const topic = isEn ? `Paging-${dIdx % 16}` : `页表机制-${dIdx % 16}`;
      cards.push({
        id: `card-${g}`,
        selections: [{ sourceId: `src-doc-${srcDocIdx}-p1` }],
        citations: [{ selection: { sourceId: `src-doc-${srcDocIdx}-p2` } }],
      });
      searchableCards.push({
        id: `card-${g}`,
        label: prompt,
        keywords: [`COURSE-${dIdx % 8}`, topic, isEn ? 'tlb' : '缺页中断', `deck-${dIdx}`],
      });
    }
    decks.push({ id: `deck-${dIdx}`, cards });
  }

  const snapshot = {
    sources,
    decks,
    drafts: [],
    documents: Array.from({ length: 10 }, (_, i) => ({
      id: `versioned-doc-${i}`,
      currentRevision: 2,
      versions: [
        { revision: 1, sourceIds: [`src-hist-${i}`] },
        { revision: 2, sourceIds: [`src-doc-${i}-p1`] },
      ],
    })),
    settings: {
      materialPins: ['doc:mat-md-2', 'doc:mat-pptx-1'],
      materialFolders: {
        folders: ['Module-0', 'Module-1'],
        items: { 'doc:mat-pptx-4': 'Module-1' },
      },
    },
  };

  return { snapshot, searchableCards, docCount };
}

describe('Bit-Exact Equivalence & Large-Library Scale NFR (fuzzy & source-helpers)', () => {
  test('1. Bit-exact equivalence for fuzzyScore & fuzzyFilter across EN, CJK, mixed, boundaries, keywords, Unicode, and astral emoji', () => {
    const queries = [
      '',
      '   ',
      'v',
      'VMP',
      'virtual memory',
      'virtual memory page',
      '虚拟',
      '虚拟内存页表',
      '页表 p1',
      'lecture-01',
      '🚀',
      '🚀 vm',
      'vm 🚀',
      '👨‍👩‍👧‍👦',
      '👨‍👩‍👧‍👦 family',
      'i',
      'k',
      '12',
      'a'.repeat(300),
    ];

    const texts = [
      '',
      'Virtual Memory Page Table',
      'virtual memory page exact match',
      'Lecture 001 Virtual Memory · p.1',
      'foo/bar_baz:qux|item(1)[2]',
      '讲义 001 虚拟内存与页表 · p.1',
      '全角\u3000虚拟内存',
      'NBSP\u00A0memory',
      '🚀 virtual memory',
      'virtual 🚀 memory page',
      '👨‍👩‍👧‍👦 family tree & virtual memory',
      'İstanbul Kelvin Kelvin',
      '12345 numeric lookup',
      'prefix_' + 'a'.repeat(300) + '_suffix',
    ];

    for (const q of queries) {
      for (const t of texts) {
        assert.deepEqual(
          fuzzyScore(q, t),
          refFuzzyScore(q, t),
          `fuzzyScore mismatch for query=${JSON.stringify(q)} text=${JSON.stringify(t)}`,
        );
      }
    }

    const items = texts.map((label, idx) => ({
      id: `item-${idx}`,
      label,
      keywords: [
        idx % 2 === 0 ? 'kw-virtual-memory' : 'kw-虚拟内存',
        idx === 3 ? '🚀 rocket-kw' : 'tlb-hit',
        'Kelvin-kw',
      ],
    }));

    for (const q of queries) {
      for (const limit of [5, 200]) {
        const actual = fuzzyFilter(items, q, (x) => x.label, (x) => x.keywords, limit);
        const expected = refFuzzyFilter(items, q, (x) => x.label, (x) => x.keywords, limit);
        assert.deepEqual(
          actual,
          expected,
          `fuzzyFilter mismatch for query=${JSON.stringify(q)} limit=${limit}`,
        );
      }
    }
  });

  test('1b. Exact grouping, multi-source cardCount deduplication (1, 2, 3+ distinct sources), and folder normalization', () => {
    assert.equal(normalizeFolderName('  Module   One \t '), 'Module One');
    assert.equal(normalizeFolderName('Module-1'), 'Module-1');
    assert.equal(normalizeFolderName('   '), '');

    const snapshot = {
      sources: [
        {
          id: 's-pdf-2',
          title: 'Book · p.2',
          course: 'CS101',
          chars: 200,
          document: { id: 'a'.repeat(64), materialId: `document-${'a'.repeat(64)}-pdf`, format: 'pdf', page: 2, bookTitle: 'dir/Book.pdf' },
        },
        {
          id: 's-pdf-1',
          title: 'Book · p.1',
          courses: ['CS101', 'CS102'],
          chars: 100,
          pinned: true,
          document: { id: 'a'.repeat(64), materialId: `document-${'a'.repeat(64)}-pdf`, format: 'pdf', page: 1, bookTitle: 'dir/Book.pdf' },
        },
        {
          id: 's-pptx-1',
          title: 'Slides · p.1',
          course: 'CS101',
          archived: true,
          chars: 300,
          folder: '  Week  1 ',
          document: { materialId: 'slides-1', format: 'pptx', page: 1, filename: 'Slides.pptx' },
        },
        {
          id: 's-audio-2',
          title: 'Track (2/2)',
          chars: 50,
          audio: { batch: { id: 'b1', volume: 2, title: 'Audio Lecture' } },
        },
        {
          id: 's-audio-1',
          title: 'Track (1/2)',
          chars: 40,
          audio: { batch: { id: 'b1', volume: 1, title: 'Audio Lecture' } },
        },
      ],
      decks: [
        {
          id: 'd1',
          cards: [
            {
              id: 'c1',
              selections: [{ sourceId: 's-pdf-1' }, { sourceId: 's-pdf-1' }, { sourceId: 's-pdf-2' }],
              citations: [{ selection: { sourceId: 's-pptx-1' } }, { sourceId: 's-pdf-2' }],
            },
            {
              id: 'c2',
              selections: [{ sourceId: 's-audio-1' }],
              citations: [],
            },
          ],
        },
      ],
      drafts: [
        {
          id: 'dr1',
          cards: [
            {
              id: 'c3',
              selections: [{ sourceId: 's-pdf-1' }],
              citations: [{ selection: { sourceId: 's-audio-2' } }],
            },
          ],
        },
      ],
      settings: {
        materialPins: ['doc:slides-1'],
      },
    };

    const groups = groupSourcesFromSnapshot(snapshot);
    assert.equal(groups.length, 3);
    assert.deepEqual(
      groups.map((g) => g.key),
      ['doc:slides-1', `pdf:${'a'.repeat(64)}`, 'audio:b1'],
    );
    assert.equal(groups[0].folder, 'Week 1');
    assert.equal(groups[0].archived, true);
    assert.equal(groups[0].cardCount, 1);

    assert.equal(groups[1].title, 'Book.pdf');
    assert.deepEqual(groups[1].sourceIds, ['s-pdf-1', 's-pdf-2']);
    assert.deepEqual(groups[1].courses, ['CS101', 'CS102']);
    assert.equal(groups[1].cardCount, 3);
    assert.equal(groups[1].chars, 300);

    assert.equal(groups[2].title, 'Audio Lecture');
    assert.deepEqual(groups[2].sourceIds, ['s-audio-1', 's-audio-2']);
    assert.equal(groups[2].cardCount, 2);
  });

  test('2. Large-scale NFR proof: fuzzyFilter 5,000 items median < 15ms CPU & groupSourcesFromSnapshot 2,000 sources median < 25ms CPU', () => {
    const { snapshot, searchableCards, docCount } = buildScalePerfLibrary();

    assertPerfBudget(
      'fuzzyFilter EN (5,000 items)',
      () => fuzzyFilter(searchableCards, 'virtual memory page', (x) => x.label, (x) => x.keywords, 50),
      15,
      { warmup: 3, samples: 9 },
    );
    assertPerfBudget(
      'fuzzyFilter CJK (5,000 items)',
      () => fuzzyFilter(searchableCards, '虚拟内存页表', (x) => x.label, (x) => x.keywords, 50),
      15,
      { warmup: 3, samples: 9 },
    );
    const { lastValue: groups } = assertPerfBudget(
      'groupSourcesFromSnapshot (2,000 sources)',
      () => groupSourcesFromSnapshot(snapshot),
      25,
      { warmup: 3, samples: 9 },
    );

    assert.equal(groups.length, docCount);
    const totalCardHits = groups.reduce((acc, g) => acc + g.cardCount, 0);
    assert.equal(totalCardHits, 10000);
  });

  test('3. Flake-reproduction: wall-clock preemption jitter flakes single-shot checks while sampled CPU gate stays green and still catches genuine slowdowns', () => {
    const plainSamples = [
      'Operating systems manage virtual memory using multi-level page tables and TLB caches.',
      'Plain prose without any dollar signs or backslashes should hit the immediate return path.',
      '中文纯文本段落测试：不包含任何数学公式定界符，直接跳过正则扫描。',
    ];
    const runReplaceMathBatch = () => {
      let acc = 0;
      for (let i = 0; i < 5_000; i++) {
        acc += R.replaceMath(plainSamples[i % plainSamples.length], () => '').length;
      }
      return acc;
    };

    // (a) Reproduce CI high-load wall-clock preemption (+45ms stall): naive single-shot wall-clock check FLAKES.
    const jitteredWall = createJitteredClock([45], wallClock);
    assert.throws(
      () => assertPerfBudget('naive wall-clock replaceMath', runReplaceMathBatch, 25, {
        warmup: 0,
        samples: 1,
        clock: jitteredWall,
      }),
      /exceeded budget < 25ms/,
      'single-shot wall-clock check must flake under injected 45ms preemption stall',
    );

    // (b) Hardened gate stays GREEN under both off-CPU preemption (process.cpuUsage()) and
    //     isolated multi-sample jitter spikes (2 of 9 samples spiked +60ms / +95ms).
    const cpuResult = assertPerfBudget('hardened CPU replaceMath', runReplaceMathBatch, 25, {
      warmup: 3,
      samples: 9,
      batch: 5,
      clock: cpuClock,
    });
    assert.ok(cpuResult.lastValue > 0);

    const spikedSampleClock = createJitteredClock([0, 60, 0, 0, 95, 0, 0, 0, 0], cpuClock);
    assertPerfBudget('sampled median replaceMath with outlier spikes', runReplaceMathBatch, 25, {
      warmup: 0,
      samples: 9,
      batch: 5,
      clock: spikedSampleClock,
    });

    // (c) A genuine slowdown regression (wrapping the real `replaceMath` batch with uncached
    //     LaTeX parsing across 1,500 unique expressions as if the plain-prose fast path were
    //     bypassed) STILL FAILS the hardened gate.
    const regressedInputs = Array.from(
      { length: 1_500 },
      (_, k) => `Derivation #${k}: $\\lambda_${k} = \\frac{1}{\\mu + ${k}}$ and $$\\sum_{i=1}^{${k + 1}} \\alpha_i + x^${k}$$.`,
    );
    const runRegressedReplaceMathBatch = () => {
      let acc = runReplaceMathBatch();
      R.clearMathCache();
      for (let i = 0; i < regressedInputs.length; i++) {
        acc += R.replaceMath(regressedInputs[i], ({ tex }) => R.renderMath(tex)).length;
      }
      return acc;
    };
    const calibratedBudgetMs = Math.min(25, Math.max(cpuResult.median * 10, 0.5));
    assert.throws(
      () =>
        assertPerfBudget(
          'genuinely slow uncached replaceMath regression',
          runRegressedReplaceMathBatch,
          calibratedBudgetMs,
          { warmup: 1, samples: 3, clock: cpuClock },
        ),
      /exceeded budget </,
      'hardened CPU gate must still fail when replaceMath falls off its fast path',
    );
  });
});
