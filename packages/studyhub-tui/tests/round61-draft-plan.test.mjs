// Round 61 Track 2: DraftEditor [V] Publish Preflight dry-run modal (`draft.publish.plan`):
// `node --test tests/round61-draft-plan.test.mjs`
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
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
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-round61-${label}-`));
  tempDirs.push(d);
  return d;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const UNICODE_UI_CHROME_RE = /[\u2500-\u257F\u2580-\u259F\u25A0-\u25FF\u2600-\u27BF\u2800-\u28FF\u2190-\u21FF\u2022\u2026\u2039\u203A]/g;

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

  function send(data) {
    stdin.write(data);
  }

  async function waitFor(predicate, { timeoutMs = 10_000, label = 'condition' } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await flush();
      const screen = readScreen();
      if (predicate(screen)) return screen;
      await sleep(30);
    }
    const finalScreen = readScreen();
    throw new Error(`Timed out waiting for ${label} after ${timeoutMs}ms.\n--- SCREEN ---\n${finalScreen}\n--------------`);
  }

  function assertHealthyScreen(screen, expectedCols, expectedRows, label) {
    const lines = screen.split('\n');
    assert.ok(lines.length <= expectedRows, `${label}: row count ${lines.length} > ${expectedRows}`);
    assert.ok(!screen.includes('页面渲染异常') && !screen.includes('View Error'), `${label}: error boundary triggered`);
    assert.ok(!screen.includes('TypeError:') && !screen.includes('ReferenceError:'), `${label}: runtime JS error`);
    assert.ok(!/\bNaN\b/.test(screen), `${label}: raw NaN leaked`);
    assert.ok(!/\bundefined\b/.test(screen), `${label}: raw undefined leaked`);
    assert.ok(!screen.includes('[object Object]'), `${label}: raw [object Object] leaked`);
    assert.ok(!screen.includes('\uFFFD'), `${label}: replacement char U+FFFD leaked`);
    for (let i = 0; i < lines.length; i += 1) {
      const w = R.displayWidth(lines[i]);
      assert.ok(w <= expectedCols, `${label}: row ${i} width ${w} > ${expectedCols}: ${JSON.stringify(lines[i])}`);
    }
  }

  function assertAsciiPure(screen, label) {
    const matches = screen.match(UNICODE_UI_CHROME_RE);
    assert.ok(!matches, `${label}: leaked non-ASCII UI chrome: ${JSON.stringify([...new Set(matches || [])])}\n${screen}`);
  }

  return {
    stdin,
    stdout,
    stderr,
    firstFramePromise,
    flush,
    readScreen,
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

const SOURCE_ID = 'src-r61-algo';
const SOURCE_QUOTE_1 = 'Binary search halves the sorted search interval at every midpoint comparison, achieving O(log n) worst-case time.';
const SOURCE_QUOTE_2 = 'Contiguous arrays compute element addresses via base plus index times stride in O(1), while singly linked lists traverse pointers in O(n).';

function makeValidDraftDeck(id = 'draft-r61-plan', title = 'Algorithms Preflight Draft') {
  return {
    id,
    title,
    course: 'CS101',
    cards: [
      {
        id: 'card-r61-1',
        kind: 'open',
        topic: 'Binary Search',
        objective: 'Explain why binary search runs in O(log n) worst-case time',
        prompt: 'Why does binary search achieve O(log n) worst-case time complexity on a sorted array?',
        answer: 'Each midpoint comparison halves the remaining search interval, requiring at most ceil(log2(n + 1)) steps.',
        hint: 'Consider how the search interval size shrinks after each comparison.',
        explanation: 'Because the array is sorted, comparing with the midpoint eliminates half the remaining elements per step.',
        misconception: 'Assuming binary search works on an unsorted array without sorting first.',
        rubric: 'Must state that the array is sorted and each comparison halves the search space.',
        citations: [{ sourceId: SOURCE_ID, quote: SOURCE_QUOTE_1 }],
      },
      {
        id: 'card-r61-2',
        kind: 'open',
        topic: 'Linked Lists',
        objective: 'Compare random access complexity in arrays versus singly linked lists',
        prompt: 'Why is random access O(1) in a contiguous array yet O(n) in a singly linked list?',
        answer: 'Arrays compute element addresses via base + index * stride, whereas linked lists traverse pointers from the head.',
        hint: 'Compare contiguous memory layout against pointer traversal.',
        explanation: 'Contiguous memory allows direct offset arithmetic; linked list nodes must be visited sequentially.',
        misconception: 'Believing linked lists support constant-time offset indexing.',
        rubric: 'Must contrast direct offset arithmetic in arrays with sequential pointer traversal in linked lists.',
        citations: [{ sourceId: SOURCE_ID, quote: SOURCE_QUOTE_2 }],
      },
    ],
  };
}

describe('Round 61 Track 2: DraftEditor [V] Publish Preflight Modal (draft.publish.plan)', () => {
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

  async function mountApp({ initialPage = 'library', asciiMode = false, language = 'zh', cols = 120, rows = 36 } = {}) {
    await unmountActiveApp();
    await H.saveTuiPreferences({ language, asciiMode }, { env: { DSH_HOME: dshHome } });
    host.setLanguage(language);
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

  before(async () => {
    boxDir = await makeTempDir('main');
    dshHome = join(boxDir, 'dsh-home');
    libraryRoot = join(boxDir, 'library');
    await mkdir(libraryRoot, { recursive: true });
    process.env.DSH_HOME = dshHome;

    host = await H.createTuiHost({
      env: { DSH_HOME: dshHome },
      home: join(boxDir, 'home'),
      libraryRoot,
      skipAutoProbe: true,
      language: 'zh',
      eventDebounceMs: 30,
      injectedComplete: async () => {
        modelCalls += 1;
        return '{}';
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

  test('1) createTuiHost integration: draft.save -> draft.publish.plan (quick: true) is strict dry-run with 0 model calls', async () => {
    modelCalls = 0;
    const srcRes = await host.call('source.add', {
      id: SOURCE_ID,
      title: 'CS101 Lecture Notes',
      courses: ['CS101'],
      text: `${SOURCE_QUOTE_1}\n\n${SOURCE_QUOTE_2}`,
    });
    assert.equal(srcRes.ok, true, srcRes.error?.message);

    const saved = await host.call('draft.save', {
      deck: makeValidDraftDeck('draft-r61-plan', 'Algorithms Preflight Draft'),
    });
    assert.equal(saved.ok, true, saved.error?.message);
    const savedDraft = saved.value;
    assert.equal(savedDraft.id, 'draft-r61-plan');

    const beforeSnap = await host.call('snapshot');
    assert.equal(beforeSnap.ok, true, beforeSnap.error?.message);
    const deckCountBefore = (beforeSnap.value.decks ?? []).length;
    const draftCountBefore = (beforeSnap.value.drafts ?? []).length;
    assert.ok(draftCountBefore >= 1, 'saved draft should be present in snapshot');

    const planRes = await host.call('draft.publish.plan', {
      id: savedDraft.id,
      draftVersion: savedDraft.draftVersion,
      quick: true,
    });
    assert.equal(planRes.ok, true, planRes.error?.message);
    assert.equal(planRes.value.expect.draftId, savedDraft.id);
    assert.equal(planRes.value.expect.before, null);
    assert.equal(planRes.value.expect.remaining, null);
    assert.equal(planRes.value.expect.receipt.accepted, 2);
    assert.equal(planRes.value.expect.receipt.added, 2);
    assert.equal(planRes.value.expect.receipt.rejected, 0);
    assert.equal(planRes.value.expect.receipt.total, 2);
    assert.equal(modelCalls, 0, 'draft.publish.plan (quick: true) must make 0 model calls');

    // Verify stale draftVersion returns error cleanly
    const stalePlan = await host.call('draft.publish.plan', {
      id: savedDraft.id,
      draftVersion: (savedDraft.draftVersion ?? 0) + 99,
      quick: true,
    });
    assert.equal(stalePlan.ok, false, 'stale draftVersion must fail validation cleanly');
    assert.ok(stalePlan.error?.message, 'stale error must carry message');
    assert.equal(modelCalls, 0);

    // Verify library snapshot STILL has 0 newly published decks and draft remains intact
    const afterSnap = await host.call('snapshot');
    assert.equal(afterSnap.ok, true, afterSnap.error?.message);
    assert.equal((afterSnap.value.decks ?? []).length, deckCountBefore, 'dry-run must NOT mutate decks');
    assert.equal((afterSnap.value.drafts ?? []).length, draftCountBefore, 'dry-run must keep draft in drafts');
    assert.ok((afterSnap.value.drafts ?? []).some((d) => d.id === savedDraft.id));
  });

  test('2) PTY E2E (120x36 zh): GenerateView (4) -> Drafts (Tab) -> [V] preflight -> [r] refresh -> [p] confirm -> [n] cancel', async () => {
    modelCalls = 0;
    const snapBefore = await host.call('snapshot');
    assert.equal(snapBefore.ok, true, snapBefore.error?.message);
    const deckCountBefore = (snapBefore.value.decks ?? []).length;

    const tty = await mountApp({ initialPage: 'library', asciiMode: false, language: 'zh', cols: 120, rows: 36 });
    await tty.waitFor((s) => s.includes('学习库') || s.includes('Library'), {
      timeoutMs: 8_000,
      label: 'Initial Library view rendered (zh)',
    });

    // Navigate to GenerateView ('3')
    tty.send('3');
    await tty.waitFor((s) => s.includes('新建出题任务') && s.includes('草稿箱'), {
      timeoutMs: 8_000,
      label: 'GenerateView rendered via 3 (zh)',
    });

    // Switch to Drafts tab ('Tab')
    tty.send('\t');
    const draftsScreen = await tty.waitFor(
      (s) => s.includes('Algorithms Preflight Draft') && s.includes('预检'),
      { timeoutMs: 8_000, label: 'DraftEditor loaded in Drafts tab (120x36 zh)' },
    );
    tty.assertHealthyScreen(draftsScreen, 120, 36, 'DraftEditor 120x36 zh');
    assert.equal(modelCalls, 0, 'opening Drafts tab must trigger 0 model calls');

    // Press 'V' to open Publish Preflight modal
    tty.send('V');
    const planScreen = await tty.waitFor(
      (s) =>
        s.includes('发布预检') &&
        s.includes('新建题组') &&
        s.includes('通过 (accepted): 2') &&
        s.includes('拦截 (rejected): 0') &&
        s.includes('新增 (added): 2'),
      { timeoutMs: 8_000, label: 'Publish Preflight modal displays receipt counts (120x36 zh)' },
    );
    tty.assertHealthyScreen(planScreen, 120, 36, 'PublishPreflightModal 120x36 zh');
    assert.equal(modelCalls, 0, 'pressing [V] must trigger 0 model calls');

    // Press 'r' to re-run dry-run preflight
    tty.send('r');
    const refreshedScreen = await tty.waitFor(
      (s) =>
        s.includes('发布预检') &&
        s.includes('通过 (accepted): 2') &&
        s.includes('发布后总计 (total): 2'),
      { timeoutMs: 8_000, label: 'Publish Preflight modal refreshed via [r] (120x36 zh)' },
    );
    tty.assertHealthyScreen(refreshedScreen, 120, 36, 'PublishPreflightModal refreshed 120x36 zh');
    assert.equal(modelCalls, 0, 'refreshing preflight with [r] must trigger 0 model calls');

    // Press 'p' to transition to publish-confirm overlay
    tty.send('p');
    const confirmScreen = await tty.waitFor(
      (s) => s.includes('发布草稿到题组') && s.includes('立即发布'),
      { timeoutMs: 8_000, label: 'Transitioned to publish-confirm dialog via [p] (120x36 zh)' },
    );
    tty.assertHealthyScreen(confirmScreen, 120, 36, 'PublishConfirmDialog 120x36 zh');

    // Cancel with 'n'
    tty.send('n');
    const afterCancelScreen = await tty.waitFor(
      (s) => !s.includes('发布草稿到题组') && !s.includes('发布预检') && s.includes('Algorithms Preflight Draft'),
      { timeoutMs: 8_000, label: 'Cancelled publish-confirm cleanly with [n] (120x36 zh)' },
    );
    tty.assertHealthyScreen(afterCancelScreen, 120, 36, 'DraftEditor after cancel 120x36 zh');
    assert.equal(modelCalls, 0, 'cancelling confirm must trigger 0 model calls');

    // Verify draft is still unpublished
    const snapAfter = await host.call('snapshot');
    assert.equal(snapAfter.ok, true, snapAfter.error?.message);
    assert.equal((snapAfter.value.decks ?? []).length, deckCountBefore, 'library decks count must remain unchanged');
    assert.ok((snapAfter.value.drafts ?? []).some((d) => d.id === 'draft-r61-plan'), 'draft must remain unpublished');
  });

  test('3) PTY E2E (80x24 --ascii en): Drafts -> [V] preflight pure ASCII & responsive -> Esc closes cleanly', async () => {
    modelCalls = 0;
    const tty = await mountApp({ initialPage: 'library', asciiMode: true, language: 'en', cols: 80, rows: 24 });
    await tty.waitFor((s) => s.includes('Library') || s.includes('Courses'), {
      timeoutMs: 8_000,
      label: 'Initial Library view rendered (en --ascii)',
    });

    // Navigate to GenerateView ('3') and switch to Drafts ('Tab')
    tty.send('3');
    await tty.waitFor((s) => s.includes('New Generation') && s.includes('Drafts'), {
      timeoutMs: 8_000,
      label: 'GenerateView rendered via 3 (80x24 en --ascii)',
    });

    tty.send('\t');
    const draftsScreen = await tty.waitFor(
      (s) => s.includes('Algorithms Preflight Draft') && s.includes('Plan'),
      { timeoutMs: 8_000, label: 'DraftEditor rendered in Drafts tab (80x24 en --ascii)' },
    );
    tty.assertHealthyScreen(draftsScreen, 80, 24, 'DraftEditor 80x24 en --ascii');
    tty.assertAsciiPure(draftsScreen, 'DraftEditor 80x24 en --ascii');

    // Press 'V' to open Publish Preflight modal
    tty.send('V');
    const planScreen = await tty.waitFor(
      (s) =>
        s.includes('Publish Preflight') &&
        s.includes('New deck') &&
        s.includes('Accepted: 2') &&
        s.includes('Rejected: 0') &&
        s.includes('Added: 2'),
      { timeoutMs: 8_000, label: 'Publish Preflight modal rendered (80x24 en --ascii)' },
    );
    tty.assertHealthyScreen(planScreen, 80, 24, 'PublishPreflightModal 80x24 en --ascii');
    tty.assertAsciiPure(planScreen, 'PublishPreflightModal 80x24 en --ascii');
    assert.equal(modelCalls, 0);

    // Press Esc to close modal cleanly
    tty.send('\x1b');
    const closedScreen = await tty.waitFor(
      (s) => !s.includes('Publish Preflight') && s.includes('Algorithms Preflight Draft'),
      { timeoutMs: 5_000, label: 'Publish Preflight modal closed via Esc (80x24 en --ascii)' },
    );
    tty.assertHealthyScreen(closedScreen, 80, 24, 'DraftEditor after Esc 80x24 en --ascii');
    tty.assertAsciiPure(closedScreen, 'DraftEditor after Esc 80x24 en --ascii');
    assert.equal(modelCalls, 0);
  });
});
