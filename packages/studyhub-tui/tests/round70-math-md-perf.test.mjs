// Round 70 Track 1: Math + Markdown fast-path correctness, edge cases & NFR throughput benchmark.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..');

const tempOutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studyhub-r70-math-md-'));
const renderOutFile = path.join(tempOutDir, 'render.mjs');
const tokensOutFile = path.join(tempOutDir, 'tokens.mjs');
await Promise.all([
  build({
    entryPoints: [path.join(pkgRoot, 'src/render/index.ts')],
    outfile: renderOutFile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    logLevel: 'silent',
    absWorkingDir: pkgRoot,
  }),
  build({
    entryPoints: [path.join(pkgRoot, 'src/theme/tokens.ts')],
    outfile: tokensOutFile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    logLevel: 'silent',
    absWorkingDir: pkgRoot,
  }),
]);
fs.symlinkSync(path.join(pkgRoot, 'node_modules'), path.join(tempOutDir, 'node_modules'), 'junction');

const R = await import(pathToFileURL(renderOutFile).href);
const T = await import(pathToFileURL(tokensOutFile).href);

const initialColorLevel = T.getColorLevel();
const THEME = T.getTheme('dsh-dark');
const ANSI_RE = /\u001B\][\s\S]*?(?:\u0007|\u001B\\|\u009C)|[\u001B\u009B][[\]()#;?]*(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]/g;
const stripAnsi = (s) => s.replace(ANSI_RE, '');

after(() => {
  T.setColorLevel(initialColorLevel);
  R.clearMathCache();
  R.clearMarkdownCache();
  fs.rmSync(tempOutDir, { recursive: true, force: true });
});

describe('Round 70 Math & Markdown fast-path equivalence and NFR throughput', () => {
  test('1. Equivalence & edge-case coverage across prose, LaTeX delimiters, escapes, code, CJK tables, ascii, and NO_COLOR', () => {
    T.setColorLevel(3);
    R.clearMathCache();
    R.clearMarkdownCache();

    // Plain prose with neither $ nor \ takes zero-overhead fast path
    const plainProse = 'The quick brown fox jumps over 42 lazy dogs in StudyHub TUI.';
    assert.equal(
      R.replaceMath(plainProse, () => {
        throw new Error('replaceMath callback must not run on plain prose');
      }),
      plainProse,
    );
    assert.equal(R.renderInlineMath(plainProse), plainProse);
    assert.equal(R.renderMath('plain text 123'), 'plain text 123');
    // Backslash without \( or \[ also skips regex
    assert.equal(
      R.replaceMath('C:\\Users\\studyhub\\notes.md', () => {
        throw new Error('replaceMath callback must not run on path without math delimiters');
      }),
      'C:\\Users\\studyhub\\notes.md',
    );

    // Inline and display math
    assert.equal(R.renderMath('x^2 + \\alpha'), 'x² + α');
    assert.equal(R.renderMath('\\sum_{i=1}^n \\frac{1}{i}'), '∑ᵢ₌₁ⁿ 1/i');
    assert.equal(
      R.renderInlineMath('Inline $x^2 + \\alpha$ and display $$\\sum_{i=1}^n \\frac{1}{i}$$'),
      'Inline x² + α and display ∑ᵢ₌₁ⁿ 1/i',
    );

    // \( ... \) and \[ ... \] delimiters
    assert.equal(
      R.renderInlineMath('Parens \\(\\beta + \\gamma\\) and brackets \\[\\sqrt{a^2 + b^2}\\]'),
      'Parens β + γ and brackets √(a² + b²)',
    );
    const mdParenBracket = R.renderMarkdownLines(
      'Inline \\(x^2 + \\alpha\\) here.\n\n\\[\n\\sum_{i=1}^n \\frac{1}{i}\n\\]',
      { width: 60, theme: THEME },
    ).map(stripAnsi).join('\n');
    assert.ok(mdParenBracket.includes('x² + α'), mdParenBracket);
    assert.ok(mdParenBracket.includes('∑ᵢ₌₁ⁿ 1/i'), mdParenBracket);

    // Escaped \$50 and currency amounts must NOT be converted as math
    assert.equal(R.renderInlineMath('Item costs \\$50 and $5 or $6.'), 'Item costs \\$50 and $5 or $6.');
    assert.equal(R.renderInlineMath('Price \\$50 with math $x^2$.'), 'Price \\$50 with math x².');
    const mdEscaped = R.renderMarkdownLines('Price is \\$50 today, and $x^2 + \\alpha$ is math.', {
      width: 60,
      theme: THEME,
    }).map(stripAnsi).join('\n');
    assert.ok(mdEscaped.includes('$50'), mdEscaped);
    assert.ok(mdEscaped.includes('x² + α'), mdEscaped);

    // Code blocks & inline codespans containing $x$ must NOT be math-converted
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
    const codePlain = R.renderMarkdownLines(mdCode, { width: 70, theme: THEME }).map(stripAnsi).join('\n');
    assert.ok(codePlain.includes('$x^2 + \\alpha$'), 'inline codespan kept literal');
    assert.ok(codePlain.includes('const expr = "$x^2 + \\alpha$";'), 'fenced code block kept literal');
    assert.ok(codePlain.includes('Outside x² + α converts.'), 'prose math still converted');

    // mathUnicode: false restores raw math source
    const rawMathLines = R.renderMarkdownLines('Check $x^2 + \\alpha$ and \\(\\beta\\).', {
      width: 60,
      theme: THEME,
      mathUnicode: false,
    }).map(stripAnsi).join('\n');
    assert.ok(rawMathLines.includes('$x^2 + \\alpha$') && rawMathLines.includes('\\(\\beta\\)'), rawMathLines);

    // CJK table alignment and width bounds
    const cjkTableMd = [
      '| 章节 | 公式 | 状态 |',
      '|:--|:--:|--:|',
      '| 虚拟内存 | $x^2 + \\alpha$ | 95% |',
      '| 调度算法 | 吞吐率分析 | 100% |',
    ].join('\n');
    for (const width of [24, 40, 72]) {
      const lines = R.renderMarkdownLines(cjkTableMd, { width, theme: THEME });
      for (const l of lines) {
        assert.ok(R.displayWidth(l) <= width, `CJK table line exceeded width ${width}: ${stripAnsi(l)}`);
      }
      const plain = lines.map(stripAnsi);
      const gridRows = plain.filter((l) => /^[┌├└│]/.test(l));
      assert.equal(gridRows.length, 6);
      const rowWidth = R.displayWidth(gridRows[0]);
      for (const gr of gridRows) assert.equal(R.displayWidth(gr), rowWidth);
    }

    // ascii: true emits no Unicode box-drawing / bullet / ellipsis glyphs
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
      assert.equal(asciiForbidden.test(stripAnsi(l)), false, `unexpected non-ASCII glyph in ${JSON.stringify(stripAnsi(l))}`);
    }

    // colorLevel: 0 (NO_COLOR) emits zero ANSI escapes
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

  test('2. NFR throughput: 5,000 plain-prose replaceMath < 25ms and 300 mixed docs < 1200ms', () => {
    T.setColorLevel(3);
    const plainSamples = [
      'Operating systems manage virtual memory using multi-level page tables and TLB caches.',
      'Plain prose without any dollar signs or backslashes should hit the immediate return path.',
      'StudyHub flashcard spaced repetition schedules reviews based on recall confidence.',
      'Summary: read chapter 4, solve practice problems 1 through 12, and review notes.',
      '中文纯文本段落测试：不包含任何数学公式定界符，直接跳过正则扫描。',
    ];

    // Warm up JIT for replaceMath
    let warmLen = 0;
    for (let i = 0; i < 200; i++) {
      warmLen += R.replaceMath(plainSamples[i % plainSamples.length], () => '').length;
    }
    assert.ok(warmLen > 0);

    const tMath0 = performance.now();
    let plainAcc = 0;
    for (let i = 0; i < 5_000; i++) {
      const out = R.replaceMath(plainSamples[i % plainSamples.length], () => '');
      plainAcc += out.length;
    }
    const mathElapsedMs = performance.now() - tMath0;
    console.log(`[round70-math-md-perf] 5,000 plain-prose replaceMath calls: ${mathElapsedMs.toFixed(2)}ms`);
    assert.ok(plainAcc > 0);
    assert.ok(
      mathElapsedMs < 25,
      `5,000 plain-prose replaceMath calls took ${mathElapsedMs.toFixed(2)}ms (budget < 25ms)`,
    );

    // Warm up lazy cli-highlight once so cold-doc benchmark measures Markdown+LaTeX+table+code rendering
    R.renderMarkdownLines('```js\nconst warmup = 1;\n```', { width: 72, theme: THEME });
    R.clearMathCache();
    R.clearMarkdownCache();

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
    const tDocs0 = performance.now();
    for (let i = 0; i < docs.length; i++) {
      const lines = R.renderMarkdownLines(docs[i], {
        width,
        theme: THEME,
        mathUnicode: true,
        ascii: i % 2 === 1,
      });
      assert.ok(lines.length > 0, `doc ${i} produced empty lines`);
      for (const line of lines) {
        assert.ok(
          R.displayWidth(line) <= width,
          `doc ${i} line exceeded width ${width}: ${R.displayWidth(line)}`,
        );
      }
    }
    const docsElapsedMs = performance.now() - tDocs0;
    console.log(`[round70-math-md-perf] 300 mixed Markdown+LaTeX+table docs: ${docsElapsedMs.toFixed(2)}ms`);

    assert.ok(R.markdownCacheSize() > 0 && R.markdownCacheSize() <= 256);
    assert.ok(R.mathCacheSize() > 0 && R.mathCacheSize() <= 512);
    assert.ok(
      docsElapsedMs < 1200,
      `300 mixed Markdown+LaTeX+table docs took ${docsElapsedMs.toFixed(2)}ms (budget < 1200ms)`,
    );
  });
});
