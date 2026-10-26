import test from 'node:test';
import assert from 'node:assert/strict';
import { KINDS, cardOf, consoleLibrary } from './helpers/audio-console.mjs';
import { isAudioJob } from '../lib/job-status.js';
import { ENDED, plain, readActions, ui } from './helpers/console-card.mjs';
import { live, readCard, refuse, startAll } from './helpers/audio-console-matrix.mjs';
import { settleJob, until } from './helpers/wait.mjs';

/* S6-5, the audio side, with the switch of every audio path off: every kind of audio job (single recording, batch, subtitles, review, class save, class correction) seen through the public
   operations of the 任务 console (snapshot, job.status, job.wait, job.control, job.output, job.archive / unarchive / dismiss / delete) and the code the console draws it with
   (ui/tasks/*, read without a DOM). Fakes only. What is not as it should be is recorded as a finding (written up in docs/plans/unified-job-runtime/s6-5-audio-console.md)
   and asserted as it is today, so the document and the code cannot drift apart and a fix turns a finding into a test to update.
   This is the 'off' third of unified-runtime-audio-console.test.mjs, moved here as it was (same names, same assertions, the setup of helpers/audio-console.mjs), so that
   the runner can put the three modes on three workers: the other two modes are the files beside it. */

/** This file's mode, the one every test here is named after: the switch of every audio path off, so the matrix starts each kind on the original path only. */
const mode = 'off';

test(`${mode}: every kind of audio job, while it runs, is a card the console can draw, offers what it declares and refuses the rest in words`, async t => {
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
        assert.ok(answer.reply, `${card.name}/${card.side}: job.${operation} by ${byContract ? 'contract' : 'card'} id: ${answer.error?.message}`);
      }
      if (status.reply) assert.deepEqual([status.reply.finished, status.reply.id], [false, row.id]);
      if (waited.reply) assert.ok(['queued', 'running'].includes(waited.reply.status), `${card.name}/${card.side}: job.wait answers while it runs`);
    }
    // What is not offered is refused in words.
    for (const action of ['pause', 'resume', 'retry', 'set']) {
      if (c.actions[action].available) continue;
      const { reply, error } = await refuse(lib, { jobId: row.id, action, ...(action === 'set' ? { patch: { textConcurrency: 2 } } : {}) });
      if (reply) {
        // The contract is the one truth: an action that was not offered a moment ago may have become offered in between (a batch's controls are ready a little after it starts); the card read again says which.
        const now = ui.model.contractOf(await cardOf(lib, row.id));
        assert.ok(now.actions[action].available, `${card.name}/${card.side}: job.control ${action} was accepted while its action says "${now.actions[action].reason?.code}"`);
        continue;
      }
      assert.ok(plain(error.message), `${card.name}/${card.side}: ${action} refused in words ("${error.message}")`);
      if (action === 'retry' && c.capabilities?.retry !== false) assert.ok(/还在进行/.test(error.message), `${card.name}/${card.side}: retrying a RUNNING job says it is still running ("${error.message}")`);
    }
    // job.message is the generation tools' door; to an audio job it is a plain refusal, not an internal error.
    const message = await refuse(lib, { jobId: row.id, message: 'hello' }, 'job.message');
    assert.ok(message.error && plain(message.error.message), `${card.name}/${card.side}: job.message to an audio job is refused in words ("${message.error?.message}")`);
    // The output of a call: readable (or says it cannot be) and with a cursor to go on from.
    const call = c.calls.find(item => item.callId);
    if (call) {
      const output = await lib.service.call('job.output', { jobId: row.id, callId: call.callId });
      assert.deepEqual([typeof output.supported, typeof output.live, typeof output.text, typeof output.nextCursor], ['boolean', 'boolean', 'string', 'number'], `${card.name}/${card.side}: job.output`);
    }
  }
  assert.equal(new Set(rows.map(item => item.c.jobId)).size, rows.length, 'every card is its own job: no id is shared');
  // Let the requests answer a few at a time until every job has ended.
  const currentCards = async () => {
    const { jobs } = await lib.service.call('snapshot');
    return rows.map(item => jobs.find(job => job.id === item.row.id));
  };
  const states = async () => (await currentCards()).map((card, index) => `${rows[index].name}/${rows[index].side}:${card.status}:${card.stage}:${(card.contract?.calls ?? []).slice(-2).map(call => `${call.kind}.${call.status}`).join('+')}`).join(' ');
  await until(async () => { lib.trickle(4); return (await currentCards()).every(row => ENDED.includes(row.status)); }, 'every job to end', { timeoutMs: 300_000, intervalMs: 250 })
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

test(`${mode}: stopping a job of every kind: the card ends cancelled in words, what was kept is not lost, dismissing it removes the card`, async t => {
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
    assert.ok(error && plain(error.message), `${where}: stopping a stopped job is refused in words ("${error?.message}"), as its card says`);
    if (c.actions.retry.available) assert.ok(c.capabilities?.retry ?? true, `${where}: retry only when declared`);
    assert.deepEqual((await lib.service.call('job.dismiss', { jobId: item.id })).dismissed, [item.id], `${where}: dismissed`);
    assert.ok(!(await lib.service.call('snapshot')).jobs.some(job => job.id === item.id), `${where}: no card is left`);
  }
});

/* ---- The findings of the first run of this matrix, each with its own test ---------------------------------------------------------------------------------- */

test(`${mode}: every kind of audio job the runtime has is in the audio family of the console, so the console draws it as an audio job (the class correction was missing)`, () => {
  for (const [name, kind] of Object.entries(KINDS)) assert.equal(isAudioJob({ type: kind.kind }), true, `${name} (${kind.kind}) is an audio job`);
});

test(`${mode}: a message to a running audio job is refused in the learner's words, not with an internal error`, async t => {
  const lib = await consoleLibrary(t);
  lib.set(mode === 'on', 'audioSubtitles');
  const started = await KINDS.subtitles.start(lib, 1), row = await live(lib, started.jobId);
  const { reply, error } = await refuse(lib, { jobId: row.id, message: 'please mind the terms' }, 'job.message');
  assert.equal(reply, undefined);
  assert.ok(plain(error.message), `refused in words: "${error.message}"`);
  assert.ok(/补充说明|消息/.test(error.message), 'and it says what the door is for');
  await lib.service.call('job.control', { jobId: row.id, action: 'cancel' }); await settleJob(lib.service, row.id);
});
