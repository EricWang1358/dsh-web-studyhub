// Render-layer unit tests: `node --test tests/render.test.mjs`
// Bundles src/render/index.ts with esbuild (deps external) and imports the result.
process.env.FORCE_COLOR = process.env.FORCE_COLOR ?? '3'; // exercise the ANSI paths

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..');
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studyhub-render-'));
const outfile = path.join(outDir, 'render.mjs');
await build({
  entryPoints: [path.join(pkgRoot, 'src/render/index.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  logLevel: 'silent',
  absWorkingDir: pkgRoot,
});
// packages: 'external' keeps bare imports; resolve them from the package's node_modules.
// 'junction' needs no admin rights on Windows; the type is ignored on POSIX.
fs.symlinkSync(path.join(pkgRoot, 'node_modules'), path.join(outDir, 'node_modules'), 'junction');
const R = await import(pathToFileURL(outfile).href);
process.on('exit', () => fs.rmSync(outDir, { recursive: true, force: true }));

const ANSI = /\u001B\][\s\S]*?(?:\u0007|\u001B\\)|\u001B\[[\d;:]*[A-Za-z]/g;
const strip = (s) => s.replace(ANSI, '');

const theme = {
  id: 'dsh-dark', label: 'DSH Dark', dark: true,
  primary: '#4b6fff', accent: '#7da1de', success: '#38d39f', warning: '#f5b841', error: '#f06478',
  ai: '#a78bfa', info: '#7da1de', text: '#e6edf3', muted: '#8b949e', dim: '#565f6b',
  border: '#30363d', borderActive: '#4b6fff', bg: '#0d1117', surface: '#161b22',
  selectionBg: '#1f2a4d', selectionFg: '#ffffff', heading: '#9fb4ff', code: '#f5b841',
  codeBg: '#1c2230', link: '#7da1de', quote: '#8b949e', track: '#262c36',
  heat: ['#21262d', '#1d3b6e', '#2f56c4', '#4b6fff', '#9fb4ff'],
};

const RED = '\u001B[31m';
const RESET = '\u001B[39m';

// ------------------------------------------------------------------------------------------- cjk

test('displayWidth: ASCII, CJK, full-width punctuation, emoji, ANSI', () => {
  assert.equal(R.displayWidth(''), 0);
  assert.equal(R.displayWidth('hello'), 5);
  assert.equal(R.displayWidth('中文'), 4);
  assert.equal(R.displayWidth('你好，世界。'), 12);
  assert.equal(R.displayWidth('ｆｕｌｌ'), 8);
  assert.equal(R.displayWidth('😀'), 2);
  assert.equal(R.displayWidth('👨‍👩‍👧'), 2, 'ZWJ family is one wide cluster');
  assert.equal(R.displayWidth('👍🏽'), 2, 'skin tone modifier');
  assert.equal(R.displayWidth('❤️'), 2, 'VS16 emoji presentation');
  assert.equal(R.displayWidth('🇨🇳'), 2, 'flag');
  assert.equal(R.displayWidth('é'), 1, 'combining acute is zero-width');
  assert.equal(R.displayWidth('x⃗'), 1, 'combining arrow is zero-width');
  assert.equal(R.displayWidth('a\u200Bb'), 2, 'zero-width space');
  assert.equal(R.displayWidth(`${RED}中文abc${RESET}`), 7);
  assert.equal(R.displayWidth('\u001B]8;;https://x.y\u0007link\u001B]8;;\u0007'), 4, 'OSC-8 hyperlink');
  assert.equal(R.displayWidth('한국어'), 6);
  assert.equal(R.displayWidth('かな'), 4);
});

test('truncateDisplay never exceeds width and never splits wide chars', () => {
  const samples = ['中文English混合😀测试', `${RED}红色中文文本${RESET} tail`, 'abcdefghij', '一二三四五六七八九十', '😀😀😀😀'];
  for (const s of samples) {
    for (let w = 0; w <= R.displayWidth(s) + 2; w++) {
      const t = R.truncateDisplay(s, w);
      assert.ok(R.displayWidth(t) <= w, `${JSON.stringify(s)} @${w} → ${JSON.stringify(t)}`);
      assert.ok(!strip(t).includes('\uFFFD'));
      if (R.displayWidth(s) <= w) assert.equal(t, s);
      else if (w >= 1) assert.ok(strip(t).endsWith('…'), `ellipsis at ${w}: ${t}`);
    }
  }
  assert.equal(strip(R.truncateDisplay('中文中文', 5)), '中文…');
  assert.equal(strip(R.truncateDisplay('中文中文', 4)), '中…');
  assert.equal(R.truncateDisplay('abcdef', 4, ''), 'abcd');
  // ANSI close codes after the cut are preserved
  const t = R.truncateDisplay(`${RED}abcdefgh${RESET}`, 4);
  assert.ok(t.endsWith(RESET));
});

test('padDisplay: left/right/center + truncation with mixed content', () => {
  assert.equal(R.padDisplay('中a', 6), '中a   ');
  assert.equal(R.padDisplay('中a', 6, 'right'), '   中a');
  assert.equal(R.padDisplay('中a', 7, 'center'), '  中a  ');
  for (const s of ['中文😀abc', `${RED}中${RESET}x`, 'plain', '']) {
    for (let w = 0; w < 12; w++) assert.equal(R.displayWidth(R.padDisplay(s, w)), w, `${s}@${w}`);
  }
});

test('wrapDisplay: latin words, CJK char-wrap, hard breaks, newlines, ANSI', () => {
  assert.deepEqual(R.wrapDisplay('the quick brown fox', 10), ['the quick', 'brown fox']);
  assert.deepEqual(R.wrapDisplay('中文字符换行测试', 6), ['中文字', '符换行', '测试']);
  assert.deepEqual(R.wrapDisplay('abcdefghijkl', 5), ['abcde', 'fghij', 'kl']);
  assert.deepEqual(R.wrapDisplay('a\nb\n\nc', 10), ['a', 'b', '', 'c']);
  // kinsoku: closing punctuation never starts a line
  const k = R.wrapDisplay('你好世界，再见', 8);
  for (const l of k) assert.ok(!l.startsWith('，'), JSON.stringify(k));
  const mixed = `学习 ${RED}Machine Learning${RESET} 是一个😀很有趣的过程，需要坚持 every day!`;
  for (let w = 2; w <= 30; w++) {
    const lines = R.wrapDisplay(mixed, w);
    for (const l of lines) assert.ok(R.displayWidth(l) <= w, `w=${w} ${JSON.stringify(l)}`);
    // no content lost (spaces may be dropped at wrap points)
    assert.equal(strip(lines.join('')).replace(/\s/g, ''), strip(mixed).replace(/\s/g, ''));
  }
  // each line is ANSI-self-contained: colour re-opened on continuation lines
  const red = R.wrapDisplay(`${RED}aaaa bbbb cccc${RESET}`, 5);
  assert.equal(red.length, 3);
  for (const l of red) assert.ok(l.includes('\u001B[31m'), JSON.stringify(red));
});

test('sliceDisplay keeps column alignment around wide chars', () => {
  assert.equal(R.sliceDisplay('abcdef', 1, 4), 'bcd');
  assert.equal(R.sliceDisplay('中文字', 2, 4), '文');
  assert.equal(R.sliceDisplay('中文字', 1, 4), ' 文');
  assert.equal(R.displayWidth(R.sliceDisplay('中文字abc', 1, 6)), 5);
});

// ------------------------------------------------------------------------------------------ math

test('renderMath: Greek, scripts, fractions, roots', () => {
  const m = (s) => R.renderMath(s);
  assert.equal(m('\\alpha + \\beta = \\Omega'), 'α + β = Ω');
  assert.equal(m('x^2'), 'x²');
  assert.equal(m('x^{10}'), 'x¹⁰');
  assert.equal(m('a_{i,j}'), 'aᵢ,ⱼ');
  assert.equal(m('x_1 + x_n'), 'x₁ + xₙ');
  assert.equal(m('e^{-x}'), 'e⁻ˣ');
  assert.equal(m('e^{i\\pi}'), 'e^(iπ)', 'fallback when a glyph has no superscript');
  assert.equal(m('x^q'), 'x^q');
  assert.equal(m('\\frac{a}{b}'), 'a/b');
  assert.equal(m('\\frac{x+1}{2}'), '(x+1)/2');
  assert.equal(m('\\frac{1}{x^2+1}'), '1/(x²+1)');
  assert.equal(m('\\sqrt{x}'), '√x');
  assert.equal(m('\\sqrt{x+1}'), '√(x+1)');
  assert.equal(m('\\sqrt[3]{x}'), '∛x');
  assert.equal(m('90^\\circ'), '90°');
  assert.equal(m("f'(x)"), 'f′(x)');
});

test('renderMath: operators, fonts, accents, text, delimiters', () => {
  const m = (s) => R.renderMath(s);
  assert.equal(m('\\sum_{i=1}^{n} i'), '∑ᵢ₌₁ⁿ i');
  assert.equal(m('\\int_0^\\infty f(x)\\,dx'), '∫₀∞ f(x) dx');
  assert.equal(m('\\lim_{x \\to 0}'), 'lim_(x→0)');
  assert.equal(m('a \\leq b \\geq c \\neq d \\approx e'), 'a ≤ b ≥ c ≠ d ≈ e');
  assert.equal(m('x \\in A \\notin B \\subseteq C \\cup D \\cap E'), 'x ∈ A ∉ B ⊆ C ∪ D ∩ E');
  assert.equal(m('\\forall x \\exists y'), '∀ x ∃ y');
  assert.equal(m('A \\Rightarrow B \\Leftrightarrow C \\to D \\mapsto E'), 'A ⇒ B ⇔ C → D ↦ E');
  assert.equal(m('\\partial f \\nabla g \\times \\cdot \\pm \\mp \\div'), '∂ f ∇ g × · ± ∓ ÷');
  assert.equal(m('1, \\ldots, n \\cdots'), '1, …, n ⋯');
  assert.equal(m('\\mathbb{R}^n'), 'ℝⁿ');
  assert.equal(m('\\mathbb{N} \\mathbb{Z} \\mathbb{Q} \\mathbb{C}'), 'ℕ ℤ ℚ ℂ');
  assert.equal(m('\\mathbf{v}'), '𝐯');
  assert.equal(m('\\vec{x}'), 'x\u20D7');
  assert.equal(m('\\hat{y}'), 'y\u0302');
  assert.equal(m('\\bar{x}'), 'x\u0304');
  assert.equal(m('\\text{if } x > 0'), 'if x > 0');
  assert.equal(m('\\left( \\frac{a}{b} \\right)'), '( a/b )');
  assert.equal(m('\\unknowncmd{x}'), 'unknowncmdx');
  assert.equal(m('$x^2$'), 'x²', 'strips delimiters');
});

test('renderMath enabled=false and renderInlineMath', () => {
  assert.equal(R.renderMath('x^2', false), 'x^2');
  assert.equal(R.renderInlineMath('Let $x^2$ and $$\\alpha$$ and \\(\\beta\\) and \\[\\gamma\\].'), 'Let x² and α and β and γ.');
  assert.equal(R.renderInlineMath('costs $5 and $6 today'), 'costs $5 and $6 today');
  assert.equal(R.renderInlineMath('a $x$ b', false), 'a $x$ b');
  assert.equal(R.renderInlineMath('求 $\\sqrt{2}$ 的值'), '求 √2 的值');
});

test('math LRU is bounded at 512', () => {
  R.clearMathCache();
  for (let i = 0; i < 600; i++) R.renderMath(`x^{${i}} + \\alpha_${i}`);
  assert.ok(R.mathCacheSize() <= 512, String(R.mathCacheSize()));
  assert.ok(R.mathCacheSize() > 0);
  R.clearMathCache();
  assert.equal(R.mathCacheSize(), 0);
});

// -------------------------------------------------------------------------------------- markdown

const mdOpts = (width, extra = {}) => ({ width, theme, ...extra });
const allFit = (lines, width) => lines.every((l) => R.displayWidth(l) <= width);

test('markdown: cli-highlight is lazy-loaded only on first fenced code block', () => {
  assert.equal(R.isHighlighterLoaded(), false, 'highlighter not loaded on module import');
  R.renderMarkdownLines(
    [
      '# Heading',
      '',
      'Plain paragraph with **bold**, *italic*, `inline code`, and [link](https://example.com).',
      '',
      '- item one',
      '- [x] task two',
      '',
      '| Col A | Col B |',
      '|---|---|',
      '| 1 | 2 |',
      '',
      'Inline math $x^2 + y^2$ and block:',
      '',
      '$$\\alpha + \\beta$$',
    ].join('\n'),
    mdOpts(60),
  );
  assert.equal(R.isHighlighterLoaded(), false, 'plain markdown keeps cli-highlight unloaded');

  const codeLines = R.renderMarkdownLines('```js\nconst answer = 42;\n```', mdOpts(40));
  assert.equal(R.isHighlighterLoaded(), true, 'fenced code block lazily loads cli-highlight');
  assert.ok(codeLines.map(strip).some((l) => l.includes('const answer = 42;')));
});

test('markdown: headings, paragraphs, inline styles', () => {
  const lines = R.renderMarkdownLines('# 标题 Title\n\n## Sub\n\nSome **bold** *it* ~~del~~ `code` [link](https://ex.com).', mdOpts(40));
  const plain = lines.map(strip);
  assert.equal(plain[0], '标题 Title');
  assert.equal(plain[1], '─'.repeat(40));
  assert.ok(plain.includes('Sub'));
  const para = plain.find((l) => l.startsWith('Some'));
  assert.ok(para.includes('bold') && para.includes(' code ') && para.includes('link'), para);
  assert.ok(plain.join(' ').includes('(https://ex.com)'));
  assert.ok(lines[0].includes('\u001B['), 'heading is styled');
  assert.ok(allFit(lines, 40));
  assert.equal(typeof R.renderMarkdown('hi', mdOpts(10)), 'string');
  assert.equal(R.renderMarkdown('', mdOpts(10)), '');
});

test('markdown: lists (nested, ordered, task)', () => {
  const md = '- one\n- two\n  - nested\n- [x] done\n- [ ] todo\n\n1. first\n2. second';
  const plain = R.renderMarkdownLines(md, mdOpts(30)).map(strip);
  assert.ok(plain.includes('• one'), plain.join('|'));
  assert.ok(plain.includes('  ◦ nested'), plain.join('|'));
  assert.ok(plain.includes('☑ done'));
  assert.ok(plain.includes('☐ todo'));
  assert.ok(plain.includes('1. first'));
  assert.ok(plain.includes('2. second'));
});

test('markdown: fenced code frame sized to width', () => {
  const md = '```js\nconst x = 1;\nfunction 中文() { return "a very long line that must wrap inside the frame"; }\n```';
  const width = 36;
  const lines = R.renderMarkdownLines(md, mdOpts(width));
  const plain = lines.map(strip);
  assert.ok(plain[0].startsWith('╭─ js '), plain[0]);
  assert.ok(plain[0].endsWith('╮'));
  assert.ok(plain.at(-1).startsWith('╰') && plain.at(-1).endsWith('╯'));
  for (const l of plain) assert.equal(R.displayWidth(l), width, JSON.stringify(l));
  assert.ok(plain.slice(1, -1).every((l) => l.startsWith('│ ') && l.endsWith(' │')));
  assert.ok(plain.some((l) => l.includes('const x = 1;')));
});

test('markdown: blockquote, hr', () => {
  const plain = R.renderMarkdownLines('> 引用 quote\n\n---', mdOpts(20)).map(strip);
  assert.equal(plain[0], '▎ 引用 quote');
  assert.equal(plain.at(-1), '─'.repeat(20));
});

test('markdown: GFM table with Chinese columns stays aligned', () => {
  const md = '| 科目 | 进度 | Notes |\n|:--|--:|:-:|\n| 数学 | 80% | 微积分 |\n| English | 5% | essay writing practice |\n| 物理学 | 100% | 😀 |';
  for (const width of [80, 40, 28, 20]) {
    const lines = R.renderMarkdownLines(md, mdOpts(width));
    assert.ok(allFit(lines, width), `width ${width}`);
    const plain = lines.map(strip);
    const tableLines = plain.filter((l) => /^[┌├└│]/.test(l));
    assert.equal(tableLines.length, 3 + 1 + 3, plain.join('\n'));
    const w0 = R.displayWidth(tableLines[0]);
    for (const l of tableLines) assert.equal(R.displayWidth(l), w0, `width ${width}: ${JSON.stringify(l)}`);
    // column separators line up at the same display columns on every row
    const cols = (l) => {
      const out = [];
      let c = 0;
      for (const ch of l) {
        if ('│┼┬┴├┤┌┐└┘'.includes(ch)) out.push(c);
        c += R.displayWidth(ch);
      }
      return out.join(',');
    };
    const ref = cols(tableLines[0]);
    for (const l of tableLines) assert.equal(cols(l), ref, `width ${width}: ${l}`);
  }
  const wide = R.renderMarkdownLines(md, mdOpts(80)).map(strip);
  assert.ok(wide.some((l) => l.includes('数学') && l.includes('微积分')));
});

test('markdown: inline + block math, protected from emphasis', () => {
  const md = 'Energy $E = mc^2$ and $a_1 + b_2$ here.\n\n$$\n\\sum_{i=1}^{n} x_i\n$$\n\n`$keep_raw$`';
  const plain = R.renderMarkdownLines(md, mdOpts(60)).map(strip);
  const text = plain.join('\n');
  assert.ok(text.includes('E = mc²'), text);
  assert.ok(text.includes('a₁ + b₂'), text);
  assert.ok(text.includes('∑ᵢ₌₁ⁿ xᵢ'), text);
  assert.ok(text.includes('$keep_raw$'), 'code span untouched');
  const raw = R.renderMarkdownLines('Energy $E = mc^2$ and $a_1 + b_2$.', mdOpts(60, { mathUnicode: false })).map(strip).join('\n');
  assert.ok(raw.includes('$E = mc^2$') && raw.includes('$a_1 + b_2$'), raw);
});

test('markdown: every line fits for a long mixed document at many widths', () => {
  const md = [
    '# 学习笔记 Study Notes 😀',
    '',
    '这是一个很长的段落，包含中文、English words、emoji 🎉 以及 `inline code` 和 **加粗文字** 用于测试换行是否正确处理所有宽度。',
    '',
    '> 引用：知识就是力量。Knowledge is power — Francis Bacon',
    '',
    '- 列表项 one with a long tail that needs wrapping across lines',
    '  - 嵌套 nested item 二级',
    '',
    '| 名称 | 值 |',
    '|---|---|',
    '| 很长很长的名称字段 | 1234567890 |',
    '',
    '```python',
    'def f(x):\n    return x ** 2  # 平方',
    '```',
    '',
    'Inline $\\frac{a}{b}$ math.',
  ].join('\n');
  for (const width of [12, 20, 33, 50, 79, 120]) {
    const lines = R.renderMarkdownLines(md, mdOpts(width));
    for (const l of lines) assert.ok(R.displayWidth(l) <= width, `w=${width}: ${JSON.stringify(strip(l))}`);
  }
});

test('markdown: ascii mode emits zero Unicode box-drawing/block/bullet glyphs and keeps exact widths', () => {
  const md = [
    '# Title',
    '',
    '> quoted line',
    '',
    '---',
    '',
    '- alpha',
    '  - nested',
    '- [x] done',
    '- [ ] todo',
    '',
    '| ColA | ColB |',
    '|---|---:|',
    '| foo | 12 |',
    '',
    '```js',
    'const x = 1;',
    '```',
  ].join('\n');
  const width = 36;
  const lines = R.renderMarkdownLines(md, mdOpts(width, { ascii: true }));
  const plain = lines.map(strip);
  const forbidden = /[\u2500-\u257F\u2580-\u259F\u2800-\u28FF•◦☑☐▎▸▾…]/;
  for (const l of plain) {
    assert.ok(R.displayWidth(l) <= width, `exceeds width: ${l}`);
    assert.equal(forbidden.test(l), false, `unexpected Unicode glyph in ${JSON.stringify(l)}`);
    assert.match(l, /^[\x20-\x7e]*$/);
  }
  assert.ok(plain.includes('-'.repeat(width)), 'h1 underline and hr use ---');
  assert.ok(plain.includes('| quoted line'), 'blockquote uses | bar');
  assert.ok(plain.includes('* alpha') && plain.includes('  - nested'), 'lists use * / -');
  assert.ok(plain.includes('[x] done') && plain.includes('[ ] todo'), 'task lists use [x] / [ ]');
  assert.ok(plain.some((l) => l.startsWith('+--- js ') && l.endsWith('+')), plain.join('\n'));
  const codeFrame = plain.slice(-3);
  assert.equal(codeFrame.length, 3);
  for (const l of codeFrame) assert.equal(R.displayWidth(l), width, JSON.stringify(l));
  assert.ok(codeFrame[1].startsWith('| ') && codeFrame[1].endsWith(' |'));
  assert.ok(codeFrame.at(-1).startsWith('+') && codeFrame.at(-1).endsWith('+'));
  const tableRows = plain.filter((l) => (/^\+[-+]+\+$/.test(l) && l.slice(1, -1).includes('+')) || /^\| (?:ColA|foo)/.test(l));
  assert.equal(tableRows.length, 5, plain.join('\n'));
  const tw = R.displayWidth(tableRows[0]);
  for (const l of tableRows) assert.equal(R.displayWidth(l), tw);
  assert.equal(R.renderMarkdown('> hi', mdOpts(20, { ascii: true })).includes('▎'), false);
});

test('markdown LRU is bounded at 256 and keyed on width', () => {
  R.clearMarkdownCache();
  for (let i = 0; i < 300; i++) R.renderMarkdownLines(`para ${i} **b**`, mdOpts(40));
  assert.ok(R.markdownCacheSize() <= 256, String(R.markdownCacheSize()));
  R.clearMarkdownCache();
  R.renderMarkdownLines('x', mdOpts(40));
  R.renderMarkdownLines('x', mdOpts(41));
  R.renderMarkdownLines('x', mdOpts(41));
  assert.equal(R.markdownCacheSize(), 2);
  const a = R.renderMarkdownLines('x', mdOpts(41));
  a.push('mutated');
  assert.equal(R.renderMarkdownLines('x', mdOpts(41)).length, 1, 'cached arrays are not exposed');
});

// ---------------------------------------------------------------------------------------- charts

test('renderProgressBar: exact width at 0 / 0.37 / 1 / NaN, both styles', () => {
  for (const style of ['block', 'line']) {
    for (const showPercent of [false, true]) {
      for (const r of [0, 0.37, 1, Number.NaN, -1, 2]) {
        for (const w of [1, 5, 10, 23]) {
          const s = R.renderProgressBar(r, w, theme, { style, showPercent });
          assert.equal(R.displayWidth(s), w, `${style} pct=${showPercent} r=${r} w=${w}: ${JSON.stringify(strip(s))}`);
        }
      }
    }
  }
  assert.equal(strip(R.renderProgressBar(1, 10, theme)), '█'.repeat(10));
  assert.equal(strip(R.renderProgressBar(0, 10, theme)), '░'.repeat(10));
  assert.equal(strip(R.renderProgressBar(Number.NaN, 10, theme, { showPercent: true })), '░░░░░   0%');
  assert.equal(strip(R.renderProgressBar(0.37, 15, theme, { showPercent: true })).slice(-4), ' 37%');
  assert.match(strip(R.renderProgressBar(0.37, 10, theme)), /^███▊░+$/);
  assert.match(strip(R.renderProgressBar(0.5, 10, theme, { style: 'line' })), /^━{5}╺─{4}$/);
  assert.equal(R.renderProgressBar(0.5, 0, theme), '');
});

test('renderSparkline', () => {
  assert.equal(R.renderSparkline([]), '');
  assert.equal(R.renderSparkline([0, 7]), '▁█');
  assert.equal(R.renderSparkline([1, 2, 3, 4, 5, 6, 7, 8]), '▁▂▃▄▅▆▇█');
  assert.equal(R.renderSparkline([3, 3, 3]), '▄▄▄');
  assert.equal(R.renderSparkline([1, 5, 2, 8, 3], 12).length, 12);
  assert.equal([...R.renderSparkline(Array.from({ length: 100 }, (_, i) => i), 10)].length, 10);
  assert.equal(R.renderSparkline([1, Number.NaN, 3]).length, 3);
});

test('renderBarChart: every line exactly width, CJK labels aligned', () => {
  const items = [
    { label: '数学', value: 120 },
    { label: 'English', value: 45.5 },
    { label: '物理学科很长的名字', value: 0, color: '#ff0000' },
    { label: '😀 emoji', value: 80 },
  ];
  for (const w of [10, 20, 40, 60]) {
    const lines = R.renderBarChart(items, w, theme);
    assert.equal(lines.length, items.length);
    for (const l of lines) assert.equal(R.displayWidth(l), w, `w=${w} ${JSON.stringify(strip(l))}`);
  }
  const lines = R.renderBarChart(items, 40, theme).map(strip);
  assert.ok(lines[0].trimEnd().endsWith('120'));
  assert.ok(lines[0].includes('█'));
  assert.deepEqual(R.renderBarChart([], 40, theme), []);
});

test('renderHeatmap: header + 7 weekday rows + legend', () => {
  const days = [];
  for (let i = 0; i < 120; i++) {
    const d = new Date(Date.UTC(2026, 6, 1) + i * 86400000).toISOString().slice(0, 10);
    days.push({ date: d, count: i % 7 });
  }
  const lines = R.renderHeatmap(days, 12, theme, { endDate: '2026-10-28' });
  assert.equal(lines.length, 9);
  const plain = lines.map(strip);
  const w = R.displayWidth(plain[1]);
  assert.equal(w, 3 + 24);
  for (const l of plain.slice(0, 8)) assert.equal(R.displayWidth(l), w, JSON.stringify(l));
  assert.ok(plain[0].includes('月'), plain[0]);
  assert.ok(plain[1].startsWith('一'));
  assert.ok(plain[3].startsWith('三'));
  assert.ok(plain[5].startsWith('五'));
  assert.ok(plain[8].includes('少 ░▒▓█ 多'), plain[8]);
  assert.ok(/[▒▓█]/.test(plain.slice(1, 8).join('')));
  // 2026-10-28 is a Wednesday → Thu..Sun cells of the last week are blank
  assert.ok(plain[4].endsWith('  ') && plain[7].endsWith('  '));
  const en = R.renderHeatmap(days, 8, theme, { endDate: '2026-10-28', locale: 'en' }).map(strip);
  assert.ok(en[1].startsWith('Mon') && en[3].startsWith('Wed') && en[5].startsWith('Fri'));
  assert.ok(en[8].includes('Less') && en[8].includes('More'));
  const bare = R.renderHeatmap([], 4, theme, { endDate: '2026-10-28', showLabels: false });
  assert.equal(bare.length, 8);
});

test('renderTreeLines: guides, markers, collapse, selection, width', () => {
  const nodes = [
    {
      id: 'math', label: '数学', meta: '3',
      children: [
        { id: 'calc', label: '微积分', children: [{ id: 'limits', label: 'Limits' }, { id: 'deriv', label: 'Derivatives' }] },
        { id: 'alg', label: 'Algebra' },
      ],
    },
    { id: 'phys', label: 'Physics', children: [{ id: 'mech', label: 'Mechanics' }] },
    { id: 'notes', label: 'Loose notes' },
  ];
  const lines = R.renderTreeLines(nodes, new Set(['math', 'calc']), 'deriv', 40);
  assert.deepEqual(lines.map((l) => l.id), ['math', 'calc', 'limits', 'deriv', 'alg', 'phys', 'notes']);
  assert.ok(lines[0].text.startsWith('▾ 数学'));
  assert.ok(lines[0].text.endsWith('3') && R.displayWidth(lines[0].text) === 40, 'meta right-aligned');
  assert.ok(lines[1].text.startsWith('├─ ▾ 微积分'), lines[1].text);
  assert.equal(lines[2].text, '│  ├─ Limits');
  assert.equal(lines[3].text, '│  └─ Derivatives');
  assert.equal(lines[4].text, '└─ Algebra');
  assert.ok(lines[5].text.startsWith('▸ Physics'));
  assert.equal(lines[5].expanded, false);
  assert.equal(lines[5].hasChildren, true);
  assert.equal(lines[3].selected, true);
  assert.equal(lines.filter((l) => l.selected).length, 1);
  assert.deepEqual(lines.map((l) => l.depth), [0, 1, 2, 2, 1, 0, 0]);
  for (const l of lines) assert.ok(!l.text.includes('\u001B'), 'plain text');
  const arr = R.renderTreeLines(nodes, ['phys'], null, 8);
  assert.deepEqual(arr.map((l) => l.id), ['math', 'phys', 'mech', 'notes']);
  for (const l of arr) assert.ok(R.displayWidth(l.text) <= 8, l.text);
});

test('charts: ascii mode emits zero Unicode box/block/Braille glyphs and exact widths', () => {
  const forbidden = /[\u2500-\u257F\u2580-\u259F\u2800-\u28FF▸▾…]/;

  for (const style of ['block', 'line']) {
    for (const showPercent of [false, true]) {
      for (const r of [0, 0.37, 1, Number.NaN]) {
        for (const w of [1, 5, 10, 23]) {
          const s = R.renderProgressBar(r, w, theme, { style, showPercent, ascii: true });
          const plain = strip(s);
          assert.equal(R.displayWidth(s), w, `${style} pct=${showPercent} r=${r} w=${w}: ${JSON.stringify(plain)}`);
          assert.equal(forbidden.test(plain), false, plain);
          assert.match(plain, /^[\x20-\x7e]*$/);
        }
      }
    }
  }
  assert.equal(strip(R.renderProgressBar(1, 10, theme, { ascii: true })), '#'.repeat(10));
  assert.equal(strip(R.renderProgressBar(0, 10, theme, { ascii: true })), '-'.repeat(10));
  assert.match(strip(R.renderProgressBar(0.5, 10, theme, { style: 'line', ascii: true })), /^#{5}>-{4}$/);

  const spark = R.renderSparkline([1, 2, 3, 4, 5, 6, 7], undefined, { ascii: true });
  assert.equal(spark, '_.-=+*#');
  assert.equal(R.renderSparkline([3, 3, 3], undefined, { ascii: true }), '===');
  assert.equal(R.renderSparkline([1, 5, 2, 8, 3], 12, { ascii: true }).length, 12);
  assert.equal(forbidden.test(spark), false);

  const barItems = [
    { label: 'Math', value: 120 },
    { label: 'English', value: 45.5 },
    { label: 'Physics', value: 0 },
  ];
  for (const w of [10, 20, 40]) {
    const lines = R.renderBarChart(barItems, w, theme, { ascii: true });
    assert.equal(lines.length, barItems.length);
    for (const l of lines) {
      const plain = strip(l);
      assert.equal(R.displayWidth(l), w);
      assert.equal(forbidden.test(plain), false, plain);
      assert.match(plain, /^[\x20-\x7e]*$/);
    }
  }
  assert.ok(strip(R.renderBarChart(barItems, 40, theme, { ascii: true })[0]).includes('#'));

  const days = [];
  for (let i = 0; i < 90; i++) {
    const d = new Date(Date.UTC(2026, 7, 1) + i * 86400000).toISOString().slice(0, 10);
    days.push({ date: d, count: i % 7 });
  }
  const heat = R.renderHeatmap(days, 10, theme, { endDate: '2026-10-28', locale: 'en', ascii: true }).map(strip);
  assert.equal(heat.length, 9);
  const hw = R.displayWidth(heat[1]);
  for (const l of heat.slice(0, 8)) {
    assert.equal(R.displayWidth(l), hw);
    assert.equal(forbidden.test(l), false, l);
    assert.match(l, /^[\x20-\x7e]*$/);
  }
  assert.ok(heat[8].includes('Less .:o# More'), heat[8]);
  assert.ok(/[.:oO#]/.test(heat.slice(1, 8).join('')));

  const treeNodes = [
    {
      id: 'math', label: 'Math', meta: '3',
      children: [
        { id: 'calc', label: 'Calculus', children: [{ id: 'limits', label: 'Limits' }, { id: 'deriv', label: 'Derivatives' }] },
        { id: 'alg', label: 'Algebra' },
      ],
    },
    { id: 'phys', label: 'Physics', children: [{ id: 'mech', label: 'Mechanics' }] },
    { id: 'notes', label: 'Loose notes' },
  ];
  const tree = R.renderTreeLines(treeNodes, new Set(['math', 'calc']), 'deriv', 40, { ascii: true });
  for (const l of tree) {
    assert.ok(R.displayWidth(l.text) <= 40);
    assert.equal(forbidden.test(l.text), false, l.text);
    assert.match(l.text, /^[\x20-\x7e]*$/);
  }
  assert.ok(tree[0].text.startsWith('v Math'));
  assert.equal(R.displayWidth(tree[0].text), 40);
  assert.ok(tree[1].text.startsWith('|-- v Calculus'), tree[1].text);
  assert.ok(tree[2].text.startsWith('|   |-- Limits'), tree[2].text);
  assert.ok(tree[2].text.includes('|  '), tree[2].text);
  assert.ok(tree[3].text.startsWith('|   \\-- Derivatives'), tree[3].text);
  assert.ok(tree[4].text.startsWith('\\-- Algebra'), tree[4].text);
  assert.ok(tree[5].text.startsWith('> Physics'), tree[5].text);
});

// ------------------------------------------------------------------------------------------- lru

test('LruCache evicts least-recently-used', () => {
  const c = new R.LruCache(2);
  c.set('a', 1);
  c.set('b', 2);
  assert.equal(c.get('a'), 1);
  c.set('c', 3);
  assert.equal(c.has('b'), false);
  assert.equal(c.has('a'), true);
  assert.equal(c.size, 2);
  c.clear();
  assert.equal(c.size, 0);
});
