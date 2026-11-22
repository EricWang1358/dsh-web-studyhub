// WCAG 2.1 contrast ratio audit tests across all 4 built-in themes:
// `node --test tests/theme-contrast.test.mjs`
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { tsImport } from 'tsx/esm/api';

const { THEME_IDS, getTheme, listThemes } = await tsImport('../src/theme/tokens.ts', import.meta.url);

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/** Parse `#rrggbb` into normalized [0, 1] RGB channels. */
function hexToRgb(hex) {
  assert.match(hex, HEX_COLOR_RE, `Expected 6-digit hex color, got ${hex}`);
  return [
    parseInt(hex.slice(1, 3), 16) / 255,
    parseInt(hex.slice(3, 5), 16) / 255,
    parseInt(hex.slice(5, 7), 16) / 255,
  ];
}

/** WCAG 2.1 relative luminance (sRGB IEC 61966-2-1). */
function relativeLuminance(hex) {
  const [r, g, b] = hexToRgb(hex).map((c) =>
    c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.1 contrast ratio `(L1 + 0.05) / (L2 + 0.05)`. */
function contrastRatio(fg, bg) {
  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

describe('WCAG 2.1 theme contrast audit', () => {
  test('all 4 expected themes are registered and valid', () => {
    assert.deepEqual([...THEME_IDS], ['dsh-dark', 'warm-paper', 'nord', 'high-contrast']);
    const themes = listThemes();
    assert.equal(themes.length, 4);
    for (const id of THEME_IDS) {
      assert.equal(getTheme(id).id, id);
    }
  });

  const ACCENT_TOKENS = ['heading', 'primary', 'accent', 'success', 'warning', 'error', 'ai', 'link'];

  for (const themeId of THEME_IDS) {
    const theme = getTheme(themeId);
    const isHighContrast = themeId === 'high-contrast';

    describe(`theme: ${themeId}`, () => {
      test('text on bg and surface meets AA / high-contrast thresholds', () => {
        const minText = isHighContrast ? 10.0 : 4.5;
        const onBg = contrastRatio(theme.text, theme.bg);
        const onSurface = contrastRatio(theme.text, theme.surface);
        assert.ok(
          onBg >= minText,
          `${themeId}: text (${theme.text}) on bg (${theme.bg}) = ${onBg.toFixed(2)}:1 < ${minText}:1`,
        );
        assert.ok(
          onSurface >= minText,
          `${themeId}: text (${theme.text}) on surface (${theme.surface}) = ${onSurface.toFixed(2)}:1 < ${minText}:1`,
        );
      });

      test('selectionFg on selectionBg meets AA / high-contrast thresholds', () => {
        const minSelection = isHighContrast ? 7.0 : 4.5;
        const ratio = contrastRatio(theme.selectionFg, theme.selectionBg);
        assert.ok(
          ratio >= minSelection,
          `${themeId}: selectionFg (${theme.selectionFg}) on selectionBg (${theme.selectionBg}) = ${ratio.toFixed(2)}:1 < ${minSelection}:1`,
        );
      });

      test('muted on bg meets >= 3.5:1 threshold for crisp captions', () => {
        const ratio = contrastRatio(theme.muted, theme.bg);
        assert.ok(
          ratio >= 3.5,
          `${themeId}: muted (${theme.muted}) on bg (${theme.bg}) = ${ratio.toFixed(2)}:1 < 3.5:1`,
        );
      });

      test('semantic & accent tokens on bg and surface meet >= 3.0:1 threshold', () => {
        for (const token of ACCENT_TOKENS) {
          const fg = theme[token];
          const onBg = contrastRatio(fg, theme.bg);
          const onSurface = contrastRatio(fg, theme.surface);
          assert.ok(
            onBg >= 3.0,
            `${themeId}: ${token} (${fg}) on bg (${theme.bg}) = ${onBg.toFixed(2)}:1 < 3.0:1`,
          );
          assert.ok(
            onSurface >= 3.0,
            `${themeId}: ${token} (${fg}) on surface (${theme.surface}) = ${onSurface.toFixed(2)}:1 < 3.0:1`,
          );
        }
      });
    });
  }
});
