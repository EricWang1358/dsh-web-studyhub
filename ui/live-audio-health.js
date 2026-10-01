/** Local diagnostics only. Measures the exact mono PCM sent to transcription. */
export class LiveAudioHealth {
  constructor(now = Date.now) {
    this.now = now;
    this.listeners = new Set();
    this.subscribe = listener => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
    this.getSnapshot = () => this.state;
    this.reset();
  }
  update(patch) { this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener(); }
  reset(kind = 'microphone', phase = 'idle') {
    this.update({ kind, phase, startedAt: this.now(), label: '', context: '', muted: false,
      lastFrameAt: null, lastSoundAt: null, lastAckAt: null, capturedMs: 0, acceptedMs: 0,
      queuedBytes: 0, level: 0, peak: 0 });
  }
  phase(phase) { this.update({ phase, level: 0, peak: 0, ...(phase === 'running' ? { startedAt: this.now(), lastFrameAt: null, lastSoundAt: null } : {}) }); }
  frame(bytes) {
    if (this.state.phase !== 'running') return;
    const view = new DataView(bytes);
    const samples = Math.floor(view.byteLength / 2);
    if (!samples) return;
    let sum = 0, peak = 0;
    for (let offset = 0; offset < samples * 2; offset += 2) {
      const sample = view.getInt16(offset, true) / 32768;
      sum += sample * sample;
      peak = Math.max(peak, Math.abs(sample));
    }
    const rms = Math.sqrt(sum / samples), now = this.now();
    // A relative digital level, not calibrated room loudness or speech detection.
    const level = Math.round(Math.max(0, Math.min(100, (20 * Math.log10(Math.max(rms, 1e-6)) + 60) / 60 * 100)));
    this.update({ level, peak, lastFrameAt: now, capturedMs: this.state.capturedMs + samples / 16,
      ...(rms >= 0.0032 ? { lastSoundAt: now } : {}) });
  }
  acknowledge(bytes) { this.update({ lastAckAt: this.now(), acceptedMs: this.state.acceptedMs + bytes / 32 }); }
}

export function audioInputStatus(state, now) {
  if (state.phase !== 'running') return state.phase;
  if (state.context && state.context !== 'running') return 'suspended';
  if (state.muted) return 'muted';
  if (state.lastFrameAt === null) return now - state.startedAt > 2000 ? 'missing' : 'waiting';
  if (now - state.lastFrameAt > 1500) return 'missing';
  if (now - (state.lastSoundAt ?? state.startedAt) > 3000) return 'quiet';
  if (state.peak >= 0.98) return 'clipping';
  return state.level > 0 ? 'sound' : 'quiet';
}
