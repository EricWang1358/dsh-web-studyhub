import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { audioInputStatus } from './live-audio-health.js';
import { getUiLanguage } from './i18n.js';

const t = (zh, en) => getUiLanguage() === 'en' ? en : zh;
const seconds = value => `${Math.floor(value / 1000)} ${t('秒', 's')}`;

/**
 * Input level and upload health. `compact` is the recording view: one slim line
 * (device, meter, state) that only grows when something is wrong; the transfer
 * numbers sit behind a disclosure so the transcript keeps the screen.
 */
export default function LiveAudioMonitor({ health, visible, recording, compact = false }) {
  const state = useSyncExternalStore(health.subscribe, health.getSnapshot, health.getSnapshot);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!visible || state.phase !== 'running') return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [visible, state.phase]);
  if (state.phase === 'idle' || !visible) return null;
  const current = Math.max(now, state.lastFrameAt ?? state.startedAt);
  const status = audioInputStatus(state, current);
  const labels = {
    running: t('正在采音', 'Capturing audio'), waiting: t('等待音频', 'Waiting for audio'),
    sound: t('收到声音', 'Sound detected'), quiet: t('声音很低或静音', 'Very quiet or silent'),
    muted: t('设备已静音', 'Device muted'), suspended: t('浏览器采音已中断', 'Browser audio interrupted'),
    missing: t('未收到音频', 'No audio frames received'), clipping: t('声音过大', 'Audio too loud'),
    paused: t('已暂停采音', 'Capture paused'), stopped: t('已停止采音', 'Capture stopped'),
    requesting: t('等待麦克风或共享权限', 'Waiting for audio permission'),
  };
  const level = ['sound', 'quiet', 'clipping'].includes(status) ? state.level : 0;
  const warning = ['quiet', 'muted', 'missing', 'suspended', 'clipping'].includes(status);
  const backlog = state.queuedBytes >= 96000;
  const sending = recording && state.phase === 'running';
  const transfer = !sending ? state.phase === 'running' ? t('连接中，等待上传', 'Connecting; waiting to upload') : t('上传已暂停或停止', 'Upload paused or stopped')
    : backlog ? t('上传积压，请检查连接', 'Upload is falling behind; check your connection')
      : state.lastAckAt === null ? t('等待后端接收音频', 'Waiting for the backend to accept audio')
        : current - state.lastAckAt > 3000 ? t('最近未收到上传确认', 'No recent upload confirmation')
          : t('音频正在上传', 'Uploading audio');
  const device = state.label || (state.kind === 'tab' ? t('标签页 / 系统声音', 'Tab / system audio') : t('系统默认麦克风', 'System default microphone'));
  const hint = warning && (status === 'quiet' || status === 'muted'
    ? state.kind === 'tab' ? t('请确认课程正在播放，并已勾选共享音频；检查播放器是否静音。', 'Check that the class is playing, audio sharing is enabled, and the player is not muted.')
      : t('对着麦克风说话，观察音量条。如果一直不动，请检查系统输入设备、静音开关和麦克风距离。', 'Speak toward the microphone and watch the meter. If it stays still, check your system input, mute switch and microphone distance.')
    : status === 'clipping' ? t('请调低系统输入音量或离麦克风远一点，避免声音失真。', 'Lower the system input volume or move farther from the microphone to avoid distortion.')
      : t('浏览器没有持续送来音频。请检查设备或共享状态，必要时结束后重新开始。', 'The browser is not delivering audio continuously. Check the device or sharing status; end and restart if needed.'));
  const meter = <div className={`live-audio-meter${compact ? ' slim' : ''}`} role="meter" aria-label={t('输入音量', 'Input level')}
    aria-valuemin={0} aria-valuemax={100} aria-valuenow={level} aria-valuetext={labels[status]}>
    <span style={{ width: `${level}%` }} className={status === 'clipping' ? 'clipping' : ''} /></div>;
  const numbers = <>
    <p className="live-audio-transfer">{t('已收到音频', 'Audio captured')} {seconds(state.capturedMs)} · {t('后端已接收', 'Backend accepted')} {seconds(state.acceptedMs)}</p>
    <p className="live-audio-transfer">{transfer}</p>
    <small className="muted">{t('音量反映实际采集的声音；后端接收不代表已经识别成文字。', 'The meter reflects captured audio; backend acceptance does not mean speech has been transcribed.')}</small>
  </>;
  if (compact) return <aside className={`live-audio-bar${warning ? ' warn' : ''}`} aria-label={t('音频输入状态', 'Audio input status')}>
    <div className="live-audio-line">
      <span className="live-audio-name" title={device}>{device}</span>
      {meter}
      <span className={warning ? 'live-audio-warning' : 'live-audio-state'} role="status">{labels[status]}</span>
      {backlog && <span className="live-audio-warning">{t('上传积压', 'Upload backlog')}</span>}
    </div>
    {warning && <p className="live-audio-hint">{hint}</p>}
    <details className="live-audio-more"><summary>{t('传输详情', 'Transfer details')}</summary>{numbers}</details>
  </aside>;
  return <aside className="live-audio-monitor" aria-label={t('音频输入状态', 'Audio input status')}>
    <div className="live-audio-heading"><strong>{t('输入音量', 'Input level')}</strong>
      <span className={warning ? 'live-audio-warning' : ''} role="status">{labels[status]}</span></div>
    <p className="live-audio-device">{device}</p>
    {meter}
    <div className="live-audio-scale" aria-hidden="true"><span>{t('静音', 'Silent')}</span><span>{t('响亮', 'Loud')}</span></div>
    {numbers}
    {warning && <p className="live-audio-hint">{hint}</p>}
  </aside>;
}
