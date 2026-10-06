import assert from 'node:assert/strict';

// Actual installed service preflight. No replacement controller or model calls.
export async function probeExecutorInspection({ ctx, parent, sibling, until }) {
  const jobs = ctx.get('jobs'), done = Promise.withResolvers();
  let entered = false;
  const id = jobs.start({ owner: parent.id, kind: 's15-inspection', label: 'S1-5 executor inspection',
    run: () => { entered = true; return { done: done.promise, cancel: () => done.resolve({ status: 'killed' }) }; } });
  try {
    await until(() => entered, 'inspection executor started');
    const active = jobs.get(id, parent.id);
    assert.equal(active.id, id); assert.equal(active.owner, parent.id); assert.equal(active.status, 'running');
    assert.throws(() => jobs.get(id, sibling.id), /belongs to another session/);
    assert.throws(() => jobs.get(id), /belongs to another session/);
    const missing = `${id}-absent`;
    assert.throws(() => jobs.get(missing, parent.id), error => error.message === `unknown job ${missing}`);
    done.resolve({ status: 'completed' });
    const ended = await until(() => { const value = jobs.get(id, parent.id); return value.status === 'completed' && value; }, 'inspection executor settled');
    assert.ok(ended.finishedAt);
    return { service: 'dsh-jobs', ownerAgentId: parent.id, handleId: id,
      activeStatus: active.status, terminalStatus: ended.status, wrongOwnerRefused: true,
      callerlessRefused: true, missingError: 'unknown job <id>', paidModel: false,
      limitation: 'Native get is owner-scoped. Missing alone does not prove old process death; process witness/recovery wiring still required.' };
  } finally { done.resolve({ status: 'killed' }); await jobs.wait(id, 10000, parent.id); }
}
