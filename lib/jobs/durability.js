import { validateStoredJob } from './store.js';

const fail = code => Object.assign(new Error(code), { code });
/** Private lifecycle bookkeeping over the one manifest. No task state machine. */
export function createDurability(port, contract, restored = null) {
  for (const hook of ['validateInput', 'validateCheckpoint', 'reconcileCommit']) if (typeof port?.[hook] !== 'function') throw fail('recovery-unsupported');
  if (!port.store?.load || !port.store?.save) throw fail('recovery-unsupported');
  for (const sink of port.notifications || []) {
    if (!sink.channel || typeof sink.deliver !== 'function' || typeof sink.idempotent !== 'boolean') throw fail('invalid-notification-adapter');
  }
  const metadata = restored ? structuredClone(restored) : { schemaVersion: 1, revision: 0, inputRef: structuredClone(port.inputRef), checkpoint: null,
    executorWitness: null, requestIntents: [], commits: [], deliveries: [] };
  delete metadata.contract;
  let revision = restored?.revision ?? null, queue = Promise.resolve(), delivering = Promise.resolve();
  const persist = (snapshot = contract) => {
    const value = validateStoredJob({ ...structuredClone(metadata), contract: structuredClone(snapshot) });
    const pending = queue.then(async () => {
      const saved = await port.store.save(value, { expectedRevision: revision });
      revision = saved.revision; metadata.revision = revision;
    });
    queue = pending.catch(() => {}); return pending;
  };
  return Object.freeze({ metadata, port, persist,
    async preflight(definitionVersion) {
      const latest = await port.store.load();
      if ((latest?.revision ?? null) !== revision) throw fail('revision-conflict');
      if (contract.runtime.definitionVersion !== definitionVersion) throw fail('definition-version-mismatch');
      await port.validateInput(metadata.inputRef);
      // The ledger is only checked when there is usage to put into it: a damaged usage file must not keep a job that owes it nothing from starting.
      const owed = contract.calls.filter(item => item.accounting !== 'recorded' && (item.ledgerEvent || (item.modelRequest && item.tokenUsage)));
      if (owed.length) await port.validateAccounting?.();
      for (const call of owed) {
        if (typeof port.replayCall !== 'function') throw fail('ledger-invalid');
        try { await port.replayCall(structuredClone(call)); } catch { throw fail('ledger-invalid'); }
        call.accounting = 'recorded'; await persist();
      }
      if (metadata.checkpoint) await port.validateCheckpoint(metadata.checkpoint);
      // Only a request with a side effect leaves an intent; one still pending when the process died has an unknown outcome.
      if (metadata.requestIntents.some(intent => intent.status === 'pending')) throw fail('remote-result-unknown');
      for (const commit of [...metadata.commits]) {
        const receipt = await port.reconcileCommit(structuredClone(commit));
        if (!receipt) throw fail('artifact-conflict');
        if (receipt.notPublished === true) {
          if (commit.status === 'complete') throw fail('artifact-conflict');
          metadata.commits.splice(metadata.commits.indexOf(commit), 1);
        }
        else {
          commit.receipt = structuredClone(receipt); commit.status = 'complete';
          if (receipt.checkpoint) { await port.validateCheckpoint(receipt.checkpoint); metadata.checkpoint = structuredClone(receipt.checkpoint); }
        }
        await persist();
      }
    },
    // An intent exists to stop a blind resend of a request whose remote outcome is unknown. A request that changes nothing remote needs none:
    // if the process dies inside it, there is nothing to reconcile and it is simply asked again.
    async intent(call, { sideEffect = true } = {}) {
      if (!sideEffect) return;
      metadata.requestIntents.push({ callId: call.callId, attemptId: call.attemptId, stepKey: call.stepKey, stepRunId: call.stepRunId, status: 'pending' });
      await persist();
    },
    undispatched: call => settleIntent(call, 'not-dispatched'),
    completed: call => settleIntent(call, 'completed'),
    deliver() { const run = deliverSettled(); delivering = run.catch(() => {}); return run; },
    // Settles this instance's writes: in-flight settlement deliveries, then the persist queue. A rebinding waits for it,
    // so a second instance never starts from a revision the first one is still advancing.
    async drain() { await delivering; await queue; },
  });

  async function settleIntent(call, status) {
    const intent = metadata.requestIntents.find(item => item.callId === call.callId);
    if (!intent) return;
    intent.status = status; await persist();
  }

  async function deliverSettled() {
    const view = structuredClone(contract), event = view.events.find(item => item.eventId === `${view.jobId}:${view.attemptId || 'unstarted'}:settled`);
    if (!event) return;
    for (const sink of port.notifications || []) {
      let delivery = metadata.deliveries.find(item => item.eventId === event.eventId && item.channel === sink.channel);
      if (delivery && (delivery.status === 'delivered' || !sink.idempotent)) continue;
      if (!delivery) { delivery = { eventId: event.eventId, channel: sink.channel, status: 'claimed' }; metadata.deliveries.push(delivery); }
      else delivery.status = 'claimed';
      try {
        await persist();
        try { await sink.deliver(structuredClone(event), view); delivery.status = 'delivered'; }
        catch { delivery.status = 'failed'; }
        await persist();
      } catch { contract.detail.notificationError = 'delivery-record-unavailable'; }
    }
  }
}
