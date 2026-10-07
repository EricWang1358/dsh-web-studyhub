import { errorOf, iso, terminal } from './shared.js';

/** Logical settlement: persistence, the one settled event, observer release, stop. */
export function settlementOps(k) {
  const persist = entry => { k.refresh(entry.job.contract, entry); return entry.durable?.persist(); };

  const settleObserver = entry => {
    // Delivery belongs to this Attempt's observer, even if a retry starts while
    // a notification is still draining. It never holds the physical executor.
    const id = entry.job.id, logical = entry.logical, resolve = entry.resolveLogical;
    const finish = () => { if (k.work.settled.get(id) === logical) k.work.settled.delete(id); resolve(); };
    const delivered = entry.durable ? entry.durable.deliver() : entry.definition.notifications ? deliverTransient(entry) : undefined;
    if (entry.durable ? entry.durable.port.waitForDelivery : delivered) {
      k.work.settled.set(id, logical);
      void delivered.catch(() => {}).finally(finish);
    } else { void delivered?.catch(() => {}); finish(); }
  };

  // A definition without persistence still announces its settlement once, in process, before observers resume.
  // A sink gets the bindings the job was submitted with (its submitter's own services). A failed sink is recorded on the detail and never changes the outcome.
  const deliverTransient = async entry => {
    const c = entry.job.contract, view = structuredClone(c);
    const event = view.events.find(item => item.eventId === `${view.jobId}:${view.attemptId || 'unstarted'}:settled`);
    if (!event) return;
    for (const sink of entry.definition.notifications) {
      try { await sink.deliver(structuredClone(event), structuredClone(view), entry.bindings); } catch { c.detail.notificationError = 'delivery-failed'; }
    }
  };

  const addSettledEvent = contract => {
    const eventId = `${contract.jobId}:${contract.attemptId || 'unstarted'}:settled`;
    if (!contract.events.some(event => event.eventId === eventId)) contract.events.push({ eventId, type: 'settled', at: contract.finishedAt, status: contract.status });
  };

  const finishLogical = async entry => {
    const c = entry.job.contract;
    if (!terminal(c.status) || entry.notified) return;
    c.finishedAt ||= iso();
    addSettledEvent(c);
    await persist(entry); entry.notified = true;
    k.refresh(c, entry); settleObserver(entry);
  };

  const stop = (entry, reason = 'user-cancel', fromHost = false) => {
    const c = entry.job.contract;
    if (entry.settling) return k.snapshot(entry);
    if (entry.restored && c.runtime.activeAttemptId) return k.snapshot(entry);
    if (terminal(c.status) || c.status === 'cancelling') return k.snapshot(entry);
    entry.stopReason = reason;
    if (!c.runtime.activeAttemptId) {
      c.status = 'cancelled'; c.endReason = 'user-cancel';
      void finishLogical(entry).catch(error => { c.detail.durabilityError = error.code || 'store-write-failed'; entry.resolveLogical(); });
      return k.snapshot(entry);
    }
    c.status = 'cancelling'; c.stage = { code: 'cancelling' }; c.runtime.attempts.at(-1).status = 'cancelling';
    entry.controller.abort(errorOf(reason));
    if (!fromHost) try { entry.handle?.stop(reason); } catch { c.detail.stopConfirmation = 'unknown'; }
    return k.snapshot(entry);
  };

  const stopWhere = async predicate => {
    const selected = k.all().filter(predicate);
    for (const entry of selected) stop(entry, 'scope-unloaded');
    await Promise.all(selected.map(entry => entry.physical));
    // A closed scope leaves nothing on its way to a manifest (a delivery being recorded): the next process must read the revision this one last wrote.
    await Promise.all(selected.map(entry => entry.durable?.drain()));
  };

  return { persist, settleObserver, addSettledEvent, finishLogical, stop, stopWhere };
}
