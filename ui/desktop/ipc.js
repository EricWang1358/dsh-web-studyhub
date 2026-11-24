import { registerHostConcurrencyCap } from '../../lib/generation-settings.js';
export { createDesktopEventSubscription, parseSseFrames } from './events.js';

/* Tauri v2 IPC + HTTP RPC bridge for StudyHub Desktop.
   Falls back gracefully in plain browser QA when window.__TAURI_INTERNALS__ is absent. */

const DESKTOP_CAPABILITIES = Object.freeze({
  edition: 'desktop',
  chat: false,
  agentTasks: false,
  landing: false,
});

const concurrencyListeners = new Set();
let concurrencyState = Object.freeze({ maxConcurrency: undefined, defaultConcurrency: undefined });

/** True when running inside the Tauri v2 WebView with dynamic invoke available. */
export function hasTauriBridge() {
  return typeof globalThis.__TAURI_INTERNALS__?.invoke === 'function';
}

/** Invoke a Tauri v2 command safely without static @tauri-apps/api import coupling. */
export async function tauriInvoke(command, args) {
  const invoke = globalThis.__TAURI_INTERNALS__?.invoke;
  if (typeof invoke !== 'function') {
    throw new Error(`Tauri IPC unavailable for command: ${command}`);
  }
  return invoke(command, args);
}

/** Subscribe to a Tauri v2 event via __TAURI_INTERNALS__ without static @tauri-apps/api coupling. */
export async function listenTauriEvent(eventName, handler) {
  const internals = globalThis.__TAURI_INTERNALS__;
  if (typeof internals?.invoke !== 'function' || typeof internals?.transformCallback !== 'function') {
    return () => {};
  }
  const callbackId = internals.transformCallback((event) => {
    handler(event?.payload ?? event);
  });
  let eventId;
  try {
    eventId = await internals.invoke('plugin:event|listen', {
      event: eventName,
      target: { kind: 'Any' },
      handler: callbackId,
    });
  } catch {
    internals.unregisterCallback?.(callbackId);
    return () => {};
  }
  return () => {
    void internals.invoke('plugin:event|unlisten', { event: eventName, eventId }).catch(() => {});
    internals.unregisterCallback?.(callbackId);
  };
}

/** Check for a signed desktop update via Tauri `desktop_check_update`. */
export async function checkDesktopUpdate() {
  return tauriInvoke('desktop_check_update');
}

/** Download, verify signature, install, and restart StudyHub Desktop via Tauri `desktop_install_update`. */
export async function installDesktopUpdate({ onProgress } = {}) {
  const unlisten = typeof onProgress === 'function'
    ? await listenTauriEvent('desktop-update-progress', onProgress)
    : () => {};
  try {
    return await tauriInvoke('desktop_install_update');
  } finally {
    unlisten();
  }
}

/** Read sidecar connection info from Tauri IPC, or browser QA fallback globals. */
export async function loadBootstrapInfo() {
  if (hasTauriBridge()) {
    const info = await tauriInvoke('get_bootstrap_info');
    return {
      baseUrl: String(info?.baseUrl || '').replace(/\/+$/, ''),
      token: String(info?.token || ''),
      ...(info?.installFlavor ? { installFlavor: String(info.installFlavor) } : {}),
    };
  }
  return {
    baseUrl: '',
    token: String(globalThis.STUDY_TOKEN || ''),
  };
}

function normalizeEndpointInfo(info) {
  return Object.freeze({
    baseUrl: String(info?.baseUrl || '').replace(/\/+$/, ''),
    token: String(info?.token || ''),
  });
}

/** Reactive sidecar endpoint holder updated when Tauri's watchdog restarts the sidecar on a new port/token. */
export function createSidecarConnection(initialInfo = {}) {
  let current = normalizeEndpointInfo(initialInfo);
  const listeners = new Set();
  return {
    get: () => current,
    update: (next) => {
      const normalized = normalizeEndpointInfo(next);
      if (normalized.baseUrl === current.baseUrl && normalized.token === current.token) return current;
      current = normalized;
      for (const listener of listeners) listener(current);
      return current;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const DEFAULT_RPC_TIMEOUT_MS = 200_000;
const PAYLOAD_TOO_LARGE_MSG = '请求体超过单次传输上限，请刷新页面后重试（备份文件会自动分片上传）。';

function decodeSidecarResponse(response, envelope) {
  if (!envelope || typeof envelope !== 'object') {
    if (response.status === 413) return { error: Object.assign(new Error(PAYLOAD_TOO_LARGE_MSG), { code: 'payload-too-large' }) };
    return { error: new Error(`StudyHub sidecar returned HTTP ${response.status}`) };
  }
  if (!envelope.ok) {
    const rawMessage = envelope.code === 'payload-too-large' || response.status === 413
      ? PAYLOAD_TOO_LARGE_MSG
      : (envelope.error || 'StudyHub request failed');
    const error = new Error(rawMessage);
    if (envelope.code) error.code = envelope.code;
    if (envelope.details !== undefined) error.details = envelope.details;
    return { error };
  }
  return { value: envelope.value };
}

/** Create the StudyHub HTTP RPC transport (`POST ${baseUrl}/api/call` + `X-Study-Token`). */
export function createDesktopCall(connectionOrInfo = {}, { timeoutMs = DEFAULT_RPC_TIMEOUT_MS } = {}) {
  const getTarget = typeof connectionOrInfo?.get === 'function'
    ? () => connectionOrInfo.get()
    : () => normalizeEndpointInfo(connectionOrInfo);
  return async (action, args = {}) => {
    const { baseUrl, token } = getTarget();
    const signal = timeoutMs > 0 && typeof AbortSignal?.timeout === 'function'
      ? { signal: AbortSignal.timeout(timeoutMs) }
      : {};
    const response = await fetch(`${baseUrl}/api/call`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Study-Token': token,
      },
      body: JSON.stringify({ action, args }),
      ...signal,
    });
    let envelope = null;
    try {
      envelope = await response.json();
    } catch {
      envelope = null;
    }
    const decoded = decodeSidecarResponse(response, envelope);
    if (decoded.error) throw decoded.error;
    return decoded.value;
  };
}

/** Validate an http(s) URL before handing it to the OS browser. */
export function safeExternalUrl(href) {
  const raw = String(href ?? '').trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw, globalThis.location?.href || 'https://localhost/');
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.href;
    return null;
  } catch {
    return null;
  }
}

/** Open an external http(s) link via Tauri `open_external`, falling back to `app.open` RPC. */
export async function openExternalUrl(url, desktopCall) {
  const href = safeExternalUrl(url);
  if (!href) return { ok: false };
  if (hasTauriBridge()) {
    await tauriInvoke('open_external', { url: href });
    return { ok: true };
  }
  if (typeof desktopCall === 'function') {
    return desktopCall('app.open', { url: href });
  }
  return { ok: false };
}

/** Intercept external link clicks and window.open so Tauri WebView opens them in the system browser. */
export function installExternalLinkHandler(desktopCall) {
  if (typeof document === 'undefined' || typeof window === 'undefined') return () => {};
  const origOpen = window.open;
  const open = (href) => {
    void openExternalUrl(href, desktopCall).catch(() => {});
  };
  const onClick = (event) => {
    const anchor = event.target?.closest?.('a[href]');
    if (!anchor || event.defaultPrevented || anchor.hasAttribute('download')) return;
    const href = safeExternalUrl(anchor.getAttribute('href'));
    if (!href) return;
    const crossOrigin = new URL(href).origin !== window.location.origin;
    if (anchor.target !== '_blank' && !crossOrigin) return;
    event.preventDefault();
    open(href);
  };
  document.addEventListener('click', onClick, true);
  window.open = (...args) => {
    const href = safeExternalUrl(args[0]);
    if (href) {
      open(href);
      return null;
    }
    return typeof origOpen === 'function' ? origOpen.apply(window, args) : null;
  };
  return () => {
    document.removeEventListener('click', onClick, true);
    window.open = origOpen;
  };
}

/** Sync host concurrency cap from `desktop.config.get` / `desktop.config.save` effective info. */
export function syncDesktopConcurrency(effective) {
  const max = Number.isInteger(effective?.maxConcurrency) ? effective.maxConcurrency : undefined;
  const def = Number.isInteger(effective?.defaultConcurrency) ? effective.defaultConcurrency : undefined;
  if (max === concurrencyState.maxConcurrency && def === concurrencyState.defaultConcurrency) return;
  concurrencyState = Object.freeze({ maxConcurrency: max, defaultConcurrency: def });
  registerHostConcurrencyCap(max ? { max, ...(def ? { default: def } : {}) } : null);
  for (const listener of concurrencyListeners) listener(concurrencyState);
}

/** Read current desktop concurrency cap snapshot. */
export function readDesktopConcurrency() {
  return concurrencyState;
}

/** Subscribe to desktop concurrency cap changes (for reactive host object updates). */
export function subscribeDesktopConcurrency(listener) {
  concurrencyListeners.add(listener);
  return () => concurrencyListeners.delete(listener);
}

function buildTauriBridgeCapabilities(installFlavor) {
  if (!hasTauriBridge()) return {};
  return {
    pickDirectory: () => tauriInvoke('pick_directory'),
    pickFile: (pickerOptions) => tauriInvoke('pick_file', { extensions: pickerOptions?.extensions || [] }),
    updater: {
      check: () => checkDesktopUpdate(),
      install: (onProgress) => installDesktopUpdate({ onProgress }),
      ...(installFlavor ? { installFlavor } : {}),
    },
  };
}

/** Build the StudyHub Desktop host object matching the 4-field PLUGIN_HOST capabilities contract. */
export function createDesktopHost(desktopCall, concurrency = concurrencyState, subscribeLibraryEvents = null, options = {}) {
  const installFlavor = options?.installFlavor ? String(options.installFlavor) : undefined;
  return {
    capabilities: DESKTOP_CAPABILITIES,
    warmKey: 'studyhub-desktop',
    ...buildTauriBridgeCapabilities(installFlavor),
    openExternal: (url) => openExternalUrl(url, desktopCall),
    ...(typeof subscribeLibraryEvents === 'function' ? { subscribeLibraryEvents } : {}),
    ...(concurrency?.maxConcurrency ? { maxConcurrency: concurrency.maxConcurrency } : {}),
    ...(concurrency?.defaultConcurrency ? { defaultConcurrency: concurrency.defaultConcurrency } : {}),
  };
}
