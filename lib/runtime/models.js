import { validLanguage, languageSystem } from '../language.js';
import { defaultFetch } from '../gemini.js';
import { withModelRetry } from '../model-retry.js';
import { localizeAppMessage } from '../application-messages.js';
import { omitLocalImagePayloads } from '../study-image-markdown.js';
import { stripFootnoteHtml } from '../footnote-html.js';

export function modelServices(options = {}) {
  const language = validLanguage(options.language) ? options.language : undefined;
  const execution = request => language === 'en' && request && typeof request === 'object'
    ? { ...request, ...(request.stage ? { stage: localizeAppMessage(request.stage, language) } : {}) } : request;
  const prepared = (system, prompt) => {
    // A converted PDF's footnote HTML (lib/footnote-html.js) reaches the model as the footnote's words, never as tags.
    const clean = typeof prompt === 'string' ? stripFootnoteHtml(prompt) : prompt, text = omitLocalImagePayloads(clean);
    const note = text === clean ? '' : '\nLocal image bytes are omitted. Use only the surrounding text; do not infer or claim to see image contents.';
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
  // DSH's session query (`observeSession`): lets the jobs context read a finished sub-agent's final reply on demand (lib/session-reply.js).
  sessionQuery: options.sessionQuery,
  // Host port for retrieval providers (WP28): { tools(), call(), service() }; undefined where the host has none.
  retrieval: options.retrieval,
  // Cloud PDF conversion seam (tests and previews): { baseUrl, sleep, now, limits } standing in for MinerU's address, the clock and the piece limits.
  mineru: options.mineru,
  marker: options.marker,
  // Experimental Jev decision layer seam (tests and previews): { baseUrl, fetch, sleep, random, timeoutMs, maxRetries }.
  jev: options.jev,
  // Coverage runs (tests and previews): { roundLimit, roundTimeoutMs, fillRounds } standing in for the 30 questions of a round, the minutes one round may take and the retry rounds of a run (lib/coverage-run.js).
  coverage: options.coverage };
}
