import { captureAudio } from '../live-audio.js';
import { uploadInChunks } from '../upload.js';

const DEFAULT_RATE = 16000;

function writeAscii(view, offset, text) {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

/** Pack 16-bit mono PCM ArrayBuffer/TypedArray chunks into a standard WAV byte array. */
export function pcmChunksToWavBytes(chunks, sampleRate = DEFAULT_RATE) {
  const views = (chunks || []).map((chunk) => {
    if (chunk instanceof Uint8Array) return chunk;
    if (ArrayBuffer.isView(chunk)) return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
    return new Uint8Array(0);
  });
  const dataBytes = views.reduce((sum, item) => sum + item.byteLength, 0);
  const out = new Uint8Array(44 + dataBytes);
  const header = new DataView(out.buffer);
  writeAscii(header, 0, 'RIFF');
  header.setUint32(4, 36 + dataBytes, true);
  writeAscii(header, 8, 'WAVE');
  writeAscii(header, 12, 'fmt ');
  header.setUint32(16, 16, true); // PCM chunk size
  header.setUint16(20, 1, true); // PCM format
  header.setUint16(22, 1, true); // mono
  header.setUint32(24, sampleRate, true);
  header.setUint32(28, sampleRate * 2, true); // byte rate
  header.setUint16(32, 2, true); // block align
  header.setUint16(34, 16, true); // bits per sample
  writeAscii(header, 36, 'data');
  header.setUint32(40, dataBytes, true);
  let pos = 44;
  for (const part of views) {
    out.set(part, pos);
    pos += part.byteLength;
  }
  return out;
}

/** Build an uploadable WAV Blob from recorded PCM chunks. */
export function encodeWavPcm16(chunks, sampleRate = DEFAULT_RATE) {
  const bytes = pcmChunksToWavBytes(chunks, sampleRate);
  const blob = new Blob([bytes], { type: 'audio/wav' });
  blob.name = 'voice-clip.wav';
  return blob;
}

/** True when an error indicates the decoupled `audio` plugin or API key is unconfigured. */
export function isAudioSetupError(error) {
  const msg = String(error?.message || error || '');
  return /audio\.upload|clip\.transcribe|Unknown action|未启用.*音频|音频转写|语音识别|API Key|密钥|Audio.*plugin/i.test(msg);
}

/**
 * Stateful non-React microphone capture -> WAV pack -> `audio.upload.*` helper.
 * Callers wire `onState({ phase, seconds, error })` to React state.
 */
export function createVoiceRecorder({ call, capture = captureAudio, upload = uploadInChunks, sampleRate = DEFAULT_RATE, onState }) {
  let phase = 'idle'; // idle | recording | uploading
  let handle = null;
  let startedAt = 0;
  let chunks = [];
  let controller = null;

  const emit = (extra = {}) => onState?.({
    phase,
    startedAt,
    ...extra,
  });

  const cleanupCapture = async () => {
    const h = handle;
    handle = null;
    if (h?.stop) await Promise.resolve(h.stop()).catch(() => {});
  };

  return {
    getPhase: () => phase,

    async start() {
      if (phase !== 'idle') return false;
      chunks = [];
      startedAt = Date.now();
      phase = 'recording';
      emit({ error: '' });
      try {
        handle = await capture('microphone', (buf) => {
          if (buf && buf.byteLength > 0) chunks.push(buf);
        }, () => {
          if (phase === 'recording') {
            void cleanupCapture();
            phase = 'idle';
            emit({ error: '麦克风连接已中断，请重试' });
          }
        });
        return true;
      } catch (error) {
        await cleanupCapture();
        phase = 'idle';
        emit({ error: String(error?.message || error) });
        throw error;
      }
    },

    async stopAndUpload() {
      if (phase !== 'recording') return null;
      await cleanupCapture();
      const captured = chunks;
      chunks = [];
      const totalBytes = captured.reduce((sum, item) => sum + (item?.byteLength || 0), 0);
      if (totalBytes < 320) {
        phase = 'idle';
        const err = new Error('未录到声音，请靠近麦克风后再试一次');
        emit({ error: err.message });
        throw err;
      }
      phase = 'uploading';
      emit({ error: '' });
      controller = new AbortController();
      try {
        const wav = encodeWavPcm16(captured, sampleRate);
        const uploadId = await upload(call, 'audio', wav, { signal: controller.signal });
        phase = 'idle';
        emit({ error: '' });
        return uploadId;
      } catch (error) {
        phase = 'idle';
        emit({ error: String(error?.message || error) });
        throw error;
      } finally {
        controller = null;
      }
    },

    async cancel() {
      chunks = [];
      controller?.abort();
      await cleanupCapture();
      phase = 'idle';
      emit({ error: '' });
    },
  };
}
