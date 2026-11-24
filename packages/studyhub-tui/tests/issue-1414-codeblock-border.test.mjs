// Regression test for #1414: fenced code block borders in TUI markdown must use
// `theme.dim` (visible against dark terminal backgrounds) instead of `theme.border`,
// while keeping the language label in `theme.muted`.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { register } from 'tsx/esm/api';

const unregisterTsx = register();
after(() => {
  unregisterTsx?.();
});

const [{ renderMarkdownLines, clearMarkdownCache }, { getTheme, makeChalk, getColorLevel, setColorLevel }] = await Promise.all([
  import('../src/render/markdown.ts'),
  import('../src/theme/tokens.ts'),
]);

test('#1414: renderCode draws code block borders using theme.dim while keeping language label in theme.muted', () => {
  const prevLevel = getColorLevel();
  setColorLevel(3);
  try {
    for (const themeId of ['warm-amber', 'dsh-dark', 'warm-paper']) {
      clearMarkdownCache();
      const theme = getTheme(themeId);
      const c = makeChalk(3);
      const dimBoxTop = c.hex(theme.dim)('╭─');
      const oldBorderTop = c.hex(theme.border)('╭─');
      const dimVBar = c.hex(theme.dim)('│');
      const mutedLabel = c.hex(theme.muted)(' java ');

      const lines = renderMarkdownLines('```java\nint x = 1;\n```', { width: 40, theme, ascii: false });
      assert.ok(lines.length >= 3, `${themeId}: expected top/body/bottom lines`);
      assert.ok(lines[0].includes(dimBoxTop), `${themeId}: top border should use theme.dim (${theme.dim})`);
      assert.ok(!lines[0].includes(oldBorderTop), `${themeId}: top border must not use dark theme.border (${theme.border})`);
      assert.ok(lines[0].includes(mutedLabel), `${themeId}: language label must stay theme.muted (${theme.muted})`);
      assert.ok(lines[1].includes(dimVBar), `${themeId}: side bar should use theme.dim`);
      assert.equal(lines[lines.length - 1], c.hex(theme.dim)(`╰${'─'.repeat(38)}╯`), `${themeId}: bottom border should use theme.dim`);

      // ASCII mode also uses theme.dim for borders and theme.muted for label
      clearMarkdownCache();
      const asciiLines = renderMarkdownLines('```java\nint x = 1;\n```', { width: 40, theme, ascii: true });
      assert.ok(asciiLines[0].includes(c.hex(theme.dim)('+---')), `${themeId} ascii: top border uses theme.dim`);
      assert.ok(asciiLines[0].includes(mutedLabel), `${themeId} ascii: label stays theme.muted`);
      assert.ok(asciiLines[1].includes(c.hex(theme.dim)('|')), `${themeId} ascii: side bar uses theme.dim`);
    }
  } finally {
    setColorLevel(prevLevel);
  }
});
