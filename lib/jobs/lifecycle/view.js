import { validateRuntimeContract } from '../contract.js';
import { LIMITS } from '../limits.js';
import { ACTIONS, denied, errorOf, terminal } from './shared.js';

const PRESENTATION_KEYS = ['title', 'stage', 'progress', 'detail', 'legacy', 'events'];
const PATCHED_KEYS = ['title', 'stage', 'progress'];

/** Public view of a record: domain presentation, available actions, snapshot. */
export function viewOps(k) {
  const present = (contract, entry) => {
    if (!entry?.presentation || entry.presenting) return;
    entry.presenting = true;
    try {
      const value = entry.presentation({ status: contract.status, legacyId: contract.runtime.legacyId, attemptId: contract.attemptId,
        result: structuredClone(contract.result), error: structuredClone(contract.error), calls: structuredClone(contract.calls),
        startedAt: contract.startedAt, finishedAt: contract.finishedAt });
      if (!value || typeof value !== 'object' || Object.keys(value).some(key => !PRESENTATION_KEYS.includes(key))) throw errorOf('invalid-presentation');
      if (value.legacy && Object.keys(value.legacy).some(key => !entry.definition.legacyFields?.includes(key))) throw errorOf('invalid-presentation');
      const patch = Object.fromEntries(PATCHED_KEYS.filter(key => value[key] !== undefined).map(key => [key, value[key]]));
      patch.detail = { ...contract.detail, ...value.detail, ...(value.legacy ? { legacy: value.legacy } : {}) };
      const events = [...contract.events];
      for (const event of value.events || []) {
        if (!event.id || event.type === 'settled') throw errorOf('invalid-presentation');
        const eventId = `${contract.attemptId}:domain:${event.id}`;
        if (!events.some(item => item.eventId === eventId)) events.push({ ...event, eventId, type: 'log' });
      }
      const settled = events.filter(event => event.type === 'settled');
      patch.events = [...settled, ...events.filter(event => event.type !== 'settled').slice(-LIMITS.domainEventsKept)];
      const checked = validateRuntimeContract({ ...contract, ...patch });
      for (const key of Object.keys(patch)) contract[key] = checked[key];
    } finally { entry.presenting = false; }
  };

  const denyAll = (actions, caps, code) => {
    for (const action of ACTIONS) actions[action] = { ...denied(code), ...(action === 'pause' ? { mode: caps.pauseMode } : {}) };
  };
  const pauseVerdict = (status, caps) => {
    if (!['queued', 'running'].includes(status)) return denied(terminal(status) ? 'job-ended' : 'not-running');
    if (caps.pauseMode === 'unsupported' || (caps.pauseMode === 'queued-only' && status !== 'queued')) return denied('capability-unsupported');
    return { available: true };
  };
  const refresh = (contract, entry) => {
    const { status, capabilities: caps } = contract;
    const ended = terminal(status), stopping = status === 'cancelling';
    contract.actions = {
      cancel: !caps.cancel ? denied('capability-unsupported') : ended ? denied('job-ended') : stopping ? denied('already-cancelling') : { available: true },
      pause: { ...pauseVerdict(status, caps), mode: caps.pauseMode },
      resume: status === 'paused' ? { available: true } : denied('not-paused'),
      retry: !caps.retry ? denied('capability-unsupported')
        : ['failed', 'cancelled', 'interrupted'].includes(status) ? { available: true } : denied(ended ? 'not-retryable' : 'not-ended'),
      set: !caps.set ? denied('capability-unsupported') : !entry?.controls ? denied('control-not-ready')
        : ended ? denied('job-ended') : stopping ? denied('already-cancelling') : { available: true, settings: entry.controls.settings() },
    };
    if (entry?.settling) denyAll(contract.actions, caps, 'job-settling');
    if (entry?.recoveryBlocked) denyAll(contract.actions, caps, entry.recoveryBlocked);
    if (entry && !k.live(entry)) denyAll(contract.actions, caps, 'scope-unloaded');
  };

  const snapshot = entry => { refresh(entry.job.contract, entry); return validateRuntimeContract(entry.job.contract); };
  return { present, refresh, snapshot };
}
