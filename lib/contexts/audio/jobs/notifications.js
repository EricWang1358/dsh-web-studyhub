import { notify } from '../../../inbox.js';
import { audioFacade } from './view.js';

/** Settled-event sinks of an audio import (single or batch): inbox letter, session announcement, input cleanup. */
export function audioNotifications(worker, cleanup) {
  return [
    { channel: 'inbox', idempotent: true, async deliver(_event, contract) {
      const job = audioFacade(contract);
      await worker.store.update(state => {
        for (const message of state.inbox || []) if (message.jobId === job.id) message.sourceIds = job.sourceIds;
        notify(state, { kind: job.status === 'complete' ? 'audio-result' : 'audio-failed', jobId: job.id,
          filename: job.filename, sourceIds: job.sourceIds, detail: job.stage });
      });
    } },
    { channel: 'session', idempotent: false, deliver(_event, contract) { worker.announceJob(audioFacade(contract)); } },
    { channel: 'input-cleanup', idempotent: true, async deliver(_event, contract) { if (contract.status === 'complete') await cleanup?.(); } },
  ];
}
