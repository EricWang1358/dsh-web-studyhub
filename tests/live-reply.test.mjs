import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REPLY_RULE, replyShape, rescuedComplete } from '../lib/live-reply.js';

const json = '{"items":[]}';
const prose = '你发来的是一段（未讲完的）课堂录音转写，我来帮你整理一下要点。';

test('a reply is JSON, prose (no JSON at all) or cut off (JSON that never closes)', () => {
  assert.equal(replyShape(json), 'json');
  assert.equal(replyShape('```json\n{"items":[]}\n```'), 'json');
  assert.equal(replyShape(`好的，结果如下：${json}`), 'json');
  assert.equal(replyShape(prose), 'prose');
  assert.equal(replyShape(''), 'prose');
  assert.equal(replyShape('{"items":[{"n":1,"edits":[{"from":"a"'), 'cut');
});

test('a request is sent exactly as written; a prose reply is asked again with the reply rule, which then stays for that model', async () => {
  const prompts = [];
  const replies = [prose, json, json];
  const ask = rescuedComplete({ primary: async (system, prompt) => { prompts.push({ system, prompt }); return replies.shift(); } });
  assert.equal(await ask('SYS', '{"x":1}'), json);
  assert.deepEqual(prompts[0], { system: 'SYS', prompt: '{"x":1}' });
  assert.deepEqual(prompts[1], { system: 'SYS', prompt: '{"x":1}' + REPLY_RULE });
  assert.equal(await ask('SYS', '{"x":2}'), json);
  assert.equal(prompts.length, 3, 'no wasted first try once the model is known to need the rule');
  assert.equal(prompts[2].prompt, '{"x":2}' + REPLY_RULE);
});

test('when the model keeps answering in prose, the other model takes over and stays', async () => {
  let primaryCalls = 0, fallbackCalls = 0;
  const switched = [];
  const ask = rescuedComplete({
    primary: async () => { primaryCalls++; return prose; },
    fallback: async () => { fallbackCalls++; return json; },
    onSwitch: reason => switched.push(reason),
  });
  assert.equal(await ask('S', 'P'), json);
  assert.deepEqual([primaryCalls, fallbackCalls], [2, 1]);
  assert.deepEqual(switched, ['prose']);
  // Sticky: the next request goes straight to the model that answered.
  assert.equal(await ask('S', 'P2'), json);
  assert.deepEqual([primaryCalls, fallbackCalls], [2, 2]);
});

test('with no other model, prose twice is a ReplyFormatError of kind prose that keeps what the model said', async () => {
  const ask = rescuedComplete({ primary: async () => prose });
  await assert.rejects(ask('S', 'P'), error => error.name === 'ReplyFormatError' && error.kind === 'prose' && error.message.includes('你发来的是一段'));
});

test('a cut-off reply is returned as it is: the caller decides (it is about size, not about format)', async () => {
  let calls = 0;
  const cut = '{"items":[{"n":1';
  const ask = rescuedComplete({ primary: async () => { calls++; return cut; }, fallback: async () => json });
  assert.equal(await ask('S', 'P'), cut);
  assert.equal(calls, 1);
});

test('a network or rate-limit failure tries the other model once for this request, without switching for good', async () => {
  let primaryCalls = 0;
  const ask = rescuedComplete({
    primary: async () => { primaryCalls++; if (primaryCalls === 1) throw Object.assign(new Error('429 Too Many Requests'), { status: 429 }); return json; },
    fallback: async () => json,
  });
  assert.equal(await ask('S', 'P'), json);
  assert.equal(await ask('S', 'P'), json);
  assert.equal(primaryCalls, 2, 'the second request went to the primary model again');
});

test('a timeout or a stop is not rescued: it belongs to the caller (size, or the learner stopped)', async () => {
  const timeout = Object.assign(new Error('校正请求超时'), { name: 'TimeoutError' });
  let fallbackCalls = 0;
  const ask = rescuedComplete({ primary: async () => { throw timeout; }, fallback: async () => { fallbackCalls++; return json; } });
  await assert.rejects(ask('S', 'P'), error => error === timeout);
  const controller = new AbortController();
  controller.abort();
  const stopped = rescuedComplete({ primary: async () => { throw new Error('aborted'); }, fallback: async () => { fallbackCalls++; return json; } });
  await assert.rejects(stopped('S', 'P', { signal: controller.signal }));
  assert.equal(fallbackCalls, 0);
});

test('when both models fail with errors, the primary error is the one reported', async () => {
  const ask = rescuedComplete({ primary: async () => { throw new Error('network down'); }, fallback: async () => { throw new Error('fallback down'); } });
  await assert.rejects(ask('S', 'P'), /network down/);
});
