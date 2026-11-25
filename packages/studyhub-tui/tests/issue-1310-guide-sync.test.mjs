// Documentation & in-app guide parity checks for #1310.
// Ensures docs/GUIDE.md, README.md, HelpOverlay, and CommandPalette /guide stay in sync with PAGE_REGISTRY & actual keybindings.
// node --test tests/issue-1310-guide-sync.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Box, render } from 'ink';
import React from 'react';
import stripAnsi from 'strip-ansi';
import { register } from 'tsx/esm/api';

const unregisterTsx = register();
after(() => {
  unregisterTsx?.();
});

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..');
const guidePath = path.join(pkgRoot, 'docs/GUIDE.md');
const readmePath = path.join(pkgRoot, 'README.md');

const [
  { PAGE_REGISTRY },
  { RESERVED_GLOBAL_KEYS },
  { HelpOverlay, buildInAppGuideLines },
  { buildPaletteItems },
  storeMod,
] = await Promise.all([
  import('../src/types/contracts.ts'),
  import('../src/components/focus.ts'),
  import('../src/shell/HelpOverlay.tsx'),
  import('../src/shell/CommandPalette.tsx'),
  import('../src/state/store.ts'),
]);

const { useTuiStore, DEFAULT_PREFERENCES } = storeMod;

function createInkHarness(element, { cols = 100, rows = 30 } = {}) {
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;

  const stdout = new PassThrough();
  stdout.isTTY = true;
  stdout.columns = cols;
  stdout.rows = rows;
  stdout.getColorDepth = () => 1;

  const frames = [];
  const waiters = new Set();
  const notify = () => {
    const latest = frames.at(-1) ?? '';
    for (const w of [...waiters]) {
      if (w.predicate(latest)) {
        waiters.delete(w);
        clearTimeout(w.timer);
        w.resolve(latest);
      }
    }
  };
  stdout.on('data', (chunk) => {
    const plain = stripAnsi(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
    if (plain.trim().length > 0) {
      frames.push(plain);
      notify();
    }
  });

  const inst = render(element, {
    stdout,
    stdin,
    exitOnCtrlC: false,
    patchConsole: false,
    debug: true,
  });

  return {
    write: (s) => stdin.write(s),
    waitFor: (predicate, timeoutMs = 1500) => {
      const cur = frames.at(-1) ?? '';
      if (predicate(cur)) return Promise.resolve(cur);
      return new Promise((resolve, reject) => {
        const entry = {
          predicate,
          resolve,
          timer: setTimeout(() => {
            waiters.delete(entry);
            reject(new Error(`Timed out waiting for frame. Last frame:\n${frames.at(-1) ?? '<empty>'}`));
          }, timeoutMs),
        };
        waiters.add(entry);
      });
    },
    cleanup: () => {
      inst.unmount();
      stdin.destroy();
      stdout.destroy();
    },
  };
}

describe('#1310 usage guide completeness & keybinding sync', () => {
  const guide = fs.readFileSync(guidePath, 'utf8');
  const readme = fs.readFileSync(readmePath, 'utf8');

  test('1. docs/GUIDE.md covers all 16 PAGE_REGISTRY pages, reserved keys, review strip keys, and CLI flags', () => {
    // Every SideNav / PAGE_REGISTRY page must be documented with its Chinese label and shortcut
    for (const page of PAGE_REGISTRY) {
      assert.ok(
        guide.includes(page.labelZh),
        `docs/GUIDE.md missing page label "${page.labelZh}" (${page.id})`,
      );
      assert.ok(
        guide.includes(`\`${page.shortcut}\``),
        `docs/GUIDE.md missing shortcut \`${page.shortcut}\` for page ${page.id}`,
      );
    }

    // Reserved global keys
    for (const k of RESERVED_GLOBAL_KEYS) {
      assert.ok(guide.includes(`\`${k}\``), `docs/GUIDE.md missing reserved global key \`${k}\``);
    }

    // Every Review bottom utility strip key
    for (const reviewKey of ['h', 't', '*', 'G', 'A', 'W', 'S', 'D', 'Q', 'E', 's', 'u', ',', '.', 'J', 'K', 'N', 'o', 'X']) {
      assert.ok(
        guide.includes(`\`${reviewKey}\``),
        `docs/GUIDE.md missing Review bottom utility key \`${reviewKey}\``,
      );
    }

    // Core task sections & CLI flags
    for (const required of [
      '第一次打开',
      '核心主线',
      '刷题页详解',
      '我想做 X，去哪里',
      '常见疑问',
      'FSRS-6',
      '0–5',
      'Ctrl+K',
      '/guide',
      '/due',
      '/quit',
      '--doctor',
      '--stats',
      '--due',
      '--board',
      '--search',
      '--export',
      '--mouse',
      '--no-mouse',
      'm:',
    ]) {
      assert.ok(guide.includes(required), `docs/GUIDE.md missing required topic/flag "${required}"`);
    }
  });

  test('2. README.md links to docs/GUIDE.md near the top and package.json includes docs/GUIDE.md', () => {
    const firstTenLines = readme.split('\n').slice(0, 10).join('\n');
    assert.ok(firstTenLines.includes('docs/GUIDE.md'), 'README.md must link to docs/GUIDE.md near the top');
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'));
    assert.ok(Array.isArray(pkg.files) && pkg.files.includes('docs/GUIDE.md'), 'package.json files must include docs/GUIDE.md');
  });

  test('3. HelpOverlay shows 1-sentence page description, switches to Guide tab via g/Tab, and CommandPalette includes /guide', async () => {
    useTuiStore.setState({
      page: 'review',
      helpOpen: true,
      helpTab: 'shortcuts',
      footerHints: [],
      preferences: { ...DEFAULT_PREFERENCES, language: 'zh', asciiMode: false },
    });

    // CommandPalette /guide command exists and opens help on 'guide' tab
    let openedArgs = null;
    const paletteItems = buildPaletteItems(
      {
        snapshot: null,
        preferences: DEFAULT_PREFERENCES,
        activeRunId: null,
        navigate: () => {},
        setTheme: () => {},
        setLanguage: () => {},
        toggleSidebar: () => {},
        setHelpOpen: (open, tab) => {
          openedArgs = { open, tab };
        },
        setVoicePackOpen: () => {},
        setCoursePickerOpen: () => {},
        goBack: () => {},
      },
      {
        refresh: async () => {},
        loadSample: async () => {},
        openModelSettings: () => {},
        importSource: () => {},
        switchCourse: async () => {},
        quit: () => {},
      },
    );
    const guideCmd = paletteItems.find((it) => it.id === 'cmd:guide' && it.label === '/guide');
    assert.ok(guideCmd, 'CommandPalette must expose /guide command');
    await guideCmd.action();
    assert.deepEqual(openedArgs, { open: true, tab: 'guide' });

    // In-app guide lines are non-empty in zh and en
    const zhGuide = buildInAppGuideLines('zh', 120, false).join('\n');
    const enGuide = buildInAppGuideLines('en', 120, true).join('\n');
    assert.ok(zhGuide.split('\n').length > 10);
    assert.ok(enGuide.split('\n').length > 10);

    // #1341: In-app guide must match actual ReviewView keys ([T] Guided Study, [W] Translate; [L]/[F] standalone modals)
    assert.ok(!zhGuide.includes('[T]翻译'), 'zh in-app guide must not map [T] to Translate');
    assert.ok(!enGuide.includes('[T] Translate'), 'en in-app guide must not map [T] to Translate');
    assert.ok(zhGuide.includes('[t]带学'), 'zh in-app guide must document [t]带学 (#1408)');
    assert.ok(zhGuide.includes('[W]翻译'), 'zh in-app guide must document [W]翻译');
    assert.ok(enGuide.includes('[t] Guided'), 'en in-app guide must document [t] Guided (#1408)');
    assert.ok(enGuide.includes('[W] Translate'), 'en in-app guide must document [W] Translate');
    assert.ok(guide.includes('`L`') && guide.includes('`F`'), 'docs/GUIDE.md must document standalone [L]/[F] modals alongside [T]');

    // HelpOverlay renders 1-line description for current page and toggles to Usage Guide tab
    const h = createInkHarness(
      React.createElement(
        Box,
        { width: 100, height: 28 },
        React.createElement(HelpOverlay, { isActive: true, onClose: () => {} }),
      ),
      { cols: 100, rows: 28 },
    );
    try {
      const f1 = await h.waitFor((s) => s.includes('FSRS-6 间隔复习与 AI 追问'));
      assert.ok(f1.includes('当前页:'), 'HelpOverlay must display 1-line summary of current page');
      assert.ok(f1.includes('使用教程'), 'HelpOverlay must display Usage Guide tab');
      await new Promise((r) => setTimeout(r, 30));
      h.write('\t');
      const f2 = await h.waitFor((s) => s.includes('核心闭环'));
      assert.ok(f2.includes('三大保留全局键'));
    } finally {
      h.cleanup();
    }
  });
});
