import { TEXT_CONCURRENCY, clampCount, createPool } from '../../../audio-pool.js';
import { poolHooks } from '../../../audio-job.js';
import { AUDIO_TEXT } from '../../../audio-messages.js';
import { existingLiveSources, storeLive, storeLiveNotes, translateLive } from '../../../live-job.js';
import { addSourceCourses } from '../../../source-courses.js';
import { textJobModel } from './text-model.js';

const sourceRefs = ids => ids.filter(Boolean).map(id => ({ kind: 'source', id }));

/**
 * One attempt at proofreading and saving a live class: the same class already saved under the same settings is reused; otherwise the class is proofread,
 * translated and titled through the gateway's text model and its sources are published, with the class notes. Nothing is written once the attempt is no
 * longer current, nor once the class itself is gone (deleted while it was being saved): a save never brings a deleted class back.
 */
export async function runLiveSave(context, { worker, work, session }) {
  const { view, plan, settings, args } = context.admission.state, store = worker.audioStore, root = worker.store.root;
  const assertWritable = () => {
    context.signal.throwIfAborted();
    if (worker.sessions.registered(root, session.id) !== session) throw new Error(AUDIO_TEXT.liveGone);
  };
  // Every write of the save is fenced the same way; the notes go through the same door as the transcript.
  const guarded = { ...store, publishSources: records => { assertWritable(); return store.publishSources(records, { assertCurrent: assertWritable }); } };
  const existing = existingLiveSources(await store.read(), plan);
  if (existing.length) {
    assertWritable();
    await store.update(state => addSourceCourses(state, existing, plan.courses));
    const noteId = await storeLiveNotes(guarded, session, view.language);
    view.reused = true;
    return { refs: sourceRefs([...existing, noteId]), completeness: 'complete' };
  }
  const model = textJobModel(context, { worker, work }, { view, settings, paidOnly: args.paidOnly });
  const pools = { text: createPool({ limit: clampCount(settings.textConcurrency, TEXT_CONCURRENCY), ...poolHooks(view) }) };
  view.parallel = { text: pools.text.state };
  const result = await translateLive({ plan, job: view, settings, root, complete: model.complete, signal: context.signal, pools });
  assertWritable();
  const usage = model.finish();
  await storeLive({ store: guarded, plan, result, settings, usage, job: view });
  const noteId = await storeLiveNotes(guarded, session, view.language);
  return { refs: sourceRefs([...view.sourceIds, noteId]), completeness: 'complete' };
}
