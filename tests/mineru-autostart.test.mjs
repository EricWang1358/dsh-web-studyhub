import test from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers/pdf-convert-harness.mjs';
import { until } from './helpers/wait.mjs';

/* After a reboot the local MinerU service is stopped. A conversion then starts it by itself before the first window (local, no tokens): the card and
   the log say so (phase `start-service`), and a start that fails is a failed, retryable conversion whose 接着做 starts it again. Both the original
   background run and the runtime Job (runtime.pilot.pdfConvert). */

const stopped = { running: false, mode: 'managed', tier: 'basic' };

for (const runtime of [false, true]) {
  const side = runtime ? 'Job' : 'original run';

  test(`${side}: an import with the service stopped is accepted, starts the service first, then converts`, async t => {
    const h = await harness(t, { state: { ...stopped, startBlocksMs: 600 }, runtime });
    const local = await h.call('mineru.local.status', { fresh: true });
    assert.equal(local.state, 'server-stopped');
    const { jobId } = await h.start(3);
    const starting = await until(async () => { const job = (await h.jobs()).find(item => item.id === jobId); return job?.phase === 'start-service' && job; }, 'the start-service phase');
    assert.match(starting.stage, /正在启动本机 MinerU 服务/);
    const done = await h.settled(jobId);
    assert.equal(done.status, 'complete', done.stage);
    const calls = (await h.log()).map(entry => entry.argv.slice(0, 2).join(' '));
    const parse = calls.findIndex(call => call.startsWith('parse'));
    assert.ok(calls.indexOf('server start') >= 0 && calls.indexOf('server start') < parse, `the service is started before the first window: ${calls}`);
    assert.equal(done.service.state, 'running');
    const logged = done.contract?.log?.map(entry => entry.code) || [];
    if (logged.length) assert.ok(logged.includes('service-start') && logged.includes('service-started'), logged.join(','));
  });

  test(`${side}: a start that fails fails the conversion with the reason, retryable; 接着做 starts the service and finishes`, async t => {
    const h = await harness(t, { state: { ...stopped, startFails: true }, runtime });
    const { jobId } = await h.start(3);
    const failed = await h.settled(jobId);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.errorCode, 'server-start-failed');
    assert.match(failed.stage, /本机 MinerU 服务没能启动/);
    assert.equal((await h.parses()).length, 0, 'no window ran without a service');
    await h.set({ startFails: false });
    await h.call('mineru.retry', { jobId });
    const done = await until(async () => { const job = (await h.jobs()).find(item => item.id === jobId); return job?.status === 'complete' && job; }, 'the retried conversion');
    assert.equal(done.service.state, 'running');
    assert.equal((await h.log()).filter(entry => entry.argv[0] === 'server' && entry.argv[1] === 'start').length, 2, 'started once per attempt');
  });

  test(`${side}: a service that stops mid-book is started again by 接着做, and the finished windows are kept`, async t => {
    const h = await harness(t, { state: { dieOnFirst: 201 }, runtime });
    const { jobId } = await h.start(450);
    const failed = await h.settled(jobId);
    assert.equal(failed.errorCode, 'server-stopped');
    await h.set({ dieOnFirst: 0 });
    await h.call('mineru.retry', { jobId });
    const done = await until(async () => { const job = (await h.jobs()).find(item => item.id === jobId); return job?.status === 'complete' && job; }, 'the retried conversion');
    assert.equal(done.status, 'complete');
    const pages = (await h.parses()).map(entry => entry.argv[entry.argv.indexOf('--pages') + 1]);
    assert.deepEqual(pages, ['1-200', '201-400', '201-400', '401-450'], 'the first window is not converted again');
  });
}
