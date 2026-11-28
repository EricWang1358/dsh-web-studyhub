import { randomBytes } from 'node:crypto';
import { access, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createDesktopHost } from '../application/desktop-host.js';
import { createProviderDiscovery } from '../application/provider-discovery.js';
import { createRetrievalRuntime } from '../application/retrieval-runtime.js';
import { createAgyCompleteAdapter, probeAgyModels, probeCliVersion } from '../adapters/cli/agy-adapter.mjs';
import { createCodexCompleteAdapter, probeCodexAuth, probeCodexModels } from '../adapters/cli/codex-adapter.mjs';
import { listCandidatePaths } from '../adapters/cli/candidate-paths.mjs';
import { createProcessRunner } from '../adapters/cli/process-runner.mjs';
import { startLocalServer } from '../adapters/http/local-server.mjs';
import { createOpenAiCompleteAdapter } from '../adapters/http/openai-adapter.mjs';
import { openExternalUrl } from '../adapters/os/open-external.mjs';
import { openCliTerminal } from '../adapters/os/open-terminal.mjs';
import { createRetrievalRuntimePorts } from '../adapters/retrieval/runtime-ports.mjs';
import { createInProcessJobExecutor } from '../adapters/runtime/job-executor.mjs';
import { createConfigStore } from '../adapters/storage/config-store.mjs';
import { createDesktopLibraryEvents } from '../adapters/storage/library-watcher.mjs';

const desktopRoot = fileURLToPath(new URL('../', import.meta.url));
const HANDSHAKE_TIMEOUT_MS = 15_000;
const HANDSHAKE_MAX_BYTES = 4096;

async function resolveStudyCliPath(env = process.env) {
  const candidates = [
    env.STUDYHUB_DESKTOP_RUNTIME_ROOT ? join(resolve(env.STUDYHUB_DESKTOP_RUNTIME_ROOT), 'scripts', 'study-cli.mjs') : '',
    join(resolve(desktopRoot, '../..'), 'scripts', 'study-cli.mjs'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (await access(candidate).then(() => true, () => false)) return candidate;
  }
  return '';
}

/**
 * The node this sidecar runs on (the desktop app ships its own portable node, so `process.execPath` is the bundled one), for the hand-off command an
 * outside agent runs: desktop users have no Node.js of their own. Empty when the executable is not a node binary, so the command falls back to `node`.
 */
export function resolveStudyNodePath(execPath = process.execPath) {
  const name = String(execPath ?? '').match(/[^\\/]*$/)[0];
  return /^node(\.exe)?$/i.test(name) ? String(execPath) : '';
}

function parseCliArgs(argv) {
  const dev = argv.includes('--dev');
  const devToken = argv.find((arg) => arg.startsWith('--dev-token='))?.slice(12) || '';
  const portArg = argv.find((arg) => arg.startsWith('--port='))?.slice(7);
  const parsedPort = portArg ? Number(portArg) : 0;
  const port = Number.isInteger(parsedPort) && parsedPort >= 0 && parsedPort <= 65535 ? parsedPort : 0;
  const serveUiArg = argv.find((arg) => arg === '--serve-ui' || arg.startsWith('--serve-ui='));
  const serveUiDir = serveUiArg === '--serve-ui'
    ? resolve(desktopRoot, 'dist', 'ui')
    : serveUiArg
      ? resolve(serveUiArg.slice(11))
      : '';
  return { dev, devToken, port, serveUiDir };
}

/**
 * Read one newline-delimited handshake JSON line from `stdin` while keeping `stdin` open
 * so subsequent parent EOF triggers clean shutdown.
 */
function readHandshakeToken(stdin, timeoutMs = HANDSHAKE_TIMEOUT_MS) {
  return new Promise((resolveToken, rejectToken) => {
    const decoder = new StringDecoder('utf8');
    let buffer = '';
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      stdin.off('data', onData);
      stdin.off('end', onEnd);
      stdin.off('error', onError);
    };

    const fail = (message) => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectToken(new Error(message));
    };

    const timer = setTimeout(() => fail('Timed out waiting for sidecar handshake token on stdin'), timeoutMs);
    timer.unref?.();

    const onData = (chunk) => {
      buffer += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      if (buffer.length > HANDSHAKE_MAX_BYTES) {
        fail('Sidecar handshake line exceeded maximum length');
        return;
      }
      const nl = buffer.indexOf('\n');
      if (nl < 0) return;
      const line = buffer.slice(0, nl).trim();
      settled = true;
      cleanup();
      try {
        const parsed = JSON.parse(line);
        if (!parsed || typeof parsed.token !== 'string' || parsed.token.length < 16) {
          rejectToken(new Error('Invalid handshake token payload'));
          return;
        }
        resolveToken(parsed.token);
      } catch {
        rejectToken(new Error('Malformed handshake JSON on stdin'));
      }
    };

    const onEnd = () => fail('stdin closed before handshake token arrived');
    const onError = (error) => fail(`stdin error during handshake: ${error?.message || error}`);

    stdin.on('data', onData);
    stdin.on('end', onEnd);
    stdin.on('error', onError);
    stdin.resume();
  });
}

function normalizeSidecarOptions(options = {}) {
  return {
    token: options.token,
    port: options.port ?? 0,
    serveUiDir: options.serveUiDir ?? '',
    injectDevToken: options.injectDevToken ?? false,
    env: options.env ?? process.env,
    injectedComplete: options.injectedComplete ?? null,
    retrievalRuntime: options.retrievalRuntime ?? null,
    libraryEvents: options.libraryEvents ?? null,
    studyCliPath: options.studyCliPath ?? '',
    studyNodePath: options.studyNodePath ?? resolveStudyNodePath(),
  };
}

function createSidecarDiscovery(runner, env, currentCustomPaths) {
  return createProviderDiscovery({
    listCandidates: (id, opts) => listCandidatePaths(id, { ...opts, env }),
    probeVersion: (_id, executablePath) => probeCliVersion(runner, executablePath),
    listAgyModels: (executablePath) => probeAgyModels(runner, executablePath),
    checkCodexAuth: (executablePath) => probeCodexAuth(runner, executablePath),
    listCodexModels: (executablePath) => probeCodexModels(runner, executablePath),
    getCustomPath: (id) => currentCustomPaths[id] || '',
  });
}

function buildSidecarHostOptions(opts) {
  return {
    configStore: opts.configStore,
    providerDiscovery: opts.providerDiscovery,
    openaiComplete: (config, callOpts) => createOpenAiCompleteAdapter(config, callOpts),
    agyComplete: (config, callOpts) => createAgyCompleteAdapter(config, { ...callOpts, runner: opts.runner }),
    codexComplete: (config, callOpts) => createCodexCompleteAdapter(config, { ...callOpts, runner: opts.runner }),
    jobExecutor: opts.jobExecutor,
    openExternal: (url) => openExternalUrl(url),
    openCliTerminal: (request) => openCliTerminal(request, { env: opts.env }),
    ensureDir: (dirPath) => mkdir(dirPath, { recursive: true }),
    injectedComplete: opts.injectedComplete,
    retrievalRuntime: opts.retrievalRuntime,
    libraryEvents: opts.libraryEvents,
    // The drive Windows is installed on; the default is the usual one when the variable is missing.
    systemDrive: opts.env.SystemDrive || 'C:',
    studyCliPath: opts.resolvedStudyCliPath,
    studyNodePath: opts.studyNodePath,
  };
}

/**
 * Sole Composition Root wiring domain policies, application use-cases, and Node adapters.
 */
export async function composeDesktopSidecar(rawOptions) {
  const options = normalizeSidecarOptions(rawOptions);
  const { token, port, serveUiDir, injectDevToken, env, injectedComplete, studyCliPath, studyNodePath } = options;
  const configStore = createConfigStore({ env });
  const runner = createProcessRunner();
  const jobExecutor = createInProcessJobExecutor();
  const currentCustomPaths = { agy: '', codex: '' };
  const retrievalRuntime = options.retrievalRuntime || createRetrievalRuntime(
    createRetrievalRuntimePorts({ env, dshHome: configStore.dshHome, runner })
  );
  const libraryEvents = options.libraryEvents || createDesktopLibraryEvents();
  const providerDiscovery = createSidecarDiscovery(runner, env, currentCustomPaths);
  const resolvedStudyCliPath = studyCliPath || await resolveStudyCliPath(env);

  const host = await createDesktopHost(buildSidecarHostOptions({
    configStore, providerDiscovery, runner, jobExecutor, retrievalRuntime,
    libraryEvents, env, injectedComplete, resolvedStudyCliPath, studyNodePath,
  }));
  const syncCustomPaths = () => {
    currentCustomPaths.agy = host.config.agy.executablePath;
    currentCustomPaths.codex = host.config.codex.executablePath;
  };
  syncCustomPaths();

  const onCall = async (action, args) => {
    const result = await host.call(action, args);
    syncCustomPaths();
    return result;
  };

  const server = await startLocalServer({
    token,
    onCall,
    onSubscribeEvents: host.subscribeEvents,
    port,
    serveUiDir,
    injectDevToken,
  });

  let closed = false;
  async function shutdown() {
    if (closed) return;
    closed = true;
    await Promise.allSettled([server.close(), host.dispose()]);
  }

  return Object.freeze({
    port: server.port,
    baseUrl: server.baseUrl,
    host,
    shutdown,
  });
}

async function runMain() {
  const cli = parseCliArgs(process.argv.slice(2));
  const token = cli.dev
    ? (cli.devToken || randomBytes(32).toString('hex'))
    : await readHandshakeToken(process.stdin);

  const sidecar = await composeDesktopSidecar({
    token,
    port: cli.port,
    serveUiDir: cli.serveUiDir,
    injectDevToken: cli.dev && Boolean(cli.serveUiDir),
  });

  process.stdout.write(`${JSON.stringify({ port: sidecar.port })}\n`);
  if (cli.dev) {
    process.stderr.write(`[studyhub-desktop] dev server listening at ${sidecar.baseUrl}\n`);
  }

  let exiting = false;
  const handleExit = async () => {
    if (exiting) return;
    exiting = true;
    await sidecar.shutdown();
    process.exit(0);
  };

  process.once('SIGINT', () => void handleExit());
  process.once('SIGTERM', () => void handleExit());
  if (!cli.dev) {
    process.stdin.once('end', () => void handleExit());
    process.stdin.once('close', () => void handleExit());
    process.stdin.resume();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runMain().catch((error) => {
    process.stderr.write(`[studyhub-desktop] fatal startup error: ${error?.message || error}\n`);
    process.exit(1);
  });
}
