// Round 60 Track 1: CoachNudgeModal (coach.nudge + coach.reply) with P2 ConfirmDialog guard
// createTuiHost integration + @xterm/headless PTY E2E tests:
// node --test --test-concurrency=1 tests/round60-coach-nudge.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import xtermPkg from '@xterm/headless';
import { render } from 'ink';
import React from 'react';

const { Terminal } = xtermPkg;
const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const distDir = resolve(pkgRoot, 'dist');

// Canonical dist chunk discovery
const distFiles = (await readdir(distDir)).filter((f) => f.endsWith('.mjs') && f !== 'cli.mjs');
const { StudyHubTuiApp } = await import(pathToFileURL(join(distDir, 'App.mjs')).href);

let H = null;
let R = null;
let S = null;
for (const f of distFiles) {
  if (f === 'host.mjs' || f.startsWith('host-') || f.startsWith('tui-') || f.startsWith('chunk-')) {
    const mod = await import(pathToFileURL(join(distDir, f)).href);
    if (!H && typeof mod.createTuiHost === 'function' && typeof mod.saveTuiPreferences === 'function') H = mod;
    if (!R && typeof mod.displayWidth === 'function') R = mod;
    if (!S && mod.useTuiStore?.getState && mod.DEFAULT_PREFERENCES) S = mod;
  }
}
assert.ok(H?.createTuiHost, 'dist/ must export createTuiHost');
assert.ok(H?.saveTuiPreferences, 'dist/ must export saveTuiPreferences');
assert.ok(R?.displayWidth, 'dist/ must export displayWidth');
assert.ok(S?.useTuiStore, 'dist/ must export useTuiStore');
assert.ok(S?.DEFAULT_PREFERENCES, 'dist/ must export DEFAULT_PREFERENCES');

const coachChunk = distFiles.find((f) => f.startsWith('CoachNudgeModal-'));
assert.ok(coachChunk, `dist/ must emit lazy CoachNudgeModal-*.mjs chunk, found: ${distFiles.join(', ')}`);
const coachChunkCode = fs.readFileSync(join(distDir, coachChunk), 'utf8');
assert.equal(/\bmarked\b/.test(coachChunkCode), false, `${coachChunk} must be marked-free`);

const { createTuiHost, saveTuiPreferences } = H;
const { displayWidth } = R;
const { useTuiStore: useDistTuiStore, DEFAULT_PREFERENCES } = S;

const PREV_DSH_HOME = process.env.DSH_HOME;
const tempDirs = [];
async function makeTempDir(label) {
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-round60-${label}-`));
  tempDirs.push(d);
  return d;
}

const RESOURCE_KINDS = new Set(['FSEventWrap', 'StatWatcher', 'Timeout', 'ProcessWrap', 'TCPWrap', 'PipeWrap']);
function resourceCounts() {
  const counts = {};
  for (const kind of process.getActiveResourcesInfo()) {
    if (RESOURCE_KINDS.has(kind)) counts[kind] = (counts[kind] || 0) + 1;
  }
  return counts;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const UNICODE_UI_CHROME_RE = /[\u2500-\u257F\u2580-\u259F\u25A0-\u25FF\u2600-\u27BF\u2800-\u28FF\u2190-\u21FF\u2022\u2026\u2039\u203A]/g;

function resetDistStore(language = 'zh', asciiMode = false, extra = {}) {
  useDistTuiStore.setState({
    page: 'library',
    navContext: {},
    history: [],
    snapshot: null,
    binding: null,
    config: null,
    loading: false,
    refreshing: false,
    toasts: [],
    footerHints: [],
    commandPaletteOpen: false,
    helpOpen: false,
    coursePickerOpen: false,
    inboxOpen: false,
    voicePackOpen: false,
    showLaunchpad: false,
    inputCaptured: false,
    activeRunId: null,
    preferences: {
      ...DEFAULT_PREFERENCES,
      language,
      asciiMode,
    },
    ...extra,
  });
}

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
      const w = displayWidth(lines[i]);
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

function fakeDiscovery() {
  const result = () => [
    { id: 'agy', supported: true, status: 'not-installed', executablePath: null, version: null, reasonCode: 'not-installed', reason: '' },
    { id: 'claude', supported: false, status: 'coming-soon', executablePath: null, version: null, reasonCode: 'coming-soon-not-installed', reason: '' },
    { id: 'codex', supported: true, status: 'not-installed', executablePath: null, version: null, reasonCode: 'not-installed', reason: '' },
  ];
  return {
    async scan() {
      return result();
    },
    getCached: () => result(),
    findReadyPath: () => '',
    findReadyAgyPath: () => '',
    findReadyCodexPath: () => '',
  };
}

function createNudgeStubComplete({ onNudge, onFollowup, lang = 'zh', includeChrome = false } = {}) {
  let followupIdx = 0;
  return async (_system, _prompt, opts = {}) => {
    const task = opts?.task || '';
    if (task === 'coach.reply') {
      followupIdx += 1;
      onFollowup?.(followupIdx);
      const chrome = includeChrome ? ' … ✓ → •' : '';
      return JSON.stringify({
        explain:
          lang === 'en'
            ? `Simpler analogy angle ${followupIdx}: think of TCP as a signed receipt before delivery${chrome}.`
            : `生活类比角度 ${followupIdx}：把 TCP 三次握手想象成双方互发回执确认收发能力${chrome}。`,
      });
    }
    onNudge?.();
    const chrome = includeChrome ? ' … ✓ → •' : '';
    return JSON.stringify(
      lang === 'en'
        ? {
            point: `TCP vs UDP reliability confusion${chrome}`,
            explain: `You picked UDP, which skips handshake and retransmission; TCP ensures ordered delivery${chrome}.`,
            check: {
              q: `Which protocol guarantees ordered byte stream delivery?${chrome}`,
              options: [`TCP with ACK${chrome}`, 'UDP datagram'],
              answer: 0,
              why: `TCP uses sequence numbers and ACKs to guarantee order${chrome}.`,
            },
          }
        : {
            point: `混淆了 TCP 与 UDP 的可靠性机制${chrome}`,
            explain: `你选了 UDP，但 UDP 无连接且不重传；TCP 通过三次握手和确认应答保障可靠有序传输${chrome}。`,
            check: {
              q: `哪种传输协议提供面向连接的可靠字节流？${chrome}`,
              options: [`TCP 协议${chrome}`, 'UDP 协议'],
              answer: 0,
              why: `TCP 通过序列号、ACK 确认与超时重传保证数据可靠到达${chrome}。`,
            },
          },
    );
  };
}

async function seedTwoCardQuizDeckAndRun(host, lang = 'zh') {
  const imp = await host.call('deck.import', {
    text: JSON.stringify({
      title: lang === 'en' ? 'Network Protocols Quiz' : '计算机网络测验',
      course: lang === 'en' ? 'Computer Networks' : '计算机网络',
      cards: [
        {
          kind: 'quiz',
          topic: lang === 'en' ? 'Transport Layer' : '传输层',
          objective: lang === 'en' ? 'Distinguish TCP and UDP' : '区分 TCP 与 UDP',
          prompt:
            lang === 'en'
              ? 'Which protocol guarantees reliable ordered delivery?'
              : '哪种协议提供可靠的面向连接字节流传输？',
          options: [
            { id: 'a', text: 'TCP', correct: true, explanation: 'TCP uses sequence numbers and ACKs.' },
            { id: 'b', text: 'UDP', correct: false, explanation: 'UDP is connectionless and unreliable.' },
            { id: 'c', text: 'ICMP', correct: false, explanation: 'ICMP is for network diagnostics.' },
          ],
          answer: 'TCP',
          hint: 'Think about handshake and ACKs.',
          explanation: 'TCP uses handshake, sequence numbers, and ACKs.',
          misconception: 'Confusing TCP with UDP.',
        },
        {
          kind: 'quiz',
          topic: lang === 'en' ? 'Application Layer' : '应用层',
          objective: lang === 'en' ? 'Know default HTTPS port' : '掌握 HTTPS 默认端口',
          prompt:
            lang === 'en'
              ? 'Which port does HTTPS use by default?'
              : 'HTTPS 默认使用哪个端口？',
          options: [
            { id: 'a', text: '443', correct: true, explanation: 'HTTPS uses TCP port 443.' },
            { id: 'b', text: '80', correct: false, explanation: 'Port 80 is HTTP.' },
            { id: 'c', text: '22', correct: false, explanation: 'Port 22 is SSH.' },
          ],
          answer: '443',
          hint: 'Not port 80.',
          explanation: 'HTTPS defaults to port 443.',
          misconception: 'Confusing HTTP port 80 with HTTPS port 443.',
        },
      ],
    }),
  });
  assert.equal(imp.ok, true, `deck.import failed: ${imp.error?.message}`);
  assert.equal(imp.value?.imported, 1, `deck.import failed: ${JSON.stringify(imp.value?.results)}`);
  const snapRes = await host.refreshSnapshot();
  const deck = (snapRes.snapshot?.decks ?? []).find((d) => !d.archived && !d.systemKind);
  assert.ok(deck, 'seeded deck must exist in snapshot');

  const startRes = await host.call('review.start', {
    mode: 'quiz',
    deckId: deck.id,
    fresh: true,
  });
  assert.equal(startRes.ok, true, `review.start failed: ${startRes.error?.message}`);
  assert.ok(startRes.value?.id, 'review.start must return a run id');
  return { deckId: deck.id, run: startRes.value };
}

after(async () => {
  if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = PREV_DSH_HOME;
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
});

function findWrongOptionKey(screen) {
  for (const line of screen.split('\n')) {
    const match = /\[([1-3])\/[a-c]\]/.exec(line);
    if (!match) continue;
    if (/\b(UDP|ICMP|80|22)\b/.test(line)) {
      return match[1];
    }
  }
  throw new Error(`Could not locate wrong option on screen:\n${screen}`);
}

describe('Round 60 Track 1: CoachNudgeModal (coach.nudge + coach.reply) with P2 ConfirmDialog Guard', () => {
  test('1) createTuiHost integration: coach.nudge + coach.reply (check / got / confused) round-trip cleanly with strict call counts', async () => {
    const base = await makeTempDir('host-int');
    let nudgeCalls = 0;
    let followupCalls = 0;
    const host = await createTuiHost({
      libraryRoot: join(base, 'library'),
      env: { ...process.env, DSH_HOME: join(base, 'dsh-home') },
      home: base,
      documentsDir: base,
      injectedComplete: createNudgeStubComplete({
        lang: 'en',
        onNudge: () => {
          nudgeCalls += 1;
        },
        onFollowup: () => {
          followupCalls += 1;
        },
      }),
      providerDiscovery: fakeDiscovery(),
      skipAutoProbe: true,
      language: 'en',
    });

    try {
      const { deckId, run } = await seedTwoCardQuizDeckAndRun(host, 'en');
      const cardId = run.card?.id || run.navigation?.[0]?.cardId;
      assert.ok(cardId, 'first card id must exist');

      // Answer first card wrong (option 'b')
      const wrongAns = await host.call('review.answer', {
        runId: run.id,
        cardId,
        selected: ['b'],
        queueVersion: run.queueVersion ?? 0,
      });
      assert.equal(wrongAns.ok, true, wrongAns.error?.message);
      assert.equal(nudgeCalls + followupCalls, 0, 'answering quiz card must make 0 coach calls');

      // First coach.nudge invokes model once
      const nudgeRes = await host.call('coach.nudge', { runId: run.id, index: 0 });
      assert.equal(nudgeRes.ok, true, nudgeRes.error?.message);
      assert.equal(nudgeCalls, 1, 'first coach.nudge must make 1 model call');
      assert.equal(followupCalls, 0);
      const note = (nudgeRes.value?.thread || []).find((n) => n.type === 'nudge' && n.runId === run.id && n.entryIndex === 0);
      assert.ok(note?.id, 'nudge note must be returned');
      assert.equal(note.point, 'TCP vs UDP reliability confusion');
      assert.ok(note.check?.q && Array.isArray(note.check.options) && note.check.options.length === 2);
      assert.equal(note.check.answer, undefined, 'unanswered check must hide answer key');

      // Second coach.nudge hits cache with 0 extra model calls
      const cachedNudge = await host.call('coach.nudge', { runId: run.id, index: 0 });
      assert.equal(cachedNudge.ok, true, cachedNudge.error?.message);
      assert.equal(nudgeCalls, 1, 'cached coach.nudge must trigger 0 extra model calls');

      // coach.reply 'check' (0 LLM calls)
      const checkRes = await host.call('coach.reply', { noteId: note.id, reply: 'check', choice: 0 });
      assert.equal(checkRes.ok, true, checkRes.error?.message);
      assert.equal(nudgeCalls, 1);
      assert.equal(followupCalls, 0, 'reply: check must make 0 model calls');
      const checkedNote = (checkRes.value?.thread || []).find((n) => n.id === note.id);
      assert.deepEqual(checkedNote?.checked, { choice: 0, correct: true });
      assert.ok(checkedNote?.check?.why, 'answered check must reveal why');

      // coach.reply 'confused' (up to 2 followups)
      const f1 = await host.call('coach.reply', { noteId: note.id, reply: 'confused' });
      assert.equal(f1.ok, true, f1.error?.message);
      assert.equal(followupCalls, 1, 'first confused reply must make 1 followup model call');
      const f1Note = (f1.value?.thread || []).find((n) => n.id === note.id);
      assert.equal(f1Note?.followups?.length, 1);
      assert.equal(f1Note?.reply, 'confused');

      const f2 = await host.call('coach.reply', { noteId: note.id, reply: 'confused' });
      assert.equal(f2.ok, true, f2.error?.message);
      assert.equal(followupCalls, 2, 'second confused reply must make 1 followup model call');
      const f2Note = (f2.value?.thread || []).find((n) => n.id === note.id);
      assert.equal(f2Note?.followups?.length, 2);

      // Third confused reply must NOT call model again (max 2)
      const f3 = await host.call('coach.reply', { noteId: note.id, reply: 'confused' });
      assert.equal(f3.ok, true, f3.error?.message);
      assert.equal(followupCalls, 2, 'third confused reply must make 0 extra model calls');

      // coach.reply 'got' (0 LLM calls)
      const gotRes = await host.call('coach.reply', { noteId: note.id, reply: 'got' });
      assert.equal(gotRes.ok, true, gotRes.error?.message);
      assert.equal(followupCalls, 2, 'reply: got must make 0 model calls');
      const gotNote = (gotRes.value?.thread || []).find((n) => n.id === note.id);
      assert.equal(gotNote?.reply, 'got');

      // Exam mode rejects coach.nudge with 0 extra model calls
      const examStart = await host.call('review.start', { mode: 'exam', deckId, count: 2, fresh: true });
      assert.equal(examStart.ok, true, examStart.error?.message);
      const examCardId = examStart.value.card?.id || examStart.value.navigation?.[0]?.cardId;
      await host.call('review.answer', {
        runId: examStart.value.id,
        cardId: examCardId,
        selected: ['b'],
        queueVersion: examStart.value.queueVersion ?? 0,
      });
      const examNudge = await host.call('coach.nudge', { runId: examStart.value.id, index: 0 });
      assert.equal(examNudge.ok, false, 'coach.nudge must reject exam mode');
      assert.equal(nudgeCalls, 1, 'rejected exam coach.nudge must make 0 model calls');
    } finally {
      await host.dispose();
    }
  });

  test('2) @xterm/headless PTY E2E (120x36 zh): wrong answer -> [N] preview (0 calls) -> [g] ConfirmDialog -> [n] cancel -> [g]+[y] (1 call) -> [1] check -> [c]+[y] followup (2nd call) -> [o] got -> Esc closes', async () => {
    const beforeResources = resourceCounts();
    const base = await makeTempDir('pty-zh');
    const dshHome = join(base, 'dsh-home');
    process.env.DSH_HOME = dshHome;
    await saveTuiPreferences(
      { language: 'zh', asciiMode: false, theme: 'dsh-dark', mathUnicode: false, showHints: true },
      { env: { ...process.env, DSH_HOME: dshHome } },
    );

    let modelCalls = 0;
    const host = await createTuiHost({
      libraryRoot: join(base, 'library'),
      env: { ...process.env, DSH_HOME: dshHome },
      home: join(base, 'home'),
      documentsDir: base,
      injectedComplete: createNudgeStubComplete({
        lang: 'zh',
        onNudge: () => {
          modelCalls += 1;
        },
        onFollowup: () => {
          modelCalls += 1;
        },
      }),
      providerDiscovery: fakeDiscovery(),
      skipAutoProbe: true,
      language: 'zh',
      eventDebounceMs: 30,
    });

    const tty = createVirtualTty(120, 36);
    let inkInst = null;
    try {
      const { run } = await seedTwoCardQuizDeckAndRun(host, 'zh');

      resetDistStore('zh', false, {
        page: 'review',
        activeRunId: run.id,
        navContext: { runId: run.id },
      });

      inkInst = render(
        React.createElement(StudyHubTuiApp, {
          host,
          initialPage: 'review',
          initialLanguage: 'zh',
          initialAsciiMode: false,
          autoLaunchpad: false,
          onExit: () => inkInst?.unmount(),
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

      const qScreen = await tty.waitFor(
        (s) => s.includes('哪种协议提供可靠的面向连接字节流传输') || s.includes('HTTPS 默认使用哪个端口'),
        { timeoutMs: 10_000, label: 'zh ReviewView question ready' },
      );

      // Press 'N' before answering -> friendly hint, 0 model calls, modal does not open
      tty.send('N');
      await tty.waitFor(
        (s) => s.includes('请先作答且答错或自评低于3分'),
        { timeoutMs: 5_000, label: 'zh friendly hint on N before answering' },
      );
      assert.equal(modelCalls, 0);

      // Answer wrong using dynamically located wrong option
      tty.send(findWrongOptionKey(qScreen));
      const wrongScreen = await tty.waitFor(
        (s) => s.includes('回答有误') && s.includes('陪学点拨'),
        { timeoutMs: 8_000, label: 'zh wrong answer feedback with N nudge hint' },
      );
      tty.assertHealthyScreen(wrongScreen, 120, 36, '120x36 zh wrong feedback');
      assert.equal(modelCalls, 0);

      // Press 'N' -> CoachNudgeModal opens in 0-call preview state
      tty.send('N');
      const previewScreen = await tty.waitFor(
        (s) => s.includes('AI 陪学点拨') && s.includes('0 模型调用预览') && s.includes('生成陪学点拨'),
        { timeoutMs: 8_000, label: 'zh CoachNudgeModal preview opened' },
      );
      tty.assertHealthyScreen(previewScreen, 120, 36, '120x36 zh CoachNudgeModal preview');
      assert.equal(modelCalls, 0, 'opening CoachNudgeModal must trigger 0 model calls');

      // Press 'g' -> ConfirmDialog opens, still 0 calls
      tty.send('g');
      const confirmNudgeScreen = await tty.waitFor(
        (s) => s.includes('开启 AI 陪学点拨') && s.includes('生成点拨 (y)'),
        { timeoutMs: 5_000, label: 'zh ConfirmDialog for coach.nudge' },
      );
      tty.assertHealthyScreen(confirmNudgeScreen, 120, 36, '120x36 zh ConfirmDialog nudge');
      assert.equal(modelCalls, 0, 'opening ConfirmDialog must trigger 0 model calls');

      // Cancel with 'n' -> back to preview, still 0 calls
      tty.send('n');
      const afterCancelScreen = await tty.waitFor(
        (s) => s.includes('0 模型调用预览') && !s.includes('生成点拨 (y)'),
        { timeoutMs: 5_000, label: 'zh ConfirmDialog cancelled with n' },
      );
      tty.assertHealthyScreen(afterCancelScreen, 120, 36, '120x36 zh after cancel');
      assert.equal(modelCalls, 0, 'cancelling ConfirmDialog must trigger 0 model calls');

      // Press 'g' then confirm 'y' -> 1 model call, renders point, explain, check
      tty.send('g');
      await tty.waitFor(
        (s) => s.includes('生成点拨 (y)'),
        { timeoutMs: 5_000, label: 'zh ConfirmDialog reopened' },
      );
      tty.send('y');
      const nudgeLoadedScreen = await tty.waitFor(
        (s) =>
          s.includes('混淆了 TCP 与 UDP 的可靠性机制') &&
          s.includes('你选了 UDP') &&
          s.includes('有序传输') &&
          s.includes('哪种传输协议提供面向连接的可靠字节流') &&
          s.includes('TCP 协议'),
        { timeoutMs: 8_000, label: 'zh nudge loaded with point, explain, check' },
      );
      tty.assertHealthyScreen(nudgeLoadedScreen, 120, 36, '120x36 zh nudge loaded');
      assert.equal(modelCalls, 1, 'confirming coach.nudge must trigger exactly 1 model call');

      // Press '1' for quick check -> 0 extra model calls, shows why
      tty.send('1');
      const checkDoneScreen = await tty.waitFor(
        (s) => s.includes('小检查答对了') && s.includes('超时重传保证数据可靠到达'),
        { timeoutMs: 8_000, label: 'zh quick check answered with why' },
      );
      tty.assertHealthyScreen(checkDoneScreen, 120, 36, '120x36 zh check answered');
      assert.equal(modelCalls, 1, 'answering quick check must trigger 0 extra model calls');

      // Press 'c' -> ConfirmDialog for confused -> confirm 'y' -> 2nd model call, shows followup
      tty.send('c');
      const confirmConfusedScreen = await tty.waitFor(
        (s) => s.includes('换个角度再讲') && s.includes('继续讲解 (y)'),
        { timeoutMs: 5_000, label: 'zh ConfirmDialog for confused' },
      );
      tty.assertHealthyScreen(confirmConfusedScreen, 120, 36, '120x36 zh ConfirmDialog confused');
      assert.equal(modelCalls, 1, 'opening confused ConfirmDialog must trigger 0 extra model calls');

      tty.send('y');
      const followupScreen = await tty.waitFor(
        (s) => s.includes('生活类比角度 1') && s.includes('互发回执确认收发能力'),
        { timeoutMs: 8_000, label: 'zh followup angle rendered' },
      );
      tty.assertHealthyScreen(followupScreen, 120, 36, '120x36 zh followup rendered');
      assert.equal(modelCalls, 2, 'confirming confused must trigger 2nd model call');

      // Press 'o' ('got') -> 0 extra model calls, marks understood
      tty.send('o');
      const gotScreen = await tty.waitFor(
        (s) => s.includes('已理解'),
        { timeoutMs: 8_000, label: 'zh got reply marked understood' },
      );
      tty.assertHealthyScreen(gotScreen, 120, 36, '120x36 zh got reply');
      assert.equal(modelCalls, 2, 'reply got must trigger 0 extra model calls');

      // Esc closes cleanly back to ReviewView
      tty.send('\u001b');
      const closedScreen = await tty.waitFor(
        (s) => s.includes('回答有误') && !s.includes('0 模型调用预览') && !s.includes('混淆了 TCP 与 UDP 的可靠性机制'),
        { timeoutMs: 5_000, label: 'zh Esc closes CoachNudgeModal cleanly' },
      );
      tty.assertHealthyScreen(closedScreen, 120, 36, '120x36 zh after Esc');
    } finally {
      inkInst?.unmount();
      tty.dispose();
      await host.dispose();
    }

    await sleep(40);
    const afterResources = resourceCounts();
    for (const kind of ['ProcessWrap', 'TCPWrap', 'PipeWrap']) {
      assert.ok(
        (afterResources[kind] || 0) <= (beforeResources[kind] || 0),
        `Resource leak check for ${kind}: before=${beforeResources[kind] || 0}, after=${afterResources[kind] || 0}`,
      );
    }
  });

  test('3) @xterm/headless PTY E2E (80x24 --ascii en): full CoachNudgeModal flow asserts healthy screen and 100% ASCII purity on every frame', async () => {
    const base = await makeTempDir('pty-ascii-en');
    const dshHome = join(base, 'dsh-home');
    process.env.DSH_HOME = dshHome;
    await saveTuiPreferences(
      { language: 'en', asciiMode: true, theme: 'dsh-dark', mathUnicode: false, showHints: true },
      { env: { ...process.env, DSH_HOME: dshHome } },
    );

    let modelCalls = 0;
    const host = await createTuiHost({
      libraryRoot: join(base, 'library'),
      env: { ...process.env, DSH_HOME: dshHome },
      home: join(base, 'home'),
      documentsDir: base,
      injectedComplete: createNudgeStubComplete({
        lang: 'en',
        includeChrome: true,
        onNudge: () => {
          modelCalls += 1;
        },
        onFollowup: () => {
          modelCalls += 1;
        },
      }),
      providerDiscovery: fakeDiscovery(),
      skipAutoProbe: true,
      language: 'en',
      eventDebounceMs: 30,
    });

    const tty = createVirtualTty(80, 24);
    let inkInst = null;
    try {
      const { run } = await seedTwoCardQuizDeckAndRun(host, 'en');

      resetDistStore('en', true, {
        page: 'review',
        activeRunId: run.id,
        navContext: { runId: run.id },
      });

      inkInst = render(
        React.createElement(StudyHubTuiApp, {
          host,
          initialPage: 'review',
          initialLanguage: 'en',
          initialAsciiMode: true,
          autoLaunchpad: false,
          onExit: () => inkInst?.unmount(),
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

      const qScreen = await tty.waitFor(
        (s) =>
          (s.includes('reliable ordered delivery') || s.includes('Which port does HTTPS use')) &&
          s.includes('1-6/a-f'),
        { timeoutMs: 10_000, label: 'en 80x24 ReviewView question ready' },
      );
      tty.assertHealthyScreen(qScreen, 80, 24, '80x24 en ReviewView question');
      tty.assertAsciiPure(qScreen, '80x24 en ReviewView question');
      await tty.flush(80);

      // Answer wrong using dynamically located wrong option
      tty.send(findWrongOptionKey(qScreen));
      const wrongScreen = await tty.waitFor(
        (s) => s.includes('x Incorrect') && s.includes('Nudge'),
        { timeoutMs: 8_000, label: 'en 80x24 wrong answer feedback' },
      );
      tty.assertHealthyScreen(wrongScreen, 80, 24, '80x24 en wrong feedback');
      tty.assertAsciiPure(wrongScreen, '80x24 en wrong feedback');
      assert.equal(modelCalls, 0);

      // Press 'N' -> preview modal (0 model calls)
      tty.send('N');
      const previewScreen = await tty.waitFor(
        (s) => s.includes('AI Coach Nudge') && s.includes('0-Call Preview'),
        { timeoutMs: 8_000, label: 'en 80x24 CoachNudgeModal preview' },
      );
      tty.assertHealthyScreen(previewScreen, 80, 24, '80x24 en preview');
      tty.assertAsciiPure(previewScreen, '80x24 en preview');
      assert.equal(modelCalls, 0);

      // Press 'g' -> ConfirmDialog -> cancel 'n' -> still 0 calls
      tty.send('g');
      const confirmNudgeScreen = await tty.waitFor(
        (s) => s.includes('Generate AI Coach Nudge') && s.includes('Generate (y)'),
        { timeoutMs: 5_000, label: 'en 80x24 ConfirmDialog nudge' },
      );
      tty.assertHealthyScreen(confirmNudgeScreen, 80, 24, '80x24 en ConfirmDialog nudge');
      tty.assertAsciiPure(confirmNudgeScreen, '80x24 en ConfirmDialog nudge');
      assert.equal(modelCalls, 0);

      tty.send('n');
      const cancelledScreen = await tty.waitFor(
        (s) => s.includes('0-Call Preview') && !s.includes('Generate (y)'),
        { timeoutMs: 5_000, label: 'en 80x24 ConfirmDialog cancelled' },
      );
      tty.assertHealthyScreen(cancelledScreen, 80, 24, '80x24 en cancelled');
      tty.assertAsciiPure(cancelledScreen, '80x24 en cancelled');
      assert.equal(modelCalls, 0);

      // Press 'g' -> confirm 'y' -> 1 model call
      tty.send('g');
      await tty.waitFor(
        (s) => s.includes('Generate (y)'),
        { timeoutMs: 5_000, label: 'en 80x24 ConfirmDialog reopened' },
      );
      tty.send('y');
      const nudgeLoadedScreen = await tty.waitFor(
        (s) => s.includes('TCP vs UDP reliability confusion') && s.includes('TCP with ACK'),
        { timeoutMs: 8_000, label: 'en 80x24 nudge loaded' },
      );
      tty.assertHealthyScreen(nudgeLoadedScreen, 80, 24, '80x24 en nudge loaded');
      tty.assertAsciiPure(nudgeLoadedScreen, '80x24 en nudge loaded');
      assert.equal(modelCalls, 1);

      // Press '1' -> quick check (0 extra calls)
      tty.send('1');
      const checkedScreen = await tty.waitFor(
        (s) => {
          const flat = s.replace(/\s+/g, ' ');
          return flat.includes('+ Check correct') && flat.includes('sequence numbers and ACKs');
        },
        { timeoutMs: 8_000, label: 'en 80x24 quick check answered' },
      );
      tty.assertHealthyScreen(checkedScreen, 80, 24, '80x24 en check answered');
      tty.assertAsciiPure(checkedScreen, '80x24 en check answered');
      assert.equal(modelCalls, 1);

      // Press 'c' -> ConfirmDialog -> confirm 'y' -> 2nd model call
      tty.send('c');
      const confirmConfusedScreen = await tty.waitFor(
        (s) => s.includes('Explain From Simpler Angle') && s.includes('Explain Again (y)'),
        { timeoutMs: 5_000, label: 'en 80x24 ConfirmDialog confused' },
      );
      tty.assertHealthyScreen(confirmConfusedScreen, 80, 24, '80x24 en ConfirmDialog confused');
      tty.assertAsciiPure(confirmConfusedScreen, '80x24 en ConfirmDialog confused');
      assert.equal(modelCalls, 1);

      tty.send('y');
      const followupScreen = await tty.waitFor(
        (s) => {
          const flat = s.replace(/\s+/g, ' ');
          return flat.includes('Simpler Angle 1/2') && flat.includes('signed receipt before delivery');
        },
        { timeoutMs: 8_000, label: 'en 80x24 followup rendered' },
      );
      tty.assertHealthyScreen(followupScreen, 80, 24, '80x24 en followup rendered');
      tty.assertAsciiPure(followupScreen, '80x24 en followup rendered');
      assert.equal(modelCalls, 2);

      // Press 'o' -> Understood (0 extra calls)
      tty.send('o');
      const gotScreen = await tty.waitFor(
        (s) => s.includes('+ Understood'),
        { timeoutMs: 8_000, label: 'en 80x24 Understood badge' },
      );
      tty.assertHealthyScreen(gotScreen, 80, 24, '80x24 en got');
      tty.assertAsciiPure(gotScreen, '80x24 en got');
      assert.equal(modelCalls, 2);

      // Esc closes cleanly
      tty.send('\u001b');
      const closedScreen = await tty.waitFor(
        (s) => s.includes('x Incorrect') && !s.includes('0-Call Preview') && !s.includes('TCP vs UDP reliability confusion'),
        { timeoutMs: 5_000, label: 'en 80x24 Esc closes cleanly' },
      );
      tty.assertHealthyScreen(closedScreen, 80, 24, '80x24 en after Esc');
      tty.assertAsciiPure(closedScreen, '80x24 en after Esc');
    } finally {
      inkInst?.unmount();
      tty.dispose();
      await host.dispose();
    }
  });
});
