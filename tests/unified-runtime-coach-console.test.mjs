import test from 'node:test';
import assert from 'node:assert/strict';
import { MODEL_DRIVERS } from './helpers/console-families-model.mjs';
import { gate, soon } from './helpers/console-families.mjs';
import { readCard, plain, refuse } from './helpers/console-card.mjs';

const driver = MODEL_DRIVERS.find(item => item.id === 'coach');
const rowOf = async world => (await world.service.call('snapshot')).jobs.find(row => row.type === 'coach-daily');

// The day is one aggregate across batches and switch changes. It has daily
// pause/settings, not an individual batch's cancel/retry/archive controls.
for (const mode of ['off', 'on', 'mixed']) for (const failed of [false, true]) {
  test(`coach/${mode}/${failed ? 'failed batch' : 'successful batch'}: daily card keeps its identity and controls future work`, async t => {
    const world = await driver.open(t); let identity, completed = 0;
    for (const side of mode === 'mixed' ? ['off', 'on'] : [mode]) {
      world.set(side === 'on', driver.switches);
      world.model.fail = failed;
      const hold = gate(); world.holds.push(hold); world.model.gate = hold;
      await driver.start(world); await soon(() => hold.entered, 'the coach batch to reach its model');
      const row = await rowOf(world), card = { name: 'coach', side }, c = readCard(row, card, { uiKind: 'coach' });
      assert.equal(c.status, 'running');
      if (identity) assert.equal(c.jobId, identity, 'switch changes do not create a second day');
      identity = c.jobId;
      assert.equal(c.actions.cancel.available, false); assert.equal(c.actions.retry.available, false);
      assert.equal(c.actions.pause.available, true); assert.equal(c.actions.set.available, true);
      assert.ok(c.detail.batches.some(batch => batch.status === 'running'));
      assert.equal((await world.service.call('job.control', { jobId: row.id, action: 'pause' })).paused, true);
      const paused = await rowOf(world);
      assert.equal(paused.contract.detail.paused, true); assert.equal(paused.contract.status, 'pausing', 'the day waits for its active batch');
      assert.ok(paused.contract.detail.batches.some(batch => batch.status === 'running'), 'pausing the day does not cancel its active batch');
      assert.equal(paused.contract.actions.resume.available, true);
      const setting = await world.service.call('job.control', { jobId: row.id, action: 'set', patch: { maxReady: 9 } });
      assert.deepEqual(setting.applied, { maxReady: 9 });
      assert.equal((await rowOf(world)).contract.actions.set.settings.find(item => item.key === 'maxReady').value, 9);
      const refused = await refuse(world.service, { jobId: row.id, action: 'cancel' });
      assert.ok(refused.error && plain(refused.error.message));
      hold.open(); world.model.gate = null; await driver.finish(world);
      const ended = await rowOf(world), end = readCard(ended, card, { uiKind: 'coach' });
      assert.equal(end.status, 'complete'); assert.equal(end.jobId, identity);
      assert.equal(end.detail.paused, true, "completed batches keep today's pause setting");
      const batches = end.detail.batches.filter(batch => batch.status !== 'skipped');
      assert.equal(batches.length, ++completed); assert.equal(batches.at(-1).status, failed ? 'failed' : 'ok');
      assert.equal(end.actions.resume.available, true, 'an idle day can resume future batches');
      assert.equal(end.actions.set.available, true, 'daily settings remain editable after a batch ends');
      assert.equal((await world.service.call('snapshot')).jobs.filter(item => item.type === 'coach-prep').length, 0, 'batches are not duplicate cards');
      const archived = await world.service.call('job.archive', { jobId: row.id });
      assert.deepEqual(archived.archived, []); assert.deepEqual(archived.skipped, [{ id: row.id, reason: 'not-archivable' }]);
      assert.equal((await world.service.call('job.control', { jobId: row.id, action: 'resume' })).paused, false);
    }
    assert.deepEqual((await world.service.call('job.dismiss', { jobId: identity })).dismissed, [identity]);
    assert.equal(await rowOf(world), undefined);
  });
}
