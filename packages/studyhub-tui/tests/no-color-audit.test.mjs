// End-to-end NO_COLOR=1 and ColorLevel audit tests:
// `node --test tests/no-color-audit.test.mjs`
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..');
const srcRoot = path.join(pkgRoot, 'src');
const binPath = path.join(pkgRoot, 'bin', 'studyhub-tui.mjs');

const tokensMod = await tsImport('../src/theme/tokens.ts', import.meta.url);
const markdownMod = await tsImport('../src/render/markdown.ts', import.meta.url);
const chartsMod = await tsImport('../src/render/charts.ts', import.meta.url);

const { getTheme, getColorLevel, setColorLevel, makeChalk } = tokensMod;
const { renderMarkdown, clearMarkdownCache } = markdownMod;
const { renderBarChart, renderSparkline, renderHeatmap } = chartsMod;

const ANSI_COLOR_RE = /\x1b\[(?:[349]\d|10[0-7]|38;[^\x1b]*|48;[^\x1b]*)m/;
const ANY_ANSI_RE = /\x1b\[[0-9;]*m/;
const TRUECOLOR_RE = /\x1b\[38;2;\d+;\d+;\d+m/;

const RICH_MARKDOWN = [
  '# Heading One',
  '',
  '## Heading Two',
  '',
  'Paragraph with **bold**, *italic*, ~~strike~~, and `inlineCode`.',
  '',
  'Visit [StudyHub](https://studyhub.example.com) for details.',
  '',
  '> Blockquote line with insight',
  '',
  '---',
  '',
  '- Unordered one',
  '  - Nested two',
  '- [x] Completed task',
  '1. Ordered item',
  '',
  '```js',
  'const answer = 42;',
  '```',
  '',
  'Inline math $E = mc^2$ and block math:',
  '',
  '$$\\sum_{i=1}^{n} x_i$$',
  '',
  '| Col A | Col B |',
  '|---|---|',
  '| alpha | beta |',
].join('\n');

const initialColorLevel = getColorLevel();

function walkTsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkTsFiles(full));
    } else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function findRuntimeChalkViolations(source) {
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const violations = [];

  for (const m of stripped.matchAll(/(?:^|[;\n])\s*import\s+([^;]*?)\s+from\s+['"]chalk['"]/g)) {
    const clause = m[1].trim();
    if (/^type\s+/.test(clause)) continue;

    const braceStart = clause.indexOf('{');
    const braceEnd = clause.lastIndexOf('}');
    if (braceStart === -1 || braceEnd === -1) {
      violations.push(`runtime import from 'chalk': ${m[0].trim()}`);
      continue;
    }

    const outside = (clause.slice(0, braceStart) + clause.slice(braceEnd + 1)).replace(/,/g, '').trim();
    if (outside.length > 0) {
      violations.push(`default/namespace import from 'chalk': ${m[0].trim()}`);
      continue;
    }

    const specifiers = clause
      .slice(braceStart + 1, braceEnd)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (specifiers.some((spec) => !/^type\s+/.test(spec))) {
      violations.push(`non-type named import from 'chalk': ${m[0].trim()}`);
    }
  }

  if (/\bimport\s+['"]chalk['"]/.test(stripped)) {
    violations.push("side-effect import 'chalk'");
  }
  if (/\b(?:require|import)\s*\(\s*['"]chalk['"]\s*\)/.test(stripped)) {
    violations.push("dynamic require/import('chalk')");
  }
  if (/\bnew\s+Chalk\b/.test(stripped)) {
    violations.push('direct `new Chalk(...)` instantiation');
  }

  return violations;
}

after(() => {
  setColorLevel(initialColorLevel);
  clearMarkdownCache();
});

describe('NO_COLOR & ColorLevel audit', () => {
  test('makeChalk respects runtime setColorLevel(0) and setColorLevel(3)', () => {
    setColorLevel(0);
    assert.equal(getColorLevel(), 0);
    const c0 = makeChalk();
    assert.equal(c0.level, 0);
    assert.equal(c0.bold.hex('#4b6fff').underline('plain'), 'plain');

    setColorLevel(3);
    assert.equal(getColorLevel(), 3);
    const c3 = makeChalk();
    assert.equal(c3.level, 3);
    const colored = c3.hex('#4b6fff')('styled');
    assert.match(colored, TRUECOLOR_RE);
    assert.match(colored, ANSI_COLOR_RE);
  });

  test('setColorLevel(0) strips all ANSI color escapes in renderMarkdown while keeping structure', () => {
    clearMarkdownCache();
    setColorLevel(0);
    const theme = getTheme('dsh-dark');
    const output = renderMarkdown(RICH_MARKDOWN, { width: 64, theme });

    assert.equal(ANSI_COLOR_RE.test(output), false, `Unexpected SGR color escape in:\n${output}`);
    assert.equal(ANY_ANSI_RE.test(output), false, `Unexpected ANSI escape in:\n${output}`);

    assert.ok(output.includes('Heading One'));
    assert.ok(output.includes('─'.repeat(64)));
    assert.ok(output.includes('Heading Two'));
    assert.ok(output.includes('bold') && output.includes('italic') && output.includes('strike'));
    assert.ok(output.includes(' inlineCode '));
    assert.ok(output.includes('StudyHub (https://studyhub.example.com)'));
    assert.ok(output.includes('▎ Blockquote line with insight'));
    assert.ok(output.includes('• Unordered one'));
    assert.ok(output.includes('  ◦ Nested two'));
    assert.ok(output.includes('☑ Completed task'));
    assert.ok(output.includes('1. Ordered item'));
    assert.ok(output.includes('╭─ js '));
    assert.ok(output.includes('const answer = 42;'));
    assert.ok(output.includes('E = mc²'));
    assert.ok(output.includes('∑ᵢ₌₁ⁿ xᵢ'));
    assert.ok(output.includes('┌') && output.includes('│ Col A │ Col B │'));
    assert.ok(output.includes('│ alpha │ beta  │'));
  });

  test('toggling setColorLevel(0) <-> setColorLevel(3) never returns stale LRU cache entries', () => {
    clearMarkdownCache();
    const theme = getTheme('dsh-dark');
    const opts = { width: 60, theme };

    setColorLevel(0);
    const uncolored = renderMarkdown(RICH_MARKDOWN, opts);
    assert.equal(ANSI_COLOR_RE.test(uncolored), false);

    setColorLevel(3);
    const truecolor = renderMarkdown(RICH_MARKDOWN, opts);
    assert.match(truecolor, TRUECOLOR_RE, 'Expected truecolor SGR 38;2;... escape at level 3');
    assert.match(truecolor, ANSI_COLOR_RE);

    setColorLevel(0);
    const uncoloredAgain = renderMarkdown(RICH_MARKDOWN, opts);
    assert.equal(ANSI_COLOR_RE.test(uncoloredAgain), false);
    assert.equal(uncoloredAgain, uncolored);
  });

  test('spawning bin/studyhub-tui.mjs --help under NO_COLOR=1 emits zero ANSI escapes and exits 0', () => {
    const res = spawnSync(process.execPath, [binPath, '--help'], {
      cwd: pkgRoot,
      env: { ...process.env, NO_COLOR: '1' },
      encoding: 'utf8',
    });

    assert.equal(res.status, 0, `Expected exit 0, got ${res.status}: ${res.stderr}`);
    assert.ok(res.stdout.includes('StudyHub TUI'));
    assert.ok(res.stdout.includes('Usage:'));
    assert.equal(ANSI_COLOR_RE.test(res.stdout), false, `Unexpected ANSI color in stdout: ${res.stdout}`);
    assert.equal(ANSI_COLOR_RE.test(res.stderr), false, `Unexpected ANSI color in stderr: ${res.stderr}`);
    assert.equal(ANY_ANSI_RE.test(res.stdout), false, `Unexpected ANSI escape in stdout: ${res.stdout}`);
  });

  test('static audit: zero src/**/*.ts(x) files outside src/theme/tokens.ts import runtime Chalk or default chalk', () => {
    const files = walkTsFiles(srcRoot);
    assert.ok(files.length > 0, 'Expected source files under src/');

    const allowedFile = path.join(srcRoot, 'theme', 'tokens.ts');
    assert.ok(files.includes(allowedFile), 'Expected src/theme/tokens.ts in scanned files');

    const offending = [];
    for (const file of files) {
      if (file === allowedFile) continue;
      const content = fs.readFileSync(file, 'utf8');
      const violations = findRuntimeChalkViolations(content);
      if (violations.length > 0) {
        offending.push(`${path.relative(pkgRoot, file)}: ${violations.join('; ')}`);
      }
    }

    assert.deepEqual(
      offending,
      [],
      `Found runtime Chalk/chalk usage outside src/theme/tokens.ts:\n${offending.join('\n')}`,
    );
  });

  test('renderBarChart, renderSparkline, and renderHeatmap emit zero ANSI color escapes under setColorLevel(0) and restore color under setColorLevel(3)', () => {
    const theme = getTheme('dsh-dark');
    const barItems = [
      { label: '数学', value: 120 },
      { label: 'English', value: 45.5 },
      { label: 'Physics', value: 0, color: '#ff0000' },
    ];
    const heatmapDays = [
      { date: '2026-10-15', count: 2 },
      { date: '2026-10-20', count: 5 },
      { date: '2026-10-28', count: 9 },
    ];
    const sparkValues = [1, 3, 2, 5, 4, 8];

    setColorLevel(0);
    const bars0 = renderBarChart(barItems, 40, theme);
    const spark0 = renderSparkline(sparkValues);
    const heat0 = renderHeatmap(heatmapDays, 10, theme, { endDate: '2026-10-28', locale: 'en' });

    assert.equal(bars0.length, barItems.length);
    for (const line of bars0) {
      assert.equal(ANSI_COLOR_RE.test(line), false, `Unexpected ANSI color in bar line: ${line}`);
      assert.equal(ANY_ANSI_RE.test(line), false, `Unexpected ANSI escape in bar line: ${line}`);
    }
    assert.ok(bars0[0].includes('数学') && bars0[0].includes('120'));

    assert.equal(ANSI_COLOR_RE.test(spark0), false, `Unexpected ANSI color in sparkline: ${spark0}`);
    assert.equal(ANY_ANSI_RE.test(spark0), false, `Unexpected ANSI escape in sparkline: ${spark0}`);
    assert.equal(spark0, '▁▃▂▅▄█');

    assert.equal(heat0.length, 9);
    for (const line of heat0) {
      assert.equal(ANSI_COLOR_RE.test(line), false, `Unexpected ANSI color in heatmap line: ${line}`);
      assert.equal(ANY_ANSI_RE.test(line), false, `Unexpected ANSI escape in heatmap line: ${line}`);
    }
    assert.ok(heat0[1].startsWith('Mon'));
    assert.ok(heat0[8].includes('Less') && heat0[8].includes('More'));

    setColorLevel(3);
    const bars3 = renderBarChart(barItems, 40, theme);
    const spark3 = renderSparkline(sparkValues);
    const heat3 = renderHeatmap(heatmapDays, 10, theme, { endDate: '2026-10-28', locale: 'en' });

    assert.ok(bars3.some((line) => TRUECOLOR_RE.test(line)), 'Expected truecolor escapes in renderBarChart at level 3');
    assert.ok(bars3.some((line) => ANSI_COLOR_RE.test(line)), 'Expected ANSI color escapes in renderBarChart at level 3');
    assert.ok(heat3.some((line) => TRUECOLOR_RE.test(line)), 'Expected truecolor escapes in renderHeatmap at level 3');
    assert.ok(heat3.some((line) => ANSI_COLOR_RE.test(line)), 'Expected ANSI color escapes in renderHeatmap at level 3');
    assert.equal(ANSI_COLOR_RE.test(spark3), false);
    assert.equal(spark3, spark0);

    setColorLevel(0);
    const bars0Again = renderBarChart(barItems, 40, theme);
    const heat0Again = renderHeatmap(heatmapDays, 10, theme, { endDate: '2026-10-28', locale: 'en' });
    assert.deepEqual(bars0Again, bars0);
    assert.deepEqual(heat0Again, heat0);
  });
});
