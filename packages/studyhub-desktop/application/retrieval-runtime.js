import {
  RETRIEVAL_COMPANION_PROVIDER_ID,
  RETRIEVAL_TOOL_PREFIX,
  RETRIEVAL_WRITE_TOOLS,
  buildDesktopExtensionState,
  formatRetrievalError,
  sanitizeDesktopRetrievalStatus,
} from '../domain/retrieval-policy.js';

const WRITE_TOOL_SET = new Set(RETRIEVAL_WRITE_TOOLS);
const TOOL_CALL_TIMEOUT_MS = 15 * 60 * 1000;

function runtimeError(code, detail = '') {
  return Object.assign(new Error(formatRetrievalError(code, 'zh', detail)), { code });
}

function mapMcpToolsToDsh(rawTools) {
  return (Array.isArray(rawTools) ? rawTools : []).map((tool) => ({
    name: `${RETRIEVAL_TOOL_PREFIX}${tool.name}`,
    description: tool.description || '',
    parameters: tool.inputSchema || { type: 'object', properties: {} },
  }));
}

function parseCallArguments(rawArgs) {
  if (rawArgs && typeof rawArgs === 'object') return rawArgs;
  if (typeof rawArgs === 'string' && rawArgs.trim()) return JSON.parse(rawArgs);
  return {};
}

function candidateIdentity(candidate) {
  return candidate?.valid ? `${candidate.dir}|${candidate.version}` : '';
}

function isRunning(state) {
  return Boolean(state.client && state.client.isRunning());
}

async function stopActiveClient(state) {
  const active = state.client;
  state.client = null;
  state.runningKey = '';
  state.tools = [];
  if (active) await active.close().catch(() => {});
}

function recordExitFailure(state, outcome) {
  state.client = null;
  state.runningKey = '';
  state.tools = [];
  if (state.disposed) return;
  const detail = outcome?.stderr ? outcome.stderr.slice(-200) : `code=${outcome?.code ?? 'null'}`;
  state.lastStartError = detail;
  state.failedKey = candidateIdentity(state.candidate);
}

async function startCandidateClient(state, ports, selected) {
  const key = candidateIdentity(selected);
  try {
    const settings = await ports.readSettings().catch(() => ({ provider: 'builtin' }));
    const hfEndpoint = typeof settings?.hfEndpoint === 'string' ? settings.hfEndpoint : '';
    await ports.ensureRetrievalDirs?.();
    await ports.runHeal?.(selected).catch(() => ({}));
    const nextClient = await ports.startClient(selected, {
      hfEndpoint,
      onExit: (outcome) => recordExitFailure(state, outcome),
    });
    if (state.disposed) {
      await nextClient.close().catch(() => {});
      return { running: false, candidate: selected, notStarted: false };
    }
    state.client = nextClient;
    state.runningKey = `${key}|${hfEndpoint}`;
    state.tools = mapMcpToolsToDsh(nextClient.listTools());
    state.lastStartError = null;
    state.failedKey = '';
    return { running: true, candidate: selected, notStarted: false };
  } catch (error) {
    await stopActiveClient(state);
    state.lastStartError = String(error?.message || error).slice(0, 300);
    state.failedKey = key;
    return { running: false, candidate: selected, notStarted: true, error: state.lastStartError };
  }
}

async function invokeRetrievalTool(state, ports, { name, rawArgs, signal }) {
  if (typeof name !== 'string' || !name.startsWith(RETRIEVAL_TOOL_PREFIX)) {
    const msg = `Unknown retrieval tool: ${String(name)}`;
    return { isError: true, error: { message: msg }, content: [{ type: 'text', text: msg }] };
  }
  if (!isRunning(state)) {
    const msg = formatRetrievalError('retrieval-start-failed', 'zh');
    return { isError: true, error: { message: msg }, content: [{ type: 'text', text: msg }] };
  }
  const rawName = name.slice(RETRIEVAL_TOOL_PREFIX.length);
  const args = parseCallArguments(rawArgs);
  const runCall = () => state.client.callTool(rawName, args, { signal, timeoutMs: TOOL_CALL_TIMEOUT_MS });
  const mcpResult = WRITE_TOOL_SET.has(rawName) && typeof ports.withIndexLock === 'function'
    ? await ports.withIndexLock(runCall, { signal })
    : await runCall();
  return {
    isError: Boolean(mcpResult?.isError),
    value: mcpResult,
    content: Array.isArray(mcpResult?.content) ? mcpResult.content : [],
    ...(mcpResult?.structuredContent !== undefined ? { structuredContent: mcpResult.structuredContent } : {}),
  };
}

function createToolsService(state, ports) {
  return {
    schemas: () => (isRunning(state) ? [...state.tools] : []),
    async execute(input = {}) {
      if (typeof input.name === 'string' && input.name) {
        return invokeRetrievalTool(state, ports, { name: input.name, rawArgs: input.arguments, signal: input.signal });
      }
      if (Array.isArray(input.calls)) {
        const results = [];
        for (const item of input.calls) {
          const result = await invokeRetrievalTool(state, ports, {
            name: item.name,
            rawArgs: item.arguments,
            signal: input.signal,
          });
          results.push({ callId: item.id, result });
        }
        return { results, additionalContexts: [], concluded: false };
      }
      throw runtimeError('retrieval-start-failed', 'missing tool name');
    },
  };
}

async function resetCompanionSettingIfRemoved(ports) {
  if (typeof ports.readSettings !== 'function' || typeof ports.saveSettings !== 'function') return;
  const settings = await ports.readSettings().catch(() => null);
  if (settings?.provider === RETRIEVAL_COMPANION_PROVIDER_ID) {
    await ports.saveSettings({ ...settings, provider: 'builtin' }).catch(() => {});
  }
}

async function resolveSelectedCandidate(state, ports, forceRediscover) {
  if (!forceRediscover && isRunning(state) && state.candidate) {
    return state.candidate;
  }
  const found = await ports.discover();
  state.candidate = found?.selected?.valid ? found.selected : null;
  return state.candidate;
}

async function ensureCandidateRunning(state, ports, { allowStart, forceRediscover }) {
  const selected = await resolveSelectedCandidate(state, ports, forceRediscover);
  if (!selected) {
    if (state.client) await stopActiveClient(state);
    state.lastStartError = null;
    state.failedKey = '';
    return { running: false, candidate: null, notStarted: false };
  }

  const key = candidateIdentity(selected);
  if (isRunning(state) && state.runningKey.startsWith(`${key}|`)) {
    return { running: true, candidate: selected, notStarted: false };
  }
  if (state.client) await stopActiveClient(state);

  const failedBefore = Boolean(state.lastStartError && state.failedKey === key);
  if (!allowStart || (!forceRediscover && failedBefore)) {
    return {
      running: false,
      candidate: selected,
      notStarted: failedBefore,
      ...(failedBefore ? { error: state.lastStartError } : {}),
    };
  }

  state.startPromise = startCandidateClient(state, ports, selected).finally(() => {
    state.startPromise = null;
  });
  return state.startPromise;
}

function runSerialized(state, kind, work) {
  if (state.installPromise) {
    if (state.mutationKind === kind) return state.installPromise;
    return Promise.reject(runtimeError('extension-busy'));
  }
  state.mutationKind = kind;
  state.installPromise = Promise.resolve().then(work).finally(() => {
    state.installPromise = null;
    state.mutationKind = '';
  });
  return state.installPromise;
}

function resetStartFailure(state) {
  state.lastStartError = null;
  state.failedKey = '';
}

function enrichDesktopStatus(state, ports, canInstallPlatform, rawStatus) {
  const running = isRunning(state);
  const extension = buildDesktopExtensionState({
    candidate: state.candidate,
    currentVersion: ports.getCurrentVersion(),
    sinceVersion: ports.getSinceVersion?.(),
    canInstall: canInstallPlatform,
    error: !running && state.lastStartError ? 'retrieval-start-failed' : null,
    errorDetail: !running && state.lastStartError ? state.lastStartError : null,
  });
  const notStarted = Boolean(extension.installed && !running && state.lastStartError);
  return sanitizeDesktopRetrievalStatus(rawStatus, extension, { notStarted });
}

async function performInstall(state, ports, ensureReady) {
  let stoppedForSwap = false;
  let installed;
  try {
    installed = await ports.installer.install({
      version: ports.getCurrentVersion(),
      beforeSwap: async () => {
        stoppedForSwap = true;
        await stopActiveClient(state);
      },
    });
  } catch (error) {
    if (stoppedForSwap) {
      await ensureReady({ allowStart: true, forceRediscover: true }).catch(() => {});
    }
    throw error;
  }
  if (!stoppedForSwap) {
    await stopActiveClient(state);
  }
  resetStartFailure(state);
  await ensureReady({ allowStart: true, forceRediscover: true });
  return {
    status: 'installed',
    restartRequired: false,
    application: 'applied',
    version: installed.version,
    source: 'desktop',
  };
}

async function performUninstall(state, ports) {
  const current = await resolveSelectedCandidate(state, ports, true);
  if (!current || current.source !== 'desktop') throw runtimeError('extension-uninstall-refused');
  await stopActiveClient(state);
  await ports.installer.uninstall({ targetPath: current.dir });
  resetStartFailure(state);
  const remaining = await resolveSelectedCandidate(state, ports, true);
  if (!remaining) await resetCompanionSettingIfRemoved(ports);
  return { status: 'removed', application: 'applied' };
}

/**
 * Pure application coordinator for StudyHub Desktop Retrieval (B+D hybrid).
 * All filesystem, network, locking, and process IO is injected through `ports`.
 */
export function createRetrievalRuntime(ports) {
  const canInstallPlatform = ports.canInstallPlatform !== false;
  const state = {
    candidate: null,
    client: null,
    runningKey: '',
    tools: [],
    startPromise: null,
    installPromise: null,
    mutationKind: '',
    lastStartError: null,
    failedKey: '',
    disposed: false,
  };

  async function ensureReady({ allowStart = true, forceRediscover = false } = {}) {
    if (state.disposed) return { running: false, candidate: null, notStarted: false };
    if (state.startPromise) return state.startPromise;
    return ensureCandidateRunning(state, ports, { allowStart, forceRediscover });
  }

  async function ensureReadyIfConfigured() {
    if (state.disposed || isRunning(state)) return { running: isRunning(state) };
    const settings = await ports.readSettings().catch(() => ({ provider: 'builtin' }));
    if (!settings?.provider || settings.provider === 'builtin') return { running: false };
    return ensureReady({ allowStart: true });
  }

  async function restart() {
    resetStartFailure(state);
    await stopActiveClient(state);
    return ensureReady({ allowStart: true, forceRediscover: true });
  }

  return Object.freeze({
    ensureReady,
    ensureReadyIfConfigured,
    asDshToolsService: () => createToolsService(state, ports),
    enrichStatus: (rawStatus) => enrichDesktopStatus(state, ports, canInstallPlatform, rawStatus),
    install: () => {
      if (!canInstallPlatform) return Promise.reject(runtimeError('extension-unsupported-platform'));
      return runSerialized(state, 'install', () => performInstall(state, ports, ensureReady));
    },
    uninstall: () => runSerialized(state, 'uninstall', () => performUninstall(state, ports)),
    restart,
    beforeRepair: () => stopActiveClient(state),
    afterRepair: () => { resetStartFailure(state); return ensureReady({ allowStart: true, forceRediscover: true }); },
    stop: () => stopActiveClient(state),
    dispose: async () => { state.disposed = true; await stopActiveClient(state); },
    isRunning: () => isRunning(state),
    getCandidate: () => state.candidate,
  });
}
