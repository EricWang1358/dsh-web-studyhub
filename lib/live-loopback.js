import { spawn } from 'node:child_process';
import { LIVE_LOOPBACK_MESSAGES as TEXT } from './live-loopback-install-text.js';

/* Runtime controller for 课堂实录's system-audio loopback helper (studyhub-loopback.exe):
   - Zero background process when idle or paused: pause() closes stdin and waits for process exit so no WASAPI handle stays open while paused;
   - resume() re-verifies the helper binary and spawns a fresh read-only capture process;
   - Tracks PCM health metrics (device name, relative dB level, peak, capturedMs, acceptedMs) for LiveAudioMonitor. */

let activeSubprocesses = 0;
let activeCaptures = 0;
export const loopbackProcessRunning = () => activeSubprocesses > 0;
export const loopbackInUse = () => activeSubprocesses > 0 || activeCaptures > 0;

function terminateHelper(child) {
  if (!child?.pid) return;
  try { child.stdin?.end(); } catch { /* already closed */ }
  const hardKill = () => {
    if (child.exitCode !== null || child.killed) return;
    try {
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => { try { child.kill(); } catch {} });
      else child.kill('SIGKILL');
    } catch { try { child.kill(); } catch {} }
  };
  const timer = setTimeout(hardKill, 450);
  timer.unref?.();
}

export class InputAudioTracker {
  constructor(now = Date.now) {
    this.now = now;
    this.reset('idle');
  }
  reset(phase = 'idle') {
    const at = this.now();
    this.state = {
      source: 'system', phase, startedAt: at, label: '', muted: false,
      lastFrameAt: null, lastSoundAt: null, lastAckAt: null,
      capturedMs: 0, acceptedMs: 0, level: 0, peak: 0, error: '',
    };
  }
  setPhase(phase) {
    const at = this.now();
    this.state = {
      ...this.state, phase, level: 0, peak: 0,
      ...(phase === 'running' ? { startedAt: at, lastFrameAt: null, lastSoundAt: null, error: '' } : {}),
    };
  }
  update(patch) { this.state = { ...this.state, ...patch }; }
  frame(bytes, accepted = true) {
    if (this.state.phase !== 'running') return;
    const samples = Math.floor(bytes.length / 2);
    if (!samples) return;
    let sum = 0, peak = 0;
    for (let offset = 0; offset < samples * 2; offset += 2) {
      const sample = bytes.readInt16LE(offset) / 32768;
      sum += sample * sample;
      peak = Math.max(peak, Math.abs(sample));
    }
    const rms = Math.sqrt(sum / samples), at = this.now();
    const level = Math.round(Math.max(0, Math.min(100, (20 * Math.log10(Math.max(rms, 1e-6)) + 60) / 60 * 100)));
    this.state = {
      ...this.state,
      level,
      peak,
      lastFrameAt: at,
      capturedMs: this.state.capturedMs + samples / 16,
      ...(rms >= 0.0032 ? { lastSoundAt: at } : {}),
      ...(accepted ? { lastAckAt: at, acceptedMs: this.state.acceptedMs + bytes.length / 32 } : {}),
    };
  }
  snapshot(at = this.now()) {
    const s = this.state;
    return {
      source: 'system',
      phase: s.phase,
      label: s.label,
      muted: s.muted,
      level: s.level,
      peak: s.peak,
      capturedMs: Math.round(s.capturedMs),
      acceptedMs: Math.round(s.acceptedMs),
      frameAgeMs: s.lastFrameAt === null ? null : Math.max(0, at - s.lastFrameAt),
      soundAgeMs: s.lastSoundAt === null ? null : Math.max(0, at - s.lastSoundAt),
      ackAgeMs: s.lastAckAt === null ? null : Math.max(0, at - s.lastAckAt),
      ...(s.error ? { error: s.error } : {}),
    };
  }
}

export function createSystemAudioCapture({ resolveHelper, onPcm, onUnexpectedError, spawnImpl = spawn, now = Date.now, startupTimeoutMs = 5000 }) {
  const tracker = new InputAudioTracker(now);
  let current = null, transition = Promise.resolve(), stopped = false;

  const stopCurrent = async () => {
    const active = current;
    current = null;
    if (!active) return;
    active.closing = true;
    terminateHelper(active.child);
    await active.closed;
  };

  const spawnOnce = async () => {
    const helper = await resolveHelper();
    if (!helper?.exePath) throw new Error(TEXT.needsInstall);
    let child;
    try {
      child = spawnImpl(helper.exePath, ['--capture'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch {
      throw new Error(TEXT.startFailed);
    }
    activeSubprocesses += 1;
    let counted = true;
    const releaseCount = () => { if (counted) { counted = false; activeSubprocesses = Math.max(0, activeSubprocesses - 1); } };
    let markClosed;
    const closed = new Promise(resolve => { markClosed = resolve; });
    const handle = { child, closing: false, closed };
    current = handle;

    let carry = Buffer.alloc(0), stderrRest = '';
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, val) => { if (settled) return; settled = true; clearTimeout(timer); fn(val); };
      const timer = setTimeout(() => {
        handle.closing = true;
        terminateHelper(child);
        finish(reject, new Error(TEXT.startFailed));
      }, startupTimeoutMs);
      timer.unref?.();

      const onLine = line => {
        if (!line.startsWith('STATE:')) return;
        let state;
        try { state = JSON.parse(line.slice(6)); } catch { return; }
        if (state.error === 'no-device') {
          handle.closing = true;
          terminateHelper(child);
          finish(reject, new Error(TEXT.noDevice));
          return;
        }
        if (state.error) {
          handle.closing = true;
          terminateHelper(child);
          finish(reject, new Error(TEXT.startFailed));
          return;
        }
        if (typeof state.label === 'string') tracker.update({ label: state.label });
        if (typeof state.muted === 'boolean') tracker.update({ muted: state.muted });
        if (state.ready || state.noDevice) finish(resolve, undefined);
      };

      child.stderr.on('data', chunk => {
        stderrRest += chunk.toString('utf8');
        const parts = stderrRest.split(/\r?\n/);
        stderrRest = parts.pop() || '';
        for (const line of parts) if (line.trim()) onLine(line.trim());
      });

      child.stdout.on('data', chunk => {
        if (handle.closing || stopped || tracker.state.phase !== 'running') return;
        const combined = carry.length ? Buffer.concat([carry, chunk]) : chunk;
        const even = combined.length - (combined.length % 2);
        carry = even < combined.length ? combined.subarray(even) : Buffer.alloc(0);
        if (!even) return;
        const pcm = combined.subarray(0, even);
        const accepted = onPcm?.(pcm) !== false;
        tracker.frame(pcm, accepted);
      });

      child.on('error', () => {
        releaseCount();
        markClosed();
        if (!settled) finish(reject, new Error(TEXT.startFailed));
      });

      child.on('close', code => {
        if (stderrRest.trim()) onLine(stderrRest.trim());
        stderrRest = '';
        releaseCount();
        markClosed();
        if (!settled) {
          finish(reject, new Error(TEXT.startFailed));
          return;
        }
        if (!handle.closing && !stopped && current === handle) {
          current = null;
          const message = `电脑声音采音组件意外退出（代码 ${code ?? 'unknown'}）`;
          tracker.update({ error: message });
          onUnexpectedError?.(message);
        }
      });
    });
  };

  const serialize = work => {
    const next = transition.then(work, work);
    transition = next.catch(() => {});
    return next;
  };

  let captureCounted = false;
  const holdCapture = () => { if (!captureCounted) { captureCounted = true; activeCaptures += 1; } };
  const releaseCapture = () => { if (captureCounted) { captureCounted = false; activeCaptures = Math.max(0, activeCaptures - 1); } };

  return {
    start() {
      return serialize(async () => {
        if (stopped) return;
        holdCapture();
        tracker.reset('running');
        try { await spawnOnce(); }
        catch (error) { await stopCurrent(); releaseCapture(); tracker.setPhase('stopped'); throw error; }
      });
    },
    pause() {
      return serialize(async () => {
        if (stopped || tracker.state.phase === 'paused') return;
        tracker.setPhase('paused');
        await stopCurrent();
      });
    },
    resume() {
      return serialize(async () => {
        if (stopped || tracker.state.phase === 'running') return;
        holdCapture();
        tracker.setPhase('running');
        try { await spawnOnce(); }
        catch (error) { await stopCurrent(); tracker.setPhase('paused'); throw error; }
      });
    },
    stop() {
      return serialize(async () => {
        if (stopped) return;
        stopped = true;
        tracker.setPhase('stopped');
        try { await stopCurrent(); } finally { releaseCapture(); }
      });
    },
    snapshot: (at = now()) => tracker.snapshot(at),
  };
}
