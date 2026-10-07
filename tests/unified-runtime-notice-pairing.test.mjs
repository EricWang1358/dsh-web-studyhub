/* A definition whose `persistence.open` may return null (a family whose durability is a switch of its own) declares its settlement sinks twice: `notifications` for a job that is not
   durable (delivered once, in process) and the sinks of the persistence port for a job that is (delivered through the stored `deliveries`, exactly once across a crash for an idempotent
   sink). The two lists must name the same channels with the same idempotence, so a notice cannot exist on one path only. Fakes only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { createJobLifecycle } from '../lib/jobs/lifecycle.js';
import { createRuntimeWork } from '../lib/runtime/work.js';
import { checkNoticePairing } from '../lib/jobs/notices.js';
import { durableFixture } from './fixtures/unified-runtime-durable.mjs';
import { until } from './helpers/wait.mjs';

const sink = (channel, idempotent, deliver = () => {}) => ({ channel, idempotent, deliver });
const register = (definition) => new Promise((resolve, reject) => {
  const lifecycle = createJobLifecycle('/private-library', createRuntimeWork()), ctx = new Context();
  try { lifecycle.register(ctx, 'pair.v1', { kind: 'pair', version: 1, capabilities: { recoveryMode: 'none' }, run: async () => ({ refs: [] }), ...definition }); resolve(); } catch (error) { reject(error); }
});

test('a definition with persistence may declare in-process notifications, each with its idempotence and a channel of its own', async () => {
  const open = async () => null;
  await register({ persistence: { open }, notifications: [sink('session', false), sink('inbox', true)], capabilities: { recoveryMode: 'none' } });
  await assert.rejects(register({ persistence: { open }, notifications: [{ channel: 'session', deliver() {} }] }), /notification/);
  await assert.rejects(register({ persistence: { open }, notifications: [sink('session', false), sink('session', true)] }), /notification/);
  await assert.rejects(register({ persistence: { open }, notifications: {} }), /notification/);
});

test('the two lists must match, and the failure names both sets', () => {
  checkNoticePairing([sink('session', false), sink('inbox', true)], [sink('inbox', true), sink('session', false)]);
  assert.throws(() => checkNoticePairing([sink('session', false)], [sink('session', false), sink('inbox', true)]),
    error => error.code === 'invalid-notification-adapter' && /durable port \[inbox:idempotent, session:at-most-once\]/.test(error.message) && /\[session:at-most-once\]/.test(error.message));
  assert.throws(() => checkNoticePairing([sink('session', false)], [sink('session', true)]), /session:idempotent/);
  assert.throws(() => checkNoticePairing([sink('session', false)], undefined), /durable port \[\]/);
});

test('a durable port that does not match the declared sinks is refused at submit, before anything runs', async t => {
  let ran = 0;
  const f = await durableFixture(t, async () => { ran++; return { refs: [] }; }, { declared: [sink('session', false)], notifications: [sink('session', false), sink('inbox', true)] });
  await assert.rejects(f.port.submit('persist', {}), error => error.code === 'invalid-notification-adapter' && /inbox/.test(error.message));
  assert.equal(ran, 0);
});

/** One definition, two modes: `durable` decides whether `open` returns the port or null. `held` is { channel, promise }: that sink waits for the promise (a process that dies in it). */
async function pair(t, { durable, held } = {}) {
  const seen = { session: 0, inbox: 0, started: { session: 0, inbox: 0 } };
  const make = channel => sink(channel, channel === 'inbox', async () => { seen.started[channel]++; if (held?.channel === channel) await held.promise; seen[channel]++; });
  const sinks = [make('session'), make('inbox')];
  const f = await durableFixture(t, async () => ({ refs: [] }), { waitForDelivery: true, declared: sinks, notifications: sinks, durable });
  return { f, seen };
}

test('not durable: each sink delivers once, in process, and nothing is written to the store', async t => {
  const { f, seen } = await pair(t, { durable: false });
  const job = await f.port.submit('persist', {});
  assert.equal((await f.port.wait(job.jobId)).status, 'complete');
  assert.deepEqual([seen.session, seen.inbox], [1, 1]);
  assert.equal(await f.store.load(), null, 'a job that is not durable leaves no manifest');
});

test('durable: each sink delivers once through the stored deliveries, with no key beyond eventId, channel and status', async t => {
  const { f, seen } = await pair(t, { durable: true });
  const job = await f.port.submit('persist', {});
  assert.equal((await f.port.wait(job.jobId)).status, 'complete');
  assert.deepEqual([seen.session, seen.inbox], [1, 1]);
  const { deliveries } = await f.store.load();
  assert.deepEqual(deliveries.map(item => [item.channel, item.status]).sort(), [['inbox', 'delivered'], ['session', 'delivered']]);
  for (const delivery of deliveries) assert.deepEqual(Object.keys(delivery).sort(), ['channel', 'eventId', 'status']);
});

/** The first process dies inside the sink of `channel` (claimed on disk, never delivered); a second one takes the job from the store. Returns what was delivered before and after. */
async function crashIn(t, channel) {
  const dying = Promise.withResolvers(), held = { channel, promise: dying.promise };
  // The dead process's sink is let go first: closing its fixture waits for every delivery still on its way, so this hook must run before the fixture's own.
  t.after(() => dying.resolve());
  const { f, seen } = await pair(t, { durable: true, held });
  const job = await f.port.submit('persist', {});
  await until(() => seen.started[channel] === 1, `the ${channel} sink to be claimed and started`);
  assert.equal((await f.store.load()).deliveries.find(item => item.channel === channel).status, 'claimed', 'the claim is on disk before the delivery');
  const before = { session: seen.session, inbox: seen.inbox };
  held.channel = null; // the new process's sinks do not wait
  const next = createJobLifecycle(f.root, createRuntimeWork()), ctx = new Context();
  next.register(ctx, 'persist.v1', f.definition);
  t.after(async () => { await next.dispose(); await ctx.fiber.dispose(); });
  const port = next.scoped({ owner: Symbol('next'), domain: 'persist.v1', executor: f.executor });
  assert.equal((await port.restore('persist', {})).jobId, job.jobId);
  await until(async () => (await f.store.load()).deliveries.find(item => item.channel === 'inbox')?.status === 'delivered', 'the restored job to deliver its letter');
  const after = { session: seen.session, inbox: seen.inbox };
  return { before, after };
}

test('durable, a crash between claim and delivery of the session sink: it is never sent twice (at most once), the letter after it is still written', async t => {
  const { before, after } = await crashIn(t, 'session');
  assert.deepEqual(before, { session: 0, inbox: 0 });
  assert.deepEqual(after, { session: 0, inbox: 1 }, 'the session notice is lost with the process, never doubled; the next sink is delivered');
});

test('durable, a crash between claim and delivery of the letter: it is written again (idempotent), the session notice before it is not', async t => {
  const { before, after } = await crashIn(t, 'inbox');
  assert.deepEqual(before, { session: 1, inbox: 0 });
  assert.deepEqual(after, { session: 1, inbox: 1 }, 'the letter is written once after the crash; the session notice stays at one');
});
