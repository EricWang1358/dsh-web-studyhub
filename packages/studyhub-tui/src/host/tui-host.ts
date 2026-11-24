/**
 * Standalone TUI host: composes StudyHub Desktop's application host (`createDesktopHost`) with Node
 * adapters exactly like `packages/studyhub-desktop/entry/sidecar.mjs`, minus the HTTP server, and adds:
 *
 * - **agy CLI primary / OpenAI-compatible secondary** auto-selection on a fresh `desktop.json`.
 * - In-memory env-key overlay (`DEEPSEEK_API_KEY`, `OPENAI_API_KEY`, …): the secret is never written to disk.
 * - Linux-safe `openExternal` (never blocks a headless terminal), `ensureDir`.
 * - `streamComplete` for live token-by-token Q&A over the active provider.
 * - Debounced library event forwarding, `refreshSnapshot()`, and a leak-free `dispose()`.
 */
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { delimiter, join, resolve, win32 } from 'node:path';
import type {
  BindingSnapshot,
  ChatMessage,
  DesktopConfigSnapshot,
  HostCallResult,
  HostClient,
  LibraryEvent,
  ModelProviderInfo,
  StudySnapshot,
  UiLanguage,
} from '../types/contracts.js';
import {
  loadDesktopDeps,
  type CompleteFn,
  type DesktopConfigStore,
  type DesktopDeps,
  type DesktopHost,
  type ProbeResult,
  type ProcessRunner,
  type ProviderDiscovery,
  type RawCallAnswer,
  type RawDesktopConfig,
  type RunRequest,
} from './desktop-deps.js';
import {
  describeEnvDetection,
  detectPrimaryEnvProvider,
  normalizeBaseUrlText,
  pickAgyModel,
  presetsForSnapshot,
  type EnvProviderDetection,
} from './presets.js';
import { isHeadlessOrSsh } from '../terminal.js';

type EnvLike = Record<string, string | undefined>;

export interface CreateTuiHostOptions {
  /** Pin the study library folder (CLI `--root`); wins over `desktop.json` like `STUDYHUB_LIBRARY`. */
  libraryRoot?: string;
  /** Environment used for `DSH_HOME`, PATH discovery and API-key detection (default `process.env`). */
  env?: EnvLike;
  /** Home directory (default `os.homedir()`); `~/Documents/StudyHub` is the default library. */
  home?: string;
  documentsDir?: string;
  /** Deterministic model stub for tests: used for every StudyRuntime completion and `streamComplete`. */
  injectedComplete?: CompleteFn | null;
  /** Skip the startup provider probe and agy-first auto-selection entirely. */
  skipAutoProbe?: boolean;
  /** Await the startup probe before resolving (default false: the probe runs in the background). */
  awaitAutoProbe?: boolean;
  /** Test seams. */
  providerDiscovery?: ProviderDiscovery;
  runner?: ProcessRunner;
  fetch?: typeof fetch;
  platform?: NodeJS.Platform;
  /** UI language for desktop.* messages and model errors. */
  language?: UiLanguage;
  /** Coalescing window for library change events (ms, default 150). */
  eventDebounceMs?: number;
  /** Told about every external link (so a headless TUI can show the URL instead). */
  onOpenExternal?: (url: string, opened: boolean) => void;
  /** Background log sink (default: silent, so nothing corrupts the Ink frame). */
  onLog?: (...args: unknown[]) => void;
}

export type AutoProbeOutcome = 'skipped' | 'configured' | 'agy-selected' | 'openai-env' | 'none' | 'error' | 'disposed';

export interface AutoProbeResult {
  outcome: AutoProbeOutcome;
  reason?: string;
  agy?: { executablePath: string; model: string; version: string | null };
  env?: ReturnType<typeof describeEnvDetection>;
  providers: ModelProviderInfo[];
}

export interface TuiConfigSnapshot extends DesktopConfigSnapshot {
  /** The OpenAI-compatible key in use comes from an environment variable (never persisted). */
  keyFromEnv?: boolean;
  envDetection?: ReturnType<typeof describeEnvDetection>;
}

export interface RefreshResult {
  snapshot: StudySnapshot | null;
  binding: BindingSnapshot | null;
  config: TuiConfigSnapshot | null;
  error: string | null;
}

export interface StreamCompleteParams {
  system: string;
  prompt: string;
  messages?: readonly ChatMessage[];
  signal?: AbortSignal;
  onChunk?: (delta: string) => void;
  onReasoning?: (chars: number) => void;
}

export interface TuiHost extends HostClient {
  getConfig(): TuiConfigSnapshot | null;
  streamComplete(params: StreamCompleteParams): Promise<string>;
  /** Snapshot + binding in parallel (config comes from the cached probe, never blocks on a CLI scan). */
  refreshSnapshot(args?: Record<string, unknown>): Promise<RefreshResult>;
  /** Re-run provider discovery (`force` skips the 30 s cache). */
  rescanProviders(force?: boolean): Promise<ModelProviderInfo[]>;
  setLanguage(language: UiLanguage): void;
  getLanguage(): UiLanguage;
  /** Resolves once the startup probe / auto-selection settled (immediately when skipped). */
  readonly autoProbe: Promise<AutoProbeResult>;
  readonly envDetection: ReturnType<typeof describeEnvDetection>;
  readonly dshHome: string;
  readonly configPath: string;
  readonly desktop: DesktopHost;
  readonly providerDiscovery: ProviderDiscovery;
  readonly disposed: boolean;
}

export const TUI_CONFIG_CHANGED_EVENT = 'tui:config-changed';
const DEFAULT_DEBOUNCE_MS = 150;

/** A `desktop.json` nobody has configured a model in yet (defaults only). */
export function isUnconfiguredDesktopConfig(config: RawDesktopConfig | null | undefined): boolean {
  if (!config) return true;
  return (
    config.mode === 'openai' &&
    !config.openai?.apiKey &&
    !config.openai?.baseUrl &&
    !config.openai?.model &&
    !config.agy?.executablePath &&
    !config.agy?.model &&
    !config.codex?.executablePath &&
    !config.codex?.model
  );
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(normalizeBaseUrlText(a)).origin === new URL(normalizeBaseUrlText(b)).origin;
  } catch {
    return false;
  }
}

/** Fill the OpenAI section from a detected env provider without touching anything the learner saved. */
export function overlayEnvProvider(config: RawDesktopConfig, detection: EnvProviderDetection | null): RawDesktopConfig {
  if (!detection || config.openai.apiKey) return config;
  const current = config.openai;
  if (!current.baseUrl && !current.model) {
    return {
      ...config,
      openai: { providerId: detection.presetId, baseUrl: detection.baseUrl, model: detection.model, apiKey: detection.apiKey },
    };
  }
  if (current.baseUrl && sameOrigin(current.baseUrl, detection.baseUrl)) {
    return { ...config, openai: { ...current, model: current.model || detection.model, apiKey: detection.apiKey } };
  }
  return config;
}

function toProviderInfo(probe: ProbeResult): ModelProviderInfo {
  const { executablePath, ...rest } = probe;
  return {
    ...rest,
    id: probe.id,
    ready: probe.status === 'ready',
    unauthenticated: probe.status === 'unauthenticated',
    ...(executablePath ? { executablePath } : {}),
  } as ModelProviderInfo;
}

function errorResult<T>(message: string, code?: string, details?: unknown): HostCallResult<T> {
  return { ok: false, error: { message, ...(code ? { code } : {}), ...(details !== undefined ? { details } : {}) } };
}

/** Desktop answers carry `error` as a string plus a top-level `code`; normalize to the TUI contract. */
export function normalizeCallAnswer<T>(raw: RawCallAnswer | null | undefined): HostCallResult<T> {
  if (!raw || typeof raw !== 'object') return errorResult('Empty host response', 'EMPTY_RESPONSE');
  if (raw.ok) return { ok: true, value: raw.value as T };
  const err = raw.error as { message?: string; code?: string; details?: unknown } | string | undefined;
  const message = typeof err === 'string' ? err : err?.message || 'Study request failed';
  const code = raw.code || (typeof err === 'object' ? err?.code : undefined) || 'STUDY_ERROR';
  const details = raw.details ?? (typeof err === 'object' ? err?.details : undefined);
  return errorResult<T>(message, code, details);
}

/**
 * Copy the environment. On Windows `process.env` is case-insensitive but a copy is not, so every key is
 * also exposed upper-cased (`Path` → `PATH`, `$env:deepseek_api_key` → `DEEPSEEK_API_KEY`).
 */
export function normalizeHostEnv(source: EnvLike, platform: NodeJS.Platform = process.platform): EnvLike {
  const out: EnvLike = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    out[key] = value;
  }
  if (platform === 'win32') {
    for (const [key, value] of Object.entries(out)) {
      const upper = key.toUpperCase();
      if (!(upper in out)) out[upper] = value;
    }
  }
  return out;
}

function findOnPath(name: string, env: EnvLike): string {
  for (const dir of String(env.PATH || '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return '';
}

/** Command used to open a URL, or null when in an SSH/headless session with no desktop browser. */
export function externalOpener(platform: NodeJS.Platform, env: EnvLike): { command: string; prefixArgs: string[] } | null {
  if (isHeadlessOrSsh(env, platform)) return null;
  if (platform === 'win32') {
    const root = env.SystemRoot || env.windir || 'C:\\Windows';
    return { command: win32.join(root, 'System32', 'rundll32.exe'), prefixArgs: ['url.dll,FileProtocolHandler'] };
  }
  if (platform === 'darwin') return { command: '/usr/bin/open', prefixArgs: [] };
  // Linux / BSD: even under WSL2, require a display server before spawning xdg-open.
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return null;
  const command = findOnPath('xdg-open', env) || (existsSync('/usr/bin/xdg-open') ? '/usr/bin/xdg-open' : '');
  return command ? { command, prefixArgs: [] } : null;
}

function mergeEvents(previous: LibraryEvent | null, next: LibraryEvent): LibraryEvent {
  if (!previous) return next;
  const areas = new Set<string>();
  for (const evt of [previous, next]) {
    const list = evt.payload?.changedAreas;
    if (Array.isArray(list)) for (const area of list) if (typeof area === 'string') areas.add(area);
  }
  const anyWithoutAreas = [previous, next].some((evt) => !Array.isArray(evt.payload?.changedAreas));
  return {
    ...next,
    payload: { ...(next.payload || {}), ...(areas.size && !anyWithoutAreas ? { changedAreas: [...areas] } : {}), coalesced: true },
  };
}

function toLibraryEvent(raw: Record<string, unknown>): LibraryEvent {
  return {
    type: typeof raw.type === 'string' ? raw.type : 'study:library-changed',
    ...(typeof raw.revision === 'number' ? { revision: raw.revision } : {}),
    source: typeof raw.source === 'string' ? raw.source : 'library',
    ...(typeof raw.reason === 'string' ? { reason: raw.reason } : {}),
    payload: { ...raw },
  };
}

function createOverlayStore(base: DesktopConfigStore, detection: EnvProviderDetection | null) {
  let lastStored: RawDesktopConfig | null = null;
  const store: DesktopConfigStore = {
    get dshHome() { return base.dshHome; },
    get configPath() { return base.configPath; },
    get defaultRoot() { return base.defaultRoot; },
    async load() {
      const loaded = await base.load();
      lastStored = loaded.config;
      return { ...loaded, config: overlayEnvProvider(loaded.config, detection) };
    },
    save(next) {
      // The env key is used in memory only: never persist it into desktop.json.
      const scrubbed = detection && next?.openai?.apiKey === detection.apiKey
        ? { ...next, openai: { ...next.openai, apiKey: '' } }
        : next;
      return base.save(scrubbed);
    },
    saveLibraryRoot: (root) => base.saveLibraryRoot(root),
    confirmLibraryPlace: () => base.confirmLibraryPlace(),
  };
  return { store, getLastStored: () => lastStored };
}

function abortError(signal: AbortSignal | undefined): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  return Object.assign(new Error('模型调用已取消'), { name: 'AbortError', code: 'aborted' });
}

/**
 * Create the TUI host. Resolves once the desktop host is ready (the provider probe keeps running in
 * the background unless `awaitAutoProbe` is set; await `host.autoProbe` to observe its decision).
 */
export async function createTuiHost(options: CreateTuiHostOptions = {}): Promise<TuiHost> {
  const deps: DesktopDeps = await loadDesktopDeps();
  const platform = options.platform ?? process.platform;
  const env: EnvLike = normalizeHostEnv(options.env ?? process.env, platform);
  if (options.libraryRoot && options.libraryRoot.trim()) env.STUDYHUB_LIBRARY = resolve(options.libraryRoot.trim());
  const log = options.onLog ?? (() => {});
  const debounceMs = Math.max(0, options.eventDebounceMs ?? DEFAULT_DEBOUNCE_MS);
  const injectedComplete = options.injectedComplete ?? null;
  let language: UiLanguage = options.language === 'en' ? 'en' : 'zh';

  const envDetection = detectPrimaryEnvProvider(env);
  const baseStore = deps.createConfigStore({
    env,
    ...(options.home ? { home: options.home } : {}),
    ...(options.documentsDir ? { documentsDir: options.documentsDir } : {}),
  });
  const { store: configStore, getLastStored } = createOverlayStore(baseStore, envDetection);

  // Every CLI probe / completion child is tied to this controller so dispose() kills them all.
  const lifetime = new AbortController();
  const baseRunner = options.runner ?? deps.createProcessRunner();
  const runner: ProcessRunner = {
    ...baseRunner,
    run: (request: RunRequest) =>
      baseRunner.run({ ...request, signal: request.signal ? AbortSignal.any([request.signal, lifetime.signal]) : lifetime.signal }),
  };

  const customPaths: Record<string, string> = { agy: '', codex: '' };
  const providerDiscovery: ProviderDiscovery = options.providerDiscovery ?? deps.createProviderDiscovery({
    listCandidates: (id, opts) => deps.listCandidatePaths(id, { ...opts, env }),
    probeVersion: (_id, executablePath) => deps.probeCliVersion(runner, executablePath),
    listAgyModels: (executablePath) => deps.probeAgyModels(runner, executablePath),
    checkCodexAuth: (executablePath) => deps.probeCodexAuth(runner, executablePath),
    listCodexModels: (executablePath) => deps.probeCodexModels(runner, executablePath),
    getCustomPath: (id) => customPaths[id] || '',
  });

  const openExternal = (value: unknown) => {
    const url = deps.openableExternalUrl(value);
    if (!url) throw Object.assign(new Error('仅允许打开有效的 http:// 或 https:// 链接'), { code: 'link-refused' });
    let opened = false;
    const opener = externalOpener(platform, env);
    if (opener) {
      try {
        deps.spawnDetached(opener.command, [...opener.prefixArgs, url]);
        opened = true;
      } catch (error) {
        log('[studyhub-tui] openExternal failed:', error);
      }
    } else if (isHeadlessOrSsh(env, platform)) {
      const hasSsh = Boolean(
        String(env.SSH_TTY ?? '').trim() ||
        String(env.SSH_CONNECTION ?? '').trim() ||
        String(env.SSH_CLIENT ?? '').trim(),
      );
      log(
        hasSsh
          ? `[studyhub-tui] SSH session detected; open URL in local browser: ${url}`
          : `[studyhub-tui] Headless terminal; open URL in browser: ${url}`,
      );
    }
    try { options.onOpenExternal?.(url, opened); } catch { /* listener errors never break the call */ }
    return { ok: true, url, opened };
  };

  const libraryEvents = deps.createDesktopLibraryEvents();
  const desktop = await deps.createDesktopHost({
    configStore,
    providerDiscovery,
    openaiComplete: (config, opts) => deps.createOpenAiCompleteAdapter(config, { ...(opts as object), ...(options.fetch ? { fetch: options.fetch } : {}) }),
    agyComplete: (config, opts) => deps.createAgyCompleteAdapter(config, { ...(opts as object), runner }),
    codexComplete: (config, opts) => deps.createCodexCompleteAdapter(config, { ...(opts as object), runner }),
    jobExecutor: deps.createInProcessJobExecutor({ log }),
    openExternal,
    ensureDir: (dir) => mkdir(dir, { recursive: true }),
    injectedComplete,
    libraryEvents,
    systemDrive: env.SystemDrive || 'C:',
  });
  const syncCustomPaths = () => {
    customPaths.agy = desktop.config.agy.executablePath;
    customPaths.codex = desktop.config.codex.executablePath;
  };
  syncCustomPaths();

  // ---------- events ----------
  const listeners = new Set<(event: LibraryEvent) => void>();
  let upstreamUnsubscribe: (() => void) | null = null;
  let pendingEvent: LibraryEvent | null = null;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const emitNow = (event: LibraryEvent) => {
    for (const listener of [...listeners]) {
      try { listener(event); } catch (error) { log('[studyhub-tui] event listener failed:', error); }
    }
  };
  const flush = () => {
    flushTimer = null;
    const event = pendingEvent;
    pendingEvent = null;
    if (event && !disposed) emitNow(event);
  };
  const onUpstream = (raw: Record<string, unknown>) => {
    if (disposed) return;
    pendingEvent = mergeEvents(pendingEvent, toLibraryEvent(raw || {}));
    if (debounceMs === 0) return flush();
    flushTimer ??= setTimeout(flush, debounceMs);
  };
  const stopUpstream = () => {
    upstreamUnsubscribe?.();
    upstreamUnsubscribe = null;
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
    pendingEvent = null;
  };
  const emitConfigChanged = (reason: string) => emitNow({ type: TUI_CONFIG_CHANGED_EVENT, source: 'tui-host', reason });

  // ---------- config snapshot ----------
  let memo: { config: RawDesktopConfig; providers: ProbeResult[]; language: UiLanguage; root: string; value: TuiConfigSnapshot } | null = null;
  const describedEnv = describeEnvDetection(envDetection);
  const keyFromEnv = () => Boolean(envDetection && desktop.config.openai.apiKey === envDetection.apiKey);

  const augmentConfig = (value: Record<string, unknown>): TuiConfigSnapshot => {
    const config = desktop.config;
    const providers = Array.isArray(value.providers) ? (value.providers as ProbeResult[]).map(toProviderInfo) : [];
    return {
      ...(value as unknown as DesktopConfigSnapshot),
      libraryRoot: desktop.library.root,
      libraryPlaceConfirmed: config.libraryPlaceConfirmed,
      reasoningEffort: config.reasoningEffort || '',
      providers,
      presets: presetsForSnapshot(),
      keyFromEnv: keyFromEnv(),
      envDetection: describedEnv,
    };
  };

  const getConfig = (): TuiConfigSnapshot | null => {
    if (disposed) return memo?.value ?? null;
    const config = desktop.config;
    const providers = providerDiscovery.getCached();
    const root = desktop.library.root;
    const sameProviders = memo && (memo.providers === providers || (!memo.providers.length && !providers.length));
    if (memo && sameProviders && memo.config === config && memo.language === language && memo.root === root) return memo.value;
    const localized = deps.localizeProviders(providers, language);
    const effective = injectedComplete
      ? { ready: true, label: 'TUI · Stub Model', reason: 'ok', provider: 'desktop-stub', model: 'stub', maxConcurrency: null, defaultConcurrency: null }
      : deps.resolveEffectiveModel(config, localized);
    const value: TuiConfigSnapshot = {
      ...deps.redactDesktopConfig(config),
      libraryRoot: root,
      libraryPlaceConfirmed: config.libraryPlaceConfirmed,
      reasoningEffort: config.reasoningEffort || '',
      providers: localized.map(toProviderInfo),
      effective,
      configPath: configStore.configPath,
      presets: presetsForSnapshot(),
      keyFromEnv: keyFromEnv(),
      envDetection: describedEnv,
    };
    memo = { config, providers, language, root, value };
    return value;
  };

  // ---------- call ----------
  const CONFIG_ACTIONS = new Set(['desktop.config.get', 'desktop.config.save']);
  const CONFIG_MUTATIONS = new Set(['desktop.config.save', 'binding.set', 'desktop.library.confirm']);

  async function call<T = any>(action: string, args: Record<string, unknown> = {}): Promise<HostCallResult<T>> {
    if (disposed) return errorResult<T>('StudyHub host has been disposed', 'host-disposed');
    const safeArgs = args && typeof args === 'object' ? args : {};
    const finalArgs = typeof action === 'string' && action.startsWith('desktop.') && language === 'en' && !('uiLanguage' in safeArgs)
      ? { ...safeArgs, uiLanguage: 'en' }
      : safeArgs;

    let raw: RawCallAnswer;
    try {
      raw = await desktop.call(action, finalArgs);
    } catch (error) {
      const err = error as { message?: string; code?: string };
      return errorResult<T>(err?.message || String(error), err?.code || 'STUDY_ERROR');
    }
    syncCustomPaths();
    const result = normalizeCallAnswer<T>(raw);
    if (!result.ok) return result;
    if (CONFIG_ACTIONS.has(action) && result.value && typeof result.value === 'object') {
      result.value = augmentConfig(result.value as Record<string, unknown>) as T;
    }
    if (CONFIG_MUTATIONS.has(action) && !disposed) emitConfigChanged(action);
    return result;
  }

  // ---------- agy-first auto-selection ----------
  async function runAutoProbe(): Promise<AutoProbeResult> {
    let providers: ProbeResult[] = [];
    try {
      providers = await providerDiscovery.scan({ force: false });
    } catch (error) {
      if (disposed) return { outcome: 'disposed', providers: [] };
      return { outcome: 'error', reason: (error as Error)?.message || String(error), providers: [] };
    }
    const infos = providers.map(toProviderInfo);
    if (disposed) return { outcome: 'disposed', providers: infos };
    if (!isUnconfiguredDesktopConfig(getLastStored())) {
      memo = null;
      return { outcome: 'configured', providers: infos };
    }
    const agy = providers.find((item) => item.id === 'agy' && item.status === 'ready' && item.executablePath);
    if (agy?.executablePath) {
      // Re-read the file: the learner may have saved something while the probe ran.
      const fresh = await baseStore.load().catch(() => null);
      if (disposed) return { outcome: 'disposed', providers: infos };
      if (fresh && !isUnconfiguredDesktopConfig(fresh.config)) return { outcome: 'configured', providers: infos };
      const model = pickAgyModel(agy.models);
      const saved = normalizeCallAnswer(
        await desktop.call('desktop.config.save', { mode: 'agy', agy: { executablePath: agy.executablePath, model } }),
      );
      syncCustomPaths();
      if (!saved.ok) return { outcome: 'error', reason: saved.error?.message, providers: infos };
      if (disposed) return { outcome: 'disposed', providers: infos };
      emitConfigChanged('auto-probe:agy-selected');
      return { outcome: 'agy-selected', agy: { executablePath: agy.executablePath, model, version: agy.version ?? null }, providers: infos };
    }
    if (envDetection) {
      memo = null;
      emitConfigChanged('auto-probe:openai-env');
      return { outcome: 'openai-env', env: describedEnv, providers: infos };
    }
    memo = null;
    return { outcome: 'none', providers: infos };
  }

  const autoProbe: Promise<AutoProbeResult> = options.skipAutoProbe
    ? Promise.resolve({ outcome: 'skipped', providers: [] })
    : runAutoProbe().catch((error) => ({ outcome: 'error' as const, reason: (error as Error)?.message || String(error), providers: [] }));
  if (options.awaitAutoProbe) await autoProbe;

  // ---------- streaming ----------
  const activeStreams = new Set<AbortController>();

  async function resolveStreamRunner(): Promise<CompleteFn | undefined> {
    if (injectedComplete) return injectedComplete;
    const config = desktop.config;
    if (config.mode === 'agy' || config.mode === 'codex') {
      const section = config.mode === 'agy' ? config.agy : config.codex;
      let executablePath = section.executablePath || providerDiscovery.findReadyPath(config.mode);
      if (!executablePath) {
        await providerDiscovery.scan({ force: false }).catch(() => []);
        executablePath = providerDiscovery.findReadyPath(config.mode);
      }
      if (!executablePath) return undefined;
      const create = config.mode === 'agy' ? deps.createAgyCompleteAdapter : deps.createCodexCompleteAdapter;
      return create({ ...section, executablePath }, { runner });
    }
    return deps.createOpenAiCompleteAdapter(
      { ...config.openai, reasoningEffort: config.reasoningEffort || '' },
      options.fetch ? { fetch: options.fetch } : undefined,
    );
  }

  async function streamComplete(params: StreamCompleteParams): Promise<string> {
    if (disposed) throw Object.assign(new Error('StudyHub host has been disposed'), { code: 'host-disposed' });
    if (params.signal?.aborted) throw abortError(params.signal);
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(params.signal?.reason);
    params.signal?.addEventListener('abort', forwardAbort, { once: true });
    activeStreams.add(controller);
    try {
      const complete = await resolveStreamRunner();
      if (!complete) {
        throw Object.assign(
          new Error(language === 'en'
            ? 'No model is ready yet: install and sign in to the agy CLI, or set an OpenAI-compatible endpoint in Settings'
            : '还没有可用的模型：请安装并登录 agy CLI，或在设置里填写 OpenAI 兼容接口'),
          { code: 'model-not-configured' },
        );
      }
      let emitted = false;
      const onOutput = (delta: string) => {
        if (!delta || controller.signal.aborted) return;
        emitted = true;
        params.onChunk?.(delta);
      };
      const text = await complete(String(params.system ?? ''), String(params.prompt ?? ''), {
        signal: controller.signal,
        onOutput,
        onChunk: onOutput,
        onReasoning: params.onReasoning,
        ...(Array.isArray(params.messages) && params.messages.length > 0 ? { messages: params.messages } : {}),
        task: 'assist',
        stream: true,
        language,
      });
      if (controller.signal.aborted) throw abortError(controller.signal);
      const out = typeof text === 'string' ? text : String(text ?? '');
      if (!emitted && out) params.onChunk?.(out);
      return out;
    } finally {
      params.signal?.removeEventListener('abort', forwardAbort);
      activeStreams.delete(controller);
    }
  }

  // ---------- lifecycle ----------
  let disposing: Promise<void> | null = null;
  const dispose = () => (disposing ||= (async () => {
    disposed = true;
    lifetime.abort(Object.assign(new Error('StudyHub host disposed'), { name: 'AbortError', code: 'host-disposed' }));
    for (const controller of activeStreams) controller.abort(lifetime.signal.reason);
    activeStreams.clear();
    stopUpstream();
    listeners.clear();
    await autoProbe.catch(() => {});
    await desktop.dispose();
  })());

  const host: TuiHost = {
    call,
    subscribeEvents(listener) {
      if (typeof listener !== 'function' || disposed) return () => {};
      listeners.add(listener);
      upstreamUnsubscribe ??= desktop.subscribeEvents(onUpstream);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        listeners.delete(listener);
        if (!listeners.size) stopUpstream();
      };
    },
    getLibraryRoot: () => desktop.library.root,
    getConfig,
    streamComplete,
    async refreshSnapshot(args = {}) {
      const [snapshot, binding] = await Promise.all([
        call<StudySnapshot>('snapshot', args),
        call<BindingSnapshot>('binding.get', {}),
      ]);
      return {
        snapshot: snapshot.ok ? snapshot.value ?? null : null,
        binding: binding.ok ? binding.value ?? null : null,
        config: getConfig(),
        error: snapshot.ok ? (binding.ok ? null : binding.error?.message || null) : snapshot.error?.message || 'snapshot failed',
      };
    },
    async rescanProviders(force = true) {
      const result = await call<{ providers: ProbeResult[] }>('desktop.providers.scan', { force });
      memo = null;
      return result.ok ? (result.value?.providers || []).map(toProviderInfo) : [];
    },
    setLanguage(next) {
      language = next === 'en' ? 'en' : 'zh';
    },
    getLanguage: () => language,
    autoProbe,
    envDetection: describedEnv,
    dshHome: configStore.dshHome,
    configPath: configStore.configPath,
    desktop,
    providerDiscovery,
    get disposed() { return disposed; },
    dispose,
  };
  return host;
}
