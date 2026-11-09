// Ported from BAXUIE's StudyHub for ZCode 0.4.8 (MIT).
import { Worker } from 'node:worker_threads';

/* The local live engine: 课堂实录 without Google and without a key. SenseVoice (FunAudioLLM, through sherpa-onnx) with a silero VAD runs in a
   worker thread of this process (lib/live-local-worker.mjs). LoopbackWebSocket speaks the wire format of lib/live-protocol.js (setup, realtimeInput
   audio frames, inputTranscription finals, interimInputTranscription partials, audioStreamEnd), so LiveSession, the panel and every saved class
   stay as they are: only the socket is not a socket. The engine and its model are installed on demand (lib/live-local-install.js); this file never
   downloads anything. Which engine a class uses is decided by resolveLiveProvider, and never silently: no cloud service stands in for a local
   engine that is missing, and no local engine for a key that is missing when the learner chose Gemini. */

export const LIVE_PROVIDERS = Object.freeze(['auto', 'local', 'gemini']);

/**
 * The engine a live class runs on: { provider: 'local' | 'gemini' } or { provider: null, reason }. `asked` is the choice of this start (the provider
 * choice in 课堂实录), else the saved setting `liveProvider`. 'auto' keeps today's behaviour for a learner with a Gemini key and uses the local engine
 * only when there is no key and it is installed; an explicit choice is never replaced by the other engine. reason: 'local-not-ready',
 * 'no-gemini-key' or 'no-provider'.
 */
export function resolveLiveProvider(settings = {}, { localReady = false, asked } = {}) {
  const choice = LIVE_PROVIDERS.includes(asked) ? asked : LIVE_PROVIDERS.includes(settings.liveProvider) ? settings.liveProvider : 'auto';
  const gemini = !!(settings.freeKey || settings.paidKey);
  if (choice === 'local') return localReady ? { provider: 'local', choice } : { provider: null, choice, reason: 'local-not-ready' };
  if (choice === 'gemini') return gemini ? { provider: 'gemini', choice } : { provider: null, choice, reason: 'no-gemini-key' };
  if (gemini) return { provider: 'gemini', choice };
  if (localReady) return { provider: 'local', choice };
  return { provider: null, choice, reason: 'no-provider' };
}

/* A tier that needs no key and never blocks: what LiveSession's Gemini tiers provide (a pick, usage counters, warnings), all local. The engine
   writes Chinese as Chinese, so a sentence that is already Chinese is not sent to the translator (nativeChinese). */
export class LocalTiers {
  constructor() {
    this.keys = { local: 'local' };
    this.usage = { local: { audioSeconds: 0 } };
    this.warnings = [];
    this.configured = true;
    this.nativeChinese = true;
    this.connectTimeoutMs = LOCAL_TIMING.connectTimeoutMs;
  }
  pick() { return 'local'; }
  reject() {}
  block() {}
}

/** How long the recognizer thread may take to load its model before the class reports it (a slow laptop reads 230 MB from disk first). */
export const LOCAL_TIMING = Object.freeze({ connectTimeoutMs: 90_000, closeGraceMs: 2500, drainIdleMs: 30_000 });

class LoopMessageEvent extends Event { constructor(data) { super('message'); this.data = data; } }
class LoopCloseEvent extends Event { constructor(code, reason) { super('close'); this.code = code; this.reason = reason; } }

/* Every loopback socket of this process whose recognizer thread is alive, whichever library or service opened it: the engine is one per DSH home, so
   removing it is refused while any of them runs (lib/live-local-install.js beforeUninstall). */
const openSockets = new Set();
/** Is the local engine in use anywhere in this process (a class on it is connected, live or paused)? */
export const localEngineInUse = () => openSockets.size > 0;

const WORKER_URL = new URL('./live-local-worker.mjs', import.meta.url);
const startWorker = workerData => {
  const worker = new Worker(WORKER_URL, { workerData, stdout: true, stderr: true });
  // The native engine may print to its own stdout: read and drop it, so nothing piles up in memory.
  worker.stdout?.resume(); worker.stderr?.resume();
  return worker;
};

export class LoopbackWebSocket extends EventTarget {
  /**
   * @param url      what LiveSession passes (a Gemini URL with a placeholder key); not used
   * @param options  { modelDir, enginePath, timing: { interimEveryMs, minSilenceSec }, createWorker(workerData) (a seam) }
   */
  constructor(url, { modelDir, enginePath, modelId, timing = {}, createWorker = startWorker } = {}) {
    super();
    this.url = url;
    this.readyState = 0; // CONNECTING until the recognizer thread is warm
    this.binaryType = 'arraybuffer';
    this.closing = false;
    this.closedSent = false;
    this.endSent = false;
    this.acceptedSamples = 0;
    this.processedSamples = 0;
    this.drainIdleMs = timing.drainIdleMs || LOCAL_TIMING.drainIdleMs;
    this.finished = new Promise(resolve => { this.resolveFinished = resolve; });
    try { this.worker = createWorker({ modelDir, enginePath, modelId, timing }); }
    catch (error) { this.worker = null; queueMicrotask(() => this.fail(`本地识别引擎没能启动：${error?.message || error}`)); return; }
    openSockets.add(this);
    this.worker.on('message', message => this.onWorkerMessage(message));
    this.worker.on('error', error => this.fail(`本地识别引擎出错：${error?.message || error}`));
    // An exit we did not close through is a dead recognizer: fail (LiveSession reconnects), even a clean-looking code 0, since audio sent
    // into a gone thread would vanish silently.
    this.worker.on('exit', code => { if (!this.closedSent) this.fail(`本地识别引擎已退出（代码 ${code}）`); });
  }

  onWorkerMessage(message) {
    if (this.closedSent) return;
    if (message?.type === 'ready') {
      if (this.closing) return;
      this.readyState = 1;
      this.dispatchEvent(new Event('open'));
      // What the Gemini handshake answers; LiveSession resolves on this.
      this.dispatchEvent(new LoopMessageEvent(JSON.stringify({ setupComplete: true })));
    } else if (message?.type === 'interim') {
      this.dispatchEvent(new LoopMessageEvent(JSON.stringify({ serverContent: { interimInputTranscription: { text: message.text } } })));
    } else if (message?.type === 'final') {
      this.dispatchEvent(new LoopMessageEvent(JSON.stringify({ serverContent: { inputTranscription: { text: message.text } } })));
      this.dispatchEvent(new LoopMessageEvent(JSON.stringify({ serverContent: { turnComplete: true } })));
    } else if (message?.type === 'done') {
      this.settleClose();
    } else if (message?.type === 'progress') {
      if (message.samples > this.processedSamples) {
        this.processedSamples = Math.min(message.samples, this.acceptedSamples);
        if (this.endSent) this.watchDrain();
      }
    } else if (message?.type === 'error') {
      this.fail(message.message);
    }
  }

  send(data) {
    if (this.readyState !== 1 || this.endSent) return;
    let message;
    try { message = JSON.parse(String(data)); } catch { return; } // a socket swallows a frame it cannot read; the close path reacts to real trouble
    const audio = message?.realtimeInput?.audio?.data;
    if (typeof audio === 'string') {
      const bytes = new Uint8Array(Buffer.from(audio, 'base64')); // a copy of its own: the buffer moves to the recognizer thread
      this.acceptedSamples += bytes.length / 2;
      this.worker.postMessage({ type: 'audio', buffer: bytes.buffer }, [bytes.buffer]);
    } else if (message?.realtimeInput?.audioStreamEnd) {
      this.endInput();
    }
  }

  endInput() {
    if (this.endSent || this.closedSent) return;
    this.endSent = true;
    this.worker.postMessage({ type: 'end' });
    this.watchDrain();
  }

  watchDrain() {
    clearTimeout(this.drainTimer);
    this.drainTimer = setTimeout(() => {
      const pending = Math.max(0, (this.acceptedSamples - this.processedSamples) / 16000).toFixed(1);
      this.fail(`本地识别收尾超时，约 ${pending} 秒音频仍在排队，尾段也可能尚未定稿。已完成的文字已保留。`);
    }, this.drainIdleMs);
    this.drainTimer.unref?.();
  }

  async drain() {
    this.endInput();
    const { code, reason } = await this.finished;
    if (code !== 1000) throw new Error(reason);
  }

  close() {
    if (this.closing || this.closedSent) return;
    this.closing = true;
    this.readyState = 2;
    // The thread flushes what it heard and answers 'done'; a thread that does not answer is closed anyway.
    try { this.endInput(); } catch { /* already gone */ }
    setTimeout(() => this.settleClose(), LOCAL_TIMING.closeGraceMs).unref?.();
  }

  settleClose(code = 1000, reason = '') {
    if (this.closedSent) return;
    this.closedSent = true;
    clearTimeout(this.drainTimer);
    openSockets.delete(this);
    this.readyState = 3;
    void this.worker?.terminate().catch(() => {});
    this.resolveFinished({ code, reason });
    this.dispatchEvent(new LoopCloseEvent(code, reason));
  }

  fail(reason) {
    if (this.closedSent) return;
    this.dispatchEvent(new Event('error'));
    this.settleClose(1011, String(reason || '本地识别引擎中断').slice(0, 300));
  }
}

/** LiveSession builds its socket as `new WebSocketImpl(url)`; this binds the engine and the model without touching that call. */
export const loopbackFactory = options => class extends LoopbackWebSocket {
  constructor(url) { super(url, options); }
};
