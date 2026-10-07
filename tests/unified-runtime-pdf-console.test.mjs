import test from 'node:test';
import assert from 'node:assert/strict';
import { pdfConsole } from './helpers/pdf-console.mjs';
import { ENDED, plain, readActions, readCard, refuse, ui } from './helpers/console-card.mjs';
import { settleJob, until } from './helpers/wait.mjs';

/* S6-5, the PDF side of the same regression as unified-runtime-audio-console: a conversion seen through the public operations of the 任务 console and the code the console draws
   it with, with its switch off, on, and both kinds of job in one service. Fakes only (a fake MinerU on a loopback port). */

const MODES = ['off', 'on', 'mixed'];
const cardOf = async (h, id) => (await h.call('snapshot')).jobs.find(job => job.id === id);
const listed = async (h, id) => { await until(async () => ['queued', 'running'].includes((await cardOf(h, id))?.status), `conversion ${id} to be listed as live`, { timeoutMs: 20_000 }); return cardOf(h, id); };
const sides = mode => mode === 'mixed' ? ['off', 'on'] : [mode];

for (const mode of MODES) test(`${mode}: a conversion, while it runs, is a card the console can draw, offers what it declares and refuses the rest in words; finished it can be archived, brought back and deleted`, async t => {
  const h = await pdfConsole(t), cards = [];
  for (const side of sides(mode)) { h.set(side === 'on'); const started = await h.start(30, { title: `Book ${side}` }); cards.push({ name: 'pdf', side, started }); }
  for (const card of cards) {
    const row = await listed(h, card.started.jobId), c = readCard(row, card, { uiKind: 'pdf' });
    readActions(c, card, { running: true });
    card.row = row; card.c = c;
    for (const id of [row.id, c.jobId]) {
      const status = await refuse(h.service, { jobId: id }, 'job.status'), waited = await refuse(h.service, { jobId: id, timeoutSeconds: 1 }, 'job.wait');
      if (id === row.id) assert.ok(status.reply && waited.reply, `${card.side}: the card id is taken by status and wait`);
      else assert.ok(status.reply || card.side === 'off', `${card.side}: status by the contract id (${status.error?.message})`);
    }
    for (const action of ['pause', 'resume', 'retry', 'set']) {
      if (c.actions[action].available) continue;
      const { error } = await refuse(h.service, { jobId: row.id, action, ...(action === 'set' ? { patch: { concurrency: 2 } } : {}) });
      if (error) assert.ok(plain(error.message), `${card.side}: ${action} refused in words ("${error.message}")`);
    }
  }
  h.release();
  for (const card of cards) {
    const done = await settleJob(h.service, card.row.id, { timeoutMs: 240_000 });
    assert.equal(done.status, 'complete', `${card.side}: ${done.stage}`);
    const row = await cardOf(h, card.row.id), c = readCard(row, card, { uiKind: 'pdf' });
    readActions(c, card, { running: false });
    assert.deepEqual(Object.entries(c.actions).filter(([, action]) => action.available).map(([key]) => key), [], `${card.side}: a finished conversion offers nothing`);
    const opener = ui.actions.resultOpener(row, { data: { sources: (await h.call('snapshot')).sources }, learn: { openAudioSources: () => {} } });
    assert.equal(opener?.label, '打开资料', `${card.side}: 打开结果 leads to the pages it made`);
  }
  for (const card of cards) {
    const id = card.row.id, where = `pdf/${card.side}`;
    assert.deepEqual((await h.call('job.archive', { jobId: id })).archived, [id], `${where}: archived`);
    const after = await h.call('snapshot');
    assert.ok(!after.jobs.some(job => job.id === id) && after.archivedJobs.some(job => job.id === id || ui.model.contractOf(job).jobId === card.c.jobId), `${where}: left the list, is an archived record`);
    assert.deepEqual((await h.call('job.unarchive', { jobId: id })).unarchived, [id], `${where}: brought back`);
    const back = await cardOf(h, id);
    assert.ok(back, `${where}: back in the list`);
    assert.deepEqual(Object.entries(readCard(back, card, { uiKind: 'pdf' }).actions).filter(([, action]) => action.available).map(([key]) => key).filter(key => key !== 'retry'), [], `${where}: a brought-back record offers nothing but at most a retry`);
    assert.deepEqual((await h.call('job.delete', { jobIds: [id] })).deleted, [id], `${where}: deleted`);
  }
});

for (const mode of MODES) test(`${mode}: stopping a conversion: the card ends cancelled, in words, and dismissing it removes the card`, async t => {
  const h = await pdfConsole(t), cards = [];
  for (const side of sides(mode)) { h.set(side === 'on'); cards.push({ name: 'pdf', side, started: await h.start(30, { title: `Book ${side}` }) }); }
  for (const card of cards) {
    const row = await listed(h, card.started.jobId);
    assert.equal((await h.call('job.control', { jobId: row.id, action: 'cancel' })).action, 'cancel', card.side);
    const done = await settleJob(h.service, row.id, { timeoutMs: 240_000 }), ended = await cardOf(h, row.id), c = readCard(ended, card, { uiKind: 'pdf' });
    assert.ok(['cancelled', 'failed'].includes(done.status) && ENDED.includes(c.status), `${card.side}: ended (${done.status})`);
    readActions(c, card, { running: false });
    const again = await refuse(h.service, { jobId: row.id, action: 'cancel' });
    if (again.error) assert.ok(plain(again.error.message), `${card.side}: stopping a stopped conversion is refused in words ("${again.error.message}")`);
    assert.deepEqual((await h.call('job.dismiss', { jobId: row.id })).dismissed, [row.id], `${card.side}: dismissed`);
    assert.ok(!(await h.call('snapshot')).jobs.some(job => job.id === row.id), `${card.side}: no card is left`);
  }
});
