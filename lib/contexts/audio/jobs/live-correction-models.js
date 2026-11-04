import { makeCorrector } from '../../../live-correction.js';
import { LIVE_CORRECTION } from '../../../live-correction-settings.js';
import { AUDIO_TEXT } from '../../../audio-messages.js';
import { languageSystem } from '../../../language.js';
import { providerLevel } from '../../../model-effort.js';
import { tiersFromSettings } from '../../../gemini.js';

const UNAVAILABLE = ['model-unavailable', 'agent-unavailable', 'execution-mode-unsupported'];

/**
 * The model of a live class's correction on a Job: the batch request and the background request about older sentences, each a step of the Job's gateway
 * with its own time budget (the gateway stops the request, nothing races it). The batch request goes to the host's light lane; the background request
 * may run as a sub-agent of the host and falls back to a direct request where the host has none. Same policy key as the correction was made with.
 */
export function liveCorrectionModels(context, { worker }, { settings, session }) {
  const reasoning = settings.liveCorrectionReasoning || 'low', gateway = context.gateway, host = settings.textProvider === 'host';
  // Gemini answers when it was chosen and stands by (keys set) when the conversation model was: a model that answers in prose hands over to the other.
  const gemini = !host || settings.freeKey || settings.paidKey ? tiersFromSettings(settings, { fetch: worker.fetch, skipFree: session.paidOnly, gateway }) : null;
  const tiers = host ? null : gemini;
  let sequence = 0;
  const policy = (executionMode, timeoutMs, maxOutputTokens) => ({ purpose: 'live.correct', feature: 'audio', requestedEffort: reasoning, executionMode,
    budget: { timeoutMs, maxOutputTokens } });
  // The time and the reply a request is allowed grow with the characters of its sentences (the correction passes them as options); the fixed values are the floors.
  const request = ({ name, mode, timeoutMs, stage, light = false, via = tiers }) => (system, prompt, options = {}) => {
    const maxOutputTokens = options.maxOutputTokens || LIVE_CORRECTION.maxTokens;
    const budget = policy(mode, options.timeoutMs || timeoutMs, maxOutputTokens);
    const step = gateway.step(`${name}:${++sequence}`, budget, { labels: { stage }, ...(light && !via ? { model: 'light' } : {}) });
    return via ? step.run(() => via.complete(settings.liveTranslateModel, languageSystem(system, worker.language), prompt,
      { thinkingLevel: providerLevel(reasoning), label: stage, maxOutputTokens })) : step.complete(system, prompt);
  };
  const batch = { name: 'live.correct', mode: 'direct', timeoutMs: LIVE_CORRECTION.requestMs, stage: AUDIO_TEXT.liveCorrectStage, light: true };
  const complete = request(batch);
  // The other model of a batch request: Gemini behind the conversation model, the conversation model's light lane behind Gemini.
  const fallback = host ? (gemini ? request({ ...batch, via: gemini }) : null) : request({ ...batch, via: null });
  const ask = request({ name: 'live.correct.background', mode: 'agent-preferred', timeoutMs: LIVE_CORRECTION.backgroundMs, stage: AUDIO_TEXT.liveBackgroundStage });
  // A host with neither a sub-agent nor a model to ask says so, in the learner's words; the request stays queued for a retry.
  const background = (system, prompt, options) => ask(system, prompt, options)
    .catch(error => { throw UNAVAILABLE.includes(error?.code) ? new Error(AUDIO_TEXT.correctionNoModel) : error; });
  return { tiers, correct: makeCorrector({ complete, background, fallback, subject: session.subject, vocabulary: session.vocabulary,
    modelKey: `${settings.textProvider}:${settings.liveTranslateModel}:${reasoning}`, usage: tiers ? () => tiers.summary() : undefined }) };
}
