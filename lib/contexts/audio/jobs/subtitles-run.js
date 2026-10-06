import { TEXT_CONCURRENCY, clampCount, createPool } from '../../../audio-pool.js';
import { poolHooks } from '../../../audio-job.js';
import { gatewayCalls } from '../../../audio-gateway-calls.js';
import { tiersFromSettings } from '../../../gemini.js';
import { addSourceCourses } from '../../../source-courses.js';
import { existingSubtitleSources, storeSubtitle, translateSubtitle } from '../../../subtitle-job.js';

const sourceRefs = ids => ids.map(id => ({ kind: 'source', id }));

/**
 * One attempt at a subtitle import: the same plan already imported is reused; otherwise proofread, translate and title the text through the gateway
 * (its host or Gemini text model) and publish the sources in one write that is refused once the attempt is no longer current.
 * The state of the attempt (card, plan, settings, context) is on the admission lease.
 */
export async function runSubtitles(context, { worker, work }) {
  const { view, plan, settings, args } = context.admission.state, store = worker.audioStore;
  const existing = existingSubtitleSources(await store.read(), plan);
  if (existing.length) {
    context.signal.throwIfAborted();
    await store.update(state => addSourceCourses(state, existing, plan.courses));
    view.reused = true;
    return { refs: sourceRefs(existing), completeness: 'complete' };
  }
  const tiers = tiersFromSettings(settings, { fetch: worker.fetch, skipFree: args.paidOnly === true, gateway: context.gateway });
  const calls = gatewayCalls({ gateway: context.gateway, settings, job: view, outputs: work.jobOutputs, tiers });
  const pools = { text: createPool({ limit: clampCount(settings.textConcurrency, TEXT_CONCURRENCY), ...poolHooks(view) }) };
  view.parallel = { text: pools.text.state };
  const result = await translateSubtitle({ plan, job: view, settings, root: store.root, complete: calls.text, signal: context.signal, pools });
  context.signal.throwIfAborted();
  const usage = tiers.summary();
  for (const text of tiers.warnings) if (!view.warnings.includes(text)) view.warnings.push(text);
  let sources;
  await storeSubtitle({ store: { publishSources: records => { sources = records; } }, plan, result, settings, usage, job: view });
  view.usageRun = usage;
  await store.publishSources(sources, { assertCurrent: () => context.signal.throwIfAborted() });
  return { refs: sourceRefs(sources.map(source => source.id)), completeness: 'complete' };
}
