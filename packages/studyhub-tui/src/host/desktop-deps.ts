/**
 * Typed, runtime-resolved facade over the StudyHub Desktop JavaScript modules reused by the TUI host.
 *
 * Why dynamic imports: a static `import` of upstream JS from TypeScript makes `tsc` (allowJs) follow and
 * type-check `lib/` (`// @ts-check` files) which is outside this package's contract. Resolving the
 * desktop package at runtime also keeps the path correct both from `src/host/*.ts` (tsx dev / tests)
 * and from the esbuild bundle in `dist/cli.mjs`. Zero upstream changes: every module is reused as is.
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export type DesktopMode = 'openai' | 'agy' | 'codex';

export interface RawDesktopConfig {
  mode: DesktopMode;
  openai: { providerId: string; baseUrl: string; model: string; apiKey: string };
  agy: { executablePath: string; model: string; effort: string };
  codex: { executablePath: string; model: string; effort: string };
  libraryRoot: string;
  libraryPlaceConfirmed: boolean;
  reasoningEffort: string;
}

export interface LibraryState {
  root: string;
  pickedRoot: string;
  rootSource: string;
  defaultRoot: string;
  problem: { message: string; [k: string]: unknown } | null;
}

export interface DesktopConfigStore {
  dshHome: string;
  configPath: string;
  defaultRoot: string;
  load(): Promise<{ config: RawDesktopConfig; library: LibraryState; configProblem?: unknown }>;
  save(next: RawDesktopConfig, opts?: { force?: boolean }): Promise<RawDesktopConfig>;
  recover?(): Promise<unknown>;
  saveLibraryRoot(root: string): Promise<string>;
  confirmLibraryPlace(): Promise<void>;
}

export interface ProbeResult {
  id: string;
  name?: string;
  supported?: boolean;
  status: string;
  executablePath: string | null;
  version: string | null;
  reasonCode?: string;
  reason?: string;
  models?: Array<{ id: string; name?: string }>;
  authMethod?: string;
  [k: string]: unknown;
}

export interface ProviderDiscovery {
  scan(opts?: { force?: boolean }): Promise<ProbeResult[]>;
  getCached(): ProbeResult[];
  findReadyPath(id: string): string;
  findReadyAgyPath(): string;
  findReadyCodexPath(): string;
}

export interface RunRequest {
  command: string;
  args?: string[];
  cwd?: string;
  stdinText?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onStdoutLine?: (line: string) => void;
  [k: string]: unknown;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  aborted?: boolean;
  errorCode?: string;
  errorMessage?: string;
  [k: string]: unknown;
}

export interface ProcessRunner {
  run(request: RunRequest): Promise<RunResult>;
  [k: string]: unknown;
}

export interface CompleteExecution {
  signal?: AbortSignal;
  onOutput?: (delta: string) => void;
  onChunk?: (delta: string) => void;
  onReasoning?: (chars: number) => void;
  task?: string;
  stream?: boolean;
  timeoutMs?: number;
  maxTokens?: number;
  [k: string]: unknown;
}

export type CompleteFn = (system: string, prompt: string, execution?: CompleteExecution) => Promise<string>;

export interface RawCallAnswer {
  ok: boolean;
  value?: unknown;
  error?: unknown;
  code?: string;
  details?: unknown;
}

export interface JobExecutor {
  asDshJobsService(): unknown;
  [k: string]: unknown;
}

export interface LibraryEventsPort {
  subscribe(root: string, listener: (event: Record<string, unknown>) => void): () => void;
  dispose(): void;
  activeWatcherCount(): number;
  [k: string]: unknown;
}

export interface DesktopHost {
  call(action: string, args?: Record<string, unknown>): Promise<RawCallAnswer>;
  subscribeEvents(listener: (event: Record<string, unknown>) => void): () => void;
  dispose(): Promise<void>;
  readonly config: RawDesktopConfig;
  readonly library: LibraryState;
}

export interface CreateDesktopHostDeps {
  configStore: DesktopConfigStore;
  providerDiscovery: ProviderDiscovery;
  openaiComplete: (config: unknown, opts?: unknown) => CompleteFn | undefined;
  agyComplete: (config: unknown, opts?: unknown) => CompleteFn | undefined;
  codexComplete?: ((config: unknown, opts?: unknown) => CompleteFn | undefined) | null;
  jobExecutor: JobExecutor;
  openExternal: (url: unknown) => unknown;
  openCliTerminal?: (request: unknown) => Promise<unknown>;
  ensureDir: (dir: string) => Promise<unknown>;
  injectedComplete?: CompleteFn | null;
  retrievalRuntime?: unknown;
  libraryEvents?: LibraryEventsPort | null;
  systemDrive?: string;
}

export interface EffectiveModelState {
  ready: boolean;
  label: string;
  reason: string;
  provider: string;
  model: string;
  maxConcurrency: number | null;
  defaultConcurrency: number | null;
}

export interface ProviderDiscoveryPorts {
  listCandidates: (id: string, opts: { customPath?: string }) => Promise<string[]>;
  probeVersion: (id: string, executablePath: string) => Promise<unknown>;
  listAgyModels: (executablePath: string) => Promise<unknown>;
  checkCodexAuth?: (executablePath: string) => Promise<unknown>;
  listCodexModels?: (executablePath: string) => Promise<unknown>;
  getCustomPath?: (id: string) => string;
  ttlMs?: number;
}

export interface DesktopDeps {
  desktopRoot: string;
  createDesktopHost(deps: CreateDesktopHostDeps): Promise<DesktopHost>;
  createProviderDiscovery(ports: ProviderDiscoveryPorts): ProviderDiscovery;
  localizeProviders(providers: ProbeResult[], language?: string): ProbeResult[];
  createAgyCompleteAdapter(config: unknown, opts: { runner: ProcessRunner; timeoutMs?: number }): CompleteFn | undefined;
  createCodexCompleteAdapter(config: unknown, opts: { runner: ProcessRunner; timeoutMs?: number }): CompleteFn | undefined;
  createOpenAiCompleteAdapter(config: unknown, opts?: { fetch?: typeof fetch; timeoutMs?: number }): CompleteFn | undefined;
  probeAgyModels(runner: ProcessRunner, executablePath: string): Promise<unknown>;
  probeCliVersion(runner: ProcessRunner, executablePath: string): Promise<unknown>;
  probeCodexAuth(runner: ProcessRunner, executablePath: string): Promise<unknown>;
  probeCodexModels(runner: ProcessRunner, executablePath: string): Promise<unknown>;
  listCandidatePaths(id: string, opts: { customPath?: string; env?: Record<string, string | undefined> }): Promise<string[]>;
  createProcessRunner(): ProcessRunner;
  spawnDetached(command: string, args: string[]): void;
  createInProcessJobExecutor(opts?: { log?: (...args: unknown[]) => void }): JobExecutor;
  createConfigStore(opts?: { env?: Record<string, string | undefined>; home?: string; documentsDir?: string }): DesktopConfigStore;
  createDesktopLibraryEvents(opts?: Record<string, unknown>): LibraryEventsPort;
  OPENAI_PRESETS: ReadonlyArray<{ id: string; name: string; baseUrl: string; defaultModel: string }>;
  redactDesktopConfig(config: RawDesktopConfig): {
    mode: DesktopMode;
    openai: { providerId: string; baseUrl: string; model: string; hasKey: boolean; keyLast4: string };
    agy: RawDesktopConfig['agy'];
    codex: RawDesktopConfig['codex'];
  };
  resolveEffectiveModel(config: RawDesktopConfig, providers?: ProbeResult[]): EffectiveModelState;
  normalizeDesktopConfig(raw: unknown): RawDesktopConfig;
  openableExternalUrl(value: unknown): string | null;
}

const MARKER = join('application', 'desktop-host.js');

/**
 * Locate `packages/studyhub-desktop`: `STUDYHUB_DESKTOP_ROOT`, else walk up from this module
 * (works from `src/host/` and from `dist/`).
 */
export function resolveDesktopRoot(env: Record<string, string | undefined> = process.env): string {
  const override = typeof env.STUDYHUB_DESKTOP_ROOT === 'string' ? env.STUDYHUB_DESKTOP_ROOT.trim() : '';
  if (override && existsSync(join(override, MARKER))) return resolve(override);
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    for (const candidate of [join(dir, 'studyhub-desktop'), join(dir, 'packages', 'studyhub-desktop')]) {
      if (existsSync(join(candidate, MARKER))) return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw Object.assign(new Error('Cannot locate packages/studyhub-desktop (set STUDYHUB_DESKTOP_ROOT)'), { code: 'desktop-missing' });
}

type Module = Record<string, unknown>;

let cached: Promise<DesktopDeps> | null = null;

/** Load (once) every desktop module the TUI host composes. */
export function loadDesktopDeps(): Promise<DesktopDeps> {
  cached ||= (async () => {
    const root = resolveDesktopRoot();
    const load = (rel: string): Promise<Module> => import(pathToFileURL(join(root, rel)).href) as Promise<Module>;
    const [hostMod, discoveryMod, agyMod, codexMod, candidatesMod, runnerMod, openaiMod, jobsMod, storeMod, watcherMod, policyMod, shimMod] =
      await Promise.all([
        load('application/desktop-host.js'),
        load('application/provider-discovery.js'),
        load('adapters/cli/agy-adapter.mjs'),
        load('adapters/cli/codex-adapter.mjs'),
        load('adapters/cli/candidate-paths.mjs'),
        load('adapters/cli/process-runner.mjs'),
        load('adapters/http/openai-adapter.mjs'),
        load('adapters/runtime/job-executor.mjs'),
        load('adapters/storage/config-store.mjs'),
        load('adapters/storage/library-watcher.mjs'),
        load('domain/config-policy.js'),
        load('domain/shim-parser.js'),
      ]);
    const deps = {
      desktopRoot: root,
      createDesktopHost: hostMod.createDesktopHost,
      createProviderDiscovery: discoveryMod.createProviderDiscovery,
      localizeProviders: discoveryMod.localizeProviders,
      createAgyCompleteAdapter: agyMod.createAgyCompleteAdapter,
      probeAgyModels: agyMod.probeAgyModels,
      probeCliVersion: agyMod.probeCliVersion,
      createCodexCompleteAdapter: codexMod.createCodexCompleteAdapter,
      probeCodexAuth: codexMod.probeCodexAuth,
      probeCodexModels: codexMod.probeCodexModels,
      listCandidatePaths: candidatesMod.listCandidatePaths,
      createProcessRunner: runnerMod.createProcessRunner,
      spawnDetached: runnerMod.spawnDetached,
      createOpenAiCompleteAdapter: openaiMod.createOpenAiCompleteAdapter,
      createInProcessJobExecutor: jobsMod.createInProcessJobExecutor,
      createConfigStore: storeMod.createConfigStore,
      createDesktopLibraryEvents: watcherMod.createDesktopLibraryEvents,
      OPENAI_PRESETS: policyMod.OPENAI_PRESETS,
      redactDesktopConfig: policyMod.redactDesktopConfig,
      resolveEffectiveModel: policyMod.resolveEffectiveModel,
      normalizeDesktopConfig: policyMod.normalizeDesktopConfig,
      openableExternalUrl: shimMod.openableExternalUrl,
    } as unknown as DesktopDeps;
    for (const [key, value] of Object.entries(deps)) {
      if (value === undefined) throw Object.assign(new Error(`studyhub-desktop export missing: ${key}`), { code: 'desktop-missing' });
    }
    return Object.freeze(deps);
  })();
  cached.catch(() => {
    cached = null;
  });
  return cached;
}
