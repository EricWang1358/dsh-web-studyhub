/* The process that dies (tests/generation-run-crash.test.mjs): a coverage run against a fake model, in a process of its own, ended by process.exit at one chosen moment. No cleanup runs, so what is on disk is
   what a killed host leaves. A window is a predicate over the draft in a write of the library: `before` dies with that write not made, `after` with it made. Windows on the model die at a call. */
import { pathToFileURL } from 'node:url';
import { StudyService } from '../../lib/service.js';
import { Store } from '../../lib/store.js';
import { clusteringModel } from '../helpers/clustering-model.mjs';
import { managedRuntimeOptions } from '../helpers/runtime-switch.mjs';
import { corpusWorld, CORPUS_ROUND_LIMIT, weighing } from '../helpers/record-run-corpus.mjs';
import { mergedTranscript } from '../helpers/merged-transcript.mjs';
import { coverageForDraft } from '../../lib/coverage-state.js';
import { wantedUncovered } from '../../lib/coverage-run.js';

const round = (draft, index) => draft?.editorial?.coverageSpec?.rounds?.[index]?.status;
export const WINDOWS = Object.freeze({
  'before-first-draft': { code: 81, model: true },
  'first-part-saved': { code: 82, after: draft => round(draft, 0) === 'running' && draft.cards.length > 0 },
  'round-1-done-unsaved': { code: 83, before: draft => round(draft, 1) === 'running' },
  'round-2-running-saved': { code: 84, after: draft => round(draft, 1) === 'running' },
  'round-2-part-saved': { code: 85, after: draft => round(draft, 1) === 'running' && draft.cards.length > 8 },
  'last-question-saved': { code: 86, after: (draft, goal) => draft.cards.length >= goal },
  'closing-unsaved': { code: 87, before: draft => draft?.editorial?.coverageRun?.state === 'complete' },
  'closing-saved': { code: 88, after: draft => draft.editorial?.coverageRun?.state === 'complete' },
  'closing-saved-short': { code: 91, after: draft => draft.editorial?.coverageRun?.stop?.reason === 'questions-short' },
  paused: { code: 89, after: draft => draft.editorial?.coverageRun?.state === 'paused', pauseAtCall: true },
  // The last round, with every section at its first question and the round's other parts still in flight: nothing is left to ask, and questions are still owed.
  'every-section-covered': { code: 90, after: (draft, _goal, state) => isFullyCovered(draft, state) },
});
function isFullyCovered(draft, state) {
  const spec = draft?.editorial?.coverageSpec;
  if (!spec?.quotas?.length || draft.editorial.coverageRun?.state !== 'running' || !draft.cards.length) return false;
  const view = coverageForDraft(state, draft);
  return !wantedUncovered(spec, view).size && spec.quotas.every(quota => view.sections.some(section => section.key === quota.sectionId));
}
/** A world of a test: the material, what is asked of it and how large a round is. */
export const worldOf = ({ world, roundLimit = CORPUS_ROUND_LIMIT } = {}) => ({ world: world ? mergedTranscript(world) : corpusWorld(), roundLimit });
export const MODES = Object.freeze({ legacy: [], generation: ['generation'], restart: ['generation', 'generationRestart'] });

/** The service options of a mode: the runtime's switches and a fixture host, or nothing. */
export function modeOptions(mode, complete) {
  if (!MODES[mode].length) return {};
  const { starts: _starts, ...options } = managedRuntimeOptions({ complete, paths: MODES[mode] });
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [root, name, mode, pauseAt, given] = process.argv.slice(2), scenario = JSON.parse(given || '{}'), window = WINDOWS[name], goal = 19, { world, roundLimit } = worldOf(scenario);
  const write = Store.prototype.update;
  Store.prototype.update = async function (fn, ...rest) {
    const result = await write.call(this, async state => {
      const out = await fn(state);
      if (window.before?.(state.drafts?.[0], goal)) process.exit(window.code);
      return out;
    }, ...rest);
    return result;
  };
  const after = Store.prototype.update;
  Store.prototype.update = async function (fn, ...rest) {
    let hit = false;
    const result = await after.call(this, async state => { const out = await fn(state); const draft = state.drafts?.[0]; hit = !!draft && !!window.after?.(draft, goal, state); return out; }, ...rest);
    if (hit) process.exit(window.code);
    return result;
  };
  const inner = clusteringModel().complete;
  let calls = 0, jobId, service;
  const complete = async (system, prompt, context = {}) => {
    calls += 1;
    if (window.model) process.exit(window.code);
    if (window.pauseAtCall && calls === Number(pauseAt)) await service.call('job.control', { jobId, action: 'pause' });
    return inner(system, prompt, context);
  };
  service = new StudyService(root, { coverage: { roundLimit }, ...modeOptions(mode, complete) });
  service.light = weighing;
  service.complete = complete;
  // `direct`: a second life, over what the first one left: 接着做 through generate itself, which is a new logical job and not a retry of the one that was interrupted.
  if (scenario.direct) {
    await service.call('snapshot');
    const draft = (await service.call('export')).drafts[0];
    ({ jobId } = await service.call('generate', { resumeDraftId: draft.id, draftVersion: draft.draftVersion, coverage: { run: true } }));
  } else {
    for (const source of world.sources) await service.call('source.add', { id: source.id, title: source.title, text: source.text, audio: source.audio });
    ({ jobId } = await service.call('generate', { sourceIds: world.sources.map(source => source.id), coverageLevel: 'standard', kind: 'quiz', ...(scenario.count ? { count: scenario.count } : {}) }));
  }
  await service.call('job.wait', { jobId, timeoutSeconds: 60 });
  process.exit(70); // Nothing killed it: the window was never reached.
}
