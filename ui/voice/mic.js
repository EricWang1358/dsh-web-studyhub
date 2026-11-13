import { captureAudio } from '../live-audio.js';
import { uploadInChunks } from '../upload.js';
import { VOICE_MAX_SECONDS, wavBytes } from './wav.js';

/* The microphone of a voice answer (#1031), without React: capture (the live class's AudioWorklet, ui/live-audio.js, 16 kHz PCM16), one WAV clip,
   the shared chunked upload (cancelled on any failure), then audio.clip.transcribe, which deletes the clip on the server whatever happens. It stops
   itself at the time limit. `onState({ phase, left, error })`: phase idle | recording | sending, `left` the seconds still allowed, `error` a failure
   or one of its own messages (catalogue keys), which ui/voice/useVoiceInput.js turns into text (this file stays free of the interface, so it runs in
   plain Node). `scope()`: where the text belongs (the question on screen); a transcript that comes back under another scope is dropped with the
   code VOICE_MOVED, so a learner who moved on while it was being transcribed never has it put into, or graded on, the next question. */

/** Less than this much audio is nothing said (0.1 s). */
const MIN_BYTES = 3200;
/** The countdown's tick while recording: a chain of timeouts, stopped by the returned function. */
const repeat = (fn, ms) => {
  let id = setTimeout(function tick() { fn(); id = setTimeout(tick, ms); }, ms);
  return () => clearTimeout(id);
};

export function createVoiceRecorder({ call, language, capture = captureAudio, upload = uploadInChunks, maxSeconds = VOICE_MAX_SECONDS,
  now = () => Date.now(), every = repeat, onState, onLimit, scope = () => '' } = {}) {
  let phase = 'idle', handle = null, chunks = [], startedAt = 0, stopTimer = null, aborted = null, startedIn = '';
  const emit = (extra = {}) => onState?.({ phase, left: phase === 'recording' ? Math.max(0, Math.ceil(maxSeconds - (now() - startedAt) / 1000)) : maxSeconds, ...extra });
  const release = async () => {
    stopTimer?.(); stopTimer = null;
    const current = handle;
    handle = null;
    if (current) await Promise.resolve(current.stop()).catch(() => {});
  };
  const recorder = {
    get phase() { return phase; },
    async start() {
      if (phase !== 'idle') return false;
      chunks = []; startedAt = now(); phase = 'recording'; startedIn = scope();
      try {
        handle = await capture('microphone', (buffer) => { if (buffer?.byteLength) chunks.push(new Int16Array(buffer)); },
          () => { if (phase === 'recording') { void release(); phase = 'idle'; emit({ error: '麦克风断开了，请再录一次' }); } });
      } catch (error) { phase = 'idle'; await release(); emit({ error }); throw error; }
      emit({ error: '' });
      stopTimer = every(() => {
        if (phase !== 'recording') return;
        emit();
        if ((now() - startedAt) / 1000 >= maxSeconds) onLimit?.(recorder.finish());
      }, 250);
      return true;
    },
    /** Stop, send and transcribe: resolves the text. */
    async finish() {
      if (phase !== 'recording') return null;
      await release();
      const clip = chunks;
      chunks = [];
      if (clip.reduce((sum, chunk) => sum + chunk.byteLength, 0) < MIN_BYTES) {
        phase = 'idle';
        emit({ error: '没有录到声音，请靠近麦克风再说一次' });
        throw new Error('没有录到声音，请靠近麦克风再说一次');
      }
      phase = 'sending'; emit({ error: '' });
      aborted = new AbortController();
      try {
        const bytes = wavBytes(clip);
        const file = new Blob([bytes], { type: 'audio/wav' });
        Object.defineProperty(file, 'name', { value: 'voice-answer.wav' });
        const signal = aborted.signal;
        const uploadId = await upload(call, 'audio', file, { signal });
        // Cancelled while the last chunk was on its way: the clip is complete on the server, so it is deleted there now, not left for the daily prune.
        if (signal.aborted) { await Promise.resolve(call('audio.upload.cancel', { uploadId })).catch(() => {}); signal.throwIfAborted(); }
        const result = await call('audio.clip.transcribe', { uploadId, ...(language ? { language } : {}) });
        const text = String(result?.text ?? '').trim();
        if (scope() !== startedIn) throw Object.assign(new Error('换了题，刚才说的没有放进这道题'), { code: 'VOICE_MOVED' });
        if (!text) throw new Error('没有听清，请再说一次');
        phase = 'idle'; emit({ error: '' });
        return text;
      } catch (error) {
        phase = 'idle'; emit({ error });
        throw error;
      } finally { aborted = null; }
    },
    /** Drop the clip: nothing is sent, or the upload under way is cancelled. */
    async cancel() {
      chunks = [];
      aborted?.abort();
      await release();
      phase = 'idle'; emit({ error: '' });
    },
  };
  return recorder;
}
