// Fault-injection & crash recovery resilience suite: node --test tests/resilience.test.mjs
import assert from 'node:assert/strict';
import http from 'node:http';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { render } from 'ink';
import React from 'react';
import { tsImport } from 'tsx/esm/api';

const here = dirname(fileURLToPath(import.meta.url));
const distDir = resolve(here, '..', 'dist');
const distFiles = (await readdir(distDir)).filter((f) => f.endsWith('.mjs') && f !== 'cli.mjs');
const { ViewErrorBoundary } = await import(pathToFileURL(join(distDir, 'App.mjs')).href);

let useTuiStore = null;
for (const f of distFiles) {
  if (f.startsWith('store-') || f.startsWith('chunk-')) {
    const mod = await import(pathToFileURL(join(distDir, f)).href);
    if (!useTuiStore && typeof mod.useTuiStore?.getState === 'function') useTuiStore = mod.useTuiStore;
  }
}
assert.ok(useTuiStore, 'dist/ must export useTuiStore');

const H = await tsImport('../src/host/index.ts', import.meta.url);
const { loadBoardSafe, boardFilePath } = await tsImport('../src/views/board/board-store.ts', import.meta.url);

const PREV_DSH_HOME = process.env.DSH_HOME;
const tempDirs = [];
const unhandledRejections = [];

function onUnhandledRejection(reason) {
  unhandledRejections.push(reason);
}
process.on('unhandledRejection', onUnhandledRejection);

async function tempDir(label) {
  const dir = await mkdtemp(join(tmpdir(), `studyhub-tui-resilience-${label}-`));
  tempDirs.push(dir);
  return dir;
}

function fakeDiscovery({ agyReady = false } = {}) {
  let cached = null;
  const result = () => [
    agyReady
      ? { id: 'agy', name: 'Antigravity CLI', supported: true, status: 'ready', executablePath: '/opt/fake/agy', version: '1.5.14', reasonCode: 'ready', reason: 'ready', models: [{ id: 'gemini-4-neon-high', name: 'Gemini 4 Neon' }] }
      : { id: 'agy', supported: true, status: 'not-installed', executablePath: null, version: null, reasonCode: 'not-installed', reason: '' },
    { id: 'claude', supported: false, status: 'coming-soon', executablePath: null, version: null, reasonCode: 'coming-soon-not-installed', reason: '' },
    { id: 'codex', supported: true, status: 'not-installed', executablePath: null, version: null, reasonCode: 'not-installed', reason: '' },
  ];
  return {
    async scan() {
      cached ||= result();
      return cached;
    },
    getCached: () => cached || [],
    findReadyPath: (id) => (cached || []).find((p) => p.id === id && p.status === 'ready')?.executablePath || '',
    findReadyAgyPath: () => '',
    findReadyCodexPath: () => '',
  };
}

const RESOURCE_KINDS = new Set(['FSEventWrap', 'StatWatcher', 'Timeout', 'ProcessWrap', 'TCPWrap', 'PipeWrap']);
function resourceCounts() {
  const counts = {};
  for (const kind of process.getActiveResourcesInfo()) {
    if (RESOURCE_KINDS.has(kind)) counts[kind] = (counts[kind] || 0) + 1;
  }
  return counts;
}

async function settle(ms = 60) {
  await new Promise((done) => setTimeout(done, ms));
  await new Promise((done) => setImmediate(done));
}

after(async () => {
  process.off('unhandledRejection', onUnhandledRejection);
  if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = PREV_DSH_HOME;
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
  assert.equal(unhandledRejections.length, 0, `unexpected unhandled rejections: ${unhandledRejections.map(String).join('; ')}`);
});

// ---------------------------------------------------------------------------------------------

describe('1. corrupt / truncated / non-object tui.json', () => {
  test('falls back safely to defaults on corrupt, truncated, empty, array, and invalid-type JSON', async () => {
    const base = await tempDir('prefs');
    const location = { env: { DSH_HOME: base } };
    const filePath = H.tuiPreferencesPath(location);
    await mkdir(join(base, 'study'), { recursive: true });

    const expectedDefaults = { ...H.DEFAULT_TUI_PREFERENCES, recentCommands: [] };

    const badPayloads = [
      '',
      '   \n\t  ',
      '{ broken json',
      '{"theme":"nord","language":',
      '[1, 2, 3]',
      '"just-a-string"',
      '42',
      'null',
      'true',
    ];
    for (const payload of badPayloads) {
      await writeFile(filePath, payload, 'utf8');
      const loaded = await H.loadTuiPreferences(location);
      assert.deepEqual(loaded, expectedDefaults, `payload ${JSON.stringify(payload)} should fall back to defaults`);
    }

    // Invalid field types fall back field-by-field while preserving valid fields.
    await writeFile(
      filePath,
      JSON.stringify({
        theme: 999,
        language: 'fr',
        sidebarCollapsed: 'yes',
        mathUnicode: null,
        compactMode: 1,
        showKeyHints: {},
        asciiMode: true,
        recentCommands: 'not-an-array',
        lastOpenAiPreset: '   ',
      }),
      'utf8',
    );
    const partial = await H.loadTuiPreferences(location);
    assert.equal(partial.theme, 'dsh-dark');
    assert.equal(partial.language, 'zh');
    assert.equal(partial.sidebarCollapsed, false);
    assert.equal(partial.mathUnicode, true);
    assert.equal(partial.compactMode, false);
    assert.equal(partial.showKeyHints, true);
    assert.equal(partial.asciiMode, true, 'valid boolean asciiMode survives');
    assert.deepEqual(partial.recentCommands, []);
    assert.equal('lastOpenAiPreset' in partial, false);

    // parseTuiPreferences handles hostile/primitive inputs without throwing.
    assert.deepEqual(H.parseTuiPreferences(undefined), expectedDefaults);
    assert.deepEqual(H.parseTuiPreferences(null), expectedDefaults);
    assert.deepEqual(H.parseTuiPreferences([]), expectedDefaults);
    const hostile = {
      get theme() {
        throw new Error('getter boom');
      },
    };
    assert.deepEqual(H.parseTuiPreferences(hostile), expectedDefaults);

    // saveTuiPreferences recovers cleanly even when existing file on disk is corrupt.
    await writeFile(filePath, '{corrupt', 'utf8');
    const saved = await H.saveTuiPreferences({ theme: 'nord', language: 'en' }, location);
    assert.equal(saved.theme, 'nord');
    assert.equal(saved.language, 'en');
    assert.deepEqual(await H.loadTuiPreferences(location), saved);
  });
});

// ---------------------------------------------------------------------------------------------

describe('2. corrupt tui-board.json safety', () => {
  test('loadBoardSafe returns { ok: false } and leaves original file untouched on disk', async () => {
    const libraryRoot = await tempDir('board');
    const path = boardFilePath(libraryRoot);

    const cases = [
      '{ "version": 1, "cards": [BROKEN',
      '{"version":1,"cards":[{"id":"1"',
      '[1, 2, 3]',
      '""',
    ];
    for (const raw of cases) {
      await writeFile(path, raw, 'utf8');
      const res = await loadBoardSafe(libraryRoot);
      assert.equal(res.ok, false, `expected ok:false for ${raw}`);
      assert.equal(typeof res.error, 'string');
      assert.ok(res.error.length > 0);
      assert.equal(res.path, path);
      assert.ok(Array.isArray(res.doc.cards));
      assert.equal(res.doc.cards.length, 0);
      const onDisk = await readFile(path, 'utf8');
      assert.equal(onDisk, raw, 'corrupt tui-board.json must remain untouched on disk');
    }
  });
});

// ---------------------------------------------------------------------------------------------

describe('3. OpenAI loopback HTTP & SSE fault modes', () => {
  let server;
  let baseUrl;
  let host;
  let mode = '401';
  let activeRes = null;
  let baseline;
  const secretKey = 'sk-resilience-secret-9999';

  before(async () => {
    baseline = resourceCounts();
    server = http.createServer((req, res) => {
      req.resume();
      if (mode === '401') {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `Invalid API key ${secretKey}` } }));
        return;
      }
      if (mode === '429') {
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Rate limit exceeded' } }));
        return;
      }
      if (mode === '500') {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('Internal server error');
        return;
      }
      if (mode === '503') {
        res.writeHead(503, { 'content-type': 'text/plain' });
        res.end('Service unavailable');
        return;
      }
      if (mode === 'malformed-sse') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {broken\n\n');
        res.write(': keepalive comment\n\n');
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Hello ' } }] })}\n\n`);
        res.write('data: not-json-at-all\n\n');
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'world' } }] })}\n\n`);
        res.end('data: [DONE]\n\n');
        return;
      }
      if (mode === 'truncated-sse') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Partial' } }] })}\n\n`);
        res.end();
        return;
      }
      if (mode === 'abort-mid') {
        activeRes = res;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'First ' } }] })}\n\n`);
      }
    });

    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${addr.port}/v1`;

    const box = await tempDir('openai');
    host = await H.createTuiHost({
      env: { DSH_HOME: join(box, 'dsh') },
      home: join(box, 'home'),
      libraryRoot: join(box, 'lib'),
      providerDiscovery: fakeDiscovery({ agyReady: false }),
      skipAutoProbe: true,
    });
    const saved = await host.call('desktop.config.save', {
      mode: 'openai',
      openai: { providerId: 'custom', baseUrl, model: 'gpt-test', apiKey: secretKey },
    });
    assert.equal(saved.ok, true, saved.error?.message);
  });

  after(async () => {
    try {
      activeRes?.destroy();
    } catch {
      /* ignore cleanup */
    }
    await host?.dispose();
    server?.closeAllConnections?.();
    await new Promise((done) => (server ? server.close(done) : done()));
    await settle(80);
    const now = resourceCounts();
    for (const kind of ['Timeout', 'TCPWrap']) {
      assert.ok((now[kind] || 0) <= (baseline[kind] || 0), `${kind} leaked: before ${baseline[kind] || 0}, after ${now[kind] || 0}`);
    }
  });

  test('(a) 401 Unauthorized surfaces actionable auth error and redacts API key', async () => {
    mode = '401';
    await assert.rejects(
      host.streamComplete({ system: 'sys', prompt: 'hi' }),
      (err) => {
        assert.equal(err.status, 401);
        assert.equal(err.code, 'AUTHENTICATION');
        assert.match(err.message, /401/);
        assert.equal(err.message.includes(secretKey), false, 'API key must be redacted from error message');
        return true;
      },
    );
  });

  test('(b) 429 Rate Limit surfaces actionable rate limit error', async () => {
    mode = '429';
    await assert.rejects(
      host.streamComplete({ system: 'sys', prompt: 'hi' }),
      (err) => err.status === 429 && err.code === 'RATE_LIMIT' && /429/.test(err.message),
    );
  });

  test('(c) 500 & 503 Server Errors surface actionable server error', async () => {
    mode = '500';
    await assert.rejects(
      host.streamComplete({ system: 'sys', prompt: 'hi' }),
      (err) => err.status === 500 && err.code === 'SERVER_ERROR' && /500/.test(err.message),
    );
    mode = '503';
    await assert.rejects(
      host.streamComplete({ system: 'sys', prompt: 'hi' }),
      (err) => err.status === 503 && err.code === 'SERVER_ERROR' && /503/.test(err.message),
    );
  });

  test('(d) malformed SSE lines are skipped safely & truncated SSE streams finish cleanly', async () => {
    mode = 'malformed-sse';
    const chunks = [];
    const text = await host.streamComplete({
      system: 'sys',
      prompt: 'hi',
      onChunk: (d) => chunks.push(d),
    });
    assert.equal(text, 'Hello world');
    assert.deepEqual(chunks, ['Hello ', 'world']);

    mode = 'truncated-sse';
    const partialChunks = [];
    const partialText = await host.streamComplete({
      system: 'sys',
      prompt: 'hi',
      onChunk: (d) => partialChunks.push(d),
    });
    assert.equal(partialText, 'Partial');
    assert.deepEqual(partialChunks, ['Partial']);
  });

  test('(e) mid-stream AbortController.abort() rejects cleanly with zero unhandled rejections', async () => {
    mode = 'abort-mid';
    const controller = new AbortController();
    const chunks = [];
    await assert.rejects(
      host.streamComplete({
        system: 'sys',
        prompt: 'hi',
        signal: controller.signal,
        onChunk: (d) => {
          chunks.push(d);
          controller.abort(new Error('mid-stream cancelled'));
        },
      }),
      (err) => err instanceof Error && /mid-stream cancelled|aborted/i.test(err.message),
    );
    assert.deepEqual(chunks, ['First ']);
    await settle(40);
    assert.equal(unhandledRejections.length, 0);
  });
});

// ---------------------------------------------------------------------------------------------

describe('4. crashing / non-zero-exit agy stub', () => {
  test('fails cleanly without hanging or leaking child processes', async (t) => {
    if (process.platform === 'win32') {
      t.skip('POSIX sh stub test');
      return;
    }
    const baseline = resourceCounts();
    const box = await tempDir('crashing-agy');
    const bin = join(box, 'bin');
    await mkdir(bin, { recursive: true });
    const script = join(bin, 'agy');
    await writeFile(
      script,
      [
        '#!/bin/sh',
        'case "$1" in',
        '  --version) echo "1.5.14" ;;',
        '  models) printf "gemini-4-neon-high\\tGemini 4 Neon (High)\\n" ;;',
        '  *) echo "agy fatal crash" >&2; exit 42 ;;',
        'esac',
        '',
      ].join('\n'),
      'utf8',
    );
    await chmod(script, 0o755);

    const host = await H.createTuiHost({
      env: { DSH_HOME: join(box, 'dsh'), PATH: `${bin}:/usr/bin:/bin`, HOME: join(box, 'home') },
      home: join(box, 'home'),
      libraryRoot: join(box, 'lib'),
      awaitAutoProbe: true,
    });
    try {
      const probe = await host.autoProbe;
      assert.equal(probe.outcome, 'agy-selected');
      await assert.rejects(
        host.streamComplete({ system: 'sys', prompt: 'hello' }),
        (err) => err instanceof Error && (/42/.test(err.message) || /agy fatal crash/.test(err.message)),
      );
    } finally {
      await host.dispose();
    }
    await settle(60);
    const now = resourceCounts();
    for (const kind of ['ProcessWrap', 'Timeout']) {
      assert.ok((now[kind] || 0) <= (baseline[kind] || 0), `${kind} leaked: before ${baseline[kind] || 0}, after ${now[kind] || 0}`);
    }
  });
});

// ---------------------------------------------------------------------------------------------

describe('5. invalid/garbage JSON passed to deck.import', () => {
  test('reports failure cleanly without crashing host', async () => {
    const box = await tempDir('deck-import');
    const garbagePath = join(box, 'garbage.json');
    await writeFile(garbagePath, '{not valid json!!! @@@', 'utf8');

    const host = await H.createTuiHost({
      env: { DSH_HOME: join(box, 'dsh') },
      home: join(box, 'home'),
      libraryRoot: join(box, 'lib'),
      providerDiscovery: fakeDiscovery({ agyReady: false }),
      skipAutoProbe: true,
    });
    try {
      // File containing invalid JSON reports per-file failure cleanly without crashing.
      const res = await host.call('deck.import', { path: garbagePath });
      if (res.ok) {
        assert.equal(res.value.imported, 0);
        assert.equal(res.value.failed, 1);
        assert.equal(typeof res.value.results?.[0]?.error, 'string');
        assert.ok(res.value.results[0].error.length > 0);
      } else {
        assert.equal(typeof res.error?.message, 'string');
        assert.ok(res.error.message.length > 0);
      }

      // Missing file returns normalized { ok: false } error.
      const missing = await host.call('deck.import', { path: join(box, 'does-not-exist.json') });
      assert.equal(missing.ok, false);
      assert.equal(typeof missing.error?.message, 'string');
      assert.ok(missing.error.message.length > 0);

      // Host remains healthy and responsive after the failed imports.
      const snap = await host.refreshSnapshot();
      assert.equal(snap.error, null);
      assert.ok(Array.isArray(snap.snapshot?.decks));
    } finally {
      await host.dispose();
    }
  });
});

// ---------------------------------------------------------------------------------------------

describe('6. ViewErrorBoundary crash recovery & ASCII safety', () => {
  test('catches view render error, displays ASCII-safe diagnostic, and recovers via [r] / [1]', async () => {
    useTuiStore.getState().setPreferences({ asciiMode: true, language: 'en' });
    const stdin = new PassThrough();
    stdin.isTTY = true;
    stdin.setRawMode = () => stdin;
    stdin.ref = () => stdin;
    stdin.unref = () => stdin;
    const stdout = new PassThrough();
    stdout.isTTY = true;
    stdout.columns = 90;
    stdout.rows = 24;
    const chunks = [];
    stdout.on('data', (c) => chunks.push(c.toString('utf8')));

    let shouldThrow = true;
    let resets = 0;
    let goLib = 0;

    function Bomb() {
      if (shouldThrow) throw new Error('Simulated\n  render   explosion');
      return React.createElement('ink-text', null, 'Recovered OK');
    }

    const app = render(
      React.createElement(
        ViewErrorBoundary,
        {
          page: 'review',
          lang: 'en',
          isActive: true,
          onReset: () => {
            resets += 1;
          },
          onGoLibrary: () => {
            goLib += 1;
          },
        },
        React.createElement(Bomb),
      ),
      { stdin, stdout, stderr: stdout, debug: true, exitOnCtrlC: false },
    );

    try {
      await settle(40);
      const output = chunks.join('');
      assert.match(output, /View Error/);
      assert.match(output, /review/);
      assert.match(output, /Simulated render explosion/);
      assert.match(output, /Press \[r\] to retry, or \[1\] to return to Library\./);
      assert.equal(/[╭╮╯╰─▲…]/.test(output), false, 'ASCII mode must avoid Unicode box/icon glyphs');

      shouldThrow = false;
      stdin.write('r');
      await settle(40);
      assert.equal(resets, 1);
      assert.match(chunks.join(''), /Recovered OK/);

      // Trigger another error and verify [1] returns to Library.
      shouldThrow = true;
      app.rerender(
        React.createElement(
          ViewErrorBoundary,
          {
            page: 'notes',
            lang: 'en',
            isActive: true,
            onReset: () => {
              resets += 1;
            },
            onGoLibrary: () => {
              goLib += 1;
            },
          },
          React.createElement(Bomb),
        ),
      );
      await settle(40);
      stdin.write('1');
      await settle(40);
      assert.equal(goLib, 1);
    } finally {
      app.unmount();
      useTuiStore.getState().setPreferences({ asciiMode: false, language: 'zh' });
    }
  });
});
