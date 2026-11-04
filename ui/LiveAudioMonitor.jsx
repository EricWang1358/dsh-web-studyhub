import React, { useSyncExternalStore } from 'react';
import { audioInputStatus } from './live-audio-health.js';
import { ui, uiFormat } from './i18n.js';
import { formatElapsed } from './format.js';
import { Tooltip, useNow } from './components/index.js';

/**
 * Input level and upload health. `compact` is the recording view: one slim line
 * (device, meter, state) that only grows when something is wrong; the sound
 * details sit behind a disclosure so the transcript keeps the screen. They say
 * one fact with one number: how much sound the computer has heard, and (when the
 * page knows it, `sentences`) how many sentences that became.
 */
export default function LiveAudioMonitor({ health, visible, recording, compact = false, sentences }) {
  const state = useSyncExternalStore(health.subscribe, health.getSnapshot, health.getSnapshot);
  const now = useNow(500, { enabled: visible && state.phase === 'running' });
  if (state.phase === 'idle' || !visible) return null;
  const current = Math.max(now, state.lastFrameAt ?? state.startedAt);
  const status = audioInputStatus(state, current);
  const labels = {
    running: ui('正在采音'), waiting: ui('等待音频'),
    sound: ui('收到声音'), quiet: ui('声音很低或静音'),
    muted: ui('设备已静音'), suspended: ui('浏览器采音已中断'),
    missing: ui('未收到音频'), clipping: ui('声音过大'),
    paused: ui('已暂停采音'), stopped: ui('已停止采音'),
    requesting: state.kind === 'system' ? ui('正在连接电脑声音组件') : ui('等待麦克风或共享权限'),
  };
  const level = ['sound', 'quiet', 'clipping'].includes(status) ? state.level : 0;
  const warning = ['quiet', 'muted', 'missing', 'suspended', 'clipping'].includes(status);
  const backlog = state.queuedBytes >= 96000;
  const sending = recording && state.phase === 'running';
  const transfer = !sending ? state.phase === 'running' ? ui('正在连接，还没开始听写') : ui('已暂停或停止，不再听写')
    : backlog ? ui('声音发送跟不上，请检查网络')
      : state.lastAckAt === null ? ui('正在等听写开始')
        : current - state.lastAckAt > 3000 ? ui('最近几秒没有确认听到声音')
          : ui('正在听写');
  const device = state.label || (state.kind === 'system' ? ui('电脑系统声音') : state.kind === 'tab' ? ui('标签页 / 系统声音') : ui('系统默认麦克风'));
  const hint = warning && (status === 'quiet' || status === 'muted'
    ? state.kind === 'system' ? ui('请确认课程正在播放且电脑没有静音；组件只在播放出声时收到波形。')
      : state.kind === 'tab' ? ui('请确认课程正在播放，并已勾选共享音频；检查播放器是否静音。')
        : ui('对着麦克风说话，观察音量条。如果一直不动，请检查系统输入设备、静音开关和麦克风距离。')
    : status === 'clipping' ? ui('请调低系统输入音量或离麦克风远一点，避免声音失真。')
      : state.kind === 'system' ? ui('暂时没有收到系统声音数据。请检查播放设备是否正常，必要时结束后重新开始。')
        : ui('浏览器没有持续送来音频。请检查设备或共享状态，必要时结束后重新开始。'));
  const meter = <div className={`live-audio-meter${compact ? ' slim' : ''}`} role="meter" aria-label={ui('输入音量')}
    aria-valuemin={0} aria-valuemax={100} aria-valuenow={level} aria-valuetext={labels[status]}>
    <span style={{ width: `${level}%` }} className={status === 'clipping' ? 'clipping' : ''} /></div>;
  const numbers = <>
    <p className="live-audio-transfer">{Number.isFinite(sentences) ? uiFormat('电脑已收到声音 {0} · 已识别 {1} 句', [formatElapsed(state.capturedMs), sentences])
      : uiFormat('电脑已收到声音 {0}', [formatElapsed(state.capturedMs)])}</p>
    <p className="live-audio-transfer">{transfer}</p>
    <small className="muted">{ui('音量条显示电脑实际收到的声音；收到声音不等于已经转成文字。')}</small>
  </>;
  if (compact) return <aside className={`live-audio-bar${warning ? ' warn' : ''}`} aria-label={ui('音频输入状态')}>
    <div className="live-audio-line">
      <Tooltip layer anchorClassName="live-audio-name" content={device}><span className="live-audio-name" tabIndex={0}>{device}</span></Tooltip>
      {meter}
      <span className={warning ? 'live-audio-warning' : 'live-audio-state'} role="status">{labels[status]}</span>
      {backlog && <span className="live-audio-warning">{ui('声音积压')}</span>}
    </div>
    {warning && <p className="live-audio-hint">{hint}</p>}
    <details className="live-audio-more"><summary>{ui('声音详情')}</summary>{numbers}</details>
  </aside>;
  return <aside className="live-audio-monitor" aria-label={ui('音频输入状态')}>
    <div className="live-audio-heading"><strong>{ui('输入音量')}</strong>
      <span className={warning ? 'live-audio-warning' : ''} role="status">{labels[status]}</span></div>
    <p className="live-audio-device">{device}</p>
    {meter}
    <div className="live-audio-scale" aria-hidden="true"><span>{ui('静音')}</span><span>{ui('响亮')}</span></div>
    {numbers}
    {warning && <p className="live-audio-hint">{hint}</p>}
  </aside>;
}
