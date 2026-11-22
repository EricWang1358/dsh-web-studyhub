// End-to-end NO_COLOR=1 and ColorLevel audit tests:
// `node --test tests/no-color-audit.test.mjs`
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..');
const binPath = path.join(pkgRoot, 'bin', 'studyhub-tui.mjs');

const tokensMod = await tsImport('../src/theme/tokens.ts', import.meta.url);
const markdownMod = await tsImport('../src/render/markdown.ts', import.meta.url);

const { getTheme, getColorLevel, setColorLevel, makeChalk } = tokensMod;
const { renderMarkdown, clearMarkdownCache } = markdownMod;

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
});
