// Round 84 comprehensive behavior & layout tests:
// - Track A3: Eye-care dark theme (`warm-amber`) with warm low-blue palette, WCAG AA contrast,
//             CLI --theme parsing, instant store switching, and 120x36 + 80x24 ASCII verification
// - Track C2: OSC 8 terminal hyperlinks (`osc8.ts`) with safe degradation under NO_COLOR, asciiMode,
//             TERM=dumb, non-TTY, and escape-injection rejection
// - Track B3: Review Quick Action Strip (`quick-actions.ts`) + [R] Redo current card behavior
// node --test tests/round-84-ux.test.mjs
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { render } from 'ink';
import React from 'react';
import { register } from 'tsx/esm/api';

const unregisterTsx = register();
after(() => {
  unregisterTsx?.();
});

const [
  tokensMod,
  cliMod,
  osc8Mod,
  quickMod,
  { ReviewView },
  storeMod,
] = await Promise.all([
  import('../src/theme/tokens.ts'),
  import('../src/cli-args.ts'),
  import('../src/render/osc8.ts'),
  import('../src/views/review/quick-actions.ts'),
  import('../src/views/review/ReviewView.tsx'),
  import('../src/state/store.ts'),
]);

const { THEME_IDS, getTheme } = tokensMod;
const { parseCliArgs } = cliMod;
const { buildFileHyperlinkUrl, formatOsc8Link, supportsOsc8 } = osc8Mod;
const { buildReviewQuickActions } = quickMod;
const { useTuiStore } = storeMod;

function stripAnsi(s) {
  return String(s || '')
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1b\]8;;[^\x07]*\x07/g, '');
}

function hexLuminance(hex) {
  const clean = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(clean.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(fg, bg) {
  const l1 = hexLuminance(fg);
  const l2 = hexLuminance(bg);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function createTtyHarness(columns, rows) {
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  Object.assign(stdout, { isTTY: true, columns, rows });
  Object.assign(stdin, { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
  let output = '';
  stdout.on('data', (chunk) => {
    output += chunk.toString('utf8');
  });
  return {
    stdout,
    stdin,
    getOutput: () => output,
    getPlain: () => stripAnsi(output),
    async waitFor(pred, timeoutMs = 2000) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const plain = stripAnsi(output);
        if (pred(plain)) return plain;
        await wait(25);
      }
      throw new Error(`waitFor timed out. Last output:\n${stripAnsi(output).slice(-800)}`);
    },
  };
}

describe('Round 84 Track A3 — warm-amber eye-care dark theme', () => {
  test('registers warm-amber with warm low-blue palette and WCAG AA contrast', () => {
    assert.ok(THEME_IDS.includes('warm-amber'));
    const theme = getTheme('warm-amber');
    assert.equal(theme.id, 'warm-amber');

    // Warm dark canvas: red channel > blue channel (low blue light)
    const bgHex = theme.bg.replace('#', '');
    const r = parseInt(bgHex.slice(0, 2), 16);
    const b = parseInt(bgHex.slice(4, 6), 16);
    assert.ok(r > b, `Expected warm low-blue bg (${theme.bg}), got r=${r}, b=${b}`);

    for (const token of ['text', 'primary', 'accent', 'muted', 'success', 'warning', 'error', 'info', 'ai']) {
      const ratio = contrastRatio(theme[token], theme.bg);
      assert.ok(ratio >= 4.5, `warm-amber.${token} (${theme[token]}) on ${theme.bg} contrast ${ratio.toFixed(2)} < 4.5`);
    }
    const dimRatio = contrastRatio(theme.dim, theme.bg);
    assert.ok(dimRatio >= 3.0, `warm-amber.dim (${theme.dim}) contrast ${dimRatio.toFixed(2)} < 3.0`);
  });

  test('CLI --theme warm-amber parses cleanly and switches store theme instantaneously', () => {
    const parsed = parseCliArgs(['--theme', 'warm-amber']);
    assert.equal(parsed.error, undefined);
    assert.equal(parsed.theme, 'warm-amber');

    const prev = useTuiStore.getState().preferences.theme;
    useTuiStore.getState().setPreferences({ theme: 'warm-amber' });
    assert.equal(useTuiStore.getState().preferences.theme, 'warm-amber');
    useTuiStore.getState().setPreferences({ theme: prev });
  });
});

describe('Round 84 Track C2 — OSC 8 terminal hyperlinks with safe fallback', () => {
  test('detects capable terminals and degrades cleanly under NO_COLOR, asciiMode, TERM=dumb, non-TTY', () => {
    assert.equal(supportsOsc8({ env: { WT_SESSION: '1' }, isTTY: true }), true);
    assert.equal(supportsOsc8({ env: { ITERM_SESSION_ID: 'w0t0' }, isTTY: true }), true);
    assert.equal(supportsOsc8({ env: { TERM_PROGRAM: 'WezTerm' }, isTTY: true }), true);
    assert.equal(supportsOsc8({ env: { TERM_PROGRAM: 'vscode' }, isTTY: true }), true);
    assert.equal(supportsOsc8({ env: { COLORTERM: 'truecolor' }, isTTY: true }), true);
    assert.equal(supportsOsc8({ env: { STUDYHUB_TUI_OSC8: '1' }, isTTY: false }), true);

    assert.equal(supportsOsc8({ env: { WT_SESSION: '1', NO_COLOR: '1' }, isTTY: true }), false);
    assert.equal(supportsOsc8({ env: { WT_SESSION: '1' }, isTTY: true, asciiMode: true }), false);
    assert.equal(supportsOsc8({ env: { WT_SESSION: '1', STUDYHUB_TUI_OSC8: '0' }, isTTY: true }), false);
    assert.equal(supportsOsc8({ env: { TERM: 'dumb' }, isTTY: true }), false);
    assert.equal(supportsOsc8({ env: { WT_SESSION: '1' }, isTTY: false }), false);
  });

  test('builds file:// URLs with page anchors and rejects unsafe schemes or control chars', () => {
    const url = buildFileHyperlinkUrl('/tmp/notes/ch3.pdf', 12);
    assert.equal(url, `${pathToFileURL(resolve('/tmp/notes/ch3.pdf')).href}#page=12`);
    assert.equal(buildFileHyperlinkUrl('https://example.com/doc'), 'https://example.com/doc');

    const linked = formatOsc8Link('ch3.pdf p.12', url, { enabled: true });
    assert.equal(linked, `\x1b]8;;${url}\x07ch3.pdf p.12\x1b]8;;\x07`);

    assert.equal(formatOsc8Link('ch3.pdf p.12', url, { enabled: false }), 'ch3.pdf p.12');
    assert.equal(formatOsc8Link('ch3.pdf', 'javascript:alert(1)', { enabled: true }), 'ch3.pdf');
    assert.equal(formatOsc8Link('ch3.pdf', 'file:///tmp/a\x07b', { enabled: true }), 'ch3.pdf');
  });
});

describe('Round 84 Track B3 — Review Quick Action Strip & [R] Redo', () => {
  test('orders primary actions first and gates [R] Redo on canRedo', () => {
    const pre = buildReviewQuickActions({
      lang: 'zh',
      isCardFocused: false,
      canRubricGrade: true,
      canRedo: false,
      canAdjustGrade: false,
      canAckCorrection: false,
      canCoachNudge: false,
    });
    assert.deepEqual(
      pre.filter((x) => x.primary).map((x) => x.id),
      ['h', 'T', 'S', '*'],
    );
    assert.equal(pre.find((x) => x.id === '*')?.text, '[*]收藏');

    const post = buildReviewQuickActions({
      lang: 'zh',
      isCardFocused: true,
      canRubricGrade: false,
      canRedo: true,
      canAdjustGrade: false,
      canAckCorrection: false,
      canCoachNudge: false,
    });
    assert.deepEqual(
      post.filter((x) => x.primary).map((x) => x.id),
      ['h', 'T', 'S', '*', 'R'],
    );
    assert.equal(post.find((x) => x.id === '*')?.text, '[*]已收藏');
    assert.equal(post.find((x) => x.id === 'R')?.text, '[R]重做');
  });

  test('ReviewView renders Quick Action Strip cleanly at 120x36 & 80x24 under warm-amber and [R] restarts card', async () => {
    const calls = [];
    const baseRun = {
      id: 'run-r84',
      title: 'Linear Algebra Review',
      mode: 'path',
      status: 'active',
      total: 1,
      answered: 0,
      index: 0,
      deckId: 'deck-la',
      card: {
        id: 'card-eigen',
        deckId: 'deck-la',
        kind: 'single',
        prompt: 'What is the determinant of the identity matrix I_n?',
        options: [
          { id: 'A', text: '1' },
          { id: 'B', text: '0' },
        ],
        citations: [{ sourceId: 'src-la', title: 'LA-Notes.pdf', pageNumber: 7 }],
      },
      solution: { answer: 'A', explanation: 'det(I_n) = 1.' },
      feedback: { correct: true, grade: 5, selected: ['A'] },
      revealed: true,
    };

    const host = {
      async call(action, payload) {
        calls.push({ action, payload });
        if (action === 'review.get') return { ok: true, value: baseRun };
        if (action === 'review.start') {
          return {
            ok: true,
            value: {
              ...baseRun,
              id: 'run-r84-redo',
              revealed: false,
              feedback: null,
            },
          };
        }
        return { ok: true, value: {} };
      },
    };

    useTuiStore.setState({
      preferences: {
        ...useTuiStore.getState().preferences,
        theme: 'warm-amber',
        language: 'zh',
        asciiMode: true,
      },
      activeRunId: 'run-r84',
      snapshot: {
        sources: [{ id: 'src-la', title: 'LA-Notes.pdf', filePath: '/tmp/LA-Notes.pdf' }],
      },
    });

    const wrap = (w, h) => React.createElement(ReviewView, { host, width: w, height: h, isActive: true });

    // 120x36 snapshot + [R] redo interaction
    const wideTty = createTtyHarness(120, 36);
    const wide = render(wrap(116, 34), { stdout: wideTty.stdout, stdin: wideTty.stdin, exitOnCtrlC: false, interactive: true });
    const wideText = await wideTty.waitFor((s) => s.includes('[h]讲解'));
    assert.match(wideText, /\[h\]讲解/);
    assert.match(wideText, /\[t\]带学/);
    assert.match(wideText, /\[S\]同类/);
    assert.match(wideText, /\[\*\]收藏/);
    assert.match(wideText, /\[R\]重做/);
    assert.match(wideText, /LA-Notes\.pdf/);

    wideTty.stdin.write('R');
    await wideTty.waitFor(() => calls.some((c) => c.action === 'review.start' && c.payload?.fresh === true));
    const redoCall = calls.find((c) => c.action === 'review.start' && c.payload?.fresh === true);
    assert.ok(redoCall, 'Pressing R after reveal should call review.start with fresh:true');
    assert.deepEqual(redoCall.payload.scope, [{ deckId: 'deck-la', cardId: 'card-eigen' }]);
    wide.unmount();

    // 80x24 compact ASCII snapshot (no crash, fits cleanly with overflow hint)
    useTuiStore.setState({ activeRunId: 'run-r84' });
    const narrowTty = createTtyHarness(80, 24);
    const narrow = render(wrap(76, 22), { stdout: narrowTty.stdout, stdin: narrowTty.stdin, exitOnCtrlC: false, interactive: true });
    const narrowText = await narrowTty.waitFor((s) => s.includes('[h]讲解'));
    assert.match(narrowText, /\[h\]讲解/);
    assert.match(narrowText, /\[t\]带学/);
    assert.match(narrowText, /按\?看全部|\[\?\]/);
    narrow.unmount();
  });
});
