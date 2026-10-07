import test from 'node:test';
import assert from 'node:assert/strict';
import { ALL_SWITCHES, KINDS, cardOf, consoleLibrary } from './helpers/audio-console.mjs';
import { ENDED, plain, readActions, readCard as readCardOf, refuse as refuseTo, ui } from './helpers/console-card.mjs';
import { settleJob, until } from './helpers/wait.mjs';

/* S6-5, the audio side: every kind of audio job (single recording, batch, subtitles, review, class save, class correction) seen through the public operations of the 任务 console
   (snapshot, job.status, job.wait, job.control, job.output, job.archive / unarchive / dismiss / delete) and the code the console draws it with (ui/tasks/*, read without a DOM),
   with the kind's switch off, on, and both kinds of job in one service. Fakes only. What is not as it should be is recorded as a finding (FINDINGS below, written up in
   docs/plans/unified-job-runtime/s6-5-audio-console.md) and asserted as it is today, so the document and the code cannot drift apart and a fix turns a finding into a test to update. */

const findings = new Map();
const find = (id, detail) => { if (!findings.has(id)) findings.set(id, detail); };
const MODES = ['off', 'on', 'mixed'];
const INDEX = { single: { off: 1, on: 2 }, batch: { off: 3, on: 5 }, subtitles: { off: 1, on: 2 }, review: { off: 1, on: 2 }, save: { off: 1, on: 2 }, correction: { off: 3, on: 4 } };
const refuse = (lib, args, action = 'job.control') => refuseTo(lib.service, args, action);

/** Start every kind the mode asks for: the switch of the side set, the n-th work of that kind started. Returns [{ name, side, started }]. */
async function startAll(lib, mode) {
  const cards = [];
  for (const [name, kind] of Object.entries(KINDS)) for (const side of mode === 'mixed' ? ['off', 'on'] : [mode]) {
    lib.set(side === 'on', kind.switchKey);
    cards.push({ name, side, kind, started: await kind.start(lib, INDEX[name][side]) });
  }
  return cards;
}
const live = async (lib, id, what = id) => {
  await until(async () => ['queued', 'running'].includes((await cardOf(lib, id))?.status), `job ${what} to be listed as live (it is ${(await cardOf(lib, id))?.status}: ${(await cardOf(lib, id))?.stage})`, { timeoutMs: 10_000 });
  return cardOf(lib, id);
};

const readCard = (row, card) => readCardOf(row, card, { find });

for (const mode of MODES) test(`${mode}: every kind of audio job, while it runs, is a card the console can draw, offers what it declares and refuses the rest in words`, async t => {
  const lib = await consoleLibrary(t), cards = await startAll(lib, mode);
  assert.deepEqual(cards.filter(card => !card.started).map(card => `${card.name}/${card.side}`), mode === 'on' ? [] : ['correction/off'], 'the class correction has a card only on the runtime (D-12)');
  const rows = [];
  // Newest first: the correction of a class gives up on a model that stays silent for 20 s, so it is looked at before the others.
  for (const card of cards.filter(item => item.started).reverse()) {
    const row = await live(lib, card.started.jobId, `${card.name}/${card.side}`), c = readCard(row, card);
    readActions(c, card, { running: true });
    rows.push({ ...card, row, c });
    // The same job is read by its card id and by its contract id.
    for (const id of [row.id, c.jobId]) {
      const byContract = id !== row.id, status = await refuse(lib, { jobId: id }, 'job.status'), waited = await refuse(lib, { jobId: id, timeoutSeconds: 1 }, 'job.wait');
      for (const [operation, answer] of [['status', status], ['wait', waited]]) {
        if (answer.error && byContract && card.side === 'off') find(`${operation}-by-contract-id-original`, `job.${operation} does not take the contract id of an original-path audio job (${card.name}); the card id works`);
        else assert.ok(answer.reply, `${card.name}/${card.side}: job.${operation} by ${byContract ? 'contract' : 'card'} id: ${answer.error?.message}`);
      }
      if (status.reply) assert.deepEqual([status.reply.finished, status.reply.id], [false, row.id]);
      if (waited.reply) assert.ok(['queued', 'running'].includes(waited.reply.status), `${card.name}/${card.side}: job.wait answers while it runs`);
    }
    // What is not offered is refused in words.
    for (const action of ['pause', 'resume', 'retry', 'set']) {
      if (c.actions[action].available) continue;
      const { reply, error } = await refuse(lib, { jobId: row.id, action, ...(action === 'set' ? { patch: { textConcurrency: 2 } } : {}) });
      if (reply) { find('set-accepted-though-not-offered', `${card.name}/${card.side}: job.control ${action} was accepted while its action said "${c.actions[action].reason?.code}"`); continue; }
      assert.ok(plain(error.message), `${card.name}/${card.side}: ${action} refused in words ("${error.message}")`);
      if (action === 'retry' && /已经完成/.test(error.message)) find('retry-reason-while-running', `${card.name}/${card.side}: retrying a RUNNING job is refused with "${error.message}"`);
    }
    // job.message is the generation tools' door; to an audio job it is a plain refusal, not an internal error.
    const message = await refuse(lib, { jobId: row.id, message: 'hello' }, 'job.message');
    if (message.error && !plain(message.error.message)) find('message-internal-error', `job.message to an audio job answers "${message.error.message}"`);
    // The output of a call: readable (or says it cannot be) and with a cursor to go on from.
    const call = c.calls.find(item => item.callId);
    if (call) {
      const output = await lib.service.call('job.output', { jobId: row.id, callId: call.callId });
      assert.deepEqual([typeof output.supported, typeof output.live, typeof output.text, typeof output.nextCursor], ['boolean', 'boolean', 'string', 'number'], `${card.name}/${card.side}: job.output`);
    }
  }
  assert.equal(new Set(rows.map(item => item.c.jobId)).size, rows.length, 'every card is its own job: no id is shared');
  // Let the requests answer a few at a time until every job has ended.
  const states = async () => (await Promise.all(rows.map(async item => { const card = await cardOf(lib, item.row.id); return `${item.name}/${item.side}:${card.status}:${card.stage}:${(card.contract?.calls ?? []).slice(-2).map(call => `${call.kind}.${call.status}`).join('+')}`; }))).join(' ');
  await until(async () => { lib.trickle(4); return (await Promise.all(rows.map(item => cardOf(lib, item.row.id)))).every(row => ENDED.includes(row.status)); }, 'every job to end', { timeoutMs: 300_000, intervalMs: 250 })
    .catch(async error => { throw new Error(`${error.message}: ${await states()}`); });
  for (const item of rows) {
    const done = await settleJob(lib.service, item.row.id);
    assert.equal(done.status, 'complete', `${item.name}/${item.side}: ${done.stage}`);
    const row = await cardOf(lib, item.row.id), c = readCard(row, item);
    readActions(c, item, { running: false });
    assert.deepEqual(Object.entries(c.actions).filter(([, action]) => action.available).map(([key]) => key), [], `${item.name}/${item.side}: a finished job offers nothing`);
    assert.equal(ui.model.isRunningTask(row), false);
    // 打开结果: where it leads is what the job made.
    const app = { data: { sources: (await lib.state()).sources }, learn: { openAudioSources: () => {} } }, opener = ui.actions.resultOpener(row, app);
    if (['single', 'batch', 'subtitles', 'save'].includes(item.name)) assert.equal(opener?.label, '打开资料', `${item.name}/${item.side}: 打开结果 leads to the document it made`);
    // The tokens of the host model are on the card of the runtime job (the original path has them for some of these kinds only: D-4, D-6, D-7).
    if (['subtitles', 'review', 'save'].includes(item.name) && item.side === 'on') assert.ok(c.usage.tokens > 0, `${item.name}/${item.side}: tokens on the card`);
  }
  // Leaving the list: archive and bring back, then delete; the record of an archived job is read-only and still a card.
  for (const item of rows) {
    const id = item.row.id, where = `${item.name}/${item.side}`;
    const archived = await lib.service.call('job.archive', { jobId: id });
    assert.deepEqual([archived.archived, archived.skipped], [[id], []], `${where}: archived`);
    const after = await lib.service.call('snapshot');
    assert.ok(!after.jobs.some(job => job.id === id), `${where}: left the list`);
    const record = after.archivedJobs.find(job => job.id === id || ui.model.contractOf(job).jobId === item.c.jobId);
    assert.ok(record && ui.model.isArchivedTask(record), `${where}: is an archived record`);
    assert.equal(ui.model.contractOf(record).kind, item.c.kind, `${where}: the record keeps its kind`);
    assert.deepEqual((await lib.service.call('job.unarchive', { jobId: id })).unarchived, [id], `${where}: brought back`);
    // A record brought back from the archive is history (v2) or an original-path record (v1): the console draws it like any other card, with nothing to do on it.
    const back = await cardOf(lib, id);
    assert.ok(back, `${where}: back in the list`);
    const backContract = readCard(back, item);
    assert.equal(backContract.status, 'complete', `${where}: still complete`);
    assert.deepEqual(Object.entries(backContract.actions).filter(([, action]) => action.available).map(([key]) => key), [], `${where}: a brought-back record offers nothing`);
    assert.deepEqual((await lib.service.call('job.delete', { jobIds: [id] })).deleted, [id], `${where}: deleted`);
    assert.ok(!(await lib.service.call('snapshot')).jobs.some(job => job.id === id), `${where}: gone`);
  }
});

for (const mode of MODES) test(`${mode}: stopping a job of every kind: the card ends cancelled in words, what was kept is not lost, dismissing it removes the card`, async t => {
  const lib = await consoleLibrary(t), cards = (await startAll(lib, mode)).filter(card => card.started), ids = [];
  for (const card of [...cards].reverse()) {
    const row = await live(lib, card.started.jobId, `${card.name}/${card.side}`), c = ui.model.contractOf(row);
    const reply = await lib.service.call('job.control', { jobId: row.id, action: 'cancel' });
    assert.equal(reply.action, 'cancel', `${card.name}/${card.side}`);
    ids.push({ ...card, id: row.id, jobId: c.jobId });
  }
  for (const item of ids) {
    const done = await settleJob(lib.service, item.id), row = await cardOf(lib, item.id), c = readCard(row, item), where = `${item.name}/${item.side}`;
    assert.ok(['cancelled', 'failed'].includes(done.status) && ENDED.includes(c.status), `${where}: ended (${done.status})`);
    readActions(c, item, { running: false });
    const { error } = await refuse(lib, { jobId: item.id, action: 'cancel' });
    if (error) assert.ok(plain(error.message), `${where}: stopping a stopped job is refused in words ("${error.message}")`);
    else find('cancel-accepted-after-end', `${where}: job.control cancel on an ended job is answered as done, while its card says cancel is not available`);
    if (c.actions.retry.available) assert.ok(c.capabilities?.retry ?? true, `${where}: retry only when declared`);
    assert.deepEqual((await lib.service.call('job.dismiss', { jobId: item.id })).dismissed, [item.id], `${where}: dismissed`);
    assert.ok(!(await lib.service.call('snapshot')).jobs.some(job => job.id === item.id), `${where}: no card is left`);
  }
});

test('the id of a card and the id of its contract: which operations take which (findings)', async t => {
  const lib = await consoleLibrary(t);
  lib.set(true, ...ALL_SWITCHES);
  const started = await KINDS.subtitles.start(lib, 1), row = await live(lib, started.jobId), contractId = ui.model.contractOf(row).jobId;
  assert.notEqual(contractId, row.id, 'a runtime job has a card id and a contract id');
  const takes = {};
  for (const [operation, args] of [['job.status', { jobId: contractId }], ['job.wait', { jobId: contractId, timeoutSeconds: 1 }], ['job.output', { jobId: contractId, callId: 'nope' }],
    ['job.control', { jobId: contractId, action: 'pause' }], ['job.cancel', { jobId: contractId }]]) {
    const { error } = await refuse(lib, args, operation);
    takes[operation] = !error || !/not found/i.test(error.message);
  }
  assert.deepEqual([takes['job.status'], takes['job.wait'], takes['job.control']], [true, true, true], 'the operations of the console take the contract id');
  if (!takes['job.cancel']) find('cancel-by-contract-id', 'job.cancel does not take the contract id of a runtime job (job.dismiss, job.message and job.output by callId share the gap): D\'s small PR');
  await lib.service.call('job.control', { jobId: row.id, action: 'cancel' });
  await settleJob(lib.service, row.id);
});

test('the findings of this matrix are exactly the ones written up', () => {
  assert.deepEqual([...findings.keys()].sort(), KNOWN_FINDINGS);
});
const KNOWN_FINDINGS = ['cancel-accepted-after-end', 'cancel-by-contract-id', 'correction-not-audio-family', 'message-internal-error', 'retry-reason-while-running', 'set-accepted-though-not-offered', 'status-by-contract-id-original', 'wait-by-contract-id-original'].sort();
