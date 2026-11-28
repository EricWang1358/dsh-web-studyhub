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

/**
 * The app on the sources page with the reader opened on `docTitle`. Keys sent before Ink has read the earlier ones arrive as ONE chunk
 * ("\rG" is neither Enter nor G), so every wait here is for something that is not true until the key before it has taken effect.
 * `bodyMatch`: text of the loaded page; null when the test holds the page back.
 */
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
  const unmount = () => {
    try {
      inkInstance.unmount();
    } catch {
      // ignore cleanup
    }
    tty.dispose();
  };
  try {
    await tty.firstFramePromise;
    await tty.waitFor((s) => s.includes(docTitle), { timeoutMs: 8_000, label: `Sources list shows ${docTitle}` });
    tty.send('\r');
    // Wait for DocumentReader-exclusive header/footer markers alongside body text: SourcesView's
    // right-hand preview pane also renders `bodyMatch`, which can satisfy a body-only waitFor
    // before the lazy DocumentReader chunk finishes mounting and registering its `G` handler.
    // With the page held back there is no body yet: the footer hint says the reader takes keys.
    await tty.waitFor(
      (s) => s.includes('术语译文') && (bodyMatch === null || (s.includes(bodyMatch) && s.includes('第 1 /'))),
      { timeoutMs: 8_000, label: `DocumentReader shows ${bodyMatch ?? 'its keys'}` },
    );
  } catch (error) {
    // A mounted app keeps the process alive: without this a failed wait here hangs the whole file instead of reporting.
    unmount();
    throw error;
  }
  return { tty, unmount };
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
      await session.tty.waitFor((s) => s.includes('术语原文: amortized analysis'), { timeoutMs: 5_000 });
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
      await session.tty.waitFor((s) => s.includes('译法(空=原样): 摊还分析'), { timeoutMs: 5_000 });
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
      await session.tty.waitFor((s) => s.includes('术语原文: invariance'), { timeoutMs: 5_000 });
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
      await session.tty.waitFor((s) => s.includes('术语原文: stability'), { timeoutMs: 5_000 });
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
      await session.tty.waitFor((s) => s.includes('译法(空=原样): 记忆稳定性'), { timeoutMs: 5_000 });
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
      await session.tty.waitFor((s) => s.includes('翻译术语表与已存译文') && s.includes('术语表为空'), {
        timeoutMs: 8_000,
        label: 'TranslationGlossaryModal open (no-model)',
      });
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

/* The reader hands the dialog the page's `revision` only when the page has arrived, so a dialog opened before that loads the same document a
   second time while it is open. That second load used to draw a spinner over the whole body, the add field with it: what was typed meanwhile
   was dropped (the CI failure where 「FSRS」 never reached the field). */
describe('#1419: a glossary that loads again while it is open', () => {
  /** A library with one document and no model, whose answers can be held back or replaced. */
  async function openLibrary(name) {
    const box = await temps.make(name);
    const dshHome = join(box, 'dsh');
    const libRoot = join(box, 'lib');
    await Promise.all([mkdir(dshHome, { recursive: true }), mkdir(libRoot, { recursive: true })]);
    process.env.DSH_HOME = dshHome;
    const host = await createTuiHost({ env: { DSH_HOME: dshHome }, home: join(box, 'home'), libraryRoot: libRoot, skipAutoProbe: true, language: 'zh', eventDebounceMs: 30 });
    const mdPath = join(box, 'refresh.md');
    await writeFile(mdPath, '# Offline Doc\n\nSpaced repetition updates memory stability.\n', 'utf8');
    const imported = await host.call('materials.document.import', { path: mdPath, title: 'Offline Doc', format: 'md' });
    assert.equal(imported.ok, true);

    const answer = host.call.bind(host);
    const holds = [];
    let failure = null;
    host.call = async (action, ...rest) => {
      if (failure?.match.test(action)) return { ok: false, error: { message: failure.message } };
      // The ANSWER is held, not the request: it was read before anything the test does while it is held.
      const result = await answer(action, ...rest);
      const gate = holds.find((entry) => !entry.open && entry.match.test(action));
      if (gate) await new Promise((go) => gate.waiting.push(go));
      return result;
    };
    return {
      host,
      imported: imported.value,
      stored: () => answer('materials.translation.glossary.get', { documentId: imported.value.documentId }),
      fail: (match, message) => { failure = { match, message }; },
      hold: (match) => {
        const gate = { match, open: false, waiting: [] };
        holds.push(gate);
        return {
          get pending() { return gate.waiting.length; },
          release: () => { gate.open = true; for (const go of gate.waiting.splice(0)) go(); },
        };
      },
      releaseAll: () => { for (const gate of holds) { gate.open = true; for (const go of gate.waiting.splice(0)) go(); } },
    };
  }

  const PAGE = /^source\.(pages|get)$/;
  const GLOSSARY = /^materials\.translation\.glossary\.get$/;
  const wait = (session, check, label) => session.tty.waitFor(check, { timeoutMs: 10_000, label });
  const screenNow = async (session) => { await session.tty.flush(150); return session.tty.waitFor(() => true); };

  /** The dialog opened while the reader's page is still on its way, with the add field open; then the page arrives and the dialog asks again. */
  async function typingWhenThePageArrives(library, session, page) {
    session.tty.send('G');
    await wait(session, (s) => s.includes('术语表为空'), 'the dialog loaded before the page');
    session.tty.send('a');
    await wait(session, (s) => s.includes('添加术语 (1/2)'), 'the add field');
    const reload = library.hold(GLOSSARY);
    page.release();
    await wait(session, () => reload.pending > 0, 'the second load is on its way');
    return reload;
  }

  async function withReader(name, body, { holdPage = true, before } = {}) {
    const library = await openLibrary(name);
    const page = holdPage ? library.hold(PAGE) : null;
    const prepared = before?.(library);
    let session;
    try {
      session = await mountSourcesReader(library.host, 'Offline Doc', holdPage ? null : 'Spaced repetition updates');
      await body({ library, session, page, prepared });
    } finally {
      library.releaseAll();
      session?.unmount();
      await library.host.dispose();
    }
  }

  test('the add field stays, and takes what is typed, while the dialog loads the same document again', async () => {
    await withReader('refresh-typing', async ({ library, session, page }) => {
      const reload = await typingWhenThePageArrives(library, session, page);
      const during = await screenNow(session);
      assert.ok(during.includes('添加术语 (1/2)'), `the add field is still there\n${during}`);
      assert.ok(!during.includes('正在加载术语表'), `nothing is covered by a spinner\n${during}`);
      session.tty.send('FSRS');
      await wait(session, (s) => s.includes('术语原文: FSRS'), 'typed during the reload');
      reload.release();
      const after = await screenNow(session);
      assert.ok(after.includes('术语原文: FSRS'), `and it is still typed afterwards\n${after}`);
    });
  });

  test('an answer read before a save does not put the old list back', async () => {
    await withReader('refresh-then-save', async ({ library, session, page }) => {
      const reload = await typingWhenThePageArrives(library, session, page);
      session.tty.send('FSRS');
      await wait(session, (s) => s.includes('术语原文: FSRS'), 'the term');
      session.tty.send('\r');
      await wait(session, (s) => s.includes('添加术语 (2/2)'), 'step 2');
      session.tty.send('间隔重复');
      await wait(session, (s) => s.includes('译法(空=原样): 间隔重复'), 'the translation');
      session.tty.send('\r');
      await wait(session, (s) => s.includes('FSRS → 间隔重复') && !s.includes('正在保存更改'), 'saved while the old answer is still held');
      reload.release();
      const after = await screenNow(session);
      assert.ok(after.includes('FSRS → 间隔重复') && after.includes('共 1 条术语'), `the saved term stays on screen\n${after}`);
      assert.deepEqual((await library.stored()).value.glossary, [{ term: 'FSRS', to: '间隔重复' }]);
    });
  });

  test('a reload that fails keeps what is on screen and says why', async () => {
    await withReader('refresh-fails', async ({ library, session, page }) => {
      session.tty.send('G');
      await wait(session, (s) => s.includes('术语表为空'), 'the dialog loaded before the page');
      session.tty.send('a');
      await wait(session, (s) => s.includes('添加术语 (1/2)'), 'the add field');
      library.fail(/^materials\.translation\.(glossary\.get|list)$/, '模拟的读取失败');
      page.release();
      await wait(session, () => useTuiStore.getState().toasts.some((toast) => toast.text.includes('模拟的读取失败')), 'the failure is said');
      const after = await screenNow(session);
      assert.ok(after.includes('添加术语 (1/2)') && !after.includes('加载失败'), `the dialog keeps what it showed\n${after}`);
    });
  });

  test('before the first load there is nothing to type into, so a does not open an unseen field', async () => {
    await withReader('first-load', async ({ session, prepared: first }) => {
      session.tty.send('G');
      const loading = await wait(session, (s) => s.includes('正在加载术语表'), 'the first load is on its way');
      assert.ok(!/\ba\s+添加/.test(loading), `a is not offered yet\n${loading}`);
      session.tty.send('a');
      await session.tty.flush(150);
      first.release();
      await wait(session, (s) => s.includes('术语表为空'), 'loaded');
      const loaded = await screenNow(session);
      assert.ok(!loaded.includes('添加术语 (1/2)'), `the key pressed during the spinner opened nothing\n${loaded}`);
      session.tty.send('a');
      await wait(session, (s) => s.includes('添加术语 (1/2)'), 'a works once the list is shown');
    }, { holdPage: false, before: (library) => library.hold(GLOSSARY) });
  });
});
