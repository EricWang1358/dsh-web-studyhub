import React, { useEffect, useRef, useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button, IconButton } from '../components/index.js';
import { useInjectCss } from '../shared.js';
import css from './desk-atelier.css';

export const BREATH_PHASES = Object.freeze([
  Object.freeze({ id: 'inhale', label: '吸气', seconds: 4 }),
  Object.freeze({ id: 'hold', label: '屏息', seconds: 4 }),
  Object.freeze({ id: 'exhale', label: '缓呼', seconds: 6 }),
]);

export const BREATH_CYCLE_SEC = 14;
export const BREATH_TOTAL_SEC = 60;
const BREATH_TOTAL_MS = BREATH_TOTAL_SEC * 1000;
const MIN_SCALE = 0.66;
const MAX_SCALE = 1.0;

/** Pure deterministic 4-4-6 breathing phase snapshot from elapsed milliseconds (0..60000). */
export function breathingSnapshot(rawElapsedMs) {
  const elapsedMs = Number.isFinite(rawElapsedMs) ? Math.max(0, Math.min(BREATH_TOTAL_MS, rawElapsedMs)) : 0;
  const done = elapsedMs >= BREATH_TOTAL_MS;
  const remainingSec = done ? 0 : Math.ceil((BREATH_TOTAL_MS - elapsedMs) / 1000);
  if (done) {
    return {
      elapsedMs,
      remainingSec: 0,
      phaseId: 'done',
      phaseLabel: '呼吸完成',
      phaseRemainingSec: 0,
      phaseProgress: 1,
      scale: 0.86,
      done: true,
    };
  }
  const cycleMs = BREATH_CYCLE_SEC * 1000;
  let cursorMs = elapsedMs % cycleMs;
  let active = BREATH_PHASES[0];
  for (const phase of BREATH_PHASES) {
    const durMs = phase.seconds * 1000;
    if (cursorMs < durMs) {
      active = phase;
      break;
    }
    cursorMs -= durMs;
  }
  const durMs = active.seconds * 1000;
  const phaseProgress = Math.max(0, Math.min(1, cursorMs / durMs));
  const phaseRemainingSec = Math.max(1, Math.ceil((durMs - cursorMs) / 1000));
  const ease = 0.5 - 0.5 * Math.cos(Math.PI * phaseProgress);
  let scale = MAX_SCALE;
  if (active.id === 'inhale') {
    scale = MIN_SCALE + (MAX_SCALE - MIN_SCALE) * ease;
  } else if (active.id === 'exhale') {
    scale = MAX_SCALE - (MAX_SCALE - MIN_SCALE) * ease;
  }
  return {
    elapsedMs,
    remainingSec,
    phaseId: active.id,
    phaseLabel: active.label,
    phaseRemainingSec,
    phaseProgress,
    scale: Number(scale.toFixed(4)),
    done: false,
  };
}

function readReducedMotion(node) {
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return true;
  }
  const root = node?.closest?.('.study-app, .study-seat')
    || (typeof document !== 'undefined' ? document.querySelector?.('.study-app, .study-seat') : null);
  const attr = root?.getAttribute?.('data-motion');
  return attr === 'reduced' || attr === 'off';
}

/** Opt-in 60-second 4-4-6 visual breathing halo for calm between-round breaks.
    Pauses automatically when document.hidden; switches to text-paced calm mode under reduced motion. */
export default function BreathingHalo({ compact = false, defaultRunning = true, onClose }) {
  useInjectCss(css, 'study-desk-atelier');
  const rootRef = useRef(null);
  const [active, setActive] = useState(defaultRunning);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [reducedMotion, setReducedMotion] = useState(() => readReducedMotion(null));
  const [hiddenPaused, setHiddenPaused] = useState(false);

  const elapsedRef = useRef(elapsedMs);
  elapsedRef.current = elapsedMs;

  useEffect(() => {
    const syncMotion = () => setReducedMotion(readReducedMotion(rootRef.current));
    syncMotion();
    const media = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : null;
    media?.addEventListener?.('change', syncMotion);
    const host = rootRef.current?.closest?.('.study-app, .study-seat')
      || (typeof document !== 'undefined' ? document.querySelector?.('.study-app, .study-seat') : null);
    let observer = null;
    if (host && typeof MutationObserver === 'function') {
      observer = new MutationObserver(syncMotion);
      observer.observe(host, { attributes: true, attributeFilter: ['data-motion'] });
    }
    return () => {
      media?.removeEventListener?.('change', syncMotion);
      observer?.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!active) {
      setHiddenPaused(false);
      return undefined;
    }
    let lastTickAt = Date.now();
    let rafId = null;
    let timerId = null;
    let cancelled = false;

    const advance = () => {
      if (typeof document !== 'undefined' && document.hidden) {
        setHiddenPaused(true);
        lastTickAt = Date.now();
        return;
      }
      setHiddenPaused(false);
      const now = Date.now();
      const delta = Math.max(0, Math.min(250, now - lastTickAt));
      lastTickAt = now;
      const next = Math.min(BREATH_TOTAL_MS, elapsedRef.current + delta);
      elapsedRef.current = next;
      setElapsedMs(next);
      if (next >= BREATH_TOTAL_MS) {
        setActive(false);
      }
    };

    const onVisibility = () => {
      lastTickAt = Date.now();
      if (typeof document !== 'undefined' && document.hidden) {
        setHiddenPaused(true);
      } else {
        setHiddenPaused(false);
      }
    };
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', onVisibility);
    }

    if (reducedMotion || typeof globalThis.requestAnimationFrame !== 'function') {
      const scheduleStep = () => {
        timerId = setTimeout(() => {
          timerId = null;
          if (cancelled) return;
          if (typeof document !== 'undefined' && document.hidden) {
            setHiddenPaused(true);
            lastTickAt = Date.now();
            scheduleStep();
            return;
          }
          setHiddenPaused(false);
          const now = Date.now();
          const delta = Math.max(0, Math.min(600, now - lastTickAt));
          lastTickAt = now;
          const next = Math.min(BREATH_TOTAL_MS, elapsedRef.current + delta);
          elapsedRef.current = next;
          setElapsedMs(next);
          if (next >= BREATH_TOTAL_MS) {
            setActive(false);
            return;
          }
          scheduleStep();
        }, 250);
        timerId.unref?.();
      };
      scheduleStep();
    } else {
      const loop = () => {
        if (cancelled) return;
        advance();
        if (elapsedRef.current < BREATH_TOTAL_MS) {
          rafId = globalThis.requestAnimationFrame(loop);
        }
      };
      rafId = globalThis.requestAnimationFrame(loop);
    }

    return () => {
      cancelled = true;
      if (rafId !== null && typeof globalThis.cancelAnimationFrame === 'function') {
        globalThis.cancelAnimationFrame(rafId);
      }
      if (timerId !== null) clearTimeout(timerId);
      if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
        document.removeEventListener('visibilitychange', onVisibility);
      }
    };
  }, [active, reducedMotion]);

  const snap = breathingSnapshot(elapsedMs);
  const visualScale = reducedMotion ? 1 : snap.scale;
  const haloOpacity = reducedMotion ? 0.9 : (0.55 + (snap.scale - MIN_SCALE) * 1.15);

  const handleRestart = () => {
    elapsedRef.current = 0;
    setElapsedMs(0);
    setActive(true);
  };

  const handleToggle = () => {
    if (snap.done) {
      handleRestart();
      return;
    }
    setActive((prev) => !prev);
  };

  return (
    <section
      ref={rootRef}
      className={'desk-breath' + (compact ? ' desk-breath--compact' : '')}
      data-breath-phase={snap.phaseId}
      data-breath-reduced={reducedMotion ? 'true' : 'false'}
      aria-label={ui('60 秒呼吸引导')}
    >
      <div className="desk-breath__head">
        <span className="desk-breath__title">{ui('4-4-6 呼吸引导')}</span>
        <span className="desk-breath__remain">
          {snap.done
            ? ui('已完成 60 秒')
            : uiFormat('剩余 {0} 秒', [snap.remainingSec])}
        </span>
        {onClose && (
          <IconButton
            icon="close"
            size="sm"
            label={ui('收起呼吸引导')}
            onClick={onClose}
          />
        )}
      </div>

      <div className="desk-breath__stage">
        <div className="desk-breath__halo-wrap" aria-hidden="true">
          <div className="desk-breath__ring desk-breath__ring--outer" />
          <div
            className="desk-breath__halo"
            style={{
              transform: `scale(${visualScale})`,
              opacity: Number(Math.max(0.35, Math.min(1, haloOpacity)).toFixed(3)),
            }}
          />
        </div>
        <div className="desk-breath__cue">
          <strong className="desk-breath__phase">{ui(snap.phaseLabel)}</strong>
          <span className="desk-breath__count">
            {snap.done
              ? ui('肩颈放松，准备进入下一轮')
              : hiddenPaused
                ? ui('切换页面后已暂停')
                : uiFormat('{0} 秒', [snap.phaseRemainingSec])}
          </span>
        </div>
      </div>

      <span className="sh-visually-hidden" aria-live="polite">
        {snap.done ? ui('60 秒呼吸引导完成') : ui(snap.phaseLabel)}
      </span>

      <div className="desk-breath__cadence" aria-hidden="true">
        {BREATH_PHASES.map((phase) => (
          <span
            key={phase.id}
            className={'desk-breath__step' + (snap.phaseId === phase.id ? ' is-current' : '')}
          >
            {uiFormat('{0} {1}s', [ui(phase.label), phase.seconds])}
          </span>
        ))}
      </div>

      <div className="desk-breath__actions">
        <Button
          variant="secondary"
          size="sm"
          onClick={handleToggle}
        >
          {snap.done ? ui('再来一次') : active ? ui('暂停') : ui('继续')}
        </Button>
        {!snap.done && elapsedMs > 0 && (
          <Button variant="quiet" size="sm" icon="refresh" onClick={handleRestart}>
            {ui('重新开始')}
          </Button>
        )}
      </div>
    </section>
  );
}
