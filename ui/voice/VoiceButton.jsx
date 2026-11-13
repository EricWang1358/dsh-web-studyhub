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
  // Esc puts the setup guide away, like its 先不用语音 button (the guide is long; on a phone that button is far down).
  const { setup, closeSetup } = voice;
  React.useEffect(() => {
    if (!setup) return undefined;
    const close = (event) => { if (event.key === 'Escape' && !event.defaultPrevented) closeSetup(); };
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [setup, closeSetup]);
  // Shift+V opens the 帮我弄懂 box and puts the cursor in it, so "press again to send" lands in a text box: while recording, that press ends the recording
  // instead of typing a capital V (the page's key handler leaves keys in a text box alone). Elsewhere the page's handler does it.
  const { phase, toggle } = voice;
  React.useEffect(() => {
    if (phase !== 'recording' || !/^Shift\+/.test(shortcut || '')) return undefined;
    const send = (event) => {
      if (!event.shiftKey || event.code !== 'KeyV' || event.repeat || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      if (!event.target.closest?.('input,textarea,[contenteditable]')) return;
      event.preventDefault();
      toggle();
    };
    document.addEventListener('keydown', send);
    return () => document.removeEventListener('keydown', send);
  }, [phase, toggle, shortcut]);
  // Pressing V can happen with the button below the fold: bring the recording (or the setup guide that took its place) into view, so a key press is never a silent one.
  const root = React.useRef(null), guide = React.useRef(null);
  React.useEffect(() => {
    const target = phase === 'recording' ? root.current : setup ? guide.current : null;
    if (!target?.scrollIntoView) return;
    const box = target.getBoundingClientRect();
    if (box.top < 0 || box.bottom > window.innerHeight - 90) target.scrollIntoView({ block: phase === 'recording' ? 'center' : 'nearest', behavior: 'smooth' });
  }, [phase === 'recording', !!setup]); // eslint-disable-line react-hooks/exhaustive-deps
  if (voice.unavailable) return null;
  const recording = voice.phase === 'recording', sending = voice.phase === 'sending';
  const button = (
    <Button size="sm" variant={recording ? 'primary' : 'secondary'} icon={recording ? 'stop' : 'microphone'} className="voice-button"
      aria-keyshortcuts={shortcut || undefined} aria-pressed={recording} busy={sending} busyLabel={ui('正在转写…')} onClick={voice.toggle}>
      {recording ? uiFormat('说完了 · 剩 {0}', [formatElapsed(voice.left * 1000)]) : ui(label)}
    </Button>
  );
  return (
    <div ref={root} className={`voice-input ${className}`.trim()} data-phase={voice.phase}>
      <div className="voice-input__row">
        {/* No card while the setup guide is open: an open card takes the first Esc (the shared Tooltip closes first), so the guide would need a second one. */}
        {shortcut && !recording ? <Tooltip layer content={setup ? '' : uiFormat('快捷键 {0}：开始说，再按一次发送', [shortcut])}>{button}</Tooltip> : button}
        {recording && <Button size="sm" variant="quiet" onClick={voice.cancel}>{ui('取消')}</Button>}
        {recording && <span className="voice-input__live" role="status">{ui('正在听…说完按「说完了」，录音转成文字后立刻删除')}</span>}
      </div>
      {voice.error && <InlineMessage onDismiss={voice.clearError}>{voice.error}</InlineMessage>}
      {voice.setup && <div ref={guide} className="voice-input__setup">
        <React.Suspense fallback={null}><VoiceSetup reason={voice.setup.reason} onSaved={voice.recheck} /></React.Suspense>
        <Button size="sm" variant="quiet" onClick={voice.closeSetup}>{ui('先不用语音')}</Button>
      </div>}
    </div>
  );
}
