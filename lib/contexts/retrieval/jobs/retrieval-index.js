import { buildIndex, canIngest, indexUnavailable, writeManifest } from '../../../retrieval-index.js';
import { RetrievalError } from '../../../retrieval.js';
import { INDEX_TEXT } from '../../../retrieval-messages.js';
import { adoptIndexProvider } from '../adopt-index.js';
import { createIndexPlanner } from '../index-plan.js';
import { INDEX_KIND, newRunState, presentIndex } from './retrieval-index-view.js';

const BUILD_STEP = { key: 'index', policy: { purpose: 'index', feature: 'retrieval', budget: null } };

/** The search-index build of one library. Every write goes to the extension through the host port in `binding`
 * (the existing ingest/delete tools); the manifest stays the checkpoint, the content hash and source key stay the identity.
 * Retry is not offered: the one entry is the start action, so a library never has two builds. Cancel stops after the write in flight. */
export const retrievalIndexDefinition = {
  kind: INDEX_KIND, version: 1, title: 'Search index',
  capabilities: { cancel: true, retry: false },

  async admit(context, input, binding) {
    if (!canIngest(binding.retrieval)) throw indexUnavailable();
    const state = newRunState(input.course);
    context.present(presentIndex(state));
    const prepared = await createIndexPlanner(binding).prepare(input.course);
    if (!prepared.picked.length) throw new Error(INDEX_TEXT.noSources);
    Object.assign(state, { prepared, total: prepared.plan.add.length + prepared.plan.remove.length, unchanged: prepared.plan.unchanged, firstRun: prepared.firstRun });
    binding.admitted?.();
    return { state };
  },

  async run(context, _input, binding) {
    const { state } = context.admission, { picked, library, manifest } = state.prepared;
    const save = async value => {
      try { await writeManifest(binding.state.root, value); state.unsaved = false; } catch (error) { state.unsaved = true; throw error; }
    };
    const step = context.gateway.step(BUILD_STEP.key, BUILD_STEP.policy);
    try {
      state.summary = await step.run(() => step.observe({ boundary: 'local-process', kind: BUILD_STEP.key }, async signal => ({
        value: await buildIndex({ port: binding.retrieval, sources: picked, library, manifest, firstRun: state.firstRun, signal, save,
          onItem: item => { state.inFlight = item; },
          onProgress: event => Object.assign(state, { phase: event.stage, done: event.done, total: event.total, inFlight: null }) }) })));
    } catch (error) {
      // A write the extension may already have taken is neither recorded nor called unwritten: the next build writes its key again.
      if (context.signal.aborted && state.inFlight) state.unconfirmed.push(state.inFlight);
      throw error;
    }
    if (state.unsaved) throw new RetrievalError('retrieval-manifest-unsaved', INDEX_TEXT.manifestUnsaved);
    Object.assign(state, { phase: 'done', done: state.total });
    await adoptIndexProvider(binding.retrieval);
    return { refs: [], completeness: state.summary.failed.length ? 'partial' : 'complete' };
  },
};
