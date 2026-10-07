import test from 'node:test';
import assert from 'node:assert/strict';
import { PROCESS_DRIVERS } from './helpers/console-families-process.mjs';
import { soon } from './helpers/console-families.mjs';
import { readActions, readCard, plain, refuse, ui } from './helpers/console-card.mjs';

// Real public operations and projections; every external boundary is a fake.
// The subprocess gate witnesses startup and remains held until release/cancel.
const rowsOf = async (world, driver) => (await world.call('snapshot')).jobs.filter(row => row.type === driver.kind);
for (const driver of PROCESS_DRIVERS) for (const mode of ['off', 'on', 'mixed']) for (const outcome of ['complete', 'cancelled', 'failed']) {
  test(`${driver.id}/${mode}/${outcome}: process state, controls, output and console history agree`, async t => {
    const world = await driver.open(t), saved = [];
    for (const side of mode === 'mixed' ? ['off', 'on'] : [mode]) {
      if (side === 'on' && mode === 'mixed') await driver.reset(world);
      world.set(side === 'on', driver.switches);
      if (outcome === 'failed') await driver.fail(world);
      else await driver.hold(world);
      await driver.start(world);
      if (outcome !== 'failed') await driver.entered(world);
      const card = { name: driver.id, side };
      if (outcome !== 'failed') {
        const rows = await rowsOf(world, driver);
        if (side === 'off') assert.equal(rows.length, 0, 'legacy status stays on its family panel');
        else {
          const row = rows.at(-1), c = readCard(row, card, { uiKind: 'extension' });
          assert.equal(c.status, 'running'); readActions(c, card, { running: true });
          assert.equal(c.capabilities.pauseMode, 'unsupported');
          for (const id of new Set([row.id, c.jobId])) {
            assert.equal((await world.call('job.status', { jobId: id })).finished, false);
          }
          for (const action of ['pause', 'resume', 'retry', 'set']) {
            assert.equal(c.actions[action].available, false);
            const answer = await refuse(world.service, { jobId: c.jobId, action, ...(action === 'set' ? { patch: { concurrency: 2 } } : {}) });
            assert.ok(answer.error && plain(answer.error.message), `${action}: ${answer.error?.message}`);
          }
          for (const call of c.calls.filter(call => call.callId)) {
            const output = await world.call('job.output', { jobId: c.jobId, callId: call.callId });
            assert.deepEqual([typeof output.supported, typeof output.live, typeof output.text, typeof output.nextCursor], ['boolean', 'boolean', 'string', 'number']);
          }
          if (outcome === 'cancelled') assert.equal((await world.call('job.control', { jobId: c.jobId, action: 'cancel' })).action, 'cancel');
        }
        if (outcome === 'cancelled' && side === 'off') await world.call(driver.cancel, driver.args);
        await driver.release(world);
      }
      const domain = await driver.finish(world);
      assert.equal(domain.status, outcome, `${driver.id}/${side}: ${domain.message ?? domain.stage}`);
      if (side === 'off') { assert.equal((await rowsOf(world, driver)).length, 0); continue; }
      const ended = await soon(async () => {
        const row = (await rowsOf(world, driver)).at(-1);
        return row && ['complete', 'failed', 'cancelled'].includes(row.status) && row;
      }, `${driver.id} to finish its runtime bookkeeping`);
      const c = readCard(ended, card, { uiKind: 'extension' });
      assert.equal(c.status, outcome); readActions(c, card, { running: false });
      assert.equal((await world.call('job.wait', { jobId: c.jobId, timeoutSeconds: 1 })).status, outcome);
      assert.equal(c.usage.tokens, null, 'unobserved token usage is not invented for process work');
      saved.push({ row: ended, c });
    }
    for (const { row, c } of saved) {
      assert.deepEqual((await world.call('job.archive', { jobId: row.id })).archived, [row.id]);
      const archived = (await world.call('snapshot')).archivedJobs.find(item => item.id === row.id || item.contract.jobId === c.jobId);
      assert.ok(archived && ui.model.isArchivedTask(archived)); assert.equal(archived.contract.kind, driver.kind);
      assert.deepEqual((await world.call('job.unarchive', { jobId: row.id })).unarchived, [row.id]);
      const restored = (await world.call('snapshot')).jobs.find(item => item.id === row.id);
      assert.equal(restored.contract.status, outcome); assert.equal(restored.contract.actions.cancel.available, false);
      assert.deepEqual((await world.call('job.delete', { jobIds: [row.id] })).deleted, [row.id]);
    }
  });
}
