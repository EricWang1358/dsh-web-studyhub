// Automated NFR Performance & Bundle Budget Guardrails: `node --test tests/perf-budget.test.mjs`
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..');
const distDir = path.join(pkgRoot, 'dist');

const tempOutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studyhub-perf-budget-'));
const renderOutFile = path.join(tempOutDir, 'render.mjs');
await build({
  entryPoints: [path.join(pkgRoot, 'src/render/index.ts')],
  outfile: renderOutFile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  logLevel: 'silent',
  absWorkingDir: pkgRoot,
});
fs.symlinkSync(path.join(pkgRoot, 'node_modules'), path.join(tempOutDir, 'node_modules'), 'junction');
const R = await import(pathToFileURL(renderOutFile).href);

after(() => {
  fs.rmSync(tempOutDir, { recursive: true, force: true });
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

describe('StudyHub TUI NFR Performance & Bundle Budgets', () => {
  test('1. Bundle size budgets for cli.mjs, boot-frame.mjs, and App.mjs', () => {
    const budgets = [
      { file: 'cli.mjs', maxBytes: 15 * 1024 },
      { file: 'boot-frame.mjs', maxBytes: 5 * 1024 },
      // AppShell is inlined into App.mjs once no view imports shell/index.js (tighter than prior 76 KB + 35 KB split).
      { file: 'App.mjs', maxBytes: 106 * 1024 },
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

  test('2. Markdown LRU cache stays <= 256 and renders 300 mixed documents in < 1500ms', () => {
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
    const t0 = performance.now();
    for (let i = 0; i < docs.length; i++) {
      const lines = R.renderMarkdownLines(docs[i], {
        width,
        theme: SAMPLE_THEME,
        mathUnicode: true,
        ascii: i % 2 === 1,
      });
      assert.ok(Array.isArray(lines) && lines.length > 0, `doc ${i} produced empty output`);
      for (const line of lines) {
        assert.ok(R.displayWidth(line) <= width, `doc ${i} line exceeded width ${width}: ${R.displayWidth(line)}`);
      }
    }
    const elapsedMs = performance.now() - t0;

    const cacheSize = R.markdownCacheSize();
    assert.ok(cacheSize > 0 && cacheSize <= 256, `expected markdown cache size in (0, 256], got ${cacheSize}`);
    assert.ok(elapsedMs < 1500, `rendering 300 markdown docs took ${elapsedMs.toFixed(1)}ms (budget < 1500ms)`);
  });

  test('3. CJK & ANSI displayWidth/truncateDisplay 10,000-call throughput < 500ms and width invariant', () => {
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

    const t0 = performance.now();
    let acc = 0;
    for (let i = 0; i < 5_000; i++) {
      const s = samples[i % samples.length];
      const w = widths[i % widths.length];
      acc += R.displayWidth(s);
      acc += R.truncateDisplay(s, w).length;
    }
    const elapsedMs = performance.now() - t0;

    assert.ok(acc > 0);
    assert.ok(elapsedMs < 500, `10,000 displayWidth/truncateDisplay calls took ${elapsedMs.toFixed(1)}ms (budget < 500ms)`);
  });

  test('4. Zero static heavy imports (marked / cli-highlight) on dist/boot-frame.mjs critical path', () => {
    const entryPath = path.join(distDir, 'boot-frame.mjs');
    assert.ok(fs.existsSync(entryPath), 'missing dist/boot-frame.mjs');

    const visited = new Set();
    const queue = [entryPath];
    const externalImports = new Set();

    while (queue.length > 0) {
      const cur = queue.shift();
      if (visited.has(cur)) continue;
      visited.add(cur);

      const code = fs.readFileSync(cur, 'utf8');
      for (const spec of extractStaticImportSpecifiers(code)) {
        if (spec.startsWith('.')) {
          const target = path.resolve(path.dirname(cur), spec);
          if (fs.existsSync(target)) queue.push(target);
        } else {
          externalImports.add(spec);
        }
      }
      assert.ok(
        !/\b(?:marked|cli-highlight)\b/.test(code),
        `boot-frame chunk ${path.basename(cur)} must not reference marked or cli-highlight`,
      );
    }

    assert.ok(!externalImports.has('marked'), 'dist/boot-frame.mjs must not statically import marked');
    assert.ok(!externalImports.has('cli-highlight'), 'dist/boot-frame.mjs must not statically import cli-highlight');
  });

  test('5. Shell overlays (CommandPalette, HelpOverlay, CoursePickerModal, InboxModal) are code-split out of App.mjs and AppShell static graph', () => {
    const appPath = path.join(distDir, 'App.mjs');
    const appCode = fs.readFileSync(appPath, 'utf8');
    const shellImportMatch = /import\s*\{[^}]*\bAppShell\b[^}]*\}\s*from\s*['"](\.\/chunk-[^'"]+\.mjs)['"]/.exec(appCode);
    if (shellImportMatch) {
      const shellChunkPath = path.join(distDir, shellImportMatch[1]);
      assert.ok(fs.existsSync(shellChunkPath), `missing shell chunk ${shellImportMatch[1]}`);
      const shellSize = fs.statSync(shellChunkPath).size;
      assert.ok(
        shellSize <= 35 * 1024,
        `AppShell chunk ${shellImportMatch[1]} is ${shellSize} bytes (${(shellSize / 1024).toFixed(1)} KB), exceeding 35 KB split budget`,
      );
    } else {
      assert.ok(/\bAppShell\b/.test(appCode), 'AppShell must be present in dist/App.mjs or a split chunk');
    }

    const overlayNames = ['CommandPalette', 'HelpOverlay', 'CoursePickerModal', 'InboxModal'];
    const overlayRe = new RegExp(`\\b(?:${overlayNames.join('|')})\\b`);
    const visited = new Set();
    const queue = [appPath];

    while (queue.length > 0) {
      const cur = queue.shift();
      if (visited.has(cur)) continue;
      visited.add(cur);

      const code = fs.readFileSync(cur, 'utf8');
      const chunkName = path.basename(cur);
      for (const spec of extractStaticImportSpecifiers(code)) {
        assert.ok(
          !overlayRe.test(spec),
          `${chunkName} must not statically import overlay module ${spec}`,
        );
        if (spec.startsWith('.')) {
          const target = path.resolve(path.dirname(cur), spec);
          if (fs.existsSync(target)) queue.push(target);
        }
      }

      for (const overlayName of overlayNames) {
        assert.ok(
          !new RegExp(`function\\s+${overlayName}\\d*\\b`).test(code) &&
            !new RegExp(`//\\s*src/shell/${overlayName}\\.tsx\\b`).test(code),
          `${overlayName} must be lazy-split into its own chunk, not bundled into static graph chunk ${chunkName}`,
        );
      }
    }

    const distFiles = fs.readdirSync(distDir);
    for (const overlayName of overlayNames) {
      assert.ok(
        distFiles.some((f) => f.startsWith(`${overlayName}-`) && f.endsWith('.mjs')),
        `expected lazy-split chunk ${overlayName}-*.mjs in dist/`,
      );
    }
  });

  test('6. dist/App.mjs static closure excludes zod, marked, render/markdown.ts, render/math.ts, and host/{tui-host,desktop-deps,presets}.ts; startup path avoids barrels', () => {
    const appPath = path.join(distDir, 'App.mjs');
    assert.ok(fs.existsSync(appPath), 'missing dist/App.mjs');

    const visited = new Set();
    const queue = [appPath];
    const externalImports = new Set();

    while (queue.length > 0) {
      const cur = queue.shift();
      if (visited.has(cur)) continue;
      visited.add(cur);

      const code = fs.readFileSync(cur, 'utf8');
      const chunkName = path.basename(cur);
      for (const spec of extractStaticImportSpecifiers(code)) {
        if (spec.startsWith('.')) {
          const target = path.resolve(path.dirname(cur), spec);
          if (fs.existsSync(target)) queue.push(target);
        } else {
          externalImports.add(spec);
        }
      }

      assert.ok(
        !/^\/\/\s*src\/render\/markdown\.ts\b/m.test(code),
        `App.mjs static chunk ${chunkName} must not bundle src/render/markdown.ts`,
      );
      assert.ok(
        !/^\/\/\s*src\/render\/math\.ts\b/m.test(code),
        `App.mjs static chunk ${chunkName} must not bundle src/render/math.ts`,
      );
      assert.ok(
        !/^\/\/\s*src\/host\/tui-host\.ts\b/m.test(code),
        `App.mjs static chunk ${chunkName} must not bundle src/host/tui-host.ts`,
      );
      assert.ok(
        !/^\/\/\s*src\/host\/desktop-deps\.ts\b/m.test(code),
        `App.mjs static chunk ${chunkName} must not bundle src/host/desktop-deps.ts`,
      );
      assert.ok(
        !/^\/\/\s*src\/host\/presets\.ts\b/m.test(code),
        `App.mjs static chunk ${chunkName} must not bundle src/host/presets.ts`,
      );
    }

    assert.ok(!externalImports.has('zod'), 'dist/App.mjs static closure must not import zod');
    assert.ok(!externalImports.has('marked'), 'dist/App.mjs static closure must not import marked');
    assert.ok(!externalImports.has('cli-highlight'), 'dist/App.mjs static closure must not import cli-highlight');

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

    const appSource = fs.readFileSync(path.join(pkgRoot, 'src/App.tsx'), 'utf8');
    const librarySource = fs.readFileSync(path.join(pkgRoot, 'src/views/library/LibraryView.tsx'), 'utf8');
    assert.ok(
      !/components\/index\.js/.test(appSource),
      'src/App.tsx must not import components/index.js barrel',
    );
    assert.ok(
      !/components\/index\.js/.test(librarySource),
      'src/views/library/LibraryView.tsx must not import components/index.js barrel',
    );
  });

  test('7. Zero render/index.js, components/index.js & host/index.js barrel imports in src/ and non-markdown views/overlays/modals exclude marked and render/markdown.ts', () => {
    const srcDir = path.join(pkgRoot, 'src');
    const renderIndexPath = path.join(srcDir, 'render', 'index.ts');
    const componentsIndexPath = path.join(srcDir, 'components', 'index.ts');
    const hostIndexPath = path.join(srcDir, 'host', 'index.ts');
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

    const distFiles = fs.readdirSync(distDir).filter((f) => f.endsWith('.mjs'));
    const targetPrefixes = [
      // Shell overlays
      'CommandPalette-',
      'CoursePickerModal-',
      'HelpOverlay-',
      'InboxModal-',
      // Non-markdown views (TasksView lazy-loads MarkdownView)
      'AudioView-',
      'BoardView-',
      'DashboardView-',
      'ExamCoachView-',
      'ExamPrepView-',
      'ExamView-',
      'GenerateView-',
      'Launchpad-',
      'SettingsView-',
      'SkeletonView-',
      'SourcesView-',
      'TasksView-',
      // Non-markdown settings tabs
      'AppearanceTab-',
      'StudyGenTab-',
      'WorkspaceTab-',
      // Non-markdown modals & drawers
      'AddFocusModal-',
      'BoardCardModal-',
      'BookCrunchModal-',
      'BookEditModal-',
      'BookExplainModal-',
      'BookExportModal-',
      'BookStructureModal-',
      'CardToolsModal-',
      'CoachNudgeModal-',
      'CoachPreferencesModal-',
      'CourseRouteModal-',
      'CourseSettingsModal-',
      'DailyPlanModal-',
      'DeckOpsModal-',
      'FolderModal-',
      'ImportModal-',
      'IngestModal-',
      'MarkPassageModal-',
      'MinerUModal-',
      'NoteEditorModal-',
      'OrganizeSourcesModal-',
      'OriginalFileModal-',
      'QueueModal-',
      'ReaderOutlineDrawer-',
      'RereadQueueModal-',
      'RoundConfigModal-',
      'SkeletonDiagramsModal-',
      'SourceCoverageModal-',
      'StudyMapModal-',
      'StudyPlanModal-',
      'TopicGroupsModal-',
      'TranslationGlossaryModal-',
      'WorkflowHistoryModal-',
    ];

    for (const prefix of targetPrefixes) {
      const matches = distFiles.filter((f) => f.startsWith(prefix));
      assert.ok(matches.length > 0, `expected built chunk ${prefix}*.mjs in dist/`);

      for (const entryChunk of matches) {
        const visited = new Set();
        const queue = [path.join(distDir, entryChunk)];
        const externalImports = new Set();

        while (queue.length > 0) {
          const cur = queue.shift();
          if (visited.has(cur)) continue;
          visited.add(cur);

          const code = fs.readFileSync(cur, 'utf8');
          const chunkName = path.basename(cur);
          for (const spec of extractStaticImportSpecifiers(code)) {
            if (spec.startsWith('.')) {
              const target = path.resolve(path.dirname(cur), spec);
              if (fs.existsSync(target)) queue.push(target);
            } else {
              externalImports.add(spec);
            }
          }

          assert.ok(
            !/^\/\/\s*src\/render\/markdown\.ts\b/m.test(code),
            `${entryChunk} static closure (${chunkName}) must not bundle src/render/markdown.ts`,
          );
          assert.ok(
            !/^\/\/\s*src\/render\/math\.ts\b/m.test(code),
            `${entryChunk} static closure (${chunkName}) must not bundle src/render/math.ts`,
          );
          assert.ok(
            !/^\/\/\s*src\/components\/MarkdownView\.tsx\b/m.test(code),
            `${entryChunk} static closure (${chunkName}) must not bundle src/components/MarkdownView.tsx`,
          );
        }

        assert.ok(
          !externalImports.has('marked') && ![...externalImports].some((s) => s.startsWith('marked/')),
          `${entryChunk} static closure must not statically import marked`,
        );
        assert.ok(
          !externalImports.has('cli-highlight'),
          `${entryChunk} static closure must not statically import cli-highlight`,
        );
      }
    }
  });
});
