import { errorOf, iso, terminal } from './shared.js';

/** Logical settlement: persistence, the one settled event, observer release, stop. */
export function settlementOps(k) {
  const persist = entry => { k.refresh(entry.job.contract, entry); return entry.durable?.persist(); };

  const settleObserver = entry => {
    // Delivery belongs to this Attempt's observer, even if a retry starts while
    // a notification is still draining. It never holds the physical executor.
    const id = entry.job.id, logical = entry.logical, resolve = entry.resolveLogical;
    const finish = () => { if (k.work.settled.get(id) === logical) k.work.settled.delete(id); resolve(); };
    const delivered = entry.durable?.deliver();
    if (entry.durable?.port.waitForDelivery) {
      k.work.settled.set(id, logical);
      void delivered.catch(() => {}).finally(finish);
    } else { void delivered?.catch(() => {}); finish(); }
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
  };

  return { persist, settleObserver, addSettledEvent, finishLogical, stop, stopWhere };
}
