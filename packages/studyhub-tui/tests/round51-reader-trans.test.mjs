// Round 51 DocumentReader Page Translation (target zh|en fix, cache-first list, P2 ConfirmDialog quota guard, cancel):
// `node --test tests/round51-reader-trans.test.mjs`
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import xtermPkg from '@xterm/headless';
import { render } from 'ink';
import React from 'react';

const { Terminal } = xtermPkg;
const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const distDir = resolve(pkgRoot, 'dist');

const distFiles = (await readdir(distDir)).filter((f) => f.endsWith('.mjs') && f !== 'cli.mjs');
const { StudyHubTuiApp } = await import(pathToFileURL(join(distDir, 'App.mjs')).href);

let H = null;
let R = null;
for (const f of distFiles) {
  if (f === 'host.mjs' || f.startsWith('host-') || f.startsWith('tui-') || f.startsWith('chunk-')) {
    const mod = await import(pathToFileURL(join(distDir, f)).href);
    if (!H && typeof mod.createTuiHost === 'function' && typeof mod.saveTuiPreferences === 'function') H = mod;
    if (!R && typeof mod.displayWidth === 'function') R = mod;
  }
}
assert.ok(H?.createTuiHost, 'dist/ must export createTuiHost');
assert.ok(H?.saveTuiPreferences, 'dist/ must export saveTuiPreferences');
assert.ok(R?.displayWidth, 'dist/ must export displayWidth');

const PREV_DSH_HOME = process.env.DSH_HOME;
const tempDirs = [];
async function makeTempDir(label) {
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-round51-reader-trans-${label}-`));
  tempDirs.push(d);
  return d;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const UNICODE_BOX_RE = /[\u2500-\u257f]/g;
const UNICODE_BLOCK_RE = /[\u2580-\u259f]/g;
const UNICODE_BRAILLE_RE = /[\u2800-\u28ff]/g;
const FORBIDDEN_ASCII_CHROME_RE = /[›…✓✕↑↓←→•★⚑⚠☑☐●○◆▸▾☰✎]/g;

function createVirtualTty(cols = 120, rows = 36) {
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;

  const stdout = new PassThrough();
  stdout.isTTY = true;
  stdout.columns = cols;
  stdout.rows = rows;
  stdout.getColorDepth = () => 24;

  const stderr = new PassThrough();
  stderr.isTTY = true;
  stderr.columns = cols;
  stderr.rows = rows;

  const term = new Terminal({
    cols,
    rows,
    allowProposedApi: true,
    convertEol: true,
  });

  let pendingWrites = Promise.resolve();
  let firstFrameResolve = null;
  let firstFrameSettled = false;
  const firstFramePromise = new Promise((resolveFn) => {
    firstFrameResolve = resolveFn;
  });

  stdout.on('data', (chunk) => {
    const str = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    pendingWrites = pendingWrites.then(
      () =>
        new Promise((resolveWrite) => {
          term.write(str, () => {
            if (!firstFrameSettled) {
              firstFrameSettled = true;
              firstFrameResolve?.();
            }
            resolveWrite();
          });
        }),
    );
  });

  async function flush() {
    await sleep(30);
    await pendingWrites;
  }

  function readLines() {
    const buf = term.buffer.active;
    const lines = [];
    for (let y = 0; y < term.rows; y += 1) {
      const line = buf.getLine(buf.viewportY + y);
      lines.push(line ? line.translateToString(true) : '');
    }
    return lines;
  }

  function readScreen() {
    return readLines().join('\n');
  }

  function resize(newCols, newRows) {
    stdout.columns = newCols;
    stdout.rows = newRows;
    stderr.columns = newCols;
    stderr.rows = newRows;
    term.resize(newCols, newRows);
    stdout.emit('resize');
  }

  function send(data) {
    stdin.write(data);
  }

  async function waitFor(predicate, { timeoutMs = 8_000, label = 'condition' } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await flush();
      const screen = readScreen();
      if (predicate(screen)) return screen;
      await sleep(35);
    }
    const finalScreen = readScreen();
    throw new Error(`Timed out waiting for ${label} after ${timeoutMs}ms.\n--- SCREEN ---\n${finalScreen}\n--------------`);
  }

  function assertHealthyScreen(screen, expectedCols, expectedRows, contextLabel) {
    const lines = screen.split('\n');
    assert.ok(
      !screen.includes('页面渲染异常') && !screen.includes('View Error'),
      `${contextLabel}: ViewErrorBoundary triggered!\n${screen}`,
    );
    assert.ok(
      !screen.includes('TypeError:') && !screen.includes('ReferenceError:'),
      `${contextLabel}: Runtime JS error rendered!\n${screen}`,
    );
    assert.ok(!screen.includes('\uFFFD'), `${contextLabel}: Replacement char U+FFFD found!\n${screen}`);
    assert.ok(
      !screen.includes('\x1b'),
      `${contextLabel}: Unparsed escape sequence leaked into xterm buffer!\n${screen}`,
    );
    assert.ok(
      lines.length <= expectedRows,
      `${contextLabel}: Screen rows exceeded (${lines.length} > ${expectedRows})`,
    );
    for (let i = 0; i < lines.length; i += 1) {
      const w = R.displayWidth(lines[i]);
      assert.ok(
        w <= expectedCols,
        `${contextLabel}: Row ${i} exceeds cols (${w} > ${expectedCols}): ${JSON.stringify(lines[i])}`,
      );
    }
    const buf = term.buffer.active;
    for (let y = 0; y < term.rows; y += 1) {
      const line = buf.getLine(buf.viewportY + y);
      if (line) {
        assert.equal(
          line.isWrapped,
          false,
          `${contextLabel}: xterm soft-wrapped row ${y}: ${JSON.stringify(line.translateToString(true))}`,
        );
      }
    }
  }

  function assertAsciiPure(screen, contextLabel) {
    for (const [label, re] of [
      ['box-drawing', UNICODE_BOX_RE],
      ['block-element', UNICODE_BLOCK_RE],
      ['braille', UNICODE_BRAILLE_RE],
      ['unicode-chrome', FORBIDDEN_ASCII_CHROME_RE],
    ]) {
      const match = screen.match(re);
      assert.equal(
        match,
        null,
        `${contextLabel}: ${label} leaked in --ascii mode: ${JSON.stringify(match ? [...new Set(match)] : [])}\n${screen}`,
      );
    }
  }

  return {
    stdin,
    stdout,
    stderr,
    term,
    firstFramePromise,
    flush,
    readLines,
    readScreen,
    resize,
    send,
    waitFor,
    assertHealthyScreen,
    assertAsciiPure,
    dispose: () => {
      term.dispose();
      stdin.destroy();
      stdout.destroy();
      stderr.destroy();
    },
  };
}

describe('StudyHub TUI Round 51 DocumentReader Persistent Bilingual Translation', () => {
  let boxDir;
  let dshHome;
  let libraryRoot;
  let host;
  let modelCalls = 0;
  let activeTty = null;
  let activeInk = null;
  let disposed = false;

  async function unmountActiveApp() {
    const ink = activeInk;
    const tty = activeTty;
    activeInk = null;
    activeTty = null;
    try {
      ink?.unmount();
    } catch {
      // Ignore unmount errors during test teardown
    }
    tty?.dispose();
  }

  async function mountApp({ initialPage = 'sources', asciiMode = false, language = 'zh', cols = 120, rows = 36 } = {}) {
    await unmountActiveApp();
    await H.saveTuiPreferences({ language, asciiMode }, { env: { DSH_HOME: dshHome } });
    const tty = createVirtualTty(cols, rows);
    let inkInstance = null;
    inkInstance = render(
      React.createElement(StudyHubTuiApp, {
        host,
        initialPage,
        initialLanguage: language,
        initialAsciiMode: asciiMode,
        autoLaunchpad: false,
        onExit: () => inkInstance?.unmount(),
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
    activeTty = tty;
    activeInk = inkInstance;
    await tty.firstFramePromise;
    return tty;
  }

  async function openSourceInReader(tty, titleNeedle, expectedBodyNeedle) {
    await tty.waitFor(
      (s) => s.includes(titleNeedle) && !s.includes('正在加载页面') && !s.includes('Loading page'),
      { timeoutMs: 10_000, label: `SourcesView showing ${titleNeedle}` },
    );

    tty.send('/');
    await tty.flush();
    tty.send(titleNeedle);
    await tty.waitFor(
      (s) =>
        s.includes(`Filter: ${titleNeedle}`) ||
        s.includes(`筛选资料: ${titleNeedle}`) ||
        s.includes(`搜索: ${titleNeedle}`),
      {
        timeoutMs: 5_000,
        label: `Filtered to ${titleNeedle}`,
      },
    );
    tty.send('\r');
    await sleep(60);
    await tty.flush();
    tty.send('\r');

    await tty.waitFor(
      (s) =>
        s.includes(titleNeedle) &&
        s.includes(expectedBodyNeedle) &&
        (s.includes('问本页') || s.includes('Ask') || s.includes('术语译文') || s.includes('Glossary')),
      { timeoutMs: 10_000, label: `DocumentReader opened for ${titleNeedle}` },
    );
    await sleep(80);
    await tty.flush();
  }

  before(async () => {
    boxDir = await makeTempDir('main');
    dshHome = join(boxDir, 'dsh-home');
    libraryRoot = join(boxDir, 'library');
    process.env.DSH_HOME = dshHome;

    host = await H.createTuiHost({
      env: { DSH_HOME: dshHome },
      home: join(boxDir, 'home'),
      libraryRoot,
      skipAutoProbe: true,
      language: 'zh',
      eventDebounceMs: 30,
      injectedComplete: async (_system, prompt) => {
        modelCalls += 1;
        let parsed = null;
        try {
          parsed = JSON.parse(String(prompt));
        } catch {
          parsed = null;
        }
        const passages = Array.isArray(parsed?.passages) ? parsed.passages : [];
        const target = String(parsed?.target || '');
        const isEn = target.toLowerCase().includes('english');
        return JSON.stringify({
          translations: passages.map((p, idx) => ({
            id: p.id || `p${idx}`,
            text: isEn
              ? `Translated English passage ${idx + 1}: gradient descent updates parameters iteratively.`
              : `中文译文第 ${idx + 1} 段：反向传播通过计算图精确传播梯度。`,
          })),
        });
      },
    });
  });

  after(async () => {
    if (disposed) return;
    disposed = true;
    try {
      await unmountActiveApp();
      await host?.dispose();
    } finally {
      if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = PREV_DSH_HOME;
      await Promise.all(
        tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })),
      );
    }
  });

  test('1) Host integration: estimate:true (0 model calls) -> translation.save -> list (quote/text/target) -> translate reuses cache (0 model calls)', async () => {
    modelCalls = 0;
    const headingText = '# Neural Networks';
    const bodyText = 'Backpropagation computes exact gradients through layered computational graphs.';

    const added = await host.call('source.add', {
      title: 'R51 Host Translation Doc',
      format: 'md',
      text: `${headingText}\n\n${bodyText}\n`,
    });
    assert.equal(added.ok, true, `source.add failed: ${added.error?.message || ''}`);
    const sourceId = added.value.id;
    assert.ok(sourceId, 'source.add must return id');

    const estRes = await host.call('materials.translation.translate', {
      sourceId,
      scope: { sourceIds: [sourceId] },
      target: 'zh',
      estimate: true,
    });
    assert.equal(estRes.ok, true, `estimate failed: ${estRes.error?.message || ''}`);
    assert.equal(estRes.value.status, 'estimate');
    assert.equal(estRes.value.target, 'zh');
    assert.ok(estRes.value.counts.toTranslate > 0, 'expected counts.toTranslate > 0');
    assert.equal(modelCalls, 0, 'estimate:true must make 0 model calls');

    const saveRes = await host.call('materials.translation.save', {
      sourceId,
      target: 'zh',
      passages: [
        { sourceId, text: headingText, translation: '# 神经网络' },
        { sourceId, text: bodyText, translation: '反向传播通过分层计算图精确计算梯度。' },
      ],
    });
    assert.equal(saveRes.ok, true, `translation.save failed: ${saveRes.error?.message || ''}`);
    assert.equal(saveRes.value.saved, 2);

    const listRes = await host.call('materials.translation.list', {
      sourceId,
      target: 'zh',
    });
    assert.equal(listRes.ok, true, `translation.list failed: ${listRes.error?.message || ''}`);
    assert.equal(listRes.value.target, 'zh');
    assert.equal(listRes.value.items.length, 2);
    const bodyItem = listRes.value.items.find((it) => it.text === '反向传播通过分层计算图精确计算梯度。');
    assert.ok(bodyItem, 'translation.list must return saved item text');
    assert.ok(typeof bodyItem.quote === 'string' && bodyItem.quote.includes('Backpropagation'), 'item must include quote');
    assert.equal(bodyItem.target, 'zh');
    assert.equal(modelCalls, 0, 'translation.list must make 0 model calls');

    const reuseRes = await host.call('materials.translation.translate', {
      sourceId,
      scope: { sourceIds: [sourceId] },
      target: 'zh',
    });
    assert.equal(reuseRes.ok, true, `cached translate failed: ${reuseRes.error?.message || ''}`);
    assert.equal(reuseRes.value.status, 'done');
    assert.equal(reuseRes.value.counts.toTranslate, 0);
    assert.equal(reuseRes.value.counts.cached, 2);
    assert.equal(modelCalls, 0, 'fully cached materials.translation.translate must make 0 model calls');
  });

  test('2a) @xterm/headless E2E (zh 120x36 & 80x24): uncached page [t] opens P2 ConfirmDialog (0 model calls) -> [n] cancels cleanly -> [t]+[y] translates & persists', async () => {
    modelCalls = 0;
    const title = 'R51 Uncached Zh Doc';
    const body = 'Attention mechanisms weigh token relevance across sequence positions dynamically.';

    const added = await host.call('source.add', {
      title,
      format: 'md',
      text: `${body}\n`,
    });
    assert.equal(added.ok, true);

    const tty = await mountApp({ initialPage: 'sources', asciiMode: false, language: 'zh', cols: 120, rows: 36 });
    await openSourceInReader(tty, title, 'Attention mechanisms');

    // Press 't' -> P2 ConfirmDialog must open with estimate info and 0 model calls
    tty.send('t');
    const confirmScreen120 = await tty.waitFor(
      (s) =>
        s.includes('确认翻译本页') &&
        s.includes('待翻译 1 段') &&
        s.includes('预计调用') &&
        s.includes('预计用量'),
      { timeoutMs: 8_000, label: 'P2 ConfirmDialog opened at 120x36' },
    );
    tty.assertHealthyScreen(confirmScreen120, 120, 36, 'ConfirmDialog 120x36 (zh)');
    assert.equal(modelCalls, 0, 'opening ConfirmDialog via [t] must invoke 0 model calls');

    // Verify ConfirmDialog also renders cleanly at 80x24
    tty.resize(80, 24);
    const confirmScreen80 = await tty.waitFor(
      (s) => s.includes('确认翻译本页') && s.includes('待翻译 1 段'),
      { timeoutMs: 5_000, label: 'P2 ConfirmDialog at 80x24' },
    );
    tty.assertHealthyScreen(confirmScreen80, 80, 24, 'ConfirmDialog 80x24 (zh)');

    // Press 'n' -> cancels cleanly back to DocumentReader with 0 model calls
    tty.send('n');
    const cancelledScreen = await tty.waitFor(
      (s) => !s.includes('确认翻译本页') && s.includes('Attention mechanisms'),
      { timeoutMs: 5_000, label: 'ConfirmDialog cancelled cleanly' },
    );
    tty.assertHealthyScreen(cancelledScreen, 80, 24, 'After cancel ConfirmDialog 80x24');
    assert.equal(modelCalls, 0, 'cancelling ConfirmDialog with [n] must invoke 0 model calls');

    // Restore 120x36 and confirm translation flow end-to-end
    tty.resize(120, 36);
    tty.send('t');
    await tty.waitFor((s) => s.includes('确认翻译本页'), { timeoutMs: 5_000, label: 'ConfirmDialog reopened' });
    assert.equal(modelCalls, 0, 'reopening ConfirmDialog still 0 model calls');

    tty.send('y');
    const translatedScreen = await tty.waitFor(
      (s) =>
        s.includes('双语对照翻译') &&
        s.includes('已译 1 段') &&
        s.includes('中文译文第 1 段') &&
        s.includes('Attention mechanisms'),
      { timeoutMs: 8_000, label: 'translate-view rendered model output' },
    );
    tty.assertHealthyScreen(translatedScreen, 120, 36, 'translate-view after confirm (zh)');
    assert.equal(modelCalls, 1, 'confirmed translation must invoke model once');

    // Esc back to reader, then re-press 't' -> cache hit (0 additional model calls)
    tty.send('\x1b');
    await tty.waitFor((s) => !s.includes('双语对照翻译'), { timeoutMs: 5_000, label: 'Exited translate-view' });

    tty.send('t');
    const cachedReopen = await tty.waitFor(
      (s) => s.includes('已缓存 1 段') && s.includes('中文译文第 1 段'),
      { timeoutMs: 8_000, label: 'Re-pressing [t] hits cache immediately' },
    );
    tty.assertHealthyScreen(cachedReopen, 120, 36, 'translate-view cached reopen');
    assert.equal(modelCalls, 1, 'reopening cached page must make 0 additional model calls');
  });

  test('2b) @xterm/headless E2E (--ascii en 120x36 & 80x24): pre-cached page [t] opens translate-view immediately with 0 model calls & 0 non-ASCII chrome', async () => {
    modelCalls = 0;
    const title = 'R51 PreCached Ascii Doc';
    const zhPassage = '梯度下降法通过迭代更新参数以最小化损失函数。';
    const enTranslation = 'Gradient descent iteratively updates parameters to minimize the loss function.';

    const added = await host.call('source.add', {
      title,
      format: 'md',
      text: `${zhPassage}\n`,
    });
    assert.equal(added.ok, true);
    const sourceId = added.value.id;

    const saved = await host.call('materials.translation.save', {
      sourceId,
      target: 'en',
      passages: [{ sourceId, text: zhPassage, translation: enTranslation }],
    });
    assert.equal(saved.ok, true);

    const tty = await mountApp({ initialPage: 'sources', asciiMode: true, language: 'en', cols: 120, rows: 36 });
    await openSourceInReader(tty, title, '梯度下降法通过迭代更新参数');

    tty.send('t');
    const transScreen120 = await tty.waitFor(
      (s) =>
        s.includes('Bilingual Translation') &&
        s.includes('Cached 1 passages') &&
        s.includes('Gradient descent'),
      { timeoutMs: 8_000, label: 'Pre-cached translate-view in --ascii en at 120x36' },
    );
    tty.assertHealthyScreen(transScreen120, 120, 36, 'Pre-cached translate-view 120x36 (--ascii en)');
    tty.assertAsciiPure(transScreen120, 'Pre-cached translate-view 120x36 (--ascii en)');
    assert.equal(modelCalls, 0, 'pre-cached page must invoke 0 model calls');

    tty.resize(80, 24);
    const transScreen80 = await tty.waitFor(
      (s) =>
        s.includes('Bilingual Translation') &&
        s.includes('Cached 1 passages') &&
        s.includes('Gradient descent'),
      { timeoutMs: 5_000, label: 'Pre-cached translate-view in --ascii en at 80x24' },
    );
    tty.assertHealthyScreen(transScreen80, 80, 24, 'Pre-cached translate-view 80x24 (--ascii en)');
    tty.assertAsciiPure(transScreen80, 'Pre-cached translate-view 80x24 (--ascii en)');
    assert.equal(modelCalls, 0, 'pre-cached page resize must invoke 0 model calls');
  });
});
