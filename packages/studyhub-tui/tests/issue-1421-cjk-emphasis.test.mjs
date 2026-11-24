// Regression test for #1421: bold (**…**) and italic (*…*) adjacent to Chinese
// punctuation must render as bold/italic in TUI Markdown without leaving raw asterisks
// or inserting stray spaces, while preserving literal asterisks in code & escapes.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import stripAnsi from 'strip-ansi';
import { register } from 'tsx/esm/api';

const unregisterTsx = register();
after(() => {
  unregisterTsx?.();
});

const [{ renderMarkdown, clearMarkdownCache }, { getTheme, makeChalk, getColorLevel, setColorLevel }] = await Promise.all([
  import('../src/render/markdown.ts'),
  import('../src/theme/tokens.ts'),
]);

test('#1421: **bold** and *italic* adjacent to Chinese punctuation render cleanly without raw asterisks or extra spaces', () => {
  const prevLevel = getColorLevel();
  setColorLevel(3);
  try {
    const theme = getTheme('dsh-dark');
    const c = makeChalk(3);

    const cases = [
      {
        md: '**易错点：**后面的文字',
        expectStyled: c.bold('易错点：'),
        expectPlain: '易错点：后面的文字',
      },
      {
        md: '这是**重点（很重要）**的内容',
        expectStyled: c.bold('重点（很重要）'),
        expectPlain: '这是重点（很重要）的内容',
      },
      {
        md: '核心**（注意）**概念',
        expectStyled: c.bold('（注意）'),
        expectPlain: '核心（注意）概念',
      },
      {
        md: '说明：**重点**与**结论**',
        expectStyled: c.bold('重点'),
        expectPlain: '说明：重点与结论',
      },
      {
        md: '说明：**「要点」**与**《规范》**都适用',
        expectStyled: c.bold('「要点」'),
        expectPlain: '说明：「要点」与《规范》都适用',
      },
      {
        md: '*提示：*请先检查',
        expectStyled: c.italic('提示：'),
        expectPlain: '提示：请先检查',
      },
      {
        md: '这是*重点（必看）*内容',
        expectStyled: c.italic('重点（必看）'),
        expectPlain: '这是重点（必看）内容',
      },
    ];

    for (const tc of cases) {
      clearMarkdownCache();
      const out = renderMarkdown(tc.md, { width: 80, theme });
      assert.ok(out.includes(tc.expectStyled), `expected styled run for "${tc.md}", got: ${JSON.stringify(out)}`);
      assert.equal(stripAnsi(out), tc.expectPlain, `plain text must have no asterisks or extra spaces for "${tc.md}"`);
    }

    // Bold containing inline code still renders bold without leaving **
    clearMarkdownCache();
    const withCode = renderMarkdown('**易错点（`O(n)`）：**后面的文字', { width: 80, theme });
    assert.ok(!stripAnsi(withCode).includes('**'), `nested code bold must not leave **: ${stripAnsi(withCode)}`);
    assert.ok(stripAnsi(withCode).includes('易错点（'), 'contains prefix text');
    assert.ok(stripAnsi(withCode).includes('O(n)'), 'contains inline code');
    assert.ok(stripAnsi(withCode).includes('）：后面的文字'), 'contains suffix with no stray space');

    // Code spans, fenced code blocks, and escaped \* stay untouched
    clearMarkdownCache();
    const codeSpan = renderMarkdown('代码 `**易错点：**后面` 与 \\*字面量\\*', { width: 80, theme });
    assert.ok(stripAnsi(codeSpan).includes('**易错点：**后面'), 'inline code must preserve ** verbatim');
    assert.ok(stripAnsi(codeSpan).includes('*字面量*'), 'escaped asterisks must stay literal');

    clearMarkdownCache();
    const codeFence = renderMarkdown('```md\n**易错点：**后面的文字\n```', { width: 80, theme });
    assert.ok(stripAnsi(codeFence).includes('**易错点：**后面的文字'), 'fenced code block must preserve ** verbatim');
  } finally {
    setColorLevel(prevLevel);
  }
});
