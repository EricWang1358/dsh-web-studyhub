import { captureAudio } from './live-audio.js';
import { LiveAudioHealth } from './live-audio-health.js';

export function mergeLiveSnapshot(previous, patch) {
  if (!previous || previous.id !== patch.id) return patch;
  if (!patch.segments?.length) return { ...previous, ...patch, segments: previous.segments };
  const segments = new Map(previous.segments.map((segment) => [segment.id, segment]));
  for (const segment of patch.segments || []) segments.set(segment.id, segment);
  return { ...previous, ...patch, segments: [...segments.values()].sort((a, b) => a.id - b.id) };
}

/** Kept alive above page navigation so creating questions never stops the class. */
export class LiveClient {
  constructor(call, { capture = captureAudio } = {}) {
    this.call = call;
    this.capture = capture;
    this.listeners = new Set();
    this.state = { session: null, capturing: false, busy: false, error: '' };
    this.queue = Promise.resolve();
    this.queuedBytes = 0;
    this.epoch = 0;
    this.health = new LiveAudioHealth();
    this.captureId = 0;
    this.subscribe = (listener) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
    this.getSnapshot = () => this.state;
  }
  update(patch) { this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener(); }
  accept(patch) {
    const session = mergeLiveSnapshot(this.state.session, patch);
    const previous = this.state.session;
    if (previous && Object.keys(session).every((key) => session[key] === previous[key] ||
      (key !== 'segments' && JSON.stringify(session[key]) === JSON.stringify(previous[key])))) return;
    this.update({ session });
  }
  async start(kind, args) {
    if (this.state.busy || this.state.capturing) return;
    const epoch = ++this.epoch;
    const captureId = ++this.captureId;
    this.health.reset(kind, 'requesting');
    this.update({ busy: true, error: '' });
    let capture, session;
    try {
      capture = await this.capture(kind, (bytes) => { if (captureId === this.captureId) this.enqueue(bytes); },
        () => { if (captureId === this.captureId) void this.stop().catch((error) => this.fail(error)); },
        (state) => { if (captureId === this.captureId) this.health.update(state); });
      if (epoch !== this.epoch) { await capture.stop(); return; }
      this.audio = capture;
      this.health.phase('running');
      session = await this.call('live.start', args);
      if (epoch !== this.epoch) { await capture.stop(); await this.call('live.stop', { id: session.id }); return; }
      this.queue = Promise.resolve();
      this.queuedBytes = 0;
      this.update({ session, capturing: true });
    } catch (error) {
      await capture?.stop();
      this.audio = null;
      this.health.phase('stopped');
      this.update({ error: String(error.message || error) });
      throw error;
    } finally { this.update({ busy: false }); }
  }
  enqueue(bytes) {
    this.health.frame(bytes);
    const id = this.state.session?.id;
    if (!id || !this.state.capturing) return;
    if (this.queuedBytes + bytes.byteLength > 960000) {
      this.fail(new Error('音频上传跟不上，已停止实录。已收到的内容仍然保留，请检查连接后继续'));
      void this.stop().catch((error) => this.fail(error));
      return;
    }
    this.queuedBytes += bytes.byteLength;
    this.health.update({ queuedBytes: this.queuedBytes });
    // One request in flight; no blind retries that could duplicate speech.
    this.queue = this.queue.then(async () => {
      const data = btoa(String.fromCharCode(...new Uint8Array(bytes)));
      const result = await this.call('live.audio', { id, data });
      if (!['paused', 'ended', 'error'].includes(result?.status)) this.health.acknowledge(bytes.byteLength);
    }).catch((error) => {
      this.fail(error);
      // Stop after the queue drains; never wait on that queue from within itself.
      void this.stop().catch((failure) => this.fail(failure));
    }).finally(() => { this.queuedBytes -= bytes.byteLength; this.health.update({ queuedBytes: this.queuedBytes }); });
  }
  fail(error) { this.update({ error: String(error.message || error) }); }
  async poll() {
    const session = this.state.session;
    const epoch = this.epoch;
    if (!session || this.polling || this.state.busy) return;
    this.polling = true;
    try {
      const patch = await this.call('live.poll', { id: session.id, since: session.revision });
      if (this.epoch === epoch && this.state.session?.id === session.id) {
        this.accept(patch);
        if (['ended', 'error'].includes(patch.status) && this.state.capturing) {
          this.update({ capturing: false });
          await this.audio?.stop(); this.audio = null;
          this.health.phase('stopped');
        }
      }
    } finally { this.polling = false; }
  }
  async open(id) {
    if (this.state.capturing || this.state.busy) throw new Error('请先结束当前实录');
    ++this.epoch;
    this.health.reset();
    const session = await this.call('live.get', { id });
    this.update({ session, error: '' });
  }
  close(id) {
    if (this.state.session?.id !== id || this.state.capturing) return;
    ++this.epoch;
    this.health.reset();
    this.update({ session: null });
  }
  async pause() {
    if (this.state.busy) return;
    const epoch = ++this.epoch;
    this.update({ busy: true });
    const paused = this.state.session?.status !== 'paused';
    this.audio?.pause(true);
    this.health.phase('paused');
    await this.queue;
    try {
      const result = await this.call(paused ? 'live.pause' : 'live.resume', { id: this.state.session.id });
      if (this.epoch !== epoch) return;
      this.update({ session: { ...this.state.session, status: result.status } });
      this.audio?.pause(paused);
      this.health.phase(paused ? 'paused' : 'running');
    } catch (error) { this.fail(error); throw error; }
    finally { if (this.epoch === epoch) this.update({ busy: false }); }
    await this.poll();
  }
  async stop() {
    if (this.stopping) return this.stopping;
    ++this.epoch;
    if (!this.state.session) { await this.audio?.stop(); this.audio = null; this.health.phase('stopped'); return; }
    this.stopping = (async () => {
      this.update({ busy: true });
      try {
        await this.audio?.stop(); this.audio = null;
        this.health.phase('stopped');
        this.update({ capturing: false });
        await this.queue;
        this.accept(await this.call('live.stop', { id: this.state.session.id }));
      } finally { this.update({ busy: false }); this.stopping = null; }
    })();
    return this.stopping;
  }
  dispose() {
    ++this.epoch;
    if (this.state.capturing) void this.stop().catch(() => {});
    else void this.audio?.stop();
  }
}
