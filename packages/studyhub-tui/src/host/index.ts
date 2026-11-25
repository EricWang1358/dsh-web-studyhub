/** StudyHub TUI host & provider layer — public API. */
export {
  createTuiHost,
  isUnconfiguredDesktopConfig,
  overlayEnvProvider,
  normalizeCallAnswer,
  externalOpener,
  normalizeHostEnv,
  TUI_CONFIG_CHANGED_EVENT,
  type AutoProbeOutcome,
  type AutoProbeResult,
  type CreateTuiHostOptions,
  type RefreshResult,
  type StreamCompleteParams,
  type TuiConfigSnapshot,
  type TuiHost,
} from './tui-host.js';
export {
  AGY_MODEL_PREFERENCE,
  TUI_OPENAI_PRESETS,
  describeEnvDetection,
  detectEnvProviders,
  detectPrimaryEnvProvider,
  findPreset,
  isUsableApiKey,
  isUsableBaseUrl,
  matchPresetByBaseUrl,
  pickAgyModel,
  presetConfigPatch,
  presetsForSnapshot,
  type EnvProviderDetection,
  type TuiOpenAiPreset,
} from './presets.js';
export {
  DEFAULT_TUI_PREFERENCES,
  MAX_RECENT_COMMANDS,
  THEME_IDS,
  TuiPreferencesSchema,
  UI_LANGUAGES,
  loadTuiPreferences,
  loadTuiPreferencesSafe,
  parseTuiPreferences,
  resolveStudyHome,
  saveTuiPreferences,
  tuiPreferencesPath,
  type TuiPrefsLocation,
} from './tui-prefs.js';
export * from './sample-actions.js';
export { loadDesktopDeps, resolveDesktopRoot, type CompleteFn, type CompleteExecution, type ProviderDiscovery, type ProbeResult } from './desktop-deps.js';
