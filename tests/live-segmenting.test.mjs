import test from 'node:test';
import assert from 'node:assert/strict';
import { LIVE_SEGMENT_CAP, LiveSession, splitTranscript } from '../lib/live.js';
import { GeminiTiers } from '../lib/gemini.js';

/* A final piece from Gemini can be minutes long (owner's class of 2026-11-04: sentences of 2,419 and 1,990 characters with many 。 inside). A piece is
   cut at every sentence end inside it (CJK and Latin), tiny fragments merge forward to 20 characters, and where there is no sentence end it is cut
   near 300 characters at the last comma, 、, ； or space. Chinese text on any engine needs no translation (nativeChinese for all). */

const FREE = 'AIzaLiveFreeKey_00000000000000001';
const until = async (check, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return; await new Promise(r => setTimeout(r, 5)); }
  assert.fail('condition not met in time');
};
const FIRST = '第一句话已经说完了而且说得很长很长很长很长很长。';
const chinese = n => `数据库的第${n}条规则说明了事务为什么必须保持一致性，请记住它。`;

test('splitTranscript: a long Chinese piece with 。 inside becomes one part per sentence, each within the cap, losing nothing', () => {
  const text = Array.from({ length: 40 }, (_, i) => chinese(i + 1)).join('');
  assert.ok(text.length > 1000);
  const { parts, rest } = splitTranscript(text);
  assert.equal(parts.length, 40);
  assert.equal(rest, '');
  assert.ok(parts.every(part => part.length <= LIVE_SEGMENT_CAP && /。$/.test(part)));
  assert.equal(parts.join(''), text);
});

test('splitTranscript: a sentence end is 。？！ and … anywhere, and . ? ! only before a space or the end (3.14 stays whole)', () => {
  const latin = 'The value of pi is about 3.14 in this course. Is that clear to everyone here? Yes it is, thank you very much!';
  const { parts, rest } = splitTranscript(latin);
  assert.deepEqual(parts, ['The value of pi is about 3.14 in this course. ', 'Is that clear to everyone here? ', 'Yes it is, thank you very much!']);
  assert.equal(rest, '');
  const cjk = splitTranscript('这一章讲的是索引为什么能够加快查询的速度，大家明白了吗？答案其实很简单，因为它大大减少了每次需要读取的数据量！好，那么下一个问题我们接着往下讲，请看这张图……');
  assert.equal(cjk.parts.length, 3);
});

test('splitTranscript: fragments under 20 characters merge forward into the next sentence', () => {
  const { parts } = splitTranscript('好。对。这是一句足够长的话，用来承接前面的短句。再来一句比较长的话作为收尾，希望大家都能听明白哦。');
  assert.deepEqual(parts, ['好。对。这是一句足够长的话，用来承接前面的短句。', '再来一句比较长的话作为收尾，希望大家都能听明白哦。']);
});

test('splitTranscript: text that has not reached a sentence end stays as the rest; when finished, a tail under 20 characters joins the last part', () => {
  const open = splitTranscript(`${FIRST}第二句话还在说`);
  assert.deepEqual(open, { parts: [FIRST], rest: '第二句话还在说' });
  const done = splitTranscript(`${FIRST}第二句话还在说`, { final: true });
  assert.deepEqual(done, { parts: [`${FIRST}第二句话还在说`], rest: '' });
  const long = splitTranscript(`${FIRST}第二句话还在说而且还要说上好一阵子才会停下来`, { final: true });
  assert.deepEqual(long.parts, [FIRST, '第二句话还在说而且还要说上好一阵子才会停下来']);
});

test('splitTranscript: no sentence end is cut at the cap, at the last comma, 、, ； or space when there is one', () => {
  assert.equal(LIVE_SEGMENT_CAP, 300);
  const bare = '字'.repeat(900);
  const cut = splitTranscript(bare, { final: true });
  assert.deepEqual(cut.parts.map(part => part.length), [300, 300, 300]);
  const commas = Array.from({ length: 30 }, (_, i) => `这是没有句号的第${i + 1}段话语内容`).join('，');
  const out = splitTranscript(commas, { final: true });
  assert.ok(out.parts.length >= 2);
  assert.ok(out.parts.every(part => part.length <= LIVE_SEGMENT_CAP), 'within the cap');
  assert.ok(out.parts.slice(0, -1).every(part => /，$/.test(part)), 'cut after a comma');
  assert.equal(out.parts.join(''), commas);
  const spaced = Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ');
  const words = splitTranscript(spaced, { final: true });
  assert.ok(words.parts.length >= 2 && words.parts.every(part => part.length <= LIVE_SEGMENT_CAP));
  assert.equal(words.parts.map(part => part.trim()).join(' '), spaced, 'cut at a space, no word is broken');
  // Not final: the last stretch under the cap stays in the buffer.
  const open = splitTranscript(bare);
  assert.deepEqual(open.parts.map(part => part.length), [300, 300, 300]);
  assert.equal(open.rest, '');
  assert.equal(splitTranscript('字'.repeat(700)).rest.length, 100);
});

/* ---- through a session ---- */

function socketClass() {
  return class FakeSocket {
    static instances = [];
    constructor(url) {
      this.url = url; this.readyState = 0; this.sent = []; this.listeners = {};
      FakeSocket.instances.push(this);
      setTimeout(() => { this.onSend = message => { if (message.setup) this.say({ setupComplete: {} }); }; this.readyState = 1; this.emit('open'); }, 0);
    }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    emit(type, event = {}) { for (const fn of this.listeners[type] || []) fn(event); }
    send(data) { const message = JSON.parse(data); this.sent.push(message); this.onSend?.(message); }
    close(code = 1000, reason = '') { if (this.readyState === 3) return; this.readyState = 3; setTimeout(() => this.emit('close', { code, reason }), 0); }
    say(message) { this.emit('message', { data: JSON.stringify(message) }); }
  };
}
const timing = { rotateAfterMs: 60_000, idleFlushMs: 30, retireGraceMs: 20, stopWaitMs: 40, saveDelayMs: 10, readyGraceMs: 200 };
function session(Socket, extra = {}) {
  return new LiveSession({ title: 'Segments', tiers: new GeminiTiers({ keys: { free: FREE } }), WebSocketImpl: Socket, timing, save: async () => {}, ...extra });
}

test('one 2,400-character Chinese piece with 。 inside becomes many segments, all within the cap, with the same t', async () => {
  const Socket = socketClass();
  const live = session(Socket, { translate: null });
  await live.start();
  const text = Array.from({ length: 40 }, (_, i) => chinese(i + 1)).join('');
  assert.ok(text.length >= 1000);
  Socket.instances[0].say({ serverContent: { inputTranscription: { text }, turnComplete: true } });
  await until(() => live.segments.length === 40);
  assert.ok(live.segments.every(segment => segment.en.length <= LIVE_SEGMENT_CAP));
  assert.equal(new Set(live.segments.map(segment => segment.t)).size, 1, 'one moment');
  assert.equal(new Set(live.segments.map(segment => segment.id)).size, 40);
  assert.equal(live.segments.map(segment => segment.en).join(''), text);
  await live.stop();
});

test('a long piece with no punctuation is cut at the cap, and what is left closes after the pause', async () => {
  const Socket = socketClass();
  const live = session(Socket, { translate: null });
  await live.start();
  Socket.instances[0].say({ serverContent: { inputTranscription: { text: '字'.repeat(700) } } });
  await until(() => live.segments.length === 3);
  assert.deepEqual(live.segments.map(segment => segment.en.length), [300, 300, 100]);
  await live.stop();
});

test('a sentence end inside the buffer cuts there even when the buffer ends mid-sentence, and the open part waits for the rest', async () => {
  const Socket = socketClass();
  const live = session(Socket, { translate: null, timing: { ...timing, idleFlushMs: 60_000 } });
  await live.start();
  const say = text => Socket.instances[0].say({ serverContent: { inputTranscription: { text } } });
  say(`${FIRST}第二句话还在`);
  await until(() => live.segments.length === 1);
  assert.equal(live.segments[0].en, FIRST);
  assert.equal(live.snapshot().interim.trim(), '第二句话还在');
  say('说，而且要把整个意思都说完整以后才算真正说完啊。');
  await until(() => live.segments.length === 2);
  assert.equal(live.segments[1].en, '第二句话还在说，而且要把整个意思都说完整以后才算真正说完啊。');
  await live.stop();
});

test('Chinese speech on the Gemini engine is not queued for translation; English still is', async () => {
  const Socket = socketClass();
  const calls = [];
  const live = session(Socket, { translate: async ({ items }) => { calls.push(items.map(item => item.en)); return new Map(items.map(item => [item.n, `译：${item.en}`])); } });
  assert.equal(live.engine, 'gemini');
  await live.start();
  const say = text => Socket.instances[0].say({ serverContent: { inputTranscription: { text }, turnComplete: true } });
  say('这句已经是中文，不需要翻译，直接显示即可。');
  say('A transaction is a unit of work that either commits or rolls back.');
  await until(() => live.snapshot().translating === 0 && live.snapshot().total === 2);
  const [zh, en] = live.snapshot().segments;
  assert.equal(zh.zhState, 'none');
  assert.equal(zh.zh, '');
  assert.equal(en.zhState, 'done');
  assert.deepEqual(calls.flat(), ['A transaction is a unit of work that either commits or rolls back.']);
  await live.stop();
});
