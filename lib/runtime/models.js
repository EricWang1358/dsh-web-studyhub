import { validLanguage, languageSystem } from '../language.js';
import { defaultFetch } from '../gemini.js';
import { withModelRetry } from '../model-retry.js';
import { localizeAppMessage } from '../application-messages.js';
import { omitLocalImagePayloads } from '../study-image-markdown.js';

export function modelServices(options = {}) {
  const language = validLanguage(options.language) ? options.language : undefined;
  const execution = request => language === 'en' && request && typeof request === 'object'
    ? { ...request, ...(request.stage ? { stage: localizeAppMessage(request.stage, language) } : {}) } : request;
  const prepared = (system, prompt) => {
    const text = omitLocalImagePayloads(prompt);
    const note = text === prompt ? '' : '\nLocal image bytes are omitted. Use only the surrounding text; do not infer or claim to see image contents.';
    return [languageSystem(system, language) + note, text];
  };
  const localized = model => model && Object.assign((system, prompt, ...args) => model(...prepared(system, prompt), ...args.map(execution)),
    model.spawnCorrection ? { spawnCorrection: (system, prompt, request) => model.spawnCorrection(...prepared(system, prompt), execution(request)) } : {});
  const complete = localized(options.complete);
  const route = options.completeLight || (options.complete && Object.assign((system, prompt) => options.complete(system, prompt),
    options.complete.spawnCorrection ? { spawnCorrection: options.complete.spawnCorrection } : {}));
  const light = localized(options.light || route);
  return { complete, light: light && Object.assign((system, prompt, request) => withModelRetry(() => light(system, prompt, request)),
    light.spawnCorrection ? { spawnCorrection: light.spawnCorrection } : {}),
  language, coach: !!options.coach, notify: typeof options.notify === 'function' ? options.notify : null,
  fetch: options.fetch || defaultFetch, WebSocket: options.WebSocket || globalThis.WebSocket, audioSettings: options.audioSettings,
  tokenMeter: options.tokenMeter,
  // Host port for retrieval providers (WP28): { tools(), call(), service() }; undefined where the host has none.
  retrieval: options.retrieval,
  // Cloud PDF conversion seam (tests and previews): { baseUrl, sleep, now, limits } standing in for MinerU's address, the clock and the piece limits.
  mineru: options.mineru,
  // Experimental Jev decision layer seam (tests and previews): { baseUrl, fetch, sleep, random, timeoutMs, maxRetries }.
  jev: options.jev };
}
