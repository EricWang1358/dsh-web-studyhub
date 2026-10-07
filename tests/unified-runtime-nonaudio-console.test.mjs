import test from 'node:test';
import assert from 'node:assert/strict';
import { localizeAppMessage } from '../lib/application-messages.js';
import { GENERATION_DRIVERS, gate, soon } from './helpers/console-families.mjs';
import { MODEL_DRIVERS } from './helpers/console-families-model.mjs';
import { readActions, readCard, plain, refuse, ui } from './helpers/console-card.mjs';

const DRIVERS = [...GENERATION_DRIVERS, ...MODEL_DRIVERS.filter(driver => driver.id !== 'coach')];
const LEGACY_HIDDEN = new Set(['recap', 'workflow:teaching', 'workflow:skeleton', 'assist', 'note']);
const UI_KIND = { generation: 'generation', supplement: 'supplement', 'draft-repair': 'repair', 'draft-publish': 'publish', translation: 'translation', 'coach-daily': 'coach' };
const rowsOf = async (world, driver) => (await world.service.call('snapshot')).jobs.filter(row => driver.kinds.includes(row.contract?.kind ?? row.type));
const drawing = row => ({ uiKind: UI_KIND[row.contract.kind] ?? 'extension',
  allowEmptyLine: row.contract.kind.startsWith('workflow-') && row.contract.status === 'complete' });
async function domainStatus(world, driver) {
  if (driver.id === 'assist') return world.assist.assistView(world.root).tasks.at(-1).status;
  if (driver.id.startsWith('workflow:')) {
    const { session } = await world.service.call('workflow.session.get', { id: world.last.id });
    return driver.id.endsWith('teaching') ? session.records.lesson.teaching.status : session.skeletonJob.status;
  }
  return (await world.service.call('note.get', { id: world.last.id })).generation.status;
}

for (const name of ['selection', 'repair', 'publish']) test(`${name}: unavailable runtime settings are refused in the same words as the card`, async t => {
  const driver = GENERATION_DRIVERS.find(item => item.id === `generation:${name}`), world = await driver.open(t), hold = gate();
  world.set(true, driver.switches); world.holds.push(hold); world.model.gate = hold;
  await driver.start(world); await soon(() => hold.entered, 'the model call to be held');
  const row = (await rowsOf(world, driver))[0], action = row.contract.actions.set;
  assert.deepEqual([action.available, action.reason.code], [false, 'control-not-ready']);
  const { error } = await refuse(world.service, { jobId: row.contract.jobId, action: 'set', patch: { concurrency: 2 } });
  assert.equal(error?.code, action.reason.code);
  assert.equal(error?.message, ui.control.reasonText(action, 'set'));
  assert.ok(plain(error?.message));
  assert.equal(localizeAppMessage(error.message, 'en'), 'That is not available right now.');
});

for (const driver of DRIVERS) for (const mode of ['off', 'on', 'mixed']) {
  test(`${driver.id}/${mode}: completed console cards keep kind, identity, output and archive history`, async t => {
    const world = await driver.open(t), saved = [];
    for (const side of mode === 'mixed' ? ['off', 'on'] : [mode]) {
      world.set(side === 'on', driver.switches);
      const before = new Set((await rowsOf(world, driver)).map(row => row.id));
      await driver.done(world);
      if (!(side === 'off' && LEGACY_HIDDEN.has(driver.id))) await soon(async () => {
        const pending = (await rowsOf(world, driver)).filter(row => !before.has(row.id));
        return pending.length && pending.every(row => ['complete', 'failed', 'cancelled'].includes(row.status));
      }, `${driver.id} to settle its runtime bookkeeping`);
      const rows = (await rowsOf(world, driver)).filter(row => !before.has(row.id));
      if (side === 'off' && LEGACY_HIDDEN.has(driver.id)) {
        assert.equal(rows.length, 0, 'legacy work remains visible in its own panel, without an invented job card');
        assert.equal(await domainStatus(world, driver), 'done');
        continue;
      }
      assert.equal(rows.length, 1, `${driver.id}/${side}: one newly completed card`);
      const row = rows[0], card = { name: driver.id, side };
      const c = readCard(row, card, drawing(row));
      assert.equal(c.status, 'complete', `${driver.id}/${side}: ${row.stage}`);
      if (side === 'on') assert.ok(c.usage.tokens > 0, 'successful model calls expose observed fake-host usage');
      readActions(c, card, { running: false });
      assert.deepEqual(Object.entries(c.actions).filter(([, action]) => action.available), []);
      const tasks = ui.model.tasksOf(await world.service.call('snapshot'));
      for (const id of new Set([row.id, c.jobId])) assert.equal(ui.model.pickTask({ tasks, focus: { jobId: id, nonce: id } }), c.jobId, 'detail focus resolves either public identity');
      for (const id of new Set([row.id, c.jobId])) {
        const status = await world.service.call('job.status', { jobId: id });
        const waited = await world.service.call('job.wait', { jobId: id, timeoutSeconds: 1 });
        assert.equal(status.id, row.id); assert.equal(status.finished, true); assert.equal(waited.status, 'complete');
      }
      for (const call of c.calls.filter(call => call.callId)) {
        const output = await world.service.call('job.output', { jobId: c.jobId, callId: call.callId });
        assert.deepEqual([typeof output.supported, typeof output.live, typeof output.text, typeof output.nextCursor], ['boolean', 'boolean', 'string', 'number']);
        assert.equal(output.live, false);
      }
      saved.push({ row, c, card });
    }
    assert.equal(new Set(saved.map(item => item.c.jobId)).size, saved.length, 'old and new cards have distinct logical identities');
    for (const { row, c, card } of saved) {
      assert.deepEqual((await world.service.call('job.archive', { jobId: row.id })).archived, [row.id]);
      const snapshot = await world.service.call('snapshot');
      assert.ok(!snapshot.jobs.some(item => item.id === row.id));
      const archived = snapshot.archivedJobs.find(item => item.id === row.id || item.contract.jobId === c.jobId);
      assert.ok(archived); assert.equal(archived.contract.kind, c.kind); assert.ok(ui.model.isArchivedTask(archived));
      assert.deepEqual((await world.service.call('job.unarchive', { jobId: row.id })).unarchived, [row.id]);
      const back = (await world.service.call('snapshot')).jobs.find(item => item.id === row.id);
      assert.equal(readCard(back, card, drawing(back)).status, 'complete');
      assert.deepEqual((await world.service.call('job.delete', { jobIds: [row.id] })).deleted, [row.id]);
    }
  });
}

for (const mode of ['off', 'on', 'mixed']) test(`generation/${mode}: a queued card can be cancelled without starting another model call`, async t => {
  const driver = GENERATION_DRIVERS[0], world = await driver.open(t), hold = gate();
  world.holds.push(hold); world.model.gate = hold;
  world.set(mode === 'on', driver.switches);
  const first = await driver.start(world); await soon(() => hold.entered, 'first generation to reach its model');
  world.set(mode !== 'off', driver.switches);
  const second = await driver.start(world);
  const row = await soon(async () => (await rowsOf(world, driver)).find(row => row.id === second.jobId && row.status === 'queued'), 'second generation to queue');
  const c = readCard(row, { name: 'queued generation', side: mode }, { uiKind: 'generation' });
  assert.equal(ui.summary.taskState(row), 'queued'); assert.equal(c.actions.cancel.available, true); assert.equal(c.calls.length, 0);
  const calls = world.model.calls;
  await world.service.call('job.control', { jobId: c.jobId, action: 'cancel' });
  assert.equal((await world.service.call('job.wait', { jobId: c.jobId, timeoutSeconds: 1 })).status, 'cancelled');
  assert.equal(world.model.calls, calls, 'queued cancellation does not ask the model');
  hold.open(); world.model.gate = null;
  assert.equal((await world.service.call('job.wait', { jobId: first.jobId, timeoutSeconds: 60 })).status, 'complete');
});

for (const side of ['off', 'on']) test(`publication/${side}: the held card prevents draft edits until publication finishes`, async t => {
  const driver = GENERATION_DRIVERS.find(item => item.id === 'generation:publish'), world = await driver.open(t), hold = gate();
  world.set(side === 'on', driver.switches); world.holds.push(hold); world.model.gate = hold;
  await driver.start(world); await soon(() => hold.entered, 'publication review to reach the model');
  const row = (await rowsOf(world, driver))[0], state = await world.service.call('export'), draft = state.drafts.find(item => item.id === row.draftId);
  await assert.rejects(world.service.call('draft.save', { deck: { ...draft, title: 'Edited during review' }, draftVersion: draft.draftVersion }), /正在后台发布检查/);
  hold.open(); world.model.gate = null;
  const end = await world.service.call('job.wait', { jobId: row.contract.jobId, timeoutSeconds: 60 });
  assert.equal(end.status, 'complete');
  assert.equal((await world.service.call('export')).decks.find(item => item.id === 't').cards.length, 3);
});

for (const driver of DRIVERS) for (const mode of ['off', 'on', 'mixed']) {
  test(`${driver.id}/${mode}: model failure preserves the family outcome, calls and missing usage`, async t => {
    const world = await driver.open(t); world.model.fail = true;
    for (const side of mode === 'mixed' ? ['off', 'on'] : [mode]) {
      world.set(side === 'on', driver.switches);
      const before = new Set((await rowsOf(world, driver)).map(row => row.id));
      await driver.done(world);
      if (side === 'off' && LEGACY_HIDDEN.has(driver.id)) {
        assert.equal((await rowsOf(world, driver)).length, 0);
        assert.equal(await domainStatus(world, driver), 'failed'); continue;
      }
      const ended = await soon(async () => {
        const row = (await rowsOf(world, driver)).find(row => !before.has(row.id));
        return row && ['complete', 'failed', 'cancelled'].includes(row.status) && row;
      }, `${driver.id} to settle after model failure`);
      const card = { name: driver.id, side }, c = readCard(ended, card, drawing(ended));
      const status = driver.id === 'generation:publish' ? 'complete' : 'failed';
      assert.equal(c.status, status, `${driver.id}/${side}: ${ended.stage}`);
      if (status === 'failed') assert.equal(ui.summary.taskState(ended), 'fail');
      else {
        assert.equal(ended.accepted, 2, 'publication retains its existing best-effort review policy');
        if (side === 'on') assert.ok(c.calls.some(call => call.status === 'failed'), 'the runtime retains failed review calls');
        else assert.deepEqual(c.calls, [], 'the legacy publication path does not expose individual review calls');
      }
      readActions(c, card, { running: false });
      assert.equal(c.usage.tokens, null, 'the model threw before reporting any usage');
      for (const id of new Set([ended.id, c.jobId])) {
        const answer = await world.service.call('job.status', { jobId: id });
        assert.deepEqual([answer.status, answer.finished], [status, true]);
      }
      assert.equal((await world.service.call('job.wait', { jobId: c.jobId, timeoutSeconds: 1 })).status, status);
      assert.deepEqual((await world.service.call('job.dismiss', { jobId: ended.id })).dismissed, [ended.id]);
    }
  });
}

for (const driver of DRIVERS) for (const mode of ['off', 'on', 'mixed']) {
  test(`${driver.id}/${mode}: a held model exposes truthful live controls and settles after cancellation or release`, async t => {
    const world = await driver.open(t);
    for (const side of mode === 'mixed' ? ['off', 'on'] : [mode]) {
      world.set(side === 'on', driver.switches);
      const hold = gate(); world.holds.push(hold); world.model.gate = hold;
      const before = new Set((await rowsOf(world, driver)).map(row => row.id));
      await driver.start(world);
      await soon(() => hold.entered, `${driver.id} to reach the controlled model`);
      const rows = (await rowsOf(world, driver)).filter(row => !before.has(row.id));
      if (side === 'off' && LEGACY_HIDDEN.has(driver.id)) {
        assert.equal(rows.length, 0); assert.equal(await domainStatus(world, driver), 'running');
        hold.open(); await driver.finish(world); assert.equal(await domainStatus(world, driver), 'done'); continue;
      }
      assert.equal(rows.length, 1);
      const row = rows[0], card = { name: driver.id, side };
      const c = readCard(row, card, { uiKind: UI_KIND[row.contract.kind] ?? 'extension' });
      assert.equal(c.status, 'running'); readActions(c, card, { running: true });
      for (const id of new Set([row.id, c.jobId])) {
        const status = await world.service.call('job.status', { jobId: id });
        assert.deepEqual([status.id, status.finished], [row.id, false]);
      }
      assert.equal((await world.service.call('job.wait', { jobId: c.jobId, timeoutSeconds: 1 })).status, 'running');
      for (const action of ['pause', 'resume', 'retry', 'set']) {
        if (c.actions[action].available) continue;
        const answer = await refuse(world.service, { jobId: c.jobId, action, ...(action === 'set' ? { patch: { concurrency: 2 } } : {}) });
        assert.ok(answer.error, `${driver.id}: ${action} is refused when not offered`);
        assert.ok(plain(answer.error.message), `${driver.id}: ${action}: ${answer.error.message}`);
      }
      if (driver.message || (driver.id === 'translation' && side === 'off')) {
        const message = await world.service.call('job.message', { jobId: row.id, message: 'Keep the source terms.' });
        assert.ok(message);
      } else {
        const answer = await refuse(world.service, { jobId: row.id, message: 'hello' }, 'job.message');
        assert.ok(answer.error && plain(answer.error.message), `${driver.id}: message refusal: ${answer.error?.message}`);
      }
      if (c.actions.cancel.available) {
        assert.equal((await world.service.call('job.control', { jobId: c.jobId, action: 'cancel' })).action, 'cancel');
      } else {
        const answer = await refuse(world.service, { jobId: c.jobId, action: 'cancel' });
        assert.ok(answer.error && plain(answer.error.message));
      }
      hold.open(); world.model.gate = null;
      const ended = await soon(async () => {
        const item = (await rowsOf(world, driver)).find(item => item.id === row.id);
        return item && ['complete', 'cancelled', 'failed'].includes(item.status) && item;
      }, `${driver.id} to settle after the model is released`);
      assert.equal(ended.status, c.actions.cancel.available ? 'cancelled' : 'complete', ended.stage);
      const end = readCard(ended, card, drawing(ended));
      readActions(end, card, { running: false });
      assert.deepEqual((await world.service.call('job.dismiss', { jobId: row.id })).dismissed, [row.id]);
      assert.ok(!(await rowsOf(world, driver)).some(item => item.id === row.id));
    }
  });
}
