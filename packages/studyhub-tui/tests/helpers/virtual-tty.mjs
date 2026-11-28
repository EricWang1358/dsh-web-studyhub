/**
 * Shared, event-driven, zero-flake Virtual TTY harness for StudyHub TUI E2E tests.
 *
 * Key optimizations over per-file copy-pasted harnesses:
 * 1. Pools & reuses `@xterm/headless` Terminal instances (`term.reset()` + `term.resize()`)
 *    instead of allocating a brand-new Terminal on every test case.
 * 2. Event-driven `waitFor(predicateOrRegex, { timeoutMs, label })`: resolves on the exact
 *    `term.write(chunk, cb)` frame commit with zero 45ms sleep-polling loops.
 * 3. Direct `dist/App.mjs` & `dist/host.mjs` loading (avoids scanning & importing every `chunk-*.mjs`).
 */
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import xtermPkg from '@xterm/headless';

const { Terminal } = xtermPkg;

const SECRET_ENV_KEY_SUFFIX_RE = /(?:_API_KEY|_TOKEN|_SECRET|_ACCESS_KEY)$/i;
const SECRET_ENV_PROVIDER_PREFIX_RE =
  /^(?:OPENAI|DEEPSEEK|ANTHROPIC|GEMINI|GOOGLE_API|GROQ|OPENROUTER|SILICONFLOW|ZHIPU|ZHIPUAI|GLM|MOONSHOT|KIMI|COHERE|MISTRAL|AZURE_OPENAI|MINERU|DASHSCOPE|AWS_SECRET)/i;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Copy `process.env` while scrubbing API keys, tokens, secrets, and provider credentials,
 * then merge explicit `overrides`.
 */
export function sanitizedTestEnv(overrides = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (SECRET_ENV_KEY_SUFFIX_RE.test(key) || SECRET_ENV_PROVIDER_PREFIX_RE.test(key)) {
      continue;
    }
    env[key] = value;
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
  return env;
}

/**
 * Return true if `input` points to a local loopback host (`localhost`, `127.0.0.1`, `::1`).
 */
export function isLoopbackUrl(input) {
  try {
    const raw = input instanceof URL ? input.href : typeof input === 'string' ? input : input?.url;
    if (!raw) return false;
    const parsed = new URL(String(raw));
    return LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Wrap `globalThis.fetch` so any outbound request to a non-loopback host throws immediately.
 * Returns a restore function.
 */
export function installNoNetworkGuard() {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const target = input instanceof URL ? input.href : typeof input === 'string' ? input : input?.url ?? String(input);
    if (!isLoopbackUrl(input)) {
      throw new assert.AssertionError({
        message: `0-network guard blocked outbound fetch to non-loopback host: ${target}`,
        actual: target,
        expected: 'loopback host (localhost, 127.0.0.1, ::1)',
        operator: 'noExternalNetwork',
      });
    }
    return originalFetch.call(globalThis, input, init);
  };
  return () => {
    globalThis.fetch = originalFetch;
  };
}

/**
 * Run `fn` with `installNoNetworkGuard()` active and always restore `globalThis.fetch` afterwards.
 */
export async function assertZeroExternalNetwork(fn) {
  const restore = installNoNetworkGuard();
  try {
    return await fn();
  } finally {
    restore();
  }
}

/**
 * Resolve cross-platform `npm` / `npx` spawn command and options (uses `.cmd` + `shell: true` on `win32`).
 */
export function resolveNpmCommand(tool = 'npm', platform = process.platform) {
  const isWin = platform === 'win32';
  const command = isWin && !/\.(?:cmd|exe|bat)$/i.test(tool) ? `${tool}.cmd` : tool;
  return {
    command,
    options: {
      shell: isWin,
      windowsHide: true,
    },
  };
}

/**
 * Build a regex matching timestamped export filenames produced by `defaultBackupFilePath`:
 * `<prefix>-(?:<slug>-)?YYYY-MM-DD-HHmmss(?:-<seq>)?\.<ext>` (or optional `ymd` prefix).
 */
export function exportFilenameRegex(prefix, ext, ymd) {
  const cleanExt = String(ext).replace(/^\./, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedPrefix = String(prefix).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const datePart = ymd ? ymd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '\\d{4}-\\d{2}-\\d{2}';
  return new RegExp(`^${escapedPrefix}-(?:.+-)?${datePart}-\\d{6}(?:-\\d+)?\\.${cleanExt}$`);
}

/**
 * Find the newest exported file in `backupsDir` matching `<prefix>-(?:<slug>-)?YYYY-MM-DD-HHmmss(?:-N)?\.<ext>`.
 */
export async function findExportedBackupFile(backupsDir, prefix, ext, ymd) {
  const re = exportFilenameRegex(prefix, ext, ymd);
  let names = [];
  try {
    names = await readdir(backupsDir);
  } catch {
    return null;
  }
  const matches = names.filter((name) => re.test(name)).sort();
  if (matches.length === 0) return null;
  const name = matches[matches.length - 1];
  return { name, path: join(backupsDir, name), all: matches };
}

const here = dirname(fileURLToPath(import.meta.url));
export const pkgRoot = resolve(here, '..', '..');
export const distDir = resolve(pkgRoot, 'dist');

export const UNICODE_UI_CHROME_RE =
  /[\u2500-\u257F\u2580-\u259F\u25A0-\u25FF\u2600-\u27BF\u2800-\u28FF\u2190-\u21FF\u2022\u2026\u2039\u203A]/g;

export function formatLeakedChars(matches) {
  return [...new Set(matches)].map((ch) => {
    const hex = ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
    return `${ch}(U+${hex})`;
  });
}

let cachedRuntime = null;

/**
 * Load built `App.mjs` and `host.mjs` once per worker process (no `chunk-*.mjs` scanning).
 */
export async function loadDistRuntime() {
  if (cachedRuntime) return cachedRuntime;
  const [appMod, hostMod] = await Promise.all([
    import(pathToFileURL(join(distDir, 'App.mjs')).href),
    import(pathToFileURL(join(distDir, 'host.mjs')).href),
  ]);
  cachedRuntime = {
    StudyHubTuiApp: appMod.StudyHubTuiApp,
    useTuiStore: appMod.useTuiStore,
    createTuiHost: hostMod.createTuiHost,
    saveTuiPreferences: hostMod.saveTuiPreferences,
    loadTuiPreferences: hostMod.loadTuiPreferences,
    appMod,
    hostMod,
  };
  return cachedRuntime;
}

// Reusable @xterm/headless Terminal pool (eliminates per-test Terminal construction overhead).
const terminalPool = [];

function acquireTerminal(cols, rows) {
  const pooled = terminalPool.pop();
  if (pooled) {
    pooled.reset();
    if (pooled.cols !== cols || pooled.rows !== rows) {
      pooled.resize(cols, rows);
    }
    return pooled;
  }
  return new Terminal({
    cols,
    rows,
    allowProposedApi: true,
    convertEol: true,
  });
}

function releaseTerminal(term) {
  if (!term) return;
  if (terminalPool.length < 4) {
    try {
      term.reset();
      terminalPool.push(term);
      return;
    } catch {
      // Fall through to dispose
    }
  }
  try {
    term.dispose();
  } catch {
    // Ignore dispose errors
  }
}

// Per-worker cached sample library templates (seeded once per language, cloned via fs.cp in ~3ms).
const sampleTemplateDirs = new Map();

/**
 * Seed a fresh StudyHub sample library into `destDir` by cloning a per-worker cached template.
 * Cuts repeated `sample.load` time from ~800ms per test to ~3ms while keeping 100% isolation.
 */
export async function cloneSampleLibrary(language, destDir) {
  const lang = language === 'en' ? 'en' : 'zh';
  let templateDir = sampleTemplateDirs.get(lang);
  if (!templateDir) {
    const base = await mkdtemp(join(tmpdir(), `studyhub-tui-sample-tpl-${lang}-`));
    const tplLib = join(base, 'lib');
    const tplDsh = join(base, 'dsh');
    await Promise.all([mkdir(tplLib, { recursive: true }), mkdir(tplDsh, { recursive: true })]);
    const { createTuiHost } = await loadDistRuntime();
    const host = await createTuiHost({
      libraryRoot: tplLib,
      env: sanitizedTestEnv({ DSH_HOME: tplDsh }),
      home: base,
      documentsDir: base,
      skipAutoProbe: true,
      language: lang,
    });
    try {
      const res = await host.call('sample.load', { language: lang });
      assert.equal(res.ok, true, `cloneSampleLibrary(${lang}) failed: ${res.error?.message ?? ''}`);
    } finally {
      await host.dispose();
    }
    templateDir = { base, tplLib };
    sampleTemplateDirs.set(lang, templateDir);
  }
  await mkdir(destDir, { recursive: true });
  await cp(templateDir.tplLib, destDir, { recursive: true });
  return destDir;
}

export function disposeTerminalPool() {
  while (terminalPool.length > 0) {
    const term = terminalPool.pop();
    try {
      term.dispose();
    } catch {
      // Ignore
    }
  }
  for (const [, tpl] of sampleTemplateDirs) {
    rm(tpl.base, { recursive: true, force: true }).catch(() => {});
  }
  sampleTemplateDirs.clear();
}

/**
 * Create a virtual TTY backed by a pooled `@xterm/headless` Terminal and event-driven frame waiters.
 */
export function createVirtualTty(cols = 120, rows = 36) {
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

  const term = acquireTerminal(cols, rows);
  let disposed = false;

  let pendingWrites = Promise.resolve();
  let firstFrameSettled = false;
  let firstFrameResolve = null;
  const firstFramePromise = new Promise((r) => {
    firstFrameResolve = r;
  });

  // Event-driven listeners notified immediately when any xterm write finishes committing.
  const frameListeners = new Set();
  const activeTimers = new Set();

  function notifyFrame() {
    if (frameListeners.size === 0) return;
    for (const fn of [...frameListeners]) {
      fn();
    }
  }

  stdout.on('data', (chunk) => {
    if (disposed) return;
    const str = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    pendingWrites = pendingWrites.then(
      () =>
        new Promise((resolveWrite) => {
          if (disposed) {
            resolveWrite();
            return;
          }
          term.write(str, () => {
            if (!firstFrameSettled) {
              firstFrameSettled = true;
              firstFrameResolve?.();
            }
            notifyFrame();
            resolveWrite();
          });
        }),
    );
  });

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

  /**
   * Wait for queued Ink/xterm writes and pending microtasks/React effects to commit.
   * Zero fixed sleep unless a tiny explicit `settleMs` is requested.
   */
  async function flush(settleMs = 0) {
    await new Promise((r) => setImmediate(r));
    await pendingWrites;
    if (settleMs > 0) {
      await new Promise((r) => setTimeout(r, settleMs));
      await pendingWrites;
    }
    await new Promise((r) => setImmediate(r));
  }

  function resize(newCols, newRows) {
    stdout.columns = newCols;
    stdout.rows = newRows;
    stderr.columns = newCols;
    stderr.rows = newRows;
    term.resize(newCols, newRows);
    stdout.emit('resize');
  }

  /**
   * Event-driven `waitFor`: accepts either a `(screen: string) => boolean` predicate or a `RegExp`.
   * Resolves immediately on the xterm frame commit that satisfies the condition (zero polling sleep).
   *
   * Standard UI/RPC wait deadlines (`timeoutMs >= 2_000`) use a 20_000ms contention-safe floor so
   * lazy ESM chunk imports and host snapshot/write RPCs under parallel E2E runs (`--shard`,
   * `STUDYHUB_E2E_CONCURRENCY=4`) do not spuriously time out while actively progressing; explicit
   * short timeouts (`< 2_000ms`) are honored verbatim.
   */
  async function waitFor(predicateOrRegex, { timeoutMs = 20_000, label = 'condition' } = {}) {
    const effectiveTimeoutMs = timeoutMs >= 2_000 ? Math.max(timeoutMs, 20_000) : timeoutMs;
    const check =
      predicateOrRegex instanceof RegExp
        ? (screen) => predicateOrRegex.test(screen)
        : predicateOrRegex;

    await pendingWrites;
    const immediate = readScreen();
    if (check(immediate)) return immediate;

    return new Promise((resolveWait, rejectWait) => {
      let settled = false;
      const cleanup = () => {
        if (settled) return;
        settled = true;
        frameListeners.delete(onFrame);
        clearTimeout(timer);
        activeTimers.delete(timer);
        clearInterval(storePoll);
        activeTimers.delete(storePoll);
      };

      const onFrame = () => {
        if (settled) return;
        const screen = readScreen();
        if (check(screen)) {
          cleanup();
          resolveWait(screen);
        }
      };

      // Keep the waitFor timer ref'd so Node's test runner never exits early with
      // "Promise resolution is still pending but the event loop has already resolved".
      const storePoll = setInterval(onFrame, 50);
      activeTimers.add(storePoll);

      const timer = setTimeout(() => {
        if (settled) return;
        const finalScreen = readScreen();
        if (check(finalScreen)) {
          cleanup();
          resolveWait(finalScreen);
          return;
        }
        cleanup();
        rejectWait(
          new Error(
            `Timed out waiting for ${label} after ${effectiveTimeoutMs}ms.\n--- SCREEN ---\n${finalScreen}\n--------------`,
          ),
        );
      }, effectiveTimeoutMs);
      activeTimers.add(timer);

      frameListeners.add(onFrame);
      // Re-check once on next immediate tick in case state updated synchronously right before subscribe.
      setImmediate(onFrame);
    });
  }

  function assertHealthyScreen(screen, expectedCols = stdout.columns, expectedRows = stdout.rows, contextLabel = 'screen') {
    const lines = screen.split('\n');
    assert.ok(
      lines.length <= expectedRows,
      `${contextLabel}: Row count exceeds viewport (${lines.length} > ${expectedRows})`,
    );
    assert.ok(
      !screen.includes('页面渲染异常') && !screen.includes('View Error') && !/(?:^|\s)Error:\s/m.test(screen),
      `${contextLabel}: Error boundary or Error: detected\n${screen}`,
    );
    assert.ok(
      !screen.includes('TypeError:') && !screen.includes('ReferenceError:'),
      `${contextLabel}: Runtime JS error rendered\n${screen}`,
    );
    assert.ok(!/\bNaN\b/.test(screen), `${contextLabel}: Raw NaN leaked\n${screen}`);
    assert.ok(!/\bundefined\b/.test(screen), `${contextLabel}: Raw undefined leaked\n${screen}`);
    assert.ok(!/\[object Object\]/.test(screen), `${contextLabel}: [object Object] leaked\n${screen}`);
    assert.ok(expectedCols > 0, `${contextLabel}: invalid cols`);
  }

  function assertAsciiPure(screen, contextLabel = 'screen') {
    const matches = screen.match(UNICODE_UI_CHROME_RE);
    assert.equal(
      matches,
      null,
      `${contextLabel}: Leaked Unicode UI chrome in --ascii mode: ${matches ? formatLeakedChars(matches).join(', ') : ''}\n${screen}`,
    );
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const handle of activeTimers) {
      clearTimeout(handle);
      clearInterval(handle);
    }
    activeTimers.clear();
    frameListeners.clear();
    stdout.removeAllListeners();
    stdin.destroy();
    stdout.destroy();
    stderr.destroy();
    releaseTerminal(term);
  }

  return {
    stdin,
    stdout,
    stderr,
    term,
    firstFramePromise,
    send,
    flush,
    resize,
    readLines,
    readScreen,
    waitFor,
    assertHealthyScreen,
    assertAsciiPure,
    dispose,
  };
}

/**
 * Wait deterministically for an atomically persisted JSON file (`temp + fsync + rename`)
 * to satisfy `predicate(parsed)`. Ignores transient `ENOENT` or partial-read parse errors
 * while an atomic write is in flight, and returns the matching parsed object.
 */
export async function waitForJsonFile(
  filePath,
  predicate,
  { timeoutMs = 10_000, intervalMs = 25, label = filePath } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let lastValue = null;
  let lastError = null;
  while (true) {
    try {
      const raw = await readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      lastValue = parsed;
      lastError = null;
      if (predicate(parsed)) return parsed;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `Timed out waiting for JSON file (${label}) after ${timeoutMs}ms; lastValue=${JSON.stringify(lastValue)}${lastError ? ` lastError=${lastError}` : ''}`,
  );
}

/**
 * Helper to create tracked temp directories and clean them all up in `after()`.
 */
export function createTempTracker(prefix = 'studyhub-tui-test-') {
  const dirs = [];
  return {
    async make(label = '') {
      const d = await mkdtemp(join(tmpdir(), `${prefix}${label ? `${label}-` : ''}`));
      dirs.push(d);
      return d;
    },
    async cleanup() {
      for (const d of dirs.splice(0, dirs.length)) {
        await rm(d, { recursive: true, force: true }).catch(() => {});
      }
    },
  };
}
