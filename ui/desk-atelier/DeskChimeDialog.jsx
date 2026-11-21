import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button, Dialog, InlineMessage, Switch } from '../components/index.js';
import { isAudioCaptureActive } from '../audio-capture-state.js';
import { useInjectCss } from '../shared.js';
import { useLiveEffect } from '../use-async.js';
import {
  CHIME_ARPEGGIO_IDS,
  CHIME_ARPEGGIO_STEP_MS,
  CHIME_BARS,
  CHIME_KEY_MAP,
  nextBreezeDelayMs,
  pickNextBreezeBar,
  stopAllChimes,
  strikeChimeBar,
} from './chime-synth.js';
import chimeCss from './desk-chime.css';

const STRIKE_PULSE_MS = 520;
const TRAIL_MAX = 6;

/** Playable «五声风铃 · D-Major Desk Chime Box» modal dialog.
    9 pentatonic bars (D4–A5), click + drag glissando + keyboard A–L + optional Poisson Gentle Breeze.
    Default silent (zero AudioContext until struck/toggled), auto-mutes during active audio capture. */
export default function DeskChimeDialog({ onClose }) {
  useInjectCss(chimeCss, 'study-desk-chime');
  const [breezeOn, setBreezeOn] = useState(false);
  const [struckBars, setStruckBars] = useState(() => ({}));
  const [trail, setTrail] = useState([]);
  const [captureMuted, setCaptureMuted] = useState(() => isAudioCaptureActive());

  const draggingRef = useRef(false);
  const lastGlissBarRef = useRef('');
  const lastBreezeIdxRef = useRef(-1);
  const pulseTimersRef = useRef(new Map());
  const arpeggioTimersRef = useRef([]);

  const clearArpeggioTimers = useCallback(() => {
    for (const timer of arpeggioTimersRef.current) clearTimeout(timer);
    arpeggioTimersRef.current = [];
  }, []);

  const triggerBar = useCallback((barId, { velocity = 0.85, skipCooldown = false } = {}) => {
    const bar = CHIME_BARS.find((item) => item.id === barId);
    if (!bar) return false;

    const capturing = isAudioCaptureActive();
    setCaptureMuted(capturing);
    const played = capturing ? false : strikeChimeBar(barId, { velocity, skipCooldown });

    // Trigger gentle tactile sway + concentric ink-ring feedback.
    setStruckBars((prev) => ({ ...prev, [barId]: (prev[barId] || 0) + 1 }));
    setTrail((prev) => [...prev.slice(-(TRAIL_MAX - 1)), bar.note]);

    const timers = pulseTimersRef.current;
    const prevTimer = timers.get(barId);
    if (prevTimer) clearTimeout(prevTimer);
    const nextTimer = setTimeout(() => {
      timers.delete(barId);
      setStruckBars((prev) => {
        if (!prev[barId]) return prev;
        const copy = { ...prev };
        delete copy[barId];
        return copy;
      });
    }, STRIKE_PULSE_MS);
    nextTimer.unref?.();
    timers.set(barId, nextTimer);

    return played;
  }, []);

  // Release pointer-drag glissando cleanly on pointerup / pointercancel anywhere in the window.
  useEffect(() => {
    const pulseTimers = pulseTimersRef.current;
    const endDrag = () => {
      draggingRef.current = false;
      lastGlissBarRef.current = '';
    };
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('pointerup', endDrag);
      window.addEventListener('pointercancel', endDrag);
    }
    return () => {
      if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
        window.removeEventListener('pointerup', endDrag);
        window.removeEventListener('pointercancel', endDrag);
      }
      for (const timer of pulseTimers.values()) clearTimeout(timer);
      pulseTimers.clear();
      clearArpeggioTimers();
      stopAllChimes();
    };
  }, [clearArpeggioTimers]);

  // Keyboard play: A S D F G H J K L strike the 9 pentatonic bars while dialog is open.
  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
      const tag = typeof event.target?.tagName === 'string' ? event.target.tagName.toUpperCase() : '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || event.target?.isContentEditable) return;
      const barId = CHIME_KEY_MAP[String(event.key || '').toUpperCase()];
      if (!barId) return;
      event.preventDefault();
      triggerBar(barId, { velocity: 0.88 });
    };
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('keydown', onKeyDown);
      return () => window.removeEventListener('keydown', onKeyDown);
    }
    return undefined;
  }, [triggerBar]);

  // Optional Gentle Breeze («微风自鸣»): Poisson-spaced strikes every 2.5–6s using recursive setTimeout.
  useLiveEffect((isLive) => {
    if (!breezeOn) return undefined;
    let timerId = null;

    const scheduleNext = (delayMs = nextBreezeDelayMs()) => {
      if (!isLive()) return;
      if (timerId !== null) clearTimeout(timerId);
      timerId = setTimeout(() => {
        timerId = null;
        if (!isLive()) return;
        if (typeof document !== 'undefined' && document.hidden) return;
        const nextBar = pickNextBreezeBar(lastBreezeIdxRef.current);
        lastBreezeIdxRef.current = CHIME_BARS.findIndex((item) => item.id === nextBar.id);
        triggerBar(nextBar.id, { velocity: 0.62, skipCooldown: true });
        scheduleNext();
      }, delayMs);
      timerId.unref?.();
    };

    const onVisibility = () => {
      if (!isLive()) return;
      if (typeof document !== 'undefined' && document.hidden) {
        if (timerId !== null) {
          clearTimeout(timerId);
          timerId = null;
        }
      } else if (timerId === null) {
        scheduleNext(nextBreezeDelayMs());
      }
    };

    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', onVisibility);
    }
    if (typeof document === 'undefined' || !document.hidden) {
      scheduleNext(900);
    }

    return () => {
      if (timerId !== null) clearTimeout(timerId);
      if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
        document.removeEventListener('visibilitychange', onVisibility);
      }
    };
  }, [breezeOn, triggerBar]);

  const handleFramePointerMove = (event) => {
    if (!draggingRef.current) return;
    if (typeof document === 'undefined' || typeof document.elementFromPoint !== 'function') return;
    const hit = document.elementFromPoint(event.clientX, event.clientY)?.closest?.('[data-chime-bar]');
    const barId = hit?.getAttribute?.('data-chime-bar');
    if (barId && barId !== lastGlissBarRef.current) {
      lastGlissBarRef.current = barId;
      triggerBar(barId, { velocity: 0.78 });
    }
  };

  const handleToggleArpeggio = useCallback(() => {
    clearArpeggioTimers();
    const capturing = isAudioCaptureActive();
    setCaptureMuted(capturing);
    CHIME_ARPEGGIO_IDS.forEach((barId, step) => {
      const timer = setTimeout(() => {
        if (typeof document !== 'undefined' && document.hidden) return;
        triggerBar(barId, { velocity: 0.72 + step * 0.04, skipCooldown: true });
      }, step * CHIME_ARPEGGIO_STEP_MS);
      timer.unref?.();
      arpeggioTimersRef.current.push(timer);
    });
  }, [clearArpeggioTimers, triggerBar]);

  const handleClose = () => {
    setBreezeOn(false);
    clearArpeggioTimers();
    stopAllChimes();
    onClose?.();
  };

  return (
    <Dialog
      size="md"
      title={ui('五声风铃')}
      className="desk-chime-dialog"
      onClose={handleClose}
      footer={(
        <div className="desk-chime__footer">
          <span className="desk-chime__note-trail" aria-hidden="true">
            {trail.length ? trail.join(' · ') : ui('D 大调五声音阶 · D4–A5')}
          </span>
          <Button variant="secondary" size="sm" onClick={handleClose}>
            {ui('关闭')}
          </Button>
        </div>
      )}
    >
      <div className="desk-chime">
        <p className="desk-chime__intro">
          {ui('点按、横向划过铃条，或敲击键盘 A–L 轻叩休憩片刻。')}
        </p>

        {captureMuted && (
          <InlineMessage tone="info" className="desk-chime__notice">
            {ui('正在录音或进行实时课堂，风铃已自动静音。')}
          </InlineMessage>
        )}

        <div
          className="desk-chime__frame"
          role="group"
          aria-label={ui('D 大调九音风铃排')}
          onPointerMove={handleFramePointerMove}
        >
          <div className="desk-chime__rail" aria-hidden="true" />
          <div className="desk-chime__bars">
            {CHIME_BARS.map((bar, barIdx) => {
              const pulseCount = struckBars[bar.id] || 0;
              const isStruck = pulseCount > 0;
              const warmthPct = Math.round(62 - barIdx * 5.5);
              return (
                <div
                  key={bar.id}
                  className={'desk-chime__slot' + (isStruck ? ' is-struck' : '')}
                  style={{ '--chime-bar-h': `${bar.heightPct}%`, '--chime-warmth': `${warmthPct}%` }}
                >
                  <span className="desk-chime__cord" aria-hidden="true" />
                  <Button
                    variant="quiet"
                    className={'desk-chime__bar' + (isStruck ? ' is-struck' : '')}
                    data-chime-bar={bar.id}
                    aria-label={uiFormat('轻叩 {0}（快捷键 {1}）', [bar.note, bar.key])}
                    onPointerDown={(event) => {
                      if (event.button !== 0 && event.pointerType === 'mouse') return;
                      draggingRef.current = true;
                      lastGlissBarRef.current = bar.id;
                      triggerBar(bar.id, { velocity: 0.9 });
                    }}
                    onPointerEnter={() => {
                      if (!draggingRef.current || lastGlissBarRef.current === bar.id) return;
                      lastGlissBarRef.current = bar.id;
                      triggerBar(bar.id, { velocity: 0.78 });
                    }}
                    onClick={(event) => {
                      if (event.detail === 0) triggerBar(bar.id, { velocity: 0.88 });
                    }}
                  >
                    <span className="desk-chime__cap" aria-hidden="true" />
                    <span className="desk-chime__pin" aria-hidden="true" />
                    <span className="desk-chime__ring" aria-hidden="true" />
                    <span className="desk-chime__pitch">{bar.note}</span>
                    <kbd className="desk-chime__kbd">{bar.key}</kbd>
                  </Button>
                </div>
              );
            })}
          </div>
        </div>

        <div className="desk-chime__controls">
          <Switch
            label={ui('微风自鸣')}
            hint={ui('每 2.5–6 秒随风轻叩一音，切换页面后自动暂停')}
            checked={breezeOn}
            onChange={setBreezeOn}
          />
          <Button
            variant="quiet"
            size="sm"
            icon="sparkle"
            onClick={handleToggleArpeggio}
          >
            {ui('清风一曲')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
