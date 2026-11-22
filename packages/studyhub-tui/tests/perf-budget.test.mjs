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

describe('StudyHub TUI NFR Performance & Bundle Budgets', () => {
  test('1. Bundle size budgets for cli.mjs, boot-frame.mjs, and App.mjs', () => {
    const budgets = [
      { file: 'cli.mjs', maxBytes: 15 * 1024 },
      { file: 'boot-frame.mjs', maxBytes: 5 * 1024 },
      { file: 'App.mjs', maxBytes: 80 * 1024 },
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
});
