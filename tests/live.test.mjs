import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FRAME_BYTES, LIVE_ENDPOINT, audioMessage, classifyClose, frameText, frames, parseServerMessage, setupMessage,
} from "../lib/live-protocol.js";
import { LiveSession, deleteSaved, listSaved, makeTranslator, readSaved, writeSaved } from "../lib/live.js";
import { GeminiTiers } from "../lib/gemini.js";
import { clock, excerptText, quickDocuments } from "../lib/live-save.js";
import { StudyService } from "../lib/service.js";
import { localizeAppMessage } from "../lib/application-messages.js";

const FREE = "AIzaLiveFreeKey_00000000000000001", PAID = "AIzaLivePaidKey_00000000000000002";
const pcm = (ms) => Buffer.alloc(ms * 32);
const until = async (check, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return; await new Promise((r) => setTimeout(r, 5)); }
  assert.fail("condition not met in time");
};

/* A stand-in for the browser/Node WebSocket. `behavior(socket, key)` plays the server. */
function socketClass(behavior) {
  return class FakeSocket {
    static instances = [];
    constructor(url) {
      this.url = url; this.readyState = 0; this.sent = []; this.listeners = {};
      this.key = new URL(url).searchParams.get("key");
      FakeSocket.instances.push(this);
      setTimeout(() => behavior(this, this.key), 0);
    }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    emit(type, event = {}) { for (const fn of this.listeners[type] || []) fn(event); }
    send(data) { const message = JSON.parse(data); this.sent.push(message); this.onSend?.(message); }
    close(code = 1000, reason = "") { if (this.readyState === 3) return; this.readyState = 3; setTimeout(() => this.emit("close", { code, reason }), 0); }
    open() { this.readyState = 1; this.emit("open"); }
    say(message) { this.emit("message", { data: JSON.stringify(message) }); }
    audio() { return this.sent.filter((m) => m.realtimeInput?.audio); }
  };
}
const healthy = (socket) => {
  socket.onSend = (message) => { if (message.setup) socket.say({ setupComplete: {} }); };
  socket.open();
};
const refuse = (code, reason) => (socket) => { socket.open(); socket.close(code, reason); };

const timing = { rotateAfterMs: 60_000, idleFlushMs: 30, retireGraceMs: 20, stopWaitMs: 40, saveDelayMs: 10, reconnectDelaysMs: [5, 5, 5], translateRetryMs: 5, readyGraceMs: 200 };
const echoTranslate = async ({ items }) => new Map(items.map((item) => [item.n, `译：${item.en}`]));
function session(Socket, extra = {}) {
  const tiers = extra.tiers || new GeminiTiers({ keys: { free: FREE, paid: PAID } });
  return new LiveSession({ title: "Databases", tiers, WebSocketImpl: Socket, translate: echoTranslate, timing, vocabulary: ["partition"], ...extra });
}

test("server messages are understood in camelCase, snake_case, nested or flat, text or binary", async () => {
  assert.deepEqual(parseServerMessage('{"setupComplete":{}}').setupComplete, true);
  assert.equal(parseServerMessage('{"serverContent":{"inputTranscription":{"text":"hello"}}}').final, "hello");
  assert.equal(parseServerMessage('{"server_content":{"input_transcription":{"text":"snake nested"}}}').final, "snake nested");
  assert.equal(parseServerMessage('{"serverContent":{"interimInputTranscription":{"text":"hel"}}}').interim, "hel");
  assert.equal(parseServerMessage('{"input_transcription":{"text":"flat snake"}}').final, "flat snake");
  assert.equal(parseServerMessage('{"serverContent":{"interim_input_transcription":"plain string"}}').interim, "plain string");
  assert.equal(parseServerMessage('{"serverContent":{"turnComplete":true}}').turnComplete, true);
  assert.equal(parseServerMessage('{"goAway":{"timeLeft":"30s"}}').goAway, "30s");
  const odd = parseServerMessage('{"somethingNew":1,"serverContent":{"mystery":2}}');
  assert.deepEqual(odd.keys, ["somethingNew", "serverContent", "serverContent.mystery"], "unknown shapes are reported by key names only");
  assert.equal(parseServerMessage("not json").ignored, true);
  assert.equal(await frameText(Buffer.from('{"a":1}')), '{"a":1}');
  assert.equal(await frameText(new TextEncoder().encode('{"b":2}').buffer), '{"b":2}');
  assert.equal(await frameText({ text: async () => "blob" }), "blob");
});

test("Chinese speech still goes through Simplified Chinese translation", async () => {
  const Socket = socketClass(healthy);
  const live = session(Socket, { translate: async ({ items }) => new Map(items.map((item) => [item.n, "这个数据库的事务必须保持一致性。"] )) });
  await live.start();
  Socket.instances[0].say({ serverContent: { inputTranscription: { text: "這個資料庫的事務必須保持一致性。" }, turnComplete: true } });
  await until(() => live.segments[0]?.zhState === 'done');
  assert.equal(live.segments[0].zh, "这个数据库的事务必须保持一致性。");
  await live.stop();
});

test("persisted sessions without a translator settle without waiting forever", async () => {
  const live = session(socketClass(healthy), { translate: null, saved: { segments: [{ id: 1, en: 'Pending', zh: '', zhState: 'pending' }] } });
  await Promise.race([live.settled(), new Promise((_, reject) => setTimeout(() => reject(new Error('settled timed out')), 100))]);
});

test("disk snapshots serialize writes and expose a storage failure", async () => {
  let release, started = 0, last;
  const live = session(socketClass(healthy), { save: async (snapshot) => {
    started++;
    if (started === 1) await new Promise((resolve) => { release = resolve; });
    last = snapshot;
  } });
  const first = live.saveNow();
  await until(() => started === 1);
  live.title = 'Latest title';
  const second = live.saveNow();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(started, 1, 'the second write waits for the first');
  release(); await Promise.all([first, second]);
  assert.equal(last.title, 'Latest title');
  const failing = session(socketClass(healthy), { save: async () => { throw new Error('disk full'); } });
  await failing.saveNow();
  assert.match(failing.snapshot().message, /保存失败/);
  await assert.rejects(failing.retirePersistence(), /保存失败/);
  assert.equal(typeof failing.persist, 'function', 'failed persistence must keep the in-memory writer available for retry');
  failing.persist = async () => {};
  await failing.retirePersistence();
  assert.equal(failing.persist, null);
});

test("closes are classified for the key logic, and audio is framed at 100 ms", () => {
  assert.equal(classifyClose(1007, "API key not valid. Please pass a valid API key.").kind, "key");
  assert.equal(classifyClose(1011, "RESOURCE_EXHAUSTED: quota exceeded for the day").kind, "quota");
  assert.equal(classifyClose(1011, "RESOURCE_EXHAUSTED: per day").scope, "day");
  assert.equal(classifyClose(1006, "").kind, "other");
  const { frames: list, rest } = frames(Buffer.alloc(FRAME_BYTES * 2 + 100));
  assert.equal(list.length, 2);
  assert.equal(rest.length, 100);
  assert.equal(FRAME_BYTES, 3200);
  const message = audioMessage(Buffer.from([1, 2, 3, 4]));
  assert.deepEqual(message.realtimeInput.audio, { data: "AQIDBA==", mimeType: "audio/pcm;rate=16000" });
  const setup = setupMessage({ languageCodes: [], vocabulary: ["partition"] }).setup;
  assert.deepEqual(setup, { model: "models/gemini-3.5-transcribe-live", generationConfig: { responseModalities: ["TEXT"] },
    inputAudioTranscription: { languageCodes: [], customVocabulary: ["partition"], mode: "VERBATIM" } });
  assert.ok(LIVE_ENDPOINT.startsWith("wss://generativelanguage.googleapis.com/ws/"));
});

test("audio is sent as 100 ms frames on the free key and its time is counted", async () => {
  const Socket = socketClass(healthy);
  const live = session(Socket);
  await live.start();
  assert.equal(Socket.instances.length, 1);
  assert.equal(Socket.instances[0].key, FREE);
  assert.equal(Socket.instances[0].sent[0].setup.inputAudioTranscription.customVocabulary[0], "partition");
  live.push(pcm(250)); live.push(pcm(250)); live.push(pcm(500));
  const sent = Socket.instances[0].audio();
  assert.equal(sent.length, 10);
  assert.ok(sent.every((m) => Buffer.from(m.realtimeInput.audio.data, "base64").length === 3200));
  assert.equal(live.snapshot().usage.freeSeconds, 1);
  assert.equal(live.snapshot().usage.paidSeconds, 0);
  assert.equal(live.snapshot().tier, "free");
  await live.stop();
});

test("transcript pieces become sentences; silence and end of turn also close one", async () => {
  const Socket = socketClass(healthy);
  const live = session(Socket, { translate: null });
  await live.start();
  const server = Socket.instances[0];
  server.say({ serverContent: { interimInputTranscription: { text: "so a trans" } } });
  await until(() => live.snapshot().interim === "so a trans");
  server.say({ serverContent: { inputTranscription: { text: "So a transaction" } } });
  server.say({ serverContent: { inputTranscription: { text: "is a logical unit of work." } } });
  await until(() => live.snapshot().total === 1);
  assert.equal(live.snapshot().segments[0].en, "So a transaction is a logical unit of work.");
  assert.equal(live.snapshot().interim, "");
  server.say({ serverContent: { inputTranscription: { text: "and then" } } });
  await until(() => live.snapshot().total === 2);
  assert.equal(live.snapshot().segments.at(-1).en, "and then", "an unfinished piece is closed by silence");
  server.say({ serverContent: { inputTranscription: { text: "Yes." } } });
  server.say({ serverContent: { turnComplete: true } });
  await until(() => live.snapshot().total === 3);
  server.say({ serverContent: { interimInputTranscription: { text: "still talking" } } });
  await until(() => live.snapshot().interim === "still talking");
  await live.stop();
  assert.equal(live.snapshot().segments.at(-1).en, "still talking", "stopping keeps the words that were still interim");
  assert.equal(live.status, "ended");
});

test("sentences are translated in order in small batches, with context, and failures retry", async () => {
  const Socket = socketClass(healthy);
  const calls = [];
  let failNext = 0;
  const translate = async (request) => {
    calls.push(request);
    if (failNext-- > 0) throw new Error("model hiccup");
    return echoTranslate(request);
  };
  const live = session(Socket, { translate });
  await live.start();
  const server = Socket.instances[0];
  for (const text of ["First sentence here is fine.", "Second sentence follows it closely.", "这句已经是中文，不需要翻译，直接显示即可。"])
    server.say({ serverContent: { inputTranscription: { text } } });
  await until(() => live.snapshot().translating === 0 && live.snapshot().total === 3);
  const [one, two, three] = live.snapshot().segments;
  assert.equal(one.zh, "译：First sentence here is fine.");
  assert.equal(two.zhState, "done");
  assert.equal(three.zhState, "none", "Simplified Chinese speech needs no translation on any engine");
  assert.equal(three.zh, "");
  assert.ok(calls.every((c) => c.items.every((i) => i.n)), "items are keyed by segment id");
  assert.ok(calls.flatMap((c) => c.items).length === 2, "only the English sentences reach the translator");

  failNext = 3;
  server.say({ serverContent: { inputTranscription: { text: "Fourth sentence will fail three times." } } });
  await until(() => live.snapshot().segments.at(-1)?.zhState === "error");
  failNext = 0;
  live.retryFailed();
  await until(() => live.snapshot().segments.at(-1).zhState === "done");
  assert.ok(calls.at(-1).context.length > 0, "earlier sentences ride along as context");
  await live.stop();
});

test("a rejected free key moves the session to the paid key; a spent daily quota does too", async () => {
  const Refuse = socketClass((socket, key) => (key === FREE ? refuse(1007, "API key not valid. Please pass a valid API key.")(socket) : healthy(socket)));
  const first = session(Refuse);
  await first.start();
  assert.deepEqual(Refuse.instances.map((s) => s.key), [FREE, PAID]);
  assert.equal(first.snapshot().tier, "paid");
  assert.match(first.snapshot().warnings[0], /免费密钥被拒绝/);
  first.push(pcm(60_000));
  assert.equal(first.snapshot().usage.paidSeconds, 60);
  assert.equal(first.snapshot().usage.estimatedPaidUsd, 0.009, "one paid minute is about $0.009");
  await first.stop();

  const Quota = socketClass((socket, key) => (key === FREE ? refuse(1011, "RESOURCE_EXHAUSTED: quota exceeded for the day")(socket) : healthy(socket)));
  const second = session(Quota);
  await second.start();
  assert.equal(second.snapshot().tier, "paid");
  await second.stop();

  const Nothing = socketClass(refuse(1007, "API key not valid. Please pass a valid API key."));
  await assert.rejects(session(Nothing).start(), /密钥被拒绝/);

  const PaidOnly = socketClass(healthy);
  const paidOnly = session(PaidOnly, { tiers: new GeminiTiers({ keys: { free: FREE, paid: PAID }, skipFree: true }) });
  await paidOnly.start();
  assert.deepEqual(PaidOnly.instances.map((s) => s.key), [PAID], "paid-only never opens a free connection");
  await paidOnly.stop();
});

test("before the 10-minute limit the next connection takes over without a gap", async () => {
  const Socket = socketClass(healthy);
  const live = session(Socket, { timing: { ...timing, rotateAfterMs: 40 } });
  await live.start();
  live.push(pcm(100));
  await until(() => Socket.instances.length === 2);
  await until(() => live.conn === Socket.instances.at(-1).conn || live.snapshot().tier === "free");
  const [old, next] = Socket.instances;
  await until(() => old.sent.some((m) => m.realtimeInput?.audioStreamEnd), 1000);
  live.push(pcm(100));
  assert.equal(next.audio().length, 1, "new audio goes to the new connection");
  assert.equal(old.audio().length, 1, "the old one stopped receiving audio");
  await until(() => old.readyState === 3, 1000);
  assert.equal(live.status, "live");
  old.say({ serverContent: { inputTranscription: { text: "Last words from the old connection." } } });
  await live.stop();
  assert.equal(live.snapshot().segments.at(-1).en, "Last words from the old connection.");
});

test("connection handover retains speech order when the old final arrives late", async () => {
  const Socket = socketClass(healthy);
  const live = session(Socket, { timing: { ...timing, retireGraceMs: 100 } });
  await live.start();
  await live.rotate();
  const [old, next] = Socket.instances;
  next.say({ inputTranscription: { text: 'Second sentence from the next connection.' } });
  old.say({ inputTranscription: { text: 'First sentence from the previous connection.' } });
  await until(() => live.segments.length === 2);
  assert.match(live.segments[0].en, /^First/); assert.match(live.segments[1].en, /^Second/);
  await live.stop();
});

test("setup errors reject the connection before audio can be sent", async () => {
  const Socket = socketClass(socket => {
    socket.onSend = message => { if (message.setup) socket.say({ error: { message: 'Unsupported model configuration' } }); };
    socket.open();
  });
  const live = session(Socket, { timing: { ...timing, connectTimeoutMs: 30, readyGraceMs: 5 } });
  await assert.rejects(live.start(), /Unsupported model configuration/);
});

test('ending during handover drains confirmed text before delayed socket close events', async () => {
  const Socket = socketClass(healthy);
  const live = session(Socket, { timing: { ...timing, stopWaitMs: 1, retireGraceMs: 100 } });
  await live.start();
  await live.rotate();
  for (const socket of Socket.instances) socket.close = function () {
    if (this.readyState === 3) return;
    this.readyState = 3;
    setTimeout(() => this.emit('close', { code: 1000, reason: '' }), 10);
  };
  Socket.instances[1].say({ inputTranscription: { text: 'Confirmed speech from the new connection.' } });
  await live.chain;
  await live.stop();
  assert.equal(live.segments.length, 1);
  assert.match(live.segments[0].en, /^Confirmed/);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(live.segments.length, 1, 'close callbacks must not replay confirmed text');
});

test("a dropped connection is reopened and the audio that waited is sent", async () => {
  const Socket = socketClass(healthy);
  const live = session(Socket);
  await live.start();
  Socket.instances[0].readyState = 3;
  Socket.instances[0].emit("close", { code: 1006, reason: "" });
  assert.equal(live.status, "reconnecting");
  live.push(pcm(300));
  await until(() => Socket.instances.length === 2 && live.status === "live");
  await until(() => Socket.instances[1].audio().length === 3);
  await live.stop();

  const Dead = socketClass((socket) => { if (Dead.instances.length === 1) healthy(socket); else refuse(1006, "")(socket); });
  const doomed = session(Dead);
  await doomed.start();
  Dead.instances[0].readyState = 3;
  Dead.instances[0].emit("close", { code: 1006, reason: "" });
  await until(() => doomed.status === "error", 4000);
  assert.match(doomed.message, /连接中断/);
});

/* #874: a stop that lands while the recognizer is reconnecting used to end at once. finishStop sent the end only to the connections it had, and the audio cached
   during the outage (the backlog, which only attach() sends) was dropped without a word. */
test("a stop during a reconnect waits for the new connection, sends the audio that waited and keeps what it heard", async () => {
  const Socket = socketClass((socket) => {
    if (Socket.instances.length === 1) return healthy(socket);
    socket.onSend = (message) => {
      if (message.setup) socket.say({ setupComplete: {} });
      // The recognizer answers the cached audio once the stream ends, then closes.
      if (message.realtimeInput?.audioStreamEnd) { socket.say({ serverContent: { inputTranscription: { text: "Words spoken while the connection was down." } } }); socket.close(); }
    };
    setTimeout(() => socket.open(), 15);
  });
  const live = session(Socket, { timing: { ...timing, reconnectDelaysMs: [30], stopWaitMs: 1000 } });
  await live.start();
  Socket.instances[0].readyState = 3;
  Socket.instances[0].emit("close", { code: 1006, reason: "" });
  live.push(pcm(300));
  assert.equal(live.backlog.length, 3);
  await live.stop();
  assert.equal(Socket.instances.length, 2, "the stop waited for the reconnection");
  const sent = Socket.instances[1].sent.filter((message) => message.realtimeInput);
  assert.equal(sent.filter((message) => message.realtimeInput.audio).length, 3, "every cached frame reached the new connection");
  assert.equal(sent.at(-1).realtimeInput.audioStreamEnd, true, "then the end");
  assert.deepEqual(live.segments.map((segment) => segment.en), ["Words spoken while the connection was down."]);
  assert.equal(live.status, "ended");
  assert.equal(live.toSaved().lostAudioMs, undefined, "nothing was lost");
  assert.doesNotMatch(live.snapshot().message, /没有转写/);
});

test("a stop whose reconnect does not come back in time ends anyway and says how much audio was lost", async () => {
  // The second connection never opens: the stop waits stopWaitMs, no longer.
  const Socket = socketClass((socket) => { if (Socket.instances.length === 1) healthy(socket); });
  const live = session(Socket, { timing: { ...timing, reconnectDelaysMs: [5], stopWaitMs: 60, connectTimeoutMs: 150 } });
  await live.start();
  Socket.instances[0].readyState = 3;
  Socket.instances[0].emit("close", { code: 1006, reason: "" });
  live.push(pcm(1200));
  const started = Date.now();
  await live.stop();
  assert.ok(Date.now() - started < 1000, "bounded by stopWaitMs, not by the connect timeout");
  assert.equal(live.status, "ended");
  assert.equal(live.backlog.length, 0, "nothing is left waiting for a connection that will not come");
  const saved = live.toSaved();
  assert.equal(saved.lostAudioMs, 1200, "the record keeps how much audio was not transcribed");
  assert.match(live.snapshot().message, /约 1 秒的声音没有转写/);
  assert.doesNotMatch(live.snapshot().message, /正在重连/, "an ended class is not reconnecting");
  assert.doesNotMatch(localizeAppMessage(live.snapshot().message), /[㐀-鿿]/, "said in English too");
  const reopened = session(Socket, { saved });
  assert.match(reopened.snapshot().message, /约 1 秒的声音没有转写/, "the note survives a reload");
  // The attempt that was still connecting gives up later: it is closed, and it does not turn the ended class into an error.
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(Socket.instances[1].readyState, 3);
  assert.equal(live.status, "ended");
  assert.match(live.snapshot().message, /没有转写/);
});

/* #1040 review: the backlog keeps the last 30 s. Audio pushed out of it during a longer outage, and the backlog left when reconnecting gives up, were lost
   without being counted. */
test("a 60 s outage keeps the last 30 s for the new connection and the record says about 30 s were not transcribed", async () => {
  const Socket = socketClass((socket) => {
    if (Socket.instances.length === 1) return healthy(socket);
    socket.onSend = (message) => { if (message.setup) socket.say({ setupComplete: {} }); };
    setTimeout(() => socket.open(), 15);
  });
  const live = session(Socket, { timing: { ...timing, reconnectDelaysMs: [30] } });
  await live.start();
  Socket.instances[0].readyState = 3;
  Socket.instances[0].emit("close", { code: 1006, reason: "" });
  live.push(pcm(60_000));
  await until(() => live.status === "live" && Socket.instances.length === 2);
  await until(() => Socket.instances[1].audio().length === 300);
  assert.equal(Math.round(live.lostAudioMs), 30_000, "the half pushed out of the backlog is counted");
  assert.match(live.snapshot().message, /约 30 秒的声音没有转写/, "the record says so while the class goes on");
  assert.match(localizeAppMessage(live.snapshot().message), /About 30 seconds of audio were not transcribed/);
  assert.doesNotMatch(localizeAppMessage(live.snapshot().message), /[㐀-鿿]/);
  await live.stop();
  assert.equal(live.toSaved().lostAudioMs, 30_000);
});

/* #1040 polish: the English of the lost-audio note agrees with its count, reads on after "; ", and every part of a joined message is translated. */
test("the English lost-audio note says was for one second, were otherwise, and continues a sentence after the semicolon", () => {
  const note = (seconds) => `转写连接断开期间，约 ${seconds} 秒的声音没有转写`;
  assert.equal(localizeAppMessage(note(1)), "About 1 second of audio was not transcribed while the transcription connection was down");
  assert.match(localizeAppMessage(note(2)), /^About 2 seconds of audio were not transcribed/);
  const joined = localizeAppMessage(`页面已关闭或断开，实录已自动结束；${note(1)}`);
  assert.equal(joined, "The page closed or disconnected; live recording ended automatically; about 1 second of audio was not transcribed while the transcription connection was down");
});

test("a message joined from three parts has no Han characters in English", () => {
  const interrupted = "连接中断：无法重连。已记录的内容已保存，可以从列表打开。";
  const storage = "自动保存失败，请检查磁盘；当前文字暂留在内存中";
  const note = "转写连接断开期间，约 2 秒的声音没有转写";
  for (const message of [
    `页面已关闭或断开，实录已自动结束；${interrupted}；${note}`,
    `${interrupted}；${storage}；${note}`,
    `${interrupted}；${storage}`,
    `页面已关闭或断开，实录已自动结束；${interrupted}`,
  ]) {
    const english = localizeAppMessage(message);
    assert.doesNotMatch(english, /[㐀-鿿；]/, english);
    assert.ok(english.includes("; "), english);
  }
  assert.equal(localizeAppMessage(`${interrupted}；${storage}；${note}`),
    "Connection interrupted: Unable to reconnect. Recorded content was saved and can be opened from the list; autosave failed. Check the disk; current text remains in memory; about 2 seconds of audio were not transcribed while the transcription connection was down");
});

test("a reconnect that gives up counts the audio it was holding", async () => {
  const Dead = socketClass((socket) => { if (Dead.instances.length === 1) healthy(socket); else refuse(1006, "")(socket); });
  const live = session(Dead);
  await live.start();
  Dead.instances[0].readyState = 3;
  Dead.instances[0].emit("close", { code: 1006, reason: "" });
  live.push(pcm(2_000));
  await until(() => live.status === "error", 4000);
  assert.equal(live.backlog.length, 0, "nothing is left waiting for a connection that will not come");
  assert.equal(live.toSaved().lostAudioMs, 2_000);
  assert.match(live.snapshot().message, /连接中断.*约 2 秒的声音没有转写/);
  assert.doesNotMatch(localizeAppMessage(live.snapshot().message), /[㐀-鿿]/);
});

test("paused audio is neither sent nor counted", async () => {
  const Socket = socketClass(healthy);
  const live = session(Socket);
  await live.start();
  live.push(pcm(200));
  live.pause();
  live.push(pcm(5000));
  assert.equal(live.status, "paused");
  assert.equal(Socket.instances[0].audio().length, 2);
  assert.equal(Math.round(live.snapshot().elapsedMs), 200);
  live.resume();
  live.push(pcm(100));
  assert.equal(Socket.instances[0].audio().length, 3);
  await live.stop();
});

test("the class is saved as it goes, can be listed, read back and deleted", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "live-save-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const Socket = socketClass(healthy);
  const live = session(Socket, { save: (data) => writeSaved(root, data) });
  await live.start();
  Socket.instances[0].say({ serverContent: { inputTranscription: { text: "A sentence that is worth keeping around." } } });
  await until(async () => (await readdir(join(root, "live")).catch(() => [])).length === 1);
  await live.stop();
  await live.settled();
  const saved = await readSaved(root, live.id);
  assert.equal(saved.segments[0].zh, "译：A sentence that is worth keeping around.");
  assert.ok(!JSON.stringify(saved).includes("AIza"), "no key on disk");
  assert.equal((await listSaved(root))[0].segments, 1);
  await assert.rejects(readSaved(root, "../../secret"), /无效的实录编号/);
  await deleteSaved(root, live.id);
  assert.deepEqual(await listSaved(root), []);
  assert.ok(!(await readFile(join(root, "live", "index.json"), "utf8").catch(() => "")).includes("worth"));
});

test("excerpts and the quick bilingual document follow the class timeline", () => {
  assert.deepEqual([clock(0), clock(75_000), clock(3_725_000)], ["00:00", "01:15", "1:02:05"]);
  const segments = [
    { id: 1, t: 5_000, en: "A transaction is a unit of work.", zh: "事务是一个工作单元。" },
    { id: 2, t: 12_000, en: "It either commits or rolls back.", zh: "" },
  ];
  assert.equal(excerptText("Databases", segments), "《Databases》课堂片段（00:05–00:12）\n\n[00:05] A transaction is a unit of work.\n事务是一个工作单元。\n\n[00:12] It either commits or rolls back.");
  assert.ok(!excerptText("Databases", segments, { includeChinese: false }).includes("事务"));
  const [document] = quickDocuments("Databases", segments);
  assert.match(document, /《Databases》全量中英对照逐字稿\nFull Bilingual Transcript: Live Class Transcript/);
  assert.match(document, /【第一部分：第 1 段 · 00:05–00:12】\n\[Part 1: Segment 1 · 00:05–00:12\]/);
  assert.match(document, /【英文原句】\nA transaction is a unit of work\. It either commits or rolls back\.\n\n【中文对照】\n事务是一个工作单元。（这句没有译文）/);
});

/* ---- through the service, as the panel uses it ---- */

const json = (body) => new Response(JSON.stringify(body), { status: 200 });
function geminiText(seen) {
  return async (url, init = {}) => {
    const body = JSON.parse(init.body);
    const payload = JSON.parse(body.contents[0].parts[0].text);
    seen.push(String(url));
    if (payload.items[0]?.text !== undefined) return json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ items: [],
      note: { text: '分区减少需要读取的数据。', refs: [payload.items[0].n] }, memory: { text: '数据库分区与索引', refs: [payload.items[0].n] }, followups: [] }) }] } }], usageMetadata: {} });
    return json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ items: payload.items.map((i) => ({ n: i.n, zh: `译：${i.en}` })) }) }] } }], usageMetadata: {} });
  };
}
async function serviceFixture(t, { complete, seen = [] } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "live-service-")), previous = process.env.DSH_HOME;
  process.env.DSH_HOME = join(dir, "home");
  t.after(async () => {
    for (const item of await listSaved(service.store.root)) {
      const session = service.runtime.liveSessions.registered(service.store.root, item.id);
      if (session?.active) await session.stop();
      await session?.retirePersistence(); service.runtime.liveSessions.unregister(service.store.root, item.id);
    }
    if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous;
    await rm(dir, { recursive: true, force: true });
  });
  const Socket = socketClass(healthy);
  const service = new StudyService(join(dir, "library"), { fetch: geminiText(seen), WebSocket: Socket, complete });
  await service.call("audio.settings.set", { freeKey: FREE, paidKey: PAID });
  return { service, Socket, seen, dir };
}
const say = (socket, text) => socket.say({ serverContent: { inputTranscription: { text } } });

test('resume and delete wait for translations and retire the old disk writer', async (t) => {
  const { service, Socket } = await serviceFixture(t);
  const started = await service.call('live.start', { title: 'Race test', course: 'Original course' });
  const old = service.runtime.liveSessions.registered(service.store.root, started.id);
  old.timing.stopWaitMs = 10;
  let release;
  old.translate = ({ items }) => new Promise(resolve => { release = () => resolve(new Map(items.map(item => [item.n, '已翻译']))); });
  say(Socket.instances[0], 'The original class has one sentence awaiting translation.');
  await until(() => !!release);
  await service.call('live.stop', { id: started.id });
  let resumed = false;
  const restarting = service.call('live.start', { resumeId: started.id, course: 'Changed focus' }).then(result => { resumed = true; return result; });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(resumed, false, 'wait for the prior writer before loading its snapshot');
  release(); await restarting;
  const current = service.runtime.liveSessions.registered(service.store.root, started.id);
  assert.equal(current.course, 'Original course');
  current.timing.stopWaitMs = 10;
  say(Socket.instances.at(-1), 'The next class adds another important sentence.');
  await until(() => current.segments.length === 2);
  await service.call('live.stop', { id: started.id });
  await current.settled();
  await old.saveNow();
  assert.equal((await readSaved(service.store.root, started.id)).segments.length, 2);
  assert.equal((await readSaved(service.store.root, started.id)).course, 'Original course');
  await service.call('live.delete', { id: started.id });
  await current.saveNow();
  await assert.rejects(readSaved(service.store.root, started.id), /没有找到/);
});

test('restored incomplete translation can retry using configured model', async (t) => {
  const { service } = await serviceFixture(t);
  const id = 'restored-class';
  await writeSaved(service.store.root, { id, title: 'Saved class', segments: [{ id: 1, t: 0, en: 'Please translate this restored sentence.', zh: '', zhState: 'pending' }] });
  const restored = await service.call('live.get', { id });
  assert.equal(restored.segments[0].zhState, 'error');
  await service.call('live.retry', { id });
  await until(async () => (await service.call('live.get', { id })).segments[0].zhState === 'done');
  assert.match((await service.call('live.get', { id })).segments[0].zh, /^译：/);
  await service.runtime.liveSessions.registered(service.store.root, id).settled();
  service.runtime.liveSessions.unregister(service.store.root, id);
});

test('a reopened class retains its course through reviewed transcript saving', async t => {
  const { service } = await serviceFixture(t, { complete: async (system, prompt) => {
    if (system.startsWith('You proofread')) return JSON.stringify({ corrections: [] });
    if (system.startsWith('You translate')) return JSON.stringify({ titleZh: '课堂', titleEn: 'Class',
      paragraphs: JSON.parse(prompt).paragraphs.map(paragraph => ({ n: paragraph.n, zh: '数据库事务保持一致性。' })) });
    return JSON.stringify({ titleEn: 'Transactions' });
  } });
  await service.call('source.add', { title: 'Current course', text: 'Systems', courses: ['Systems'] });
  await service.call('audio.settings.set', { textProvider: 'host' });
  const id = 'saved-course-session';
  await writeSaved(service.store.root, { id, title: 'Databases', course: 'Databases', vocabulary: ['transaction'],
    segments: [{ id: 1, t: 0, en: 'Transactions preserve consistency across related database changes.', zh: '数据库事务保持一致性。', zhState: 'done' }] });
  assert.equal((await service.call('live.get', { id })).course, 'Databases');
  const job = await service.call('live.save', { id, proofread: true });
  const done = await service.call('job.wait', { jobId: job.jobId, timeoutSeconds: 10 });
  assert.equal(done.status, 'complete', done.stage);
  assert.deepEqual((await service.call('source.get', { id: done.sourceIds[0] })).courses, ['Databases']);
  assert.equal((await service.call('snapshot')).focus.course, 'Systems');
});

test("live.* actions: start, stream audio, poll text and translation, stop", async (t) => {
  const { service, Socket, seen } = await serviceFixture(t);
  const started = await service.call("live.start", { title: "Databases week 5", subject: "SQL", terms: "partition, ACID" });
  assert.equal(started.status, "live");
  assert.equal(started.tier, "free");
  await assert.rejects(service.call("live.start", {}), /已经有一场实录在进行/);
  const audio = pcm(300).toString("base64");
  assert.equal((await service.call("live.audio", { id: started.id, data: audio })).status, "live");
  assert.equal(Socket.instances[0].audio().length, 3);
  await assert.rejects(service.call("live.audio", { id: started.id, data: "!!!" }), /音频数据无效/);
  await assert.rejects(service.call("live.audio", { id: "nope", data: audio }), /已经结束或不存在/);

  say(Socket.instances[0], "The optimizer can skip a whole patient when the date filter matches.");
  let poll;
  await until(async () => (poll = await service.call("live.poll", { id: started.id, since: 0 })).segments[0]?.zhState === "done");
  assert.equal(poll.segments[0].zh, "译：The optimizer can skip a whole patient when the date filter matches.");
  assert.equal((await service.call("live.poll", { id: started.id, since: poll.revision })).segments.length, 0, "polling with the last revision returns only changes");
  assert.ok(seen.every((url) => url.includes("gemini-3.5-flash-lite")), "live translation uses the fast model");
  assert.ok(!JSON.stringify(poll).includes("AIza"));

  const stopped = await service.call("live.stop", { id: started.id });
  assert.equal(stopped.status, "ended");
  assert.equal((await service.call("live.list", {})).sessions[0].title, "Databases week 5");
  const reopened = await service.call("live.get", { id: started.id });
  assert.equal(reopened.total, 1);
});

test("selected sentences become a source and a generation job while the class continues", async (t) => {
  const prompts = [];
  const { service, Socket } = await serviceFixture(t, { complete: async (system, prompt) => { prompts.push(prompt); throw new Error("stop after reading"); } });
  // This model only stands in for question generation; the live translation is Gemini here, not that model.
  await service.call("audio.settings.set", { textProvider: "gemini" });
  const { id } = await service.call("live.start", { title: "Databases week 5", course: 'Databases' });
  for (const text of [
    "A transaction is a logical unit of work that either fully happens or does not happen at all.",
    "Isolation levels decide which intermediate states of other transactions a query is allowed to see.",
    "Yes.",
  ]) say(Socket.instances[0], text);
  await until(async () => (await service.call("live.poll", { id })).segments.filter((s) => s.zhState === "done").length === 3);
  const { segments } = await service.call("live.poll", { id });

  await assert.rejects(service.call("live.generate", { id, segmentIds: [segments[2].id] }), /选中的内容太少/);
  await assert.rejects(service.call("live.generate", { id, segmentIds: [] }), /请先选中/);
  await assert.rejects(service.call("live.generate", { id, segmentIds: [segments[0].id, 999] }), /已经不存在/);
  await assert.rejects(service.call("live.generate", { id, segmentIds: [segments[0].id, segments[1].id], kind: "essay" }), /不支持的题型/);
  await assert.rejects(service.call("live.generate", { id, segmentIds: [segments[0].id, segments[1].id], language: "Klingon" }), /不支持的题目语言/);

  // The questions follow the 出题语言 setting (#1002), as every other run does, not the interface language (Chinese here).
  await service.call("settings", { generation: { language: "English" } });
  const result = await service.call("live.generate", { id, segmentIds: [segments[1].id, segments[0].id], count: 4, kind: "quiz", includeChinese: true });
  assert.equal(result.segments, 2);
  const job = await service.call("job.wait", { jobId: result.jobId, timeoutSeconds: 20 });
  assert.equal(job.count, 4);
  assert.equal(job.asked.language, "English");
  const source = await service.call("source.get", { id: result.sourceId });
  assert.deepEqual(source.courses, ['Databases']);
  assert.equal(job.course, 'Databases');
  assert.match(source.title, /Databases week 5 · 片段 /);
  assert.match(source.text, /\[00:00\] A transaction is a logical unit of work[\s\S]*译：A transaction is a logical unit[\s\S]*\[00:00\] Isolation levels/);
  assert.ok(prompts.some((p) => p.includes("Isolation levels decide")), "the model is given the selected text");
  assert.ok(!prompts.some((p) => p.includes("Yes.")), "sentences that were not selected are not sent");
  assert.deepEqual((await service.call("live.poll", { id })).generatedIds.sort(), [segments[0].id, segments[1].id].sort());
  assert.equal((await service.call("live.poll", { id })).status, "live", "generating does not interrupt the class");
  await service.call("live.stop", { id });
});

test("a finished class is saved as a bilingual source, and an unfinished one refuses", async (t) => {
  const { service, Socket } = await serviceFixture(t);
  await service.call('source.add', { title: 'Courses', text: 'Available courses', courses: ['Databases', 'Systems'] });
  await service.call('focus.set', { course: 'Databases' });
  const { id } = await service.call("live.start", { title: "Databases week 5" });
  await service.call('focus.set', { course: 'Systems' });
  say(Socket.instances[0], "Partitioning splits one big table into smaller physical pieces by a chosen key.");
  await until(async () => (await service.call("live.poll", { id })).segments[0]?.zhState === "done");
  await assert.rejects(service.call("live.save", { id }), /请先结束/);
  await assert.rejects(service.call('live.archive', { id, archived: true }), /请先结束/);
  await service.call("live.stop", { id });
  await until(async () => (await service.call("live.poll", { id })).translating === 0);
  await service.runtime.liveSessions.registered(service.store.root, id).settled();
  const saved = await service.call("live.save", { id });
  assert.equal(saved.sourceIds.length, 2);
  const note = await service.call('source.get', { id: saved.noteSourceId });
  assert.deepEqual(note.courses, ['Databases']);
  assert.match(note.text, /累计摘要[\s\S]*数据库分区与索引/);
  assert.match(note.text, /分批笔记[\s\S]*句 1 · 00:00/);
  const source = await service.call("source.get", { id: saved.sourceIds[0] });
  assert.deepEqual(source.courses, ['Databases']);
  assert.equal((await readSaved(service.store.root, id)).course, 'Databases');
  assert.match(source.text, /【英文原句】\nPartitioning splits one big table/);
  assert.match(source.text, /【中文对照】\n译：Partitioning splits/);
  assert.equal((await service.call("live.save", { id })).sourceIds[0], saved.sourceIds[0], "saving twice reuses the source");
  assert.equal((await service.call("snapshot", {})).sources.filter((s) => s.audio?.live).length, 1);
  await service.call('live.archive', { id, archived: true });
  assert.ok((await readSaved(service.store.root, id)).archivedAt);
  assert.ok((await service.call('live.list')).sessions.find(item => item.id === id).archivedAt);
  await assert.rejects(service.call('live.start', { resumeId: id }), /归档中恢复/);
  const old = service.runtime.liveSessions.registered(service.store.root, id);
  await old.retirePersistence(); service.runtime.liveSessions.unregister(service.store.root, id);
  assert.ok((await service.call('live.get', { id })).archivedAt, 'archive persists across process reload');
  await service.call('live.archive', { id, archived: false });
  assert.equal((await readSaved(service.store.root, id)).archivedAt, null);
  await service.call('live.archive', { id, archived: true });
  await service.call("live.delete", { id });
  assert.ok((await service.call('source.get', { id: saved.sourceIds[0] })).text, 'exported transcript survives deleting recording');
  assert.ok((await service.call('source.get', { id: saved.noteSourceId })).text, 'exported notes survive deleting recording');
  await assert.rejects(service.call("live.get", { id }), /没有找到这场实录/);
});

test("a translator whose model answers in prose turns to the other model, and keeps using it", async () => {
  const prose = "好的，我来帮你翻译这段课堂内容。";
  let primary = 0, fallback = 0;
  const translate = makeTranslator({ subject: "DB", vocabulary: [], complete: async () => { primary++; return prose; },
    fallback: async (_system, prompt) => { fallback++; return JSON.stringify({ items: JSON.parse(prompt).items.map((item) => ({ n: item.n, zh: `译：${item.en}` })) }); } });
  assert.equal((await translate({ items: [{ n: 1, en: "Hello there." }], context: [] })).get(1), "译：Hello there.");
  assert.equal((await translate({ items: [{ n: 2, en: "Again." }], context: [] })).get(2), "译：Again.");
  assert.deepEqual([primary, fallback], [2, 2]);
});

test("sentences whose translation failed are tried again on their own, a bounded number of rounds", async () => {
  const Socket = socketClass(healthy);
  let calls = 0, failing = Infinity;
  const translate = async (request) => { calls++; if (calls <= failing) throw new Error("model hiccup"); return echoTranslate(request); };
  const live = session(Socket, { translate, timing: { ...timing, translateAutoRetryMs: 20 } });
  await live.start();
  failing = 3;
  Socket.instances[0].say({ serverContent: { inputTranscription: { text: "This sentence fails three times, then works." } } });
  await until(() => live.snapshot().segments[0]?.zhState === "done");
  assert.equal(calls, 4, "no click needed: one automatic round brought it back");
  failing = Infinity;
  Socket.instances[0].say({ serverContent: { inputTranscription: { text: "This sentence never gets a translation at all." } } });
  await until(() => live.snapshot().segments[1]?.zhState === "error");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(live.snapshot().segments[1].zhState, "error", "after the automatic rounds it waits for the learner");
  assert.equal(calls, 4 + 3 * 3, "three tries, then two automatic rounds of three tries");
  failing = 0;
  live.retryFailed();
  await until(() => live.snapshot().segments[1].zhState === "done");
  await live.stop();
});
