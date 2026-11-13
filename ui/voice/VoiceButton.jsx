import { ui, uiFormat } from '../i18n.js';
import React from 'react';
import { Button, InlineMessage, Tooltip } from '../components/index.js';
import { useInjectCss } from '../shared.js';
import { formatElapsed } from '../format.js';
import css from './voice.css';

// Loaded the first time a learner without transcription presses the button (ui/voice/VoiceSetup.jsx).
const VoiceSetup = React.lazy(() => import('./VoiceSetup.jsx'));

/* The one voice button (#1031), wherever an answer can be spoken: practice (V), the 帮我弄懂 box (Shift+V) and the oral mock interview. It shows the
   seconds left while recording, a cancel, what went wrong, and the audio setup guide when transcription is not set up yet. `voice` is useVoiceInput. */
export default function VoiceButton({ voice, label = '语音作答', shortcut, className = '' }) {
  useInjectCss(css, 'study-voice');
  if (voice.unavailable) return null;
  const recording = voice.phase === 'recording', sending = voice.phase === 'sending';
  const button = (
    <Button size="sm" variant={recording ? 'primary' : 'secondary'} icon="audio" className="voice-button"
      aria-keyshortcuts={shortcut || undefined} aria-pressed={recording} busy={sending} busyLabel={ui('正在转写…')} onClick={voice.toggle}>
      {recording ? uiFormat('说完了 · 剩 {0}', [formatElapsed(voice.left * 1000)]) : ui(label)}
    </Button>
  );
  return (
    <div className={`voice-input ${className}`.trim()} data-phase={voice.phase}>
      <div className="voice-input__row">
        {shortcut && !recording ? <Tooltip layer content={uiFormat('快捷键 {0}：开始说，再按一次发送', [shortcut])}>{button}</Tooltip> : button}
        {recording && <Button size="sm" variant="quiet" onClick={voice.cancel}>{ui('取消')}</Button>}
        {recording && <span className="voice-input__live" role="status">{ui('正在听…说完按「说完了」，录音转成文字后立刻删除')}</span>}
      </div>
      {voice.error && <InlineMessage onDismiss={voice.clearError}>{voice.error}</InlineMessage>}
      {voice.setup && <div className="voice-input__setup">
        <React.Suspense fallback={null}><VoiceSetup reason={voice.setup.reason} onSaved={voice.recheck} /></React.Suspense>
        <Button size="sm" variant="quiet" onClick={voice.closeSetup}>{ui('先不用语音')}</Button>
      </div>}
    </div>
  );
}
