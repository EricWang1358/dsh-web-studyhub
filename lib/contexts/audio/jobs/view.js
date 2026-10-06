import { jobContract } from '../../../job-contract.js';
import { LEGACY_AUDIO_TYPE } from '../../../audio-runtime-common.js';
import { AUDIO_TEXT, savedAs } from '../../../audio-messages.js';

/* What every audio job on the runtime shows: the working card its pipeline fills in (the shape readers of audio jobs have always
   known), the presentation reader the kernel asks for the console's title, stage, progress and detail, and the card notifications read. */

/** The card's value as plain data: what a field was never given (undefined) is not part of the record. */
const plain = value => JSON.parse(JSON.stringify(value));

export const sourceIdsOf = result => result.refs.filter(ref => ref.kind === 'source').map(ref => ref.id);

const stageOf = (view, observed) => {
  if (observed.status === 'complete') return view.reused ? AUDIO_TEXT.reused : savedAs(view.sourceIds.length, view.corrected);
  if (observed.status === 'cancelled') return AUDIO_TEXT.cancelled;
  return observed.error ? observed.error.message : view.stage;
};

/**
 * The presentation reader of one attempt: observed lifecycle + working card → public view.
 * `fields` are the card fields readers may read through the job record; `refresh(view, observed)` brings derived fields (tallies) up to date first.
 */
export function presentAudio(view, { fields, refresh = () => {} }) {
  return observed => {
    Object.assign(view, { id: observed.legacyId, status: observed.status, startedAt: observed.startedAt, finishedAt: observed.finishedAt,
      retryable: observed.status !== 'complete', sourceIds: sourceIdsOf(observed.result) });
    if (observed.status === 'complete') view.phase = 'done';
    refresh(view, observed);
    view.stage = stageOf(view, observed);
    const projected = jobContract({ ...view, type: LEGACY_AUDIO_TYPE });
    return { title: projected.title, stage: projected.stage, progress: projected.progress, detail: projected.detail,
      legacy: Object.fromEntries(fields.filter(key => view[key] !== undefined).map(key => [key, plain(view[key])])), events: projected.events };
  };
}

/** The legacy job shape that notifications and announcements read, rebuilt from a settled contract. */
export const audioFacade = contract => ({ ...contract.detail.legacy, id: contract.runtime.legacyId, type: LEGACY_AUDIO_TYPE,
  status: contract.status === 'interrupted' ? 'failed' : contract.status, stage: contract.error?.message || contract.stage.text || contract.stage.code,
  sourceIds: sourceIdsOf(contract.result) });
