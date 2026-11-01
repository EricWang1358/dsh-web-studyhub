import test from 'node:test';
import assert from 'node:assert/strict';
import { createPanelBridge } from '../lib/panel-bridge.js';
import { createIntentGuard } from '../ui/host/intent-sequence.js';

/* The panel takes intents in the order the conversation issued them (#537): one that arrives after a newer one has been shown is dropped, so it cannot take the question
   off the screen. The browser test (guided-drafts-browser) drives the same guard through the real host adapter. */

test('a newer intent is taken, an older one arriving late is not', () => {
  const guard = createIntentGuard();
  const bridge = createPanelBridge();
  bridge.queuePanelIntent('s', { type: 'run', runId: 'first' }, 1000);
  const first = bridge.takePanelIntent('s', 1000);
  bridge.queuePanelIntent('s', { type: 'run', runId: 'second' }, 2000);
  const second = bridge.takePanelIntent('s', 2000);
  assert.equal(guard.accept('s', second), true);
  assert.equal(guard.accept('s', first), false, 'the late one does not replace what is on screen');
  assert.equal(guard.accept('s', second), false, 'the same intent twice is one intent');
});

test('sessions do not share an order', () => {
  const guard = createIntentGuard();
  assert.equal(guard.accept('a', { intentSeq: 9, issuedAt: 9000 }), true);
  assert.equal(guard.accept('b', { intentSeq: 1, issuedAt: 1000 }), true);
});

test('a host that restarted counts from 1 again: its newer intents still get through', () => {
  const guard = createIntentGuard();
  assert.equal(guard.accept('s', { intentSeq: 40, issuedAt: 5000 }), true);
  assert.equal(guard.accept('s', { intentSeq: 1, issuedAt: 9000 }), true, 'later by the clock, whatever its number');
  assert.equal(guard.accept('s', { intentSeq: 39, issuedAt: 4000 }), false);
});

test('an intent without a sequence (an older host) is taken as before', () => {
  const guard = createIntentGuard();
  assert.equal(guard.accept('s', { intentSeq: 3, issuedAt: 3000 }), true);
  assert.equal(guard.accept('s', { type: 'run', runId: 'x' }), true);
});
