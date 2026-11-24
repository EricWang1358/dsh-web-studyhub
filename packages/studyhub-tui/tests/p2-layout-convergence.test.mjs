// P2 (#1354 D4/D5/Terminal-Compat): Permanent Typography, Breakpoint, Overflow & Glyph Convergence Guardrails.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { render } from 'ink';
import { register } from 'tsx/esm/api';

const unregisterTsx = register();
after(() => {
  unregisterTsx?.();
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(__dirname, '..');
const srcDir = path.join(pkgRoot, 'src');

function walkTsFiles(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walkTsFiles(full, out);
    else if (/\.(ts|tsx)$/.test(ent.name)) out.push(full);
  }
  return out;
}

function renderDebugToString(element, cols = 80, rows = 24) {
  let out = '';
  const stdout = Object.assign(new EventEmitter(), {
    columns: cols,
    rows,
    isTTY: true,
    write(chunk) {
      out += String(chunk);
      return true;
    },
  });
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true,
    setRawMode() {},
    resume() {},
    pause() {},
    ref() {},
    unref() {},
    read() {
      return null;
    },
  });
  const inst = render(element, { stdout, stdin, debug: true, exitOnCtrlC: false });
  inst.unmount();
  return out;
}

describe('P2 (#1354 D4/D5): Typography, Breakpoints, Overflow & Glyph Convergence', () => {
  test('1. Static guardrail: zero hardcoded numeric SplitPane breakpoint={N} props across src/', () => {
    const violations = [];
    for (const file of walkTsFiles(srcDir)) {
      const rel = path.relative(srcDir, file).replace(/\\/g, '/');
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, idx) => {
        if (/\bbreakpoint\s*=\s*\{\s*\d+\s*\}/.test(line)) {
          violations.push(`${rel}:${idx + 1}: ${line.trim()}`);
        }
      });
    }
    assert.deepEqual(
      violations,
      [],
      `Found hardcoded numeric breakpoint={N} props (use LAYOUT_BP.* from components/layout-tokens.js):\n${violations.join('\n')}`,
    );
  });

  test('2. Static guardrail: core chrome & layout primitives consume centralized glyphs.ts and layout-tokens.ts', () => {
    assert.ok(fs.existsSync(path.join(srcDir, 'render/glyphs.ts')), 'src/render/glyphs.ts must exist');
    const glyphConsumers = [
      'components/Layout.tsx',
      'components/Panel.tsx',
      'components/Modal.tsx',
      'components/SplitPane.tsx',
      'components/Badge.tsx',
      'components/layout-tokens.ts',
      'shell/SideNav.tsx',
      'shell/AppShell.tsx',
    ];
    for (const rel of glyphConsumers) {
      const src = fs.readFileSync(path.join(srcDir, rel), 'utf8');
      assert.match(src, /render\/glyphs\.js/, `${rel} must import centralized glyphs from render/glyphs.js`);
    }
  });

  test('3. Glyph table: every glyph has a pure-ASCII fallback and hairline(w, ascii) matches exact width', async () => {
    const { GLYPHS, glyph, hairline } = await import('../src/render/glyphs.ts');
    const ids = Object.keys(GLYPHS);
    assert.ok(ids.length >= 16, `Expected >= 16 canonical glyphs, got ${ids.length}`);
    for (const id of ids) {
      const asciiVal = glyph(id, true);
      const uniVal = glyph(id, false);
      assert.ok(uniVal.length > 0, `Unicode glyph "${id}" must be non-empty`);
      assert.match(asciiVal, /^[\x20-\x7e]+$/, `ASCII glyph "${id}" must be pure printable ASCII, got ${JSON.stringify(asciiVal)}`);
    }
    assert.equal(hairline(10, true), '----------');
    assert.equal(hairline(10, false), '──────────');
    assert.equal(hairline(0, true), '');
  });

  test('4. Monotonic shell layout (#1354 D5): split-pane eligibility never oscillates as terminal widens 60..240 cols', async () => {
    const { LAYOUT_BP, resolveContentTier, isViewportTooSmall } = await import('../src/components/layout-tokens.ts');
    const { shellLayout } = await import('../src/shell/AppShell.tsx');

    let everSplit = false;
    for (let cols = 60; cols <= 240; cols += 1) {
      const { contentW } = shellLayout(cols, 36, { sidebarCollapsed: false, showKeyHints: true });
      const canSplit = contentW >= LAYOUT_BP.SPLIT_DEFAULT;
      if (canSplit) everSplit = true;
      assert.ok(
        !everSplit || canSplit,
        `Non-monotonic layout regression at cols=${cols}: contentW=${contentW} < SPLIT_DEFAULT(${LAYOUT_BP.SPLIT_DEFAULT}) after already entering split mode`,
      );
    }
    assert.equal(everSplit, true, 'Must enter split mode at wide viewports');

    // Content-width 4-tier classification (<60 narrow, 60-84 compact, 85-119 regular, >=120 wide)
    assert.equal(resolveContentTier(55), 'narrow');
    assert.equal(resolveContentTier(60), 'compact');
    assert.equal(resolveContentTier(84), 'compact');
    assert.equal(resolveContentTier(85), 'regular');
    assert.equal(resolveContentTier(119), 'regular');
    assert.equal(resolveContentTier(120), 'wide');

    // Minimum viewport guard (< 60x18)
    assert.equal(isViewportTooSmall(59, 24), true);
    assert.equal(isViewportTooSmall(80, 17), true);
    assert.equal(isViewportTooSmall(40, 12), true);
    assert.equal(isViewportTooSmall(60, 18), false);
    assert.equal(isViewportTooSmall(80, 24), false);
  });

  test('5. KeyHintBar D4 overflow & priority: primary hints precede secondary and overflow shows compact +N indicator within width', async () => {
    const { computeKeyHintBarLayout, KeyHintBar } = await import('../src/components/Badge.tsx');
    const { displayWidth } = await import('../src/render/cjk.ts');
    const { useTuiStore, DEFAULT_PREFERENCES } = await import('../src/state/store.ts');

    const manyHints = [
      { key: 'x', label: '次要导出', priority: 'secondary' },
      { key: '1-6', label: '作答', priority: 'primary' },
      { key: 'Enter', label: '下一题', priority: 'primary' },
      { key: 'h', label: 'AI讲解', priority: 'primary' },
      { key: 't', label: '带学' },
      { key: 'W', label: '翻译', priority: 'secondary' },
      { key: 'S', label: '同类题', priority: 'secondary' },
      { key: 'Q', label: '队列', priority: 'secondary' },
      { key: 'D', label: '工具箱', priority: 'secondary' },
    ];

    const narrow = computeKeyHintBarLayout(manyHints, 64, { asciiMode: false, lang: 'zh' });
    assert.ok(narrow.shown.length > 0, 'Must display at least one hint');
    assert.equal(narrow.shown[0].key, '1-6', 'Primary hints must sort ahead of secondary hints');
    assert.ok(narrow.hiddenCount > 0, 'Overflowing hints must report hiddenCount > 0');
    assert.ok(narrow.overflowText.includes(`+${narrow.hiddenCount}`), `Overflow badge must include +N, got: ${narrow.overflowText}`);
    assert.ok(narrow.usedWidth <= 64, `Used width ${narrow.usedWidth} must stay <= 64`);

    const narrowAscii = computeKeyHintBarLayout(manyHints, 64, { asciiMode: true, lang: 'en' });
    assert.ok(narrowAscii.hiddenCount > 0);
    assert.match(narrowAscii.overflowText, /^[\x20-\x7e]+$/, `ASCII overflow badge must be pure ASCII: ${narrowAscii.overflowText}`);
    assert.ok(displayWidth(narrowAscii.overflowText) <= 20);

    // Live render check
    useTuiStore.setState({ preferences: { ...DEFAULT_PREFERENCES, language: 'zh', asciiMode: false } });
    const renderedZh = renderDebugToString(React.createElement(KeyHintBar, { hints: manyHints, width: 64 }), 64, 3);
    assert.ok(renderedZh.includes('1-6') && renderedZh.includes(`+${narrow.hiddenCount}`), `Rendered KeyHintBar must show primary key & +N badge: ${renderedZh}`);
  });

  test('6. Typography primitives <ChromeLabel> (truncates chrome) and <Prose> (wraps content without truncation)', async () => {
    const { ChromeLabel, Prose } = await import('../src/components/Layout.tsx');
    const { useTuiStore, DEFAULT_PREFERENCES } = await import('../src/state/store.ts');
    useTuiStore.setState({ preferences: { ...DEFAULT_PREFERENCES, language: 'zh', asciiMode: true } });

    const longTitle = 'A very long chrome panel heading that exceeds twenty columns cleanly';
    const labelOut = renderDebugToString(React.createElement(ChromeLabel, { text: longTitle, maxWidth: 20 }), 40, 3);
    assert.ok(labelOut.includes('...'), `ChromeLabel must truncate chrome with ASCII ellipsis: ${labelOut}`);
    assert.ok(!labelOut.includes('cleanly'), 'ChromeLabel must clip overflow beyond maxWidth');

    const longBody = 'This is learner content that must wrap naturally and keep its final marker TAIL_INTACT.';
    const proseOut = renderDebugToString(React.createElement(Prose, { width: 30 }, longBody), 40, 8);
    assert.ok(proseOut.includes('TAIL_INTACT'), `Prose must wrap without truncating content: ${proseOut}`);
  });

  test('7. Viewport-too-small guard screen renders cleanly in AppShell when terminal < 60x18', async () => {
    const { AppShell } = await import('../src/shell/AppShell.tsx');
    const { useTuiStore, DEFAULT_PREFERENCES } = await import('../src/state/store.ts');
    useTuiStore.setState({
      page: 'library',
      loading: false,
      snapshot: { decks: [], courses: [], sources: [], jobs: [] },
      showLaunchpad: false,
      toasts: [],
      preferences: { ...DEFAULT_PREFERENCES, language: 'zh', asciiMode: true },
    });

    const noopHost = {
      mode: 'embedded',
      snapshot: async () => ({ decks: [], courses: [], sources: [], jobs: [] }),
      call: async () => ({ ok: true, value: {} }),
      subscribeEvents: () => () => {},
      close: async () => {},
    };

    let pageRendered = false;
    const out = renderDebugToString(
      React.createElement(AppShell, {
        host: noopHost,
        autoLaunchpad: false,
        renderPage: () => {
          pageRendered = true;
          return React.createElement('box');
        },
      }),
      48,
      14,
    );
    assert.equal(pageRendered, false, 'AppShell must not render page content when viewport < 60x18');
    assert.ok(out.includes('80x24') || out.includes('80×24'), `Too-small guard must recommend 80x24: ${out}`);
    assert.ok(out.includes('48x14') || out.includes('48×14'), `Too-small guard must show current size: ${out}`);
  });
});
