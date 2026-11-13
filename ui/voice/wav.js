/* A voice answer as a file (#1031): 16 kHz mono 16-bit PCM in a plain WAV, the shape every transcription tier reads (the cloud tiers as a file, the
   local live engine as raw frames after the header). Pure, no browser API, so the recorder (ui/voice/mic.js) and the tests share it. */

export const VOICE_RATE = 16000;
/** The longest voice answer: the recorder stops itself here, and the server refuses a longer clip. */
export const VOICE_MAX_SECONDS = 90;

/** The WAV bytes of Int16 mono chunks at `rate`. */
export function wavBytes(chunks, rate = VOICE_RATE) {
  const samples = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const bytes = new Uint8Array(44 + samples * 2), view = new DataView(bytes.buffer);
  const text = (offset, value) => { for (let i = 0; i < value.length; i++) bytes[offset + i] = value.charCodeAt(i); };
  text(0, 'RIFF'); view.setUint32(4, 36 + samples * 2, true); text(8, 'WAVE');
  text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, samples * 2, true);
  let offset = 44;
  for (const chunk of chunks) for (let i = 0; i < chunk.length; i++, offset += 2) view.setInt16(offset, chunk[i], true);
  return bytes;
}
