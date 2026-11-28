// @ts-check

/** @typedef {'agy' | 'claude' | 'codex'} ProviderId */
/** @typedef {'ready' | 'unauthenticated' | 'broken-shim' | 'not-installed' | 'coming-soon'} ProviderStatus */
/** @typedef {'openai' | 'agy' | 'codex'} DesktopMode */
/** @typedef {'' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'} AgyEffort */
/** @typedef {'off' | 'after-use' | 'always'} AgyPrewarm when a spare agy waits for the next call (see agy-warm-policy.js) */
/** @typedef {'' | 'low' | 'medium' | 'high' | 'xhigh'} CodexEffort */
/** @typedef {'ok' | 'no-credential' | 'no-route'} EffectiveReason */

/**
 * @typedef {object} CliModelInfo
 * @property {string} id
 * @property {string} name
 */

/**
 * @typedef {object} ProbeResult
 * @property {ProviderId} id
 * @property {string} name
 * @property {boolean} supported
 * @property {'account' | 'api-key' | 'unknown'} [authMethod] how a ready codex is signed in (an account, or an API key billed per use)
 * @property {ProviderStatus} status
 * @property {string | null} executablePath
 * @property {string | null} version
 * @property {string} reason
 * @property {string} [reasonCode]
 * @property {Record<string, string>} [reasonParams]
 * @property {CliModelInfo[]} [models]
 */

/**
 * @typedef {object} OpenAiPreset
 * @property {string} id
 * @property {string} name
 * @property {string} baseUrl
 * @property {string} defaultModel
 */

/**
 * @typedef {object} OpenAiConfig
 * @property {string} providerId
 * @property {string} baseUrl
 * @property {string} model
 * @property {string} apiKey
 */

/**
 * @typedef {object} OpenAiConfigView
 * @property {string} providerId
 * @property {string} baseUrl
 * @property {string} model
 * @property {boolean} hasKey
 * @property {string} keyLast4
 */

/**
 * @typedef {object} AgyConfig
 * @property {string} executablePath
 * @property {string} model
 * @property {AgyEffort} effort
 * @property {AgyPrewarm} prewarm
 */

/**
 * @typedef {object} CodexConfig
 * @property {string} executablePath
 * @property {string} model
 * @property {CodexEffort} effort
 */

/**
 * @typedef {object} DesktopConfig
 * @property {DesktopMode} mode
 * @property {OpenAiConfig} openai
 * @property {AgyConfig} agy
 * @property {CodexConfig} codex
 * @property {string} libraryRoot
 * @property {boolean} libraryPlaceConfirmed the learner has chosen (or accepted) where the library lives; false until then
 * @property {string} reasoningEffort
 */

/**
 * @typedef {object} LibraryPlace
 * @property {boolean} confirmed
 * @property {boolean} onSystemDrive
 */

/**
 * How the model in use is reached: through the learner's API Key, or through a CLI on this computer.
 * @typedef {object} ModelVia
 * @property {'api' | 'cli'} kind
 * @property {string} name
 * @property {'account' | 'per-use' | 'unknown'} billing what the model costs: an account's quota, a charge per use, or not known
 */

/**
 * @typedef {object} EffectiveModelState
 * @property {boolean} ready
 * @property {string} label
 * @property {EffectiveReason} reason
 * @property {string} provider
 * @property {string} model
 * @property {number | null} maxConcurrency
 * @property {number | null} defaultConcurrency
 */

/**
 * @typedef {object} UsageBuckets
 * @property {number} inputTokens
 * @property {number} uncachedInputTokens
 * @property {number} outputTokens
 * @property {number} cacheReadTokens
 * @property {number} cacheWriteTokens
 * @property {number} [reasoningTokens]
 */

/**
 * @typedef {object} CompletionExecution
 * @property {AbortSignal} [signal]
 * @property {number} [maxTokens]
 * @property {string} [task]
 * @property {(chunk: string) => void} [onOutput]
 * @property {(chunk: string) => void} [onChunk]
 */

/**
 * @typedef {(system: string, prompt: string, execution?: CompletionExecution) => Promise<string>} CompletionPort
 */

/**
 * @typedef {object} ProcessRunRequest
 * @property {string} command
 * @property {string[]} [args]
 * @property {string} [cwd]
 * @property {Record<string, string | undefined>} [env]
 * @property {string} [stdinText]
 * @property {number} [timeoutMs]
 * @property {AbortSignal} [signal]
 * @property {number} [maxOutputBytes]
 * @property {(line: string) => void} [onStdoutLine]
 */

/**
 * @typedef {object} ProcessRunResult
 * @property {number | null} code
 * @property {string | null} signal
 * @property {string} stdout
 * @property {string} stderr
 * @property {boolean} timedOut
 * @property {boolean} aborted
 * @property {boolean} truncated
 * @property {string | null} errorCode
 * @property {string | null} errorMessage
 * @property {number} durationMs
 */

/**
 * @typedef {object} ProcessRunnerPort
 * @property {(request: ProcessRunRequest) => Promise<ProcessRunResult>} run
 * @property {(command: string, args: string[]) => void} [spawnDetached]
 */

/**
 * @typedef {object} DesktopCapabilities
 * @property {'desktop'} edition
 * @property {false} chat
 * @property {false} agentTasks
 * @property {false} landing
 */

/** @type {Readonly<DesktopCapabilities>} */
export const DESKTOP_CAPABILITIES = Object.freeze({
  edition: 'desktop',
  chat: false,
  agentTasks: false,
  landing: false,
});

/** @type {readonly ProviderId[]} */
export const ALL_CLI_PROVIDERS = Object.freeze(['agy', 'claude', 'codex']);

/** @type {readonly ProviderId[]} */
export const SUPPORTED_CLI_PROVIDERS = Object.freeze(['agy', 'codex']);

/** @type {Readonly<Record<ProviderId, string>>} */
export const PROVIDER_DISPLAY_NAMES = Object.freeze({
  agy: 'Antigravity CLI (agy)',
  claude: 'Claude Code CLI',
  codex: 'Codex CLI',
});
