import test from 'node:test';
import assert from 'node:assert/strict';
import { JEV, JevError, JEV_MESSAGES, JEV_MESSAGES_EN, createJevClient, choice, jevMessage, noul, score } from '../lib/jev.js';
import { FAKE_KEY, startFakeJev } from './helpers/fake-jev.mjs';

/* The Jev (TypeSafe AI System One) client against a local fake that follows docs.typesafe.ai. */

const han = /[㐀-鿿]/;
const waits = [];
const clientFor = (fake, extra = {}) => createJevClient({ apiKey: fake.key, baseUrl: fake.baseUrl, random: () => 0,
  sleep: async ms => { waits.push(ms); }, ...extra });
async function harness(t, options) {
  const fake = await startFakeJev(options);
  t.after(() => fake.close());
  waits.length = 0;
  return fake;
}

test('the endpoint, the model and the limits live in one place', () => {
  assert.equal(JEV.baseUrl, 'https://api.typesafe.ai');
  assert.equal(JEV.path, '/v1/systemone');
  assert.equal(JEV.model, 'jev-latest');
  assert.equal(JEV.maxChoices, 255);
  assert.deepEqual([JEV.minScoreLevels, JEV.maxScoreLevels], [2, 10]);
  assert.equal(JEV.maxRetries, 2);
});

test('the request is exactly what the documentation shows: POST /v1/systemone, bearer key, { state, model, questions }', async t => {
  const fake = await harness(t);
  const client = clientFor(fake);
  await client.decide({ title: 'Lecture 3', excerpt: 'Kubernetes pods' }, {
    topic: choice('Which course does this belong to?', { a: 'Course A', b: 'Course B' }),
    clear: noul('Is the text understandable by itself?', { true: 'self-contained', false: 'needs context' }),
    plain: noul('Is it about containers?'),
    level: score('How hard is it?', ['easy', 'medium', 'hard']),
  });
  assert.equal(fake.requests.length, 1);
  const [request] = fake.requests;
  assert.equal(request.method, 'POST');
  assert.equal(request.path, '/v1/systemone');
  assert.equal(request.headers.authorization, `Bearer ${FAKE_KEY}`);
  assert.match(request.headers['content-type'], /^application\/json/);
  assert.deepEqual(Object.keys(request.payload).sort(), ['model', 'questions', 'state']);
  assert.equal(request.payload.model, 'jev-latest');
  assert.deepEqual(request.payload.state, { title: 'Lecture 3', excerpt: 'Kubernetes pods' });
  assert.deepEqual(request.payload.questions, {
    topic: { type: 'choice', instructions: 'Which course does this belong to?', criteria: { a: 'Course A', b: 'Course B' } },
    clear: { type: 'noul', instructions: 'Is the text understandable by itself?', criteria: { true: 'self-contained', false: 'needs context' } },
    plain: { type: 'noul', instructions: 'Is it about containers?' },
    level: { type: 'score', instructions: 'How hard is it?', criteria: ['easy', 'medium', 'hard'] },
  });
});

test('a string state and an array state are sent as they are', async t => {
  const fake = await harness(t);
  const client = clientFor(fake);
  await client.decide('plain text', { q: noul('ok?') });
  await client.decide(['a', 'b'], { q: noul('ok?') });
  assert.equal(fake.requests[0].payload.state, 'plain text');
  assert.deepEqual(fake.requests[1].payload.state, ['a', 'b']);
});

test('the answers come back normalised with the token usage', async t => {
  const fake = await harness(t, { answer: (name, question) => ({
    noul: { type: 'noul', noul: 0.93 },
    choice: { type: 'choice', choice: 'b', confidence: 0.81, probabilities: { a: 0.1, b: 0.9 } },
    score: { type: 'score', score: 1.43, confidence: 0.35, legend: { 0: 'x', 1: 'y', 2: 'z' }, probabilities: { 0: 0, 1: 0.57, 2: 0.43 } },
  })[question.type], usage: () => ({ input_tokens: 328, output_tokens: 34 }) });
  const result = await clientFor(fake).decide('s', { n: noul('a?'), c: choice('b?', { a: '1', b: '2' }), s: score('c?', ['x', 'y', 'z']) });
  assert.equal(result.model, 'jev-1.13.0');
  assert.deepEqual(result.answers.n, { type: 'noul', noul: 0.93 });
  assert.deepEqual(result.answers.c, { type: 'choice', choice: 'b', confidence: 0.81, probabilities: { a: 0.1, b: 0.9 } });
  assert.equal(result.answers.s.score, 1.43);
  assert.deepEqual(result.usage, { inputTokens: 328, outputTokens: 34 });
});

test('401 is an invalid key (not retried), 422 an invalid request (not retried)', async t => {
  const fake = await harness(t);
  await assert.rejects(createJevClient({ apiKey: 'wrong-key-0000000000000000', baseUrl: fake.baseUrl, sleep: async () => {} }).decide('s', { q: noul('a?') }),
    error => error instanceof JevError && error.code === 'invalid-key' && error.httpStatus === 401 && error.retryable === false);
  assert.equal(fake.requests.length, 1, 'no retry on 401');
  fake.fail(422);
  await assert.rejects(clientFor(fake).decide('s', { q: noul('a?') }),
    error => error.code === 'invalid-request' && error.httpStatus === 422 && error.retryable === false);
  assert.equal(fake.requests.length, 2);
});

test('429 and 529 are retried with exponential backoff (0.5 s, doubling), then reported as rate-limited / overloaded', async t => {
  const fake = await harness(t, { failures: [429, 429, 429] });
  await assert.rejects(clientFor(fake).decide('s', { q: noul('a?') }), error => error.code === 'rate-limited' && error.retryable === true && error.httpStatus === 429);
  assert.equal(fake.requests.length, 3, 'one try and two retries');
  assert.deepEqual(waits, [500, 1000]);
  waits.length = 0;
  fake.fail(529, 529, 529);
  await assert.rejects(clientFor(fake).decide('s', { q: noul('a?') }), error => error.code === 'overloaded' && error.httpStatus === 529);
  assert.deepEqual(waits, [500, 1000]);
});

test('a retry that succeeds returns the answer; the delay is capped at 5 s and jitter only ever shortens it', async t => {
  const fake = await harness(t, { failures: [529] });
  const result = await clientFor(fake, { random: () => 1 }).decide('s', { q: noul('a?') });
  assert.equal(result.answers.q.noul, 0.5);
  assert.deepEqual(waits, [375], 'jitter removes up to 25%');
  waits.length = 0;
  const slow = await harness(t, { failures: [500, 500, 500, 500, 500, 500] });
  await assert.rejects(clientFor(slow, { maxRetries: 5 }).decide('s', { q: noul('a?') }), error => error.code === 'unavailable');
  assert.deepEqual(waits, [500, 1000, 2000, 4000, 5000]);
});

test('Retry-After is honoured when it is short, and a long one is reported instead of waited for', async t => {
  const fake = await harness(t, { failures: [{ status: 429, headers: { 'retry-after': '2' } }] });
  await clientFor(fake).decide('s', { q: noul('a?') });
  assert.deepEqual(waits, [2000]);
  waits.length = 0;
  fake.fail({ status: 429, headers: { 'retry-after': '120' } });
  await assert.rejects(clientFor(fake).decide('s', { q: noul('a?') }), error => error.code === 'rate-limited' && error.retryAfterMs === 120000);
  assert.deepEqual(waits, [], 'it did not sit and wait two minutes');
});

test('a request that takes longer than the timeout is a timeout; a closed port is a network failure; both are retried', async t => {
  const slow = await harness(t, { delayMs: 300 });
  await assert.rejects(clientFor(slow, { timeoutMs: 40, maxRetries: 1 }).decide('s', { q: noul('a?') }), error => error.code === 'timeout' && error.retryable === true);
  assert.equal(slow.requests.length, 2, 'retried once');
  const gone = await startFakeJev();
  const baseUrl = gone.baseUrl;
  await gone.close();
  await assert.rejects(createJevClient({ apiKey: FAKE_KEY, baseUrl, sleep: async () => {}, maxRetries: 0 }).decide('s', { q: noul('a?') }), error => error.code === 'network');
});

test('an aborted signal stops at once with its own reason and never retries', async t => {
  const fake = await harness(t, { delayMs: 200 });
  const controller = new AbortController();
  const pending = clientFor(fake).decide('s', { q: noul('a?') }, { signal: controller.signal });
  setTimeout(() => controller.abort(new Error('cancelled by the learner')), 30);
  await assert.rejects(pending, error => error.message === 'cancelled by the learner');
  assert.equal(fake.requests.length, 1);
  await assert.rejects(clientFor(fake).decide('s', { q: noul('a?') }, { signal: AbortSignal.abort(new Error('already')) }), error => error.message === 'already');
  assert.equal(fake.requests.length, 1, 'an already aborted signal sends nothing');
});

test('a request the service would refuse is refused before it is sent', async t => {
  const fake = await harness(t);
  const client = clientFor(fake);
  const refuse = (state, questions) => assert.rejects(client.decide(state, questions), error => error instanceof JevError && error.code === 'invalid-request');
  await refuse('s', {});
  await refuse('', { q: noul('a?') });
  await refuse('s', { q: { type: 'noul' } });
  await refuse('s', { q: { type: 'rank', instructions: 'x' } });
  await refuse('s', { q: choice('pick', {}) });
  await refuse('s', { q: choice('pick', Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`o${i}`, 'd']))) });
  await refuse('s', { q: score('rate', ['only one']) });
  await refuse('s', { q: score('rate', Array.from({ length: 11 }, (_, i) => `l${i}`)) });
  await assert.rejects(client.decide('x'.repeat(JEV.maxStateChars + 1), { q: noul('a?') }), error => error.code === 'too-large');
  assert.equal(fake.requests.length, 0, 'nothing was sent');
  // The edge cases the service accepts.
  await client.decide('s', { q: choice('pick', Object.fromEntries(Array.from({ length: 255 }, (_, i) => [`o${i}`, 'd']))), r: score('rate', ['a', 'b']), t: score('rate', Array.from({ length: 10 }, (_, i) => `l${i}`)) });
  assert.equal(fake.requests.length, 1);
});

test('a malformed answer is a bad response, not a guess', async t => {
  for (const answer of [
    () => ({ type: 'noul', noul: 1.5 }),
    () => ({ type: 'noul' }),
    () => ({ type: 'choice', choice: 'zzz', confidence: 0.5, probabilities: { zzz: 1 } }),
    () => ({ type: 'choice', choice: 'a', confidence: 0.5, probabilities: { a: 'high' } }),
    () => ({ type: 'score', score: 'x' }),
  ]) {
    const fake = await harness(t, { answer });
    await assert.rejects(clientFor(fake).decide('s', { q: answer().type === 'noul' ? noul('a?') : answer().type === 'choice' ? choice('b?', { a: '1', b: '2' }) : score('c?', ['x', 'y']) }),
      error => error.code === 'bad-response');
  }
  const dropped = await harness(t, { answer: () => ({ type: 'noul', noul: 0.5 }) });
  // Two questions, but the answer type of one does not match.
  await assert.rejects(clientFor(dropped).decide('s', { a: noul('a?'), b: choice('b?', { x: '1', y: '2' }) }), error => error.code === 'bad-response');
});

test('errors never carry the key or the state, and every error has a plain message in both languages', async t => {
  const fake = await harness(t, { failures: [401] });
  const secret = 'the learner wrote a private sentence';
  try { await clientFor(fake).decide(secret, { q: noul('a?') }); assert.fail('should reject'); }
  catch (error) {
    const dump = `${error.message} ${JSON.stringify(error)} ${error.stack}`;
    assert.ok(!dump.includes(FAKE_KEY), 'no key');
    assert.ok(!dump.includes(secret), 'no state');
    assert.match(error.message, /Jev/);
  }
  assert.deepEqual(Object.keys(JEV_MESSAGES).sort(), Object.keys(JEV_MESSAGES_EN).sort());
  for (const code of Object.keys(JEV_MESSAGES)) {
    assert.ok(han.test(JEV_MESSAGES[code]), `${code} is Chinese`);
    assert.ok(!han.test(JEV_MESSAGES_EN[code]), `${code} English has no Han`);
    assert.equal(jevMessage(code, 'en'), JEV_MESSAGES_EN[code]);
    assert.equal(jevMessage(code, 'zh'), JEV_MESSAGES[code]);
  }
  for (const code of ['invalid-key', 'rate-limited', 'overloaded', 'network', 'timeout', 'invalid-request', 'bad-response', 'unavailable', 'too-large', 'no-key']) assert.ok(JEV_MESSAGES[code], code);
});

test('check() is one tiny harmless call that reports the model and the tokens it used', async t => {
  const fake = await harness(t);
  const result = await clientFor(fake).check();
  assert.equal(result.ok, true);
  assert.equal(result.model, 'jev-1.13.0');
  assert.ok(result.usage.inputTokens > 0);
  assert.equal(fake.requests.length, 1);
  assert.ok(fake.requests[0].body.length < 600, 'tiny');
  assert.ok(!fake.requests[0].body.includes('lecture'), 'no learner text');
});

test('the client is a provider: { id, decide }, the seam another provider can fill', async t => {
  const fake = await harness(t);
  const client = clientFor(fake);
  assert.equal(client.id, 'jev');
  assert.equal(typeof client.decide, 'function');
});
