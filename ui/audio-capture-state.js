/* Tracks active microphone / live-class capture sessions across ui/live-audio.js and ui/voice/mic.js so UI sound effects stay muted while recording. */
let activeAudioCaptures = 0;

/** Hold an active capture guard until the returned idempotent release fn runs. */
export function holdAudioCapture() {
  let held = true;
  activeAudioCaptures += 1;
  return () => {
    if (!held) return;
    held = false;
    activeAudioCaptures = Math.max(0, activeAudioCaptures - 1);
  };
}

export const isAudioCaptureActive = () => activeAudioCaptures > 0;
