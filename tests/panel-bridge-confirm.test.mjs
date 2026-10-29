import test from 'node:test';
import assert from 'node:assert/strict';
import { createPanelBridge } from '../lib/panel-bridge.js';

test('queuePanelIntent assigns monotonic intentSeq and unique intentId', () => {
  const bridge = createPanelBridge();
  const q1 = bridge.queuePanelIntent('sess-1', { type: 'run', runId: 'r1' }, 1000);
  const q2 = bridge.queuePanelIntent('sess-1', { type: 'run', runId: 'r2' }, 1050);

  assert.equal(q1.intentSeq, 1);
  assert.equal(q2.intentSeq, 2);
  assert.ok(q1.intentId);
  assert.ok(q2.intentId);
  assert.notEqual(q1.intentId, q2.intentId);

  const taken = bridge.takePanelIntent('sess-1', 1100);
  assert.equal(taken.runId, 'r2');
  assert.equal(taken.intentSeq, 2);
});

test('waitForIntentAck resolves immediately if ack arrived before wait', async () => {
  const bridge = createPanelBridge();
  bridge.ackPanelIntent('sess-1', { intentId: 'pi_early', status: 'displayed' });
  const ack = await bridge.waitForIntentAck('sess-1', 'pi_early', 500);

  assert.ok(ack);
  assert.equal(ack.intentId, 'pi_early');
  assert.equal(ack.status, 'displayed');
});

test('waitForIntentAck resolves when ack arrives asynchronously', async () => {
  const bridge = createPanelBridge();
  const waitPromise = bridge.waitForIntentAck('sess-1', 'pi_async', 500);

  setTimeout(() => {
    bridge.ackPanelIntent('sess-1', { intentId: 'pi_async', status: 'displayed', placement: 'sidebar' });
  }, 30);

  const ack = await waitPromise;
  assert.ok(ack);
  assert.equal(ack.intentId, 'pi_async');
  assert.equal(ack.status, 'displayed');
});

test('waitForIntentAck times out and returns null when no ack arrives', async () => {
  const bridge = createPanelBridge();
  const start = Date.now();
  const ack = await bridge.waitForIntentAck('sess-1', 'pi_timeout', 40);
  const elapsed = Date.now() - start;

  assert.equal(ack, null);
  assert.ok(elapsed >= 35);
});

test('setPanelVisible automatically acks when options contain ackIntentId', async () => {
  const bridge = createPanelBridge();
  const waitPromise = bridge.waitForIntentAck('sess-1', 'pi_visible_ack', 500);

  bridge.setPanelVisible('sess-1', 'sidebar', { id: 'r1' }, Date.now(), 1, { ackIntentId: 'pi_visible_ack' });

  const ack = await waitPromise;
  assert.ok(ack);
  assert.equal(ack.intentId, 'pi_visible_ack');
  assert.equal(ack.status, 'displayed');
});

test('ackPanelIntent handles deferred_by_user_activity', async () => {
  const bridge = createPanelBridge();
  const waitPromise = bridge.waitForIntentAck('sess-1', 'pi_deferred', 500);

  bridge.ackPanelIntent('sess-1', { intentId: 'pi_deferred', status: 'deferred_by_user_activity' });

  const ack = await waitPromise;
  assert.ok(ack);
  assert.equal(ack.intentId, 'pi_deferred');
  assert.equal(ack.status, 'deferred_by_user_activity');
});
