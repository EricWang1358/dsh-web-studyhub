import { LIMITS } from './limits.js';

const sumField = (a, b, field) => (Number(a?.[field]) || 0) + (Number(b?.[field]) || 0);
const sumTokens = (a, b) => ({
  uncachedInputTokens: sumField(a, b, 'uncachedInputTokens'),
  outputTokens: sumField(a, b, 'outputTokens'),
  cacheReadTokens: sumField(a, b, 'cacheReadTokens'),
  cacheWriteTokens: sumField(a, b, 'cacheWriteTokens'),
});
const totalTokens = usage => (usage?.uncachedInputTokens || 0) + (usage?.cacheReadTokens || 0) + (usage?.cacheWriteTokens || 0) + (usage?.outputTokens || 0);

/** Compact completed Call, Step and Intent history beyond kernel retention bounds while preserving:
 *  - exact cumulative usage (`detail.archivedCalls`),
 *  - every unrecorded accounting call,
 *  - every `pending` requestIntent (unknown remote outcome never retries blindly), and
 *  - every Step referenced by a retained Call, retained Intent, or checkpoint. */
export function compactRuntimeHistory(record, metadata = null, limits = LIMITS) {
  const maxCalls = limits.retainedCalls ?? 300;
  const maxSteps = limits.retainedSteps ?? 300;
  const maxIntents = limits.retainedIntents ?? 300;
  const overIntents = Boolean(metadata?.requestIntents && metadata.requestIntents.length > maxIntents);
  const overCalls = Array.isArray(record?.calls) && record.calls.length > maxCalls;
  const overSteps = Array.isArray(record?.runtime?.steps) && record.runtime.steps.length > maxSteps;
  if (!overIntents && !overCalls && !overSteps) return false;

  record.detail ||= {};
  if (overIntents) {
    const intents = metadata.requestIntents;
    const keepFrom = Math.max(0, intents.length - maxIntents);
    const kept = [];
    let archivedCompleted = record.detail.archivedIntents?.completed || 0;
    let archivedNotDispatched = record.detail.archivedIntents?.notDispatched || 0;
    for (let i = 0; i < intents.length; i++) {
      const intent = intents[i];
      if (i >= keepFrom || intent.status === 'pending') kept.push(intent);
      else if (intent.status === 'completed') archivedCompleted++;
      else archivedNotDispatched++;
    }
    if (kept.length < intents.length) {
      metadata.requestIntents = kept;
      record.detail.archivedIntents = { completed: archivedCompleted, notDispatched: archivedNotDispatched };
    }
  }

  const pendingIntentCalls = new Set((metadata?.requestIntents || []).filter(item => item.status === 'pending').map(item => item.callId));
  if (overCalls) {
    const calls = record.calls;
    const keepFrom = Math.max(0, calls.length - maxCalls);
    const prev = record.detail.archivedCalls || { totalCalls: 0, modelCalls: 0, knownModelCalls: 0, tokenUsage: null, runners: [], stageCounts: {} };
    const runners = new Set(prev.runners || []);
    const stageCounts = { ...(prev.stageCounts || {}) };
    let totalCalls = prev.totalCalls || 0, modelCalls = prev.modelCalls || 0, knownModelCalls = prev.knownModelCalls || 0;
    let tokenUsage = prev.tokenUsage ? structuredClone(prev.tokenUsage) : null;
    const kept = [];
    for (let i = 0; i < calls.length; i++) {
      const call = calls[i];
      const active = call.status === 'running' || call.status === 'waiting';
      const owesAccounting = call.accounting !== 'recorded' && Boolean(call.ledgerEvent || (call.modelRequest && call.tokenUsage));
      if (i >= keepFrom || active || owesAccounting || pendingIntentCalls.has(call.callId)) {
        kept.push(call);
        continue;
      }
      totalCalls++;
      if (call.modelRequest) {
        modelCalls++;
        if (call.runner) runners.add(call.runner);
        if (call.tokenUsage) {
          knownModelCalls++;
          tokenUsage = tokenUsage ? sumTokens(tokenUsage, call.tokenUsage) : structuredClone(call.tokenUsage);
        }
      }
      if (call.kind && call.kind !== 'wait') {
        const bucket = stageCounts[call.kind] ? { ...stageCounts[call.kind] } : { done: 0, total: 0 };
        bucket.total += 1;
        if (call.status === 'ok') bucket.done += 1;
        stageCounts[call.kind] = bucket;
      }
    }
    if (kept.length < calls.length) {
      record.calls = kept;
      record.detail.archivedCalls = { totalCalls, modelCalls, knownModelCalls, tokenUsage, runners: [...runners], stageCounts };
    }
  }

  if (overSteps) {
    const steps = record.runtime.steps;
    const keepFrom = Math.max(0, steps.length - maxSteps);
    const referenced = new Set();
    for (const call of record.calls || []) if (call.stepRunId) referenced.add(call.stepRunId);
    for (const intent of metadata?.requestIntents || []) if (intent.stepRunId) referenced.add(intent.stepRunId);
    const checkpointStep = metadata?.checkpoint?.stepKey || null;
    const kept = [];
    let dropped = 0;
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const active = step.status === 'queued' || step.status === 'running';
      if (i >= keepFrom || active || referenced.has(step.stepRunId) || (checkpointStep && step.stepKey === checkpointStep)) kept.push(step);
      else dropped++;
    }
    if (dropped > 0) {
      record.runtime.steps = kept;
      record.detail.archivedSteps = (record.detail.archivedSteps || 0) + dropped;
    }
  }
  return true;
}

/** Fold retained live Calls with `detail.archivedCalls` into cumulative usage and execution mode. */
export function foldRecordUsage(record) {
  const archived = record.detail?.archivedCalls;
  const liveModelCalls = record.calls.filter(call => call.modelRequest);
  const liveKnown = liveModelCalls.filter(call => call.tokenUsage);
  const liveUsage = liveKnown.length ? liveKnown.reduce((sum, call) => sumTokens(sum, call.tokenUsage), {}) : null;
  const archivedUsage = archived?.tokenUsage || null;
  const usage = archivedUsage && liveUsage ? sumTokens(archivedUsage, liveUsage) : archivedUsage ? structuredClone(archivedUsage) : liveUsage;
  const totalCalls = (archived?.modelCalls || 0) + liveModelCalls.length;
  const knownCalls = (archived?.knownModelCalls || 0) + liveKnown.length;
  record.usage = { calls: totalCalls, tokens: usage ? totalTokens(usage) : null, tokenUsage: usage };
  record.detail.usageIncomplete = knownCalls < totalCalls;
  const runners = new Set([...(archived?.runners || []), ...liveModelCalls.map(call => call.runner).filter(Boolean)]);
  record.execution.mode = runners.size > 1 ? 'mixed' : [...runners][0] || null;
}
