import { validLanguage, languageSystem } from '../language.js';
import { defaultFetch } from '../gemini.js';
import { withModelRetry } from '../model-retry.js';
import { localizeAppMessage } from '../application-messages.js';

export function modelServices(options = {}) {
  const language = validLanguage(options.language) ? options.language : undefined;
  const execution = request => language === 'en' && request && typeof request === 'object'
    ? { ...request, ...(request.stage ? { stage: localizeAppMessage(request.stage, language) } : {}) } : request;
  const localized = model => model && Object.assign((system, prompt, ...args) => model(languageSystem(system, language), prompt, ...args.map(execution)),
    model.spawnCorrection ? { spawnCorrection: (system, prompt, request) => model.spawnCorrection(languageSystem(system, language), prompt, execution(request)) } : {});
  const complete = localized(options.complete);
  const route = options.completeLight || (options.complete && Object.assign((system, prompt) => options.complete(system, prompt),
    options.complete.spawnCorrection ? { spawnCorrection: options.complete.spawnCorrection } : {}));
  const light = localized(options.light || route);
  return { complete, light: light && Object.assign((system, prompt, request) => withModelRetry(() => light(system, prompt, request)),
    light.spawnCorrection ? { spawnCorrection: light.spawnCorrection } : {}),
  language, coach: !!options.coach, notify: typeof options.notify === 'function' ? options.notify : null,
  fetch: options.fetch || defaultFetch, WebSocket: options.WebSocket || globalThis.WebSocket, audioSettings: options.audioSettings,
  tokenMeter: options.tokenMeter };
}
