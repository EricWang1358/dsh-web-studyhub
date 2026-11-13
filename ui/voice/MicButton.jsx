import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button, InlineMessage, Tooltip, useNow } from '../components/index.js';
import { formatClock } from '../format.js';
import { useStudy } from '../study-context.jsx';
import { useInjectCss } from '../shared.js';
import { createVoiceRecorder, isAudioSetupError } from './mic.js';
import css from './voice.css';

/**
 * Reusable microphone record + upload button.
 * Falls back smoothly to an inline MinerU-style setup note if the decoupled `audio` plugin/provider isn't ready.
 */
const MicButton = forwardRef(function MicButton(
  { label, recordingLabel, uploadingLabel = '正在上传语音…', variant = 'secondary', size = 'sm',
    disabled = false, onRecorded, hint, className = '', onActiveChange },
  ref,
) {
  useInjectCss(css, 'study-voice');
  const { call, openSettings } = useStudy();
  const [micState, setMicState] = useState({ phase: 'idle', startedAt: 0, error: '' });
  const [needsSetup, setNeedsSetup] = useState(false);
  const recorderRef = useRef(null);
  const onRecordedRef = useRef(onRecorded);
  onRecordedRef.current = onRecorded;

  if (!recorderRef.current) {
    recorderRef.current = createVoiceRecorder({
      call,
      onState: (next) => {
        setMicState((prev) => ({ ...prev, ...next }));
        onActiveChange?.(next.phase !== 'idle');
      },
    });
  }

  useEffect(() => () => {
    void recorderRef.current?.cancel();
  }, []);

  const stopAndSubmit = useCallback(async () => {
    try {
      const uploadId = await recorderRef.current.stopAndUpload();
      if (uploadId) await onRecordedRef.current?.(uploadId);
    } catch (error) {
      if (isAudioSetupError(error)) setNeedsSetup(true);
      setMicState((prev) => ({ ...prev, phase: 'idle', error: String(error?.message || error) }));
    }
  }, []);

  const toggle = useCallback(async () => {
    if (disabled) return;
    const phase = recorderRef.current.getPhase();
    if (phase === 'uploading') return;
    if (phase === 'recording') {
      await stopAndSubmit();
      return;
    }
    setNeedsSetup(false);
    try {
      await recorderRef.current.start();
    } catch (error) {
      if (isAudioSetupError(error)) setNeedsSetup(true);
    }
  }, [disabled, stopAndSubmit]);

  useImperativeHandle(ref, () => ({
    toggle,
    cancel: () => recorderRef.current?.cancel(),
    isRecording: () => recorderRef.current?.getPhase() === 'recording',
  }), [toggle]);

  const recording = micState.phase === 'recording';
  const uploading = micState.phase === 'uploading';
  const now = useNow(250, { enabled: recording });
  const elapsed = formatClock(recording ? Math.max(0, now - (micState.startedAt || now)) : 0);

  const button = (
    <Button
      type="button"
      variant={recording ? 'secondary' : variant}
      size={size}
      busy={uploading}
      busyLabel={ui(uploadingLabel)}
      lock={disabled}
      className={recording ? 'voice-mic-btn--recording' : undefined}
      icon={recording ? undefined : 'audio'}
      aria-pressed={recording}
      onClick={toggle}
    >
      {recording && <span className="voice-mic-dot" aria-hidden="true" />}
      {recording
        ? (recordingLabel ? `${ui(recordingLabel)} ${elapsed}` : uiFormat('正在口述 {0} · 点击完成提交', [elapsed]))
        : ui(label)}
    </Button>
  );

  return (
    <span className={`voice-mic-wrap ${className}`.trim()}>
      {hint && !recording && !uploading ? <Tooltip layer content={hint}>{button}</Tooltip> : button}
      {recording && (
        <Button type="button" variant="quiet" size="sm" onClick={() => void recorderRef.current.cancel()}>
          {ui('取消')}
        </Button>
      )}
      {needsSetup && (
        <span className="voice-mic-setup" role="status">
          <span>{ui('请先启用或配置音频转写插件')}</span>
          <Button type="button" variant="link" size="sm" onClick={() => openSettings('settings-audio')}>
            {ui('前往设置')}
          </Button>
        </span>
      )}
      {micState.error && !needsSetup && (
        <InlineMessage tone="error">{micState.error}</InlineMessage>
      )}
    </span>
  );
});

export default MicButton;
