// Regression tests for #1419: TranslationGlossaryModal AI-suggested term translation
// with explicit confirmation before model call, edit/override support, and no-model fallback.
import assert from 'node:assert/strict';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { render } from 'ink';
import React from 'react';
import { tsImport } from 'tsx/esm/api';
import {
  createTempTracker,
  createVirtualTty,
  disposeTerminalPool,
  distDir,
  loadDistRuntime,
} from './helpers/virtual-tty.mjs';

const glossaryMod = await tsImport('../src/views/sources/TranslationGlossaryModal.tsx', import.meta.url);
const { buildGlossarySuggestPrompt, parseGlossarySuggestion } = glossaryMod;

const runtime = await loadDistRuntime();
const { StudyHubTuiApp, createTuiHost } = runtime;
const storeFile = (await readdir(distDir)).find((f) => f.startsWith('store-') && f.endsWith('.mjs'));
assert.ok(storeFile, 'dist/ must include store-*.mjs');
const { useTuiStore } = await import(pathToFileURL(join(distDir, storeFile)).href);

const PREV_DSH_HOME = process.env.DSH_HOME;
const temps = createTempTracker('studyhub-tui-1419-');

function resetStoreForTest() {
  useTuiStore.setState({
    page: 'library',
    navContext: {},
    history: [],
    inputCaptured: false,
    commandPaletteOpen: false,
    helpOpen: false,
    coursePickerOpen: false,
    voicePackOpen: false,
    inboxOpen: false,
    showLaunchpad: false,
    snapshot: null,
    binding: null,
    desktopConfig: null,
    loading: true,
    refreshing: false,
    lastError: null,
    activeRunId: null,
    quitConfirmOpen: false,
    quitGuard: null,
    toasts: [],
    footerHints: [],
  });
}

async function mountSourcesReader(host, docTitle, bodyMatch) {
  resetStoreForTest();
  const tty = createVirtualTty(120, 36);
  const inkInstance = render(
    React.createElement(StudyHubTuiApp, {
      host,
      initialPage: 'sources',
      initialLanguage: 'zh',
      autoLaunchpad: false,
      onExit: () => inkInstance.unmount(),
    }),
    {
      stdin: tty.stdin,
      stdout: tty.stdout,
      stderr: tty.stderr,
      interactive: true,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  );
  await tty.firstFramePromise;
  await tty.waitFor((s) => s.includes(docTitle), { timeoutMs: 8_000, label: `Sources list shows ${docTitle}` });
  tty.send('\r');
  await tty.waitFor((s) => s.includes(bodyMatch), { timeoutMs: 8_000, label: `DocumentReader shows ${bodyMatch}` });
  return {
    tty,
    unmount: () => {
      try {
        inkInstance.unmount();
      } catch {
        // ignore cleanup
      }
      tty.dispose();
    },
  };
}

after(async () => {
  try {
    disposeTerminalPool();
  } finally {
    if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = PREV_DSH_HOME;
    await temps.cleanup();
  }
});

describe('#1419: TranslationGlossaryModal AI-suggested translation', () => {
  test('pure helpers build context-aware prompt and clean AI suggestion output', () => {
    assert.equal(typeof buildGlossarySuggestPrompt, 'function', 'must export buildGlossarySuggestPrompt');
    assert.equal(typeof parseGlossarySuggestion, 'function', 'must export parseGlossarySuggestion');

    const prompt = buildGlossarySuggestPrompt({
      term: 'amortized analysis',
      target: 'zh',
      title: 'CLRS Chapter 17',
      pageText: 'In algorithm design, amortized analysis averages the cost of a sequence of operations.',
      glossary: [{ term: 'heap', to: '堆' }],
    });
    assert.ok(prompt.includes('amortized analysis'), 'prompt must include the source term');
    assert.ok(prompt.includes('CLRS Chapter 17'), 'prompt must include document title');
    assert.ok(prompt.includes('averages the cost'), 'prompt must include page context around the term');
    assert.ok(prompt.includes('heap'), 'prompt must include existing glossary for consistency');

    assert.equal(parseGlossarySuggestion('「摊还分析」'), '摊还分析');
    assert.equal(parseGlossarySuggestion('译法：`**摊还分析**`\n说明：这是算法术语'), '摊还分析');
    assert.equal(parseGlossarySuggestion('"Amortized Analysis"'), 'Amortized Analysis');
    assert.equal(parseGlossarySuggestion('   '), '');
  });

  test('with configured model: asks confirmation (0 silent calls), cancel falls back to manual, confirm pre-fills editable AI suggestion', async () => {
    const box = await temps.make('with-model');
    const dshHome = join(box, 'dsh');
    const libRoot = join(box, 'lib');
    await Promise.all([mkdir(dshHome, { recursive: true }), mkdir(libRoot, { recursive: true })]);
    process.env.DSH_HOME = dshHome;

    const calls = [];
    const host = await createTuiHost({
      env: { DSH_HOME: dshHome },
      home: join(box, 'home'),
      libraryRoot: libRoot,
      injectedComplete: async (system, prompt) => {
        calls.push({ system, prompt });
        const text = String(prompt);
        if (text.includes('术语原文: invariance')) return '「不变性」';
        if (text.includes('术语原文: stability')) return '稳定性';
        return '建议译法';
      },
      skipAutoProbe: true,
      language: 'zh',
      eventDebounceMs: 30,
    });

    const mdPath = join(box, 'algo.md');
    await writeFile(
      mdPath,
      '# Algorithms Notes\n\nAmortized analysis and invariance preserve memory stability across updates.\n',
      'utf8',
    );
    const imp = await host.call('materials.document.import', {
      path: mdPath,
      title: 'Algorithms Notes',
      format: 'md',
    });
    assert.equal(imp.ok, true);
    const docId = imp.value.documentId;

    const session = await mountSourcesReader(host, 'Algorithms Notes', 'Amortized analysis');
    try {
      session.tty.send('G');
      await session.tty.waitFor((s) => s.includes('翻译术语表与已存译文') && s.includes('术语表为空'), {
        timeoutMs: 8_000,
        label: 'TranslationGlossaryModal open',
      });

      // 1) Enter term -> ConfirmDialog MUST appear with 0 model calls; pressing 'n' skips AI for manual entry
      session.tty.send('a');
      await session.tty.waitFor((s) => s.includes('添加术语 (1/2)'), { timeoutMs: 5_000 });
      session.tty.send('amortized analysis');
      await session.tty.waitFor((s) => s.includes('amortized analysis'), { timeoutMs: 5_000 });
      session.tty.send('\r');

      const confirmScreen = await session.tty.waitFor(
        (s) => s.includes('AI 建议译法') && s.includes('amortized analysis'),
        { timeoutMs: 5_000, label: 'AI suggest ConfirmDialog shown before spending quota' },
      );
      assert.ok(confirmScreen.includes('AI 建议译法'), 'must confirm before calling model');
      assert.equal(calls.length, 0, 'must make 0 model calls before user confirms');

      session.tty.send('n');
      await session.tty.waitFor((s) => !s.includes('AI 建议译法') && s.includes('添加术语 (2/2)'), {
        timeoutMs: 5_000,
        label: 'Cancel falls back to manual Step 2',
      });
      assert.equal(calls.length, 0, 'cancelling AI suggest must make 0 model calls');
      session.tty.send('摊还分析');
      await session.tty.waitFor((s) => s.includes('摊还分析'), { timeoutMs: 5_000 });
      session.tty.send('\r');
      await session.tty.waitFor(
        (s) =>
          s.includes('amortized analysis → 摊还分析') &&
          !s.includes('正在保存更改') &&
          useTuiStore.getState().toasts.some((t) => t.text.includes('amortized analysis')),
        {
          timeoutMs: 6_000,
          label: 'Manual entry saved',
        },
      );

      // 2) Confirm AI suggestion -> pre-fills input -> Enter saves directly!
      session.tty.send('a');
      await session.tty.waitFor((s) => s.includes('添加术语 (1/2)'), { timeoutMs: 5_000 });
      session.tty.send('invariance');
      await session.tty.waitFor((s) => s.includes('invariance'), { timeoutMs: 5_000 });
      session.tty.send('\r');
      await session.tty.waitFor((s) => s.includes('AI 建议译法'), { timeoutMs: 5_000 });
      session.tty.send('y');

      await session.tty.waitFor(
        (s) => !s.includes('AI 建议译法') && s.includes('添加术语 (2/2)') && s.includes('不变性'),
        { timeoutMs: 6_000, label: 'AI suggestion pre-filled into Step 2 TextInput' },
      );
      assert.equal(calls.length, 1, 'confirmed AI suggestion must invoke model once');
      assert.ok(
        calls[0].prompt.includes('preserve memory stability'),
        'AI suggestion request must carry current page context',
      );
      // Direct Enter saves the AI suggestion
      session.tty.send('\r');
      await session.tty.waitFor(
        (s) =>
          s.includes('invariance → 不变性') &&
          !s.includes('正在保存更改') &&
          useTuiStore.getState().toasts.some((t) => t.text.includes('invariance')),
        {
          timeoutMs: 6_000,
          label: 'AI-suggested translation saved with Enter',
        },
      );

      // 3) Confirm AI suggestion -> user overrides with Ctrl+U + custom text -> saves user override!
      session.tty.send('a');
      await session.tty.waitFor((s) => s.includes('添加术语 (1/2)'), { timeoutMs: 5_000 });
      session.tty.send('stability');
      await session.tty.waitFor((s) => s.includes('stability'), { timeoutMs: 5_000 });
      session.tty.send('\r');
      await session.tty.waitFor((s) => s.includes('AI 建议译法'), { timeoutMs: 5_000 });
      session.tty.send('y');
      await session.tty.waitFor(
        (s) => !s.includes('AI 建议译法') && s.includes('添加术语 (2/2)') && s.includes('稳定性'),
        { timeoutMs: 6_000, label: 'AI suggestion pre-filled stability -> 稳定性' },
      );
      session.tty.send('\x15'); // Ctrl+U clear
      await session.tty.flush();
      session.tty.send('记忆稳定性');
      await session.tty.waitFor((s) => s.includes('记忆稳定性'), { timeoutMs: 5_000 });
      session.tty.send('\r');
      await session.tty.waitFor(
        (s) =>
          s.includes('stability → 记忆稳定性') &&
          !s.includes('正在保存更改') &&
          useTuiStore.getState().toasts.some((t) => t.text.includes('stability')),
        {
          timeoutMs: 6_000,
          label: 'User override saved instead of AI default',
        },
      );

      const check = await host.call('materials.translation.glossary.get', { documentId: docId });
      assert.equal(check.ok, true);
      assert.deepEqual(check.value.glossary, [
        { term: 'amortized analysis', to: '摊还分析' },
        { term: 'invariance', to: '不变性' },
        { term: 'stability', to: '记忆稳定性' },
      ]);
    } finally {
      session.unmount();
      await host.dispose();
    }
  });

  test('without configured model: falls back directly to manual Step 2 and explains why', async () => {
    const box = await temps.make('no-model');
    const dshHome = join(box, 'dsh');
    const libRoot = join(box, 'lib');
    await Promise.all([mkdir(dshHome, { recursive: true }), mkdir(libRoot, { recursive: true })]);
    process.env.DSH_HOME = dshHome;

    const host = await createTuiHost({
      env: { DSH_HOME: dshHome },
      home: join(box, 'home'),
      libraryRoot: libRoot,
      skipAutoProbe: true,
      language: 'zh',
      eventDebounceMs: 30,
    });

    const mdPath = join(box, 'nomodel.md');
    await writeFile(mdPath, '# Offline Doc\n\nFSRS updates memory stability.\n', 'utf8');
    const imp = await host.call('materials.document.import', {
      path: mdPath,
      title: 'Offline Doc',
      format: 'md',
    });
    assert.equal(imp.ok, true);

    const session = await mountSourcesReader(host, 'Offline Doc', 'FSRS updates memory stability');
    try {
      session.tty.send('G');
      await session.tty.waitFor((s) => s.includes('翻译术语表与已存译文'), { timeoutMs: 8_000 });
      session.tty.send('a');
      await session.tty.waitFor((s) => s.includes('添加术语 (1/2)'), { timeoutMs: 5_000 });
      session.tty.send('FSRS');
      await session.tty.waitFor((s) => s.includes('术语原文: FSRS'), { timeoutMs: 5_000 });
      session.tty.send('\r');

      const step2 = await session.tty.waitFor(
        (s) => s.includes('添加术语 (2/2)') && s.includes('未配置可用模型'),
        { timeoutMs: 5_000, label: 'No-model fallback explains reason directly in Step 2' },
      );
      assert.ok(!step2.includes('AI 建议译法'), 'must not show AI confirm when no model is configured');
      assert.ok(step2.includes('未配置可用模型'), 'must explain fallback reason to user');
    } finally {
      session.unmount();
      await host.dispose();
    }
  });
});
