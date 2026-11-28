// @ts-check
/**
 * When a spare `agy` process is started ahead of the next call, how long it may wait, and which calls it may answer.
 * A spare answers exactly one call: a second question sent to the same process continues the first one's conversation.
 */

/** @typedef {import('./contracts.js').AgyConfig} AgyConfig */
/** @typedef {import('./contracts.js').AgyPrewarm} AgyPrewarm */
/** @typedef {import('./contracts.js').DesktopConfig} DesktopConfig */
/** @typedef {{ executablePath: string, model: string, effort: string, timeoutMs: number }} AgyWarmSpec what a spare was started with; timeoutMs 0 = no limit */
/** @typedef {'call' | 'config' | 'expiry'} AgyWarmTrigger */
/** @typedef {{ action: 'release' } | { action: 'keep' } | { action: 'ensure', spec: AgyWarmSpec, idleMs: number, strict: boolean }} AgyWarmPlan */

/** @type {readonly AgyPrewarm[]} */
export const AGY_PREWARM_MODES = Object.freeze(['off', 'after-use', 'always']);
/** @type {AgyPrewarm} */
export const DEFAULT_AGY_PREWARM = 'after-use';
/** 「用过之后」: how long the spare waits for the next call before it exits. */
export const AGY_SPARE_KEEP_MS = 10 * 60 * 1000;
/** 「一直」: how old an unused spare may get before a fresh one takes its place. */
export const AGY_SPARE_RENEW_MS = 30 * 60 * 1000;

const MODES = new Set(AGY_PREWARM_MODES);

/**
 * @param {unknown} value
 * @returns {AgyPrewarm}
 */
export function normalizeAgyPrewarm(value) {
  return typeof value === 'string' && MODES.has(/** @type {AgyPrewarm} */ (value)) ? /** @type {AgyPrewarm} */ (value) : DEFAULT_AGY_PREWARM;
}

/**
 * The saved agy settings with this one filled in.
 * @template {{ executablePath?: unknown }} T
 * @param {T} section
 * @param {unknown} raw the agy section as it was read from the config file
 * @returns {T & { prewarm: AgyPrewarm }}
 */
export function withAgyPrewarm(section, raw) {
  const value = raw && typeof raw === 'object' ? /** @type {Record<string, unknown>} */ (raw).prewarm : undefined;
  return { ...section, prewarm: normalizeAgyPrewarm(value) };
}

/**
 * Apply a settings change to the already patched agy settings; a value that is not one of the three is refused.
 * @template {{ executablePath?: unknown }} T
 * @param {T} section
 * @param {unknown} patch
 * @returns {T}
 */
export function patchAgyPrewarm(section, patch) {
  const source = patch && typeof patch === 'object' ? /** @type {Record<string, unknown>} */ (patch) : {};
  if (source.prewarm === undefined) return section;
  if (!MODES.has(/** @type {AgyPrewarm} */ (source.prewarm))) {
    throw Object.assign(new Error('预热设置无效'), { code: 'invalid-prewarm' });
  }
  return { ...section, prewarm: source.prewarm };
}

/**
 * @param {{ executablePath?: unknown, model?: unknown, effort?: unknown } | null | undefined} cli
 * @param {number} timeoutMs
 * @returns {AgyWarmSpec}
 */
export function agyWarmSpec(cli, timeoutMs) {
  const text = (/** @type {unknown} */ value) => (typeof value === 'string' ? value.trim() : '');
  return { executablePath: text(cli?.executablePath), model: text(cli?.model), effort: text(cli?.effort), timeoutMs };
}

/**
 * The same program asked for the same model: what a settings change must share with a waiting spare to leave it alone.
 * @param {AgyWarmSpec} one
 * @param {AgyWarmSpec} other
 */
export function sameAgySource(one, other) {
  return one.executablePath === other.executablePath && one.model === other.model;
}

/**
 * May a spare started with `spare` answer a call that needs `call`? Model and effort are fixed when the process starts, and so is
 * the time limit agy is told: the call's own limit is kept by the runner, so a spare serves any call whose limit is no longer.
 * @param {AgyWarmSpec} spare
 * @param {AgyWarmSpec} call
 */
export function canServeAgyCall(spare, call) {
  if (!sameAgySource(spare, call) || spare.effort !== call.effort) return false;
  if (spare.timeoutMs === 0) return true;
  return call.timeoutMs > 0 && call.timeoutMs <= spare.timeoutMs;
}

/**
 * What to do about the spare. `strict` asks for exactly the model, effort and time limit in `spec` (after a call, so the next one
 * is likely to fit); otherwise a waiting spare of the same program and model is good enough.
 * @param {unknown} mode the saved setting
 * @param {AgyWarmTrigger} trigger a call is starting, the settings were read or saved, or the spare has waited its limit
 * @param {AgyWarmSpec} spec what the next spare would be started with
 * @returns {AgyWarmPlan}
 */
export function agyWarmPlan(mode, trigger, spec) {
  const setting = normalizeAgyPrewarm(mode);
  if (setting === 'off') return { action: 'release' };
  if (setting === 'always') return { action: 'ensure', spec, idleMs: AGY_SPARE_RENEW_MS, strict: trigger === 'call' };
  if (trigger === 'call') return { action: 'ensure', spec, idleMs: AGY_SPARE_KEEP_MS, strict: true };
  return trigger === 'config' ? { action: 'keep' } : { action: 'release' };
}

/**
 * What a spare would be started with for the saved settings: the effort is the one calls will ask for (the app-wide one first).
 * @param {DesktopConfig | null | undefined} config
 * @param {{ executablePath?: string, timeoutMs: number }} found the discovered program, used when the settings name none
 * @returns {AgyWarmSpec}
 */
export function agyConfigSpec(config, { executablePath = '', timeoutMs }) {
  return agyWarmSpec({
    executablePath: config?.agy?.executablePath || executablePath,
    model: config?.agy?.model,
    effort: config?.reasoningEffort || config?.agy?.effort,
  }, timeoutMs);
}

/**
 * The plan outside a call: nothing waits unless agy is the model in use and its program is known.
 * @param {DesktopConfig | null | undefined} config
 * @param {'config' | 'expiry'} trigger
 * @param {AgyWarmSpec} spec
 * @returns {AgyWarmPlan}
 */
export function agyWarmPlanForConfig(config, trigger, spec) {
  if (config?.mode !== 'agy' || !spec.executablePath) return { action: 'release' };
  return agyWarmPlan(config.agy?.prewarm, trigger, spec);
}
