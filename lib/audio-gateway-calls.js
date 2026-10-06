import { languageSystem } from './language.js';
import { audioReasoning } from './audio-dashboard.js';
import { providerLevel } from './model-effort.js';

/* How an audio job's model and provider requests are made through the runtime gateway: each request is a step named after its kind and part,
   with the policy (purpose, effort, execution mode) every audio step shares and the labels and live-output bridge the console shows.
   The pipeline of an import, a subtitle file, a review and a saved class all ask for their text the same way. */

/** The policy of one audio step. Text steps follow the learner's reasoning setting; the host may run them as a sub-agent. */
export const audioPolicy = (settings, kind, executionMode = 'direct') => ({ purpose: kind || 'audio', feature: 'audio',
  requestedEffort: kind === 'transcribe' ? 'default' : audioReasoning(settings, kind), executionMode, budget: null });

/** What the console says about a request without opening it: its stage, part, file and how big its input was. */
const labelsOf = (job, meta) => Object.fromEntries(Object.entries({ stage: meta.stage, part: meta.part, parts: meta.parts, file: job.filename,
  slot: meta.slot, inputChars: meta.inputChars }).filter(([, value]) => value !== undefined && value !== null));

const outputBridge = (job, outputs) => ({
  open: callId => outputs.open(job.id, callId), append: (callId, text) => outputs.append(job.id, callId, text),
  reasoning: (callId, count) => outputs.reasoning(job.id, callId, count), close: callId => outputs.close(job.id, callId),
});

/** What a text request is known by before it is sent. */
const describe = (options, prompt) => ({ kind: options.kind, part: options.part, parts: options.parts, stage: options.stage || '文本处理',
  inputChars: String(prompt).length, slot: options.slot });

/**
 * The gateway side of one audio job. `track(meta, run)` wraps a request (or, with `meta.reused`, records that a saved result stood in for it),
 * `reuse(meta)` records a saved result, and `text(system, prompt, options)` asks the text model: the host's (a sub-agent when the host can)
 * or Gemini's, whichever the settings name. `tiers` must have been built with the same gateway so its requests are observed.
 */
export function gatewayCalls({ gateway, settings, job, outputs, tiers }) {
  const display = meta => ({ labels: labelsOf(job, meta), ...(outputs ? { output: outputBridge(job, outputs) } : {}) });
  const stepKey = meta => `${meta.kind || 'audio'}:${meta.part || 0}`;
  const track = async (meta, run) => {
    const step = gateway.step(stepKey(meta), audioPolicy(settings, meta.kind), display(meta));
    if (meta.reused) { await step.reuse(meta.reason); return run({ ...meta }); }
    return step.run(() => run({ ...meta }));
  };
  const reuse = meta => gateway.step(`${meta.kind}:${meta.part || 0}`, audioPolicy(settings, meta.kind), display(meta)).reuse('same-audio-and-settings');
  const host = (system, prompt, options = {}) => gateway.step(`${options.kind || 'text'}:${options.part || 0}`, audioPolicy(settings, options.kind, 'agent-preferred'),
    display(describe(options, prompt))).complete(languageSystem(system, job.language), prompt);
  const gemini = (system, prompt, options = {}) => track({ ...describe(options, prompt), runtime: 'gemini', reasoning: audioReasoning(settings, options.kind) },
    async task => tiers.complete(settings.textModel, languageSystem(system, job.language), prompt, { signal: options.signal, stage: options.kind,
      thinkingLevel: providerLevel(task.reasoning), label: '文本处理', onReasoning: reasoning => { task.reasoningEffort = reasoning; } }));
  return { track, reuse, text: settings.textProvider === 'host' ? host : gemini };
}
