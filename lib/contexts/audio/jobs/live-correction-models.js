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
  const reasoning = settings.liveCorrectionReasoning || 'low', gateway = context.gateway;
  const tiers = settings.textProvider === 'host' ? null : tiersFromSettings(settings, { fetch: worker.fetch, skipFree: session.paidOnly, gateway });
  let sequence = 0;
  const policy = (executionMode, timeoutMs) => ({ purpose: 'live.correct', feature: 'audio', requestedEffort: reasoning, executionMode,
    budget: { timeoutMs, maxOutputTokens: LIVE_CORRECTION.maxTokens } });
  const request = ({ name, mode, timeoutMs, stage, light = false }) => (system, prompt) => {
    const step = gateway.step(`${name}:${++sequence}`, policy(mode, timeoutMs), { labels: { stage }, ...(light && !tiers ? { model: 'light' } : {}) });
    return tiers ? step.run(() => tiers.complete(settings.liveTranslateModel, languageSystem(system, worker.language), prompt,
      { thinkingLevel: providerLevel(reasoning), label: stage })) : step.complete(system, prompt);
  };
  const complete = request({ name: 'live.correct', mode: 'direct', timeoutMs: LIVE_CORRECTION.requestMs, stage: AUDIO_TEXT.liveCorrectStage, light: true });
  const ask = request({ name: 'live.correct.background', mode: 'agent-preferred', timeoutMs: LIVE_CORRECTION.backgroundMs, stage: AUDIO_TEXT.liveBackgroundStage });
  // A host with neither a sub-agent nor a model to ask says so, in the learner's words; the request stays queued for a retry.
  const background = (system, prompt) => ask(system, prompt).catch(error => { throw UNAVAILABLE.includes(error?.code) ? new Error(AUDIO_TEXT.correctionNoModel) : error; });
  return { tiers, correct: makeCorrector({ complete, background, subject: session.subject, vocabulary: session.vocabulary,
    modelKey: `${settings.textProvider}:${settings.liveTranslateModel}:${reasoning}`, usage: tiers ? () => tiers.summary() : undefined }) };
}
