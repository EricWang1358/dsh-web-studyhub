// Host & provider layer tests: node --test tests/host.test.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { tsImport } from 'tsx/esm/api';
import { sanitizedTestEnv } from './helpers/virtual-tty.mjs';

const H = await tsImport('../src/host/index.ts', import.meta.url);

const PREV_DSH_HOME = process.env.DSH_HOME;
const roots = [];
async function tempDir(label) {
  const dir = await mkdtemp(join(tmpdir(), `studyhub-tui-${label}-`));
  roots.push(dir);
  return dir;
}
after(async () => {
  if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = PREV_DSH_HOME;
  await Promise.all(roots.map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

/** Every host gets this stub, so no test here can launch the real browser (see no-real-browser-guard). */
const launched = [];
const recordLaunch = (url, opener) => launched.push({ url, command: opener.command });

/** A sandbox: temp DSH_HOME, temp home and temp library root; env has no PATH and no API keys. */
async function sandbox(label, extraEnv = {}) {
  const base = await tempDir(label);
  const env = { DSH_HOME: join(base, 'dsh-home'), ...extraEnv };
  const libraryRoot = join(base, 'library');
  return { base, env, libraryRoot, home: join(base, 'home'), configPath: join(env.DSH_HOME, 'study', 'desktop.json') };
}

/** Fake provider discovery (no processes): agy ready/missing with given models. */
function fakeDiscovery({ agyReady = true, models = [{ id: 'gemini-4-neon-high', name: 'Gemini 4 Neon (High)' }], delayMs = 0 } = {}) {
  let cached = null;
  const result = () => [
    agyReady
      ? { id: 'agy', name: 'Antigravity CLI', supported: true, status: 'ready', executablePath: '/opt/fake/agy', version: '1.5.14', reasonCode: 'ready', reason: 'ready', models }
      : { id: 'agy', name: 'Antigravity CLI', supported: true, status: 'not-installed', executablePath: null, version: null, reasonCode: 'not-installed', reason: '' },
    { id: 'claude', supported: false, status: 'coming-soon', executablePath: null, version: null, reasonCode: 'coming-soon-not-installed', reason: '' },
    { id: 'codex', supported: true, status: 'not-installed', executablePath: null, version: null, reasonCode: 'not-installed', reason: '' },
  ];
  const discovery = {
    scans: 0,
    async scan() {
      discovery.scans += 1;
      if (delayMs) await new Promise((done) => setTimeout(done, delayMs));
      cached ||= result();
      return cached;
    },
    getCached: () => cached || [],
    findReadyPath: (id) => (cached || []).find((p) => p.id === id && p.status === 'ready')?.executablePath || '',
    findReadyAgyPath: () => discovery.findReadyPath('agy'),
    findReadyCodexPath: () => discovery.findReadyPath('codex'),
  };
  return discovery;
}

const CARDS_JSON = JSON.stringify({
  title: 'Binary Search Basics',
  cards: [{ kind: 'quiz', prompt: 'Binary search complexity?', choices: ['O(1)', 'O(log n)', 'O(n)', 'O(n log n)'], answer: 1, explanation: 'Halves each step.', topic: 'Search' }],
});

/** Stub model: streams 3 chunks through onOutput when asked to stream. */
function streamingStub(log = []) {
  return async (system, prompt, execution = {}) => {
    log.push({ system, prompt, task: execution.task });
    if (String(prompt).includes('OK?')) return 'OK';
    if (String(system).includes('[stream-test]')) {
      const parts = ['Memento ', 'captures ', 'state.'];
      for (const part of parts) {
        execution.signal?.throwIfAborted?.();
        execution.onOutput?.(part);
        await new Promise((done) => setTimeout(done, 5));
      }
      return parts.join('');
    }
    if (String(system).includes('[slow]')) {
      await new Promise((done, fail) => {
        const timer = setTimeout(done, 5_000);
        execution.signal?.addEventListener('abort', () => { clearTimeout(timer); fail(execution.signal.reason); }, { once: true });
      });
      return 'late';
    }
    return CARDS_JSON;
  };
}

const RESOURCE_KINDS = new Set(['FSEventWrap', 'StatWatcher', 'Timeout', 'ProcessWrap', 'TCPWrap', 'PipeWrap', 'TTYWrap', 'Immediate']);
function resourceCounts() {
  const counts = {};
  for (const kind of process.getActiveResourcesInfo()) if (RESOURCE_KINDS.has(kind)) counts[kind] = (counts[kind] || 0) + 1;
  return counts;
}
async function settle(ms = 50) {
  await new Promise((done) => setTimeout(done, ms));
  await new Promise((done) => setImmediate(done));
}

// ---------------------------------------------------------------------------------------------

describe('presets & env detection', () => {
  test('exposes the DSH-TUI preset set, desktop-compatible ids first-class', () => {
    const ids = H.TUI_OPENAI_PRESETS.map((p) => p.id);
    assert.deepEqual(ids, ['deepseek', 'openai', 'siliconflow', 'zhipu', 'openrouter', 'groq', 'moonshot', 'custom']);
    for (const p of H.TUI_OPENAI_PRESETS) {
      if (p.id === 'custom') continue;
      assert.ok(H.isUsableBaseUrl(p.baseUrl), `${p.id} base URL`);
      assert.ok(p.defaultModel, `${p.id} default model`);
      assert.ok(p.models.includes(p.defaultModel), `${p.id} quick models include default`);
    }
    assert.equal(H.findPreset('SiliconFlow').name, '硅基流动 SiliconFlow');
    assert.equal(H.matchPresetByBaseUrl('https://api.deepseek.com/v1').id, 'deepseek');
    assert.equal(H.matchPresetByBaseUrl('https://example.org/v1'), undefined);
    assert.deepEqual(H.presetsForSnapshot()[0], { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', defaultModel: 'deepseek-chat' });
  });

  test('detects env keys in priority order and never reports bad keys', () => {
    assert.deepEqual(H.detectEnvProviders({}), []);
    assert.equal(H.detectPrimaryEnvProvider({ OPENAI_API_KEY: 'has space' }), null);
    const both = H.detectEnvProviders({ OPENAI_API_KEY: 'sk-openai-1111', DEEPSEEK_API_KEY: 'sk-ds-2222', SILICONFLOW_API_KEY: 'sk-sf-3333', OPENROUTER_API_KEY: 'sk-or-4444' });
    assert.deepEqual(both.map((d) => d.presetId), ['deepseek', 'openai', 'siliconflow', 'openrouter']);
    const primary = H.detectPrimaryEnvProvider({ OPENAI_API_KEY: 'sk-openai-1111', DEEPSEEK_API_KEY: 'sk-ds-2222' });
    assert.equal(primary.presetId, 'deepseek');
    assert.equal(primary.envKey, 'DEEPSEEK_API_KEY');
    assert.equal(primary.keyLast4, '2222');
    assert.equal('apiKey' in H.describeEnvDetection(primary), false);
  });

  test('OPENAI_BASE_URL maps to a known preset or a custom endpoint', () => {
    const viaSf = H.detectPrimaryEnvProvider({ OPENAI_API_KEY: 'sk-x-9999', OPENAI_BASE_URL: 'https://api.siliconflow.cn/v1/' });
    assert.equal(viaSf.presetId, 'siliconflow');
    assert.equal(viaSf.baseUrl, 'https://api.siliconflow.cn/v1');
    assert.equal(viaSf.model, 'deepseek-ai/DeepSeek-V3');
    const custom = H.detectEnvProviders({ OPENAI_API_KEY: 'sk-x-9999', OPENAI_BASE_URL: 'http://localhost:11434/v1' })[0];
    assert.equal(custom.presetId, 'custom');
    assert.equal(custom.model, '', 'custom endpoint needs a model');
    assert.equal(H.detectPrimaryEnvProvider({ OPENAI_API_KEY: 'sk-x-9999', OPENAI_BASE_URL: 'http://localhost:11434/v1' }), null);
    const withModel = H.detectPrimaryEnvProvider({ OPENAI_API_KEY: 'sk-x-9999', OPENAI_BASE_URL: 'http://localhost:11434/v1', OPENAI_MODEL: 'qwen2.5' });
    assert.equal(withModel.model, 'qwen2.5');
  });

  test('pickAgyModel prefers gemini-4-neon-high, then first non-orchestrator model', () => {
    assert.equal(H.pickAgyModel([{ id: 'claude-opus-5-5-high' }, { id: 'gemini-4-neon-high' }]), 'gemini-4-neon-high');
    assert.equal(H.pickAgyModel([{ id: 'gemini-pro-orchestrator' }, { id: 'claude-sonnet-5-5-high' }]), 'claude-sonnet-5-5-high');
    assert.equal(H.pickAgyModel([]), '');
    assert.equal(H.pickAgyModel(undefined), '');
  });

  test('presetConfigPatch builds a desktop.config.save payload', () => {
    assert.deepEqual(H.presetConfigPatch('groq', { apiKey: ' gsk-1 ' }), {
      mode: 'openai',
      openai: { providerId: 'groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile', apiKey: 'gsk-1' },
    });
    assert.equal('apiKey' in H.presetConfigPatch('deepseek').openai, false, 'keeps the saved key when none given');
  });
});

describe('cross-platform helpers (Linux bash + Windows PowerShell)', () => {
  test('normalizeHostEnv exposes upper-cased keys on win32 only', () => {
    const win = H.normalizeHostEnv({ Path: 'C:\\bin', deepseek_api_key: 'sk-lower-0042', SystemRoot: 'C:\\Windows', SKIP: undefined }, 'win32');
    assert.equal(win.PATH, 'C:\\bin');
    assert.equal(win.Path, 'C:\\bin');
    assert.equal(win.SystemRoot, 'C:\\Windows');
    assert.equal('SKIP' in win, false);
    assert.equal(H.detectPrimaryEnvProvider(win).keyLast4, '0042');
    const linux = H.normalizeHostEnv({ Path: '/bin' }, 'linux');
    assert.equal(linux.PATH, undefined);
  });

  test('cleanPathInput handles PowerShell drag & drop, Explorer copy-as-path and bash escapes', () => {
    assert.equal(H.cleanPathInput("& 'C:\\My Files\\notes.pdf'"), 'C:\\My Files\\notes.pdf');
    assert.equal(H.cleanPathInput('"C:\\My Files\\notes.pdf"'), 'C:\\My Files\\notes.pdf');
    assert.equal(H.cleanPathInput("  '/home/me/a b.md'  "), '/home/me/a b.md');
    assert.equal(H.cleanPathInput('D:\\data\\x.pptx'), 'D:\\data\\x.pptx');
    if (process.platform !== 'win32') assert.equal(H.cleanPathInput('/home/me/a\\ b.md'), '/home/me/a b.md');
    assert.equal(H.importFormatOf('C:\\Users\\me\\Lecture.PDF'), 'pdf');
  });

  test('desktop package resolves from src/ and imports via file:// URLs', async () => {
    const root = H.resolveDesktopRoot();
    assert.ok(root.endsWith(join('packages', 'studyhub-desktop')) || root.endsWith('studyhub-desktop'));
    const deps = await H.loadDesktopDeps();
    assert.equal(typeof deps.createDesktopHost, 'function');
    assert.equal(deps.desktopRoot, root);
  });
});

// ---------------------------------------------------------------------------------------------

describe('tui-prefs', () => {
  test('resolves <DSH_HOME>/study/tui.json and round-trips atomically', async () => {
    const base = await tempDir('prefs');
    const env = { DSH_HOME: join(base, 'dsh') };
    const location = { env, home: join(base, 'home') };
    assert.equal(H.tuiPreferencesPath(location), join(base, 'dsh', 'study', 'tui.json'));
    assert.equal(H.tuiPreferencesPath({ env: {}, home: '/h' }), join('/h', '.dsh', 'study', 'tui.json'));

    assert.deepEqual(await H.loadTuiPreferences(location), { ...H.DEFAULT_TUI_PREFERENCES, recentCommands: [] });
    const saved = await H.saveTuiPreferences({ theme: 'nord', language: 'en', recentCommands: ['a', 'a', 'b'], lastOpenAiPreset: 'deepseek' }, location);
    assert.equal(saved.theme, 'nord');
    assert.deepEqual(saved.recentCommands, ['a', 'b']);
    const merged = await H.saveTuiPreferences({ compactMode: true }, location);
    assert.equal(merged.theme, 'nord', 'partial save merges over stored prefs');
    assert.equal(merged.compactMode, true);
    assert.deepEqual(await H.loadTuiPreferences(location), merged);

    const files = await readdir(join(base, 'dsh', 'study'));
    assert.deepEqual(files, ['tui.json'], 'no temp files left behind');
  });

  test('concurrent saves are serialized and never corrupt the file', async () => {
    const base = await tempDir('prefs-race');
    const location = { env: { DSH_HOME: base } };
    await Promise.all(Array.from({ length: 10 }, (_, i) => H.saveTuiPreferences({ recentCommands: [`cmd-${i}`] }, location)));
    const loaded = JSON.parse(await readFile(H.tuiPreferencesPath(location), 'utf8'));
    assert.equal(loaded.recentCommands[0], 'cmd-9');
  });

  test('corrupt JSON falls back to defaults; bad fields fall back individually', async () => {
    const base = await tempDir('prefs-bad');
    const location = { env: { DSH_HOME: base } };
    const file = H.tuiPreferencesPath(location);
    await mkdir(join(base, 'study'), { recursive: true });
    await writeFile(file, '{ this is not json', 'utf8');
    assert.deepEqual(await H.loadTuiPreferences(location), { ...H.DEFAULT_TUI_PREFERENCES, recentCommands: [] });

    await writeFile(file, JSON.stringify({ theme: 'neon-pink', language: 'en', sidebarCollapsed: 'yes', recentCommands: [1, 'x', 'x', ...Array.from({ length: 30 }, (_, i) => `c${i}`)], lastOpenAiPreset: 42 }), 'utf8');
    const loaded = await H.loadTuiPreferences(location);
    assert.equal(loaded.theme, 'dsh-dark');
    assert.equal(loaded.language, 'en', 'valid fields survive');
    assert.equal(loaded.sidebarCollapsed, false);
    assert.equal(loaded.recentCommands.length, H.MAX_RECENT_COMMANDS);
    assert.equal(loaded.recentCommands[0], 'x');
    assert.equal('lastOpenAiPreset' in loaded, false);
    assert.deepEqual(H.parseTuiPreferences(null), { ...H.DEFAULT_TUI_PREFERENCES, recentCommands: [] });
    assert.deepEqual(H.parseTuiPreferences([1, 2]), { ...H.DEFAULT_TUI_PREFERENCES, recentCommands: [] });
  });
});

// ---------------------------------------------------------------------------------------------

describe('createTuiHost with injectedComplete', () => {
  let host;
  let box;
  const opened = [];
  const modelLog = [];
  let baseline;

  before(async () => {
    box = await sandbox('host');
    baseline = resourceCounts();
    host = await H.createTuiHost({
      launchExternal: recordLaunch,
      env: box.env,
      home: box.home,
      libraryRoot: box.libraryRoot,
      injectedComplete: streamingStub(modelLog),
      providerDiscovery: fakeDiscovery({ agyReady: false }),
      skipAutoProbe: true,
      platform: 'linux',
      eventDebounceMs: 40,
      onOpenExternal: (url, ok) => opened.push({ url, ok }),
    });
  });
  after(async () => {
    await host?.dispose();
  });

  test('binds the temp library root and DSH_HOME config path', async () => {
    assert.equal(host.getLibraryRoot(), box.libraryRoot);
    assert.equal(host.configPath, box.configPath);
    assert.equal(host.dshHome, box.env.DSH_HOME);
    assert.equal((await host.autoProbe).outcome, 'skipped');
    const cfg = host.getConfig();
    assert.equal(cfg.libraryRoot, box.libraryRoot);
    assert.equal(cfg.effective.ready, true);
    assert.equal(cfg.presets.length, H.TUI_OPENAI_PRESETS.length);
    assert.equal(host.getConfig(), cfg, 'memoized while nothing changed');
  });

  test('refreshSnapshot returns snapshot + binding', async () => {
    const { snapshot, binding, config, error } = await host.refreshSnapshot();
    assert.equal(error, null);
    assert.ok(snapshot && typeof snapshot === 'object');
    assert.ok(Array.isArray(snapshot.decks));
    assert.equal(binding.root, box.libraryRoot);
    assert.ok(config);
  });

  test('unknown actions come back as a normalized error object', async () => {
    const bad = await host.call('definitely.not.an.action', {});
    assert.equal(bad.ok, false);
    assert.equal(typeof bad.error, 'object');
    assert.equal(typeof bad.error.message, 'string');
    assert.ok(bad.error.code);
    await assert.rejects(H.callAction(host, 'definitely.not.an.action'), (error) => error instanceof H.HostActionError && error.action === 'definitely.not.an.action');
  });

  test('sample course loads, reviews and answers', async () => {
    const loaded = await H.loadSampleCourse(host, { language: 'en' });
    assert.equal(loaded.loaded, true);
    assert.equal(loaded.deckId, H.SAMPLE_DECK_ID);
    const status = await H.getSampleStatus(host);
    assert.equal(status.loaded, true);
    const { snapshot } = await host.refreshSnapshot();
    assert.ok(snapshot.decks.some((deck) => deck.id === H.SAMPLE_DECK_ID));

    const run = await H.startReview(host, { mode: 'flashcard', deckId: H.SAMPLE_DECK_ID, fresh: true });
    assert.ok(run.id);
    assert.ok(run.total > 0);
    const cardId = H.currentCardId(run);
    assert.ok(cardId, 'run exposes the current card');
    const revealed = await H.revealReview(host, { runId: run.id, cardId, queueVersion: run.queueVersion });
    assert.equal(revealed.revealed, true);
    const answered = await H.answerReview(host, { runId: run.id, cardId, grade: 3, queueVersion: revealed.queueVersion });
    assert.equal(answered.id, run.id);
    assert.ok(answered.answered >= 1, `answered count advanced (${answered.answered})`);
    const again = await H.getReview(host, run.id);
    assert.equal(again.id, run.id);
    await H.endReview(host, run.id);
  });

  test('voice pack helper wraps study.voicePack', async () => {
    const pack = await H.getVoicePack(host, { language: 'en' });
    assert.ok(pack && typeof pack === 'object');
  });

  test('importLocalSource retains a Markdown file; unsupported types are refused', async () => {
    const file = join(box.base, 'notes.md');
    await writeFile(file, '# Observer\n\nThe observer pattern notifies dependents of state changes.\n', 'utf8');
    const imported = await H.importLocalSource(host, { path: file, title: 'Observer notes' });
    assert.ok(imported.documentId);
    assert.ok(imported.sourceIds?.length);
    await assert.rejects(H.importLocalSource(host, { path: join(box.base, 'x.exe') }), /Unsupported file type/);
    assert.equal(H.importFormatOf('/a/b/Slides.PPTX'), 'pptx');
  });

  test('sample course removes cleanly', async () => {
    const removed = await H.removeSampleCourse(host);
    assert.equal(removed.status.loaded, false);
    assert.ok(removed.removed.decks >= 1);
    const { snapshot } = await host.refreshSnapshot();
    assert.equal(snapshot.decks.some((deck) => deck.id === H.SAMPLE_DECK_ID), false);
  });

  test('streamComplete streams token-by-token through onChunk', async () => {
    const chunks = [];
    const text = await host.streamComplete({ system: '[stream-test] tutor', prompt: 'What is Memento?', onChunk: (d) => chunks.push(d) });
    assert.equal(text, 'Memento captures state.');
    assert.deepEqual(chunks, ['Memento ', 'captures ', 'state.']);
    assert.equal(modelLog.at(-1).task, 'assist');
  });

  test('streamComplete emits a non-streaming reply once', async () => {
    const chunks = [];
    const text = await host.streamComplete({ system: 'plain', prompt: 'json please', onChunk: (d) => chunks.push(d) });
    assert.equal(text, CARDS_JSON);
    assert.deepEqual(chunks, [CARDS_JSON]);
  });

  test('streamComplete honours AbortSignal', async () => {
    const controller = new AbortController();
    const pending = host.streamComplete({ system: '[slow]', prompt: 'wait', signal: controller.signal });
    setTimeout(() => controller.abort(new Error('user cancelled')), 20);
    await assert.rejects(pending, /user cancelled/);
    await assert.rejects(host.streamComplete({ system: 'x', prompt: 'y', signal: AbortSignal.abort(new Error('pre-aborted')) }), /pre-aborted/);
  });

  test('OpenAI preset save redacts the key; config.test uses the active route', async () => {
    const events = [];
    const off = host.subscribeEvents((e) => events.push(e));
    const saved = await host.call('desktop.config.save', H.presetConfigPatch('deepseek', { apiKey: 'sk-test-secret-00001234' }));
    assert.equal(saved.ok, true, saved.error?.message);
    assert.equal(saved.value.mode, 'openai');
    assert.equal(saved.value.openai.providerId, 'deepseek');
    assert.equal(saved.value.openai.hasKey, true);
    assert.equal(saved.value.openai.keyLast4, '1234');
    assert.equal('apiKey' in saved.value.openai, false);
    assert.equal(saved.value.libraryRoot, box.libraryRoot);
    assert.equal(saved.value.presets.length, 8);
    assert.ok(Array.isArray(saved.value.providers));
    assert.ok(events.some((e) => e.type === H.TUI_CONFIG_CHANGED_EVENT && e.reason === 'desktop.config.save'));
    off();

    const persisted = JSON.parse(await readFile(box.configPath, 'utf8'));
    assert.equal(persisted.openai.apiKey, 'sk-test-secret-00001234', 'a typed key is persisted like Desktop');
    assert.equal(host.getConfig().openai.keyLast4, '1234');

    const tested = await host.call('desktop.config.test', {});
    assert.equal(tested.ok, true);
    assert.equal(tested.value.ok, true);
    assert.match(tested.value.message, /OK/);

    const badUrl = await host.call('desktop.config.save', { openai: { baseUrl: 'ftp://nope' } });
    assert.equal(badUrl.ok, false);
    assert.equal(badUrl.error.code, 'model-url-invalid');
  });

  test('library changes are forwarded debounced & coalesced', async () => {
    const events = [];
    const off = host.subscribeEvents((e) => events.push(e));
    await Promise.all([
      host.call('library.notifyChanged', { reason: 'tui-test-1', changedAreas: ['decks'] }),
      host.call('library.notifyChanged', { reason: 'tui-test-2', changedAreas: ['runs'] }),
    ]);
    await settle(150);
    const library = events.filter((e) => e.type === 'study:library-changed');
    assert.equal(library.length, 1, `coalesced into one event, got ${library.length}`);
    assert.equal(library[0].reason, 'tui-test-2');
    assert.deepEqual([...library[0].payload.changedAreas].sort(), ['decks', 'runs']);
    off();
    off();
  });

  test('app.open never spawns in a headless terminal', async () => {
    const before = launched.length;
    const result = await host.call('app.open', { url: 'https://example.com/docs' });
    assert.equal(result.ok, true);
    assert.deepEqual(opened.at(-1), { url: 'https://example.com/docs', ok: false });
    assert.equal(launched.length, before, 'a headless host never reaches the launcher');
    const refused = await host.call('app.open', { url: 'file:///etc/passwd' });
    assert.equal(refused.ok, false);
    assert.equal(H.externalOpener('linux', {}), null);
    assert.equal(H.externalOpener('darwin', {}).command, '/usr/bin/open');
    const win = H.externalOpener('win32', { SystemRoot: 'C:\\Windows' });
    assert.equal(win.command, 'C:\\Windows\\System32\\rundll32.exe');
    assert.deepEqual(win.prefixArgs, ['url.dll,FileProtocolHandler']);
  });

  test('app.open on a desktop hands the URL to launchExternal instead of spawning', async () => {
    const desk = await sandbox('host-desktop');
    const seen = [];
    const told = [];
    let fail = false;
    const deskHost = await H.createTuiHost({
      launchExternal: (url, opener) => {
        if (fail) throw new Error('launcher broke');
        seen.push({ url, command: opener.command });
      },
      env: desk.env,
      home: desk.home,
      libraryRoot: desk.libraryRoot,
      providerDiscovery: fakeDiscovery({ agyReady: false }),
      skipAutoProbe: true,
      platform: 'darwin',
      onOpenExternal: (url, ok) => told.push({ url, ok }),
    });
    try {
      const result = await deskHost.call('app.open', { url: 'https://example.com/a' });
      assert.equal(result.ok, true);
      assert.deepEqual(seen, [{ url: 'https://example.com/a', command: '/usr/bin/open' }]);
      assert.deepEqual(told, [{ url: 'https://example.com/a', ok: true }], 'the listener still hears about the open');
      fail = true;
      await deskHost.call('app.open', { url: 'https://example.com/b' });
      assert.deepEqual(told.at(-1), { url: 'https://example.com/b', ok: false }, 'a launcher error reports opened: false');
    } finally {
      await deskHost.dispose();
    }
  });

  test('dispose() is idempotent and leaves no watchers, timers or children behind', async () => {
    const off = host.subscribeEvents(() => {});
    await host.dispose();
    await host.dispose();
    off();
    assert.equal(host.disposed, true);
    const after = await host.call('snapshot', {});
    assert.equal(after.ok, false);
    assert.equal(after.error.code, 'host-disposed');
    await assert.rejects(host.streamComplete({ system: 'x', prompt: 'y' }), /disposed/);
    await settle(80);
    const now = resourceCounts();
    for (const kind of ['FSEventWrap', 'StatWatcher', 'ProcessWrap', 'Timeout']) {
      assert.ok((now[kind] || 0) <= (baseline[kind] || 0), `${kind} leaked: before ${baseline[kind] || 0}, after ${now[kind] || 0} (${JSON.stringify(now)})`);
    }
  });
});

// ---------------------------------------------------------------------------------------------

describe('agy-first auto-selection', () => {
  test('fresh config + ready agy → saves mode agy with a smart model pick', async () => {
    const box = await sandbox('agy-fresh', { DEEPSEEK_API_KEY: 'sk-ds-should-not-win-7777' });
    const discovery = fakeDiscovery({ models: [{ id: 'gemini-pro-orchestrator' }, { id: 'gemini-4-neon-high' }, { id: 'claude-opus-5-5-high' }], delayMs: 20 });
    const host = await H.createTuiHost({ launchExternal: recordLaunch, env: box.env, home: box.home, libraryRoot: box.libraryRoot, providerDiscovery: discovery });
    try {
      const events = [];
      host.subscribeEvents((e) => events.push(e));
      const result = await host.autoProbe;
      assert.equal(result.outcome, 'agy-selected');
      assert.deepEqual(result.agy, { executablePath: '/opt/fake/agy', model: 'gemini-4-neon-high', version: '1.5.14' });
      const persisted = JSON.parse(await readFile(box.configPath, 'utf8'));
      assert.equal(persisted.mode, 'agy');
      assert.equal(persisted.agy.model, 'gemini-4-neon-high');
      assert.equal(persisted.agy.executablePath, '/opt/fake/agy');
      assert.equal(persisted.openai.apiKey, '', 'env key is never written to disk');
      const cfg = host.getConfig();
      assert.equal(cfg.mode, 'agy');
      assert.equal(cfg.effective.ready, true);
      assert.equal(cfg.providers.find((p) => p.id === 'agy').ready, true);
      assert.ok(events.some((e) => e.type === H.TUI_CONFIG_CHANGED_EVENT && e.reason === 'auto-probe:agy-selected'));
    } finally {
      await host.dispose();
    }
  });

  test('awaitAutoProbe resolves after selection; an explicit user config is never overwritten', async () => {
    const box = await sandbox('agy-configured');
    await mkdir(join(box.env.DSH_HOME, 'study'), { recursive: true });
    const userConfig = { mode: 'openai', openai: { providerId: 'zhipu', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash', apiKey: 'zk-user-5555' } };
    await writeFile(box.configPath, JSON.stringify(userConfig), 'utf8');
    const host = await H.createTuiHost({ launchExternal: recordLaunch, env: box.env, home: box.home, libraryRoot: box.libraryRoot, providerDiscovery: fakeDiscovery(), awaitAutoProbe: true });
    try {
      assert.equal((await host.autoProbe).outcome, 'configured');
      const persisted = JSON.parse(await readFile(box.configPath, 'utf8'));
      assert.equal(persisted.mode, 'openai');
      assert.equal(persisted.openai.apiKey, 'zk-user-5555');
      assert.equal(host.getConfig().mode, 'openai');
    } finally {
      await host.dispose();
    }
  });

  test('agy unavailable + DEEPSEEK_API_KEY → OpenAI fallback from env, key kept in memory only', async () => {
    const box = await sandbox('env-fallback', { DEEPSEEK_API_KEY: 'sk-ds-env-key-4242' });
    const host = await H.createTuiHost({ launchExternal: recordLaunch, env: box.env, home: box.home, libraryRoot: box.libraryRoot, providerDiscovery: fakeDiscovery({ agyReady: false }), awaitAutoProbe: true });
    try {
      const result = await host.autoProbe;
      assert.equal(result.outcome, 'openai-env');
      assert.equal(result.env.presetId, 'deepseek');
      assert.equal(result.env.envKey, 'DEEPSEEK_API_KEY');
      assert.equal('apiKey' in result.env, false);
      const cfg = host.getConfig();
      assert.equal(cfg.mode, 'openai');
      assert.equal(cfg.openai.baseUrl, 'https://api.deepseek.com');
      assert.equal(cfg.openai.model, 'deepseek-chat');
      assert.equal(cfg.openai.keyLast4, '4242');
      assert.equal(cfg.keyFromEnv, true);
      assert.equal(cfg.effective.ready, true);

      // Saving settings persists the endpoint but scrubs the env key.
      const saved = await host.call('desktop.config.save', { openai: { model: 'deepseek-reasoner' } });
      assert.equal(saved.ok, true, saved.error?.message);
      assert.equal(saved.value.openai.hasKey, true);
      const persisted = JSON.parse(await readFile(box.configPath, 'utf8'));
      assert.equal(persisted.openai.model, 'deepseek-reasoner');
      assert.equal(persisted.openai.baseUrl, 'https://api.deepseek.com');
      assert.equal(persisted.openai.apiKey, '');
      assert.equal(host.getConfig().openai.model, 'deepseek-reasoner');
    } finally {
      await host.dispose();
    }
  });

  test('nothing available → outcome none, streamComplete explains how to configure', async () => {
    const box = await sandbox('none');
    const host = await H.createTuiHost({ launchExternal: recordLaunch, env: box.env, home: box.home, libraryRoot: box.libraryRoot, providerDiscovery: fakeDiscovery({ agyReady: false }), awaitAutoProbe: true, language: 'en' });
    try {
      assert.equal((await host.autoProbe).outcome, 'none');
      assert.equal(host.getConfig().effective.ready, false);
      await assert.rejects(host.streamComplete({ system: 's', prompt: 'p' }), (error) => error.code === 'model-not-configured' && /agy CLI/.test(error.message));
    } finally {
      await host.dispose();
    }
  });

  test('streamComplete over OpenAI SSE (injected fetch) delivers deltas live', async () => {
    const box = await sandbox('sse', { OPENAI_API_KEY: 'sk-openai-sse-0001' });
    const requests = [];
    const fakeFetch = async (url, init) => {
      requests.push({ url, body: JSON.parse(init.body), auth: init.headers.authorization });
      const frames = ['He', 'llo', '!'].map((t) => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`);
      frames.push('data: [DONE]\n\n');
      const stream = new ReadableStream({
        start(controller) {
          for (const frame of frames) controller.enqueue(new TextEncoder().encode(frame));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };
    const host = await H.createTuiHost({ launchExternal: recordLaunch, env: box.env, home: box.home, libraryRoot: box.libraryRoot, providerDiscovery: fakeDiscovery({ agyReady: false }), awaitAutoProbe: true, fetch: fakeFetch });
    try {
      const chunks = [];
      const text = await host.streamComplete({ system: 'sys', prompt: 'hi', onChunk: (d) => chunks.push(d) });
      assert.equal(text, 'Hello!');
      assert.deepEqual(chunks, ['He', 'llo', '!']);
      assert.equal(requests[0].url, 'https://api.openai.com/v1/chat/completions');
      assert.equal(requests[0].auth, 'Bearer sk-openai-sse-0001');
      assert.equal(requests[0].body.stream, true);
      assert.equal(requests[0].body.model, 'gpt-4.1-mini');
    } finally {
      await host.dispose();
    }
  });

  test('dispose during a slow probe returns promptly', async () => {
    const box = await sandbox('dispose-probe');
    const host = await H.createTuiHost({ launchExternal: recordLaunch, env: box.env, home: box.home, libraryRoot: box.libraryRoot, providerDiscovery: fakeDiscovery({ delayMs: 150 }) });
    const started = Date.now();
    await host.dispose();
    assert.equal((await host.autoProbe).outcome, 'disposed');
    assert.ok(Date.now() - started < 2_000);
    assert.equal(JSON.parse(await readFile(box.configPath, 'utf8').catch(() => '{}')).mode !== 'agy', true, 'no save after dispose');
  });

  test('fake agy executable on PATH is discovered by the real probe and auto-selected', async (t) => {
    if (process.platform === 'win32') { t.skip('POSIX sh stub test'); return; }
    const box = await sandbox('fake-agy-bin');
    const bin = join(box.base, 'bin');
    await mkdir(bin, { recursive: true });
    const script = join(bin, 'agy');
    await writeFile(script, [
      '#!/bin/sh',
      'case "$1" in',
      '  --version) echo "1.5.14" ;;',
      '  models) printf "Fetching available models...\\nclaude-sonnet-5-5-high\\tClaude Sonnet 5.5 (High)\\ngemini-4-neon-high\\tGemini 4 Neon (High)\\n" ;;',
      '  *) exit 3 ;;',
      'esac',
      '',
    ].join('\n'), 'utf8');
    await chmod(script, 0o755);
    const host = await H.createTuiHost({
      launchExternal: recordLaunch,
      env: { ...box.env, PATH: `${bin}:/usr/bin:/bin`, HOME: box.home },
      home: box.home,
      libraryRoot: box.libraryRoot,
      awaitAutoProbe: true,
    });
    try {
      const result = await host.autoProbe;
      assert.equal(result.outcome, 'agy-selected', JSON.stringify(result));
      assert.equal(result.agy.executablePath, script);
      assert.equal(result.agy.model, 'gemini-4-neon-high');
      assert.equal(host.getConfig().mode, 'agy');
    } finally {
      await host.dispose();
    }
  });
});

// ---------------------------------------------------------------------------------------------

function realAgyPath() {
  try {
    const out = process.platform === 'win32'
      ? execFileSync('where.exe', ['agy'], { encoding: 'utf8', windowsHide: true })
      : execFileSync('sh', ['-c', 'command -v agy'], { encoding: 'utf8' });
    return out.split(/\r?\n/)[0].trim();
  } catch {
    return '';
  }
}

describe('real local agy probe', () => {
  const agyPath = realAgyPath();
  test('auto-selects the locally installed agy CLI with a probed model', { skip: !agyPath && 'agy CLI not installed', timeout: 60_000 }, async () => {
    const box = await sandbox('real-agy');
    const env = sanitizedTestEnv({
      DSH_HOME: box.env.DSH_HOME,
      OPENAI_BASE_URL: undefined,
      STUDYHUB_LIBRARY: undefined,
    });
    const host = await H.createTuiHost({ launchExternal: recordLaunch, env, libraryRoot: box.libraryRoot, awaitAutoProbe: true });
    try {
      const result = await host.autoProbe;
      const agy = result.providers.find((p) => p.id === 'agy');
      if (!agy?.ready) {
        assert.ok(['none', 'error'].includes(result.outcome), `agy not ready (${agy?.status}) → ${result.outcome}`);
        return;
      }
      assert.equal(result.outcome, 'agy-selected');
      assert.ok(result.agy.executablePath);
      assert.ok(agy.models.some((m) => m.id === result.agy.model), `picked model ${result.agy.model} is one agy listed`);
      const persisted = JSON.parse(await readFile(box.configPath, 'utf8'));
      assert.equal(persisted.mode, 'agy');
      assert.equal(persisted.agy.model, result.agy.model);
      assert.equal(host.getConfig().effective.ready, true);
    } finally {
      await host.dispose();
    }
  });

  test('live agy streamComplete (STUDYHUB_TUI_LIVE=1 only)', { skip: (!agyPath || process.env.STUDYHUB_TUI_LIVE !== '1') && 'set STUDYHUB_TUI_LIVE=1 to call the real model', timeout: 180_000 }, async () => {
    const box = await sandbox('live-agy');
    const host = await H.createTuiHost({ launchExternal: recordLaunch, env: { ...process.env, DSH_HOME: box.env.DSH_HOME }, libraryRoot: box.libraryRoot, awaitAutoProbe: true });
    try {
      const chunks = [];
      const text = await host.streamComplete({ system: 'Answer in one word.', prompt: 'Reply with the single word OK.', onChunk: (d) => chunks.push(d) });
      assert.match(text, /ok/i);
      assert.ok(chunks.length >= 1);
    } finally {
      await host.dispose();
    }
  });
});
