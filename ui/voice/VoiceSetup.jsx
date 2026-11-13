import React from 'react';
import { useStudy } from '../study-context.jsx';
import { AudioSetupGate } from '../AudioSettings.jsx';
import { openAudioSettings } from '../audio-focus.js';

/* The audio setup guide of a voice button (#1031), in a chunk of its own: ui/voice/VoiceButton.jsx loads it only when transcription is not set up,
   so the audio settings stay out of the practice page's first load (tests/workspace-closure-pages.test.mjs). */
export default function VoiceSetup({ reason, onSaved }) {
  const { openSettings } = useStudy();
  return <AudioSetupGate reason={reason} onOpenSettings={openAudioSettings(openSettings)} onSaved={onSaved} />;
}
