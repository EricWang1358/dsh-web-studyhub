import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { longFetch } from '../lib/http.js';

test('S1-3 observable transport cancellation waits for local request close', async t => {
  const request = new EventEmitter(); let destroyed = false, ended = false;
  request.end = () => {}; request.destroy = () => { destroyed = true; };
  t.mock.method(http, 'request', () => request);
  const controller = new AbortController();
  const pending = longFetch('http://127.0.0.1/probe', { signal: controller.signal, awaitPhysicalClose: true });
  const checked = assert.rejects(pending, { name: 'AbortError' }).then(() => { ended = true; });
  controller.abort(); await Promise.resolve(); await Promise.resolve();
  assert.equal(destroyed, true); assert.equal(ended, false);
  request.emit('close'); await checked; assert.equal(ended, true);
});

test('S1-3 observable response end retains occupancy through request close', async t => {
  const request = new EventEmitter(), response = new EventEmitter(); let respond, ended = false;
  request.end = () => {}; request.destroy = () => {};
  t.mock.method(http, 'request', (url, options, callback) => { respond = callback; return request; });
  const pending = longFetch('http://127.0.0.1/probe', { awaitPhysicalClose: true }).then(result => { ended = true; return result; });
  response.statusCode = 200; response.headers = {}; response.complete = true;
  respond(response); response.emit('data', Buffer.from('{}')); response.emit('end');
  await Promise.resolve(); assert.equal(ended, false);
  request.emit('close'); assert.deepEqual(await (await pending).json(), {});
});
