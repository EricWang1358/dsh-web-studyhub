import React, { useEffect, useRef, useState } from 'react';
import { ui } from '../i18n.js';
import { Button } from '../components/index.js';
import { browserStorage, readText, writeText } from '../storage.js';
import { useInjectCss } from '../shared.js';
import chimeCss from './desk-chime.css';

export const FOCUS_AMBIENT_KEY = 'study-focus-ambient';

export const FOCUS_AMBIENT_MODES = Object.freeze([
  Object.freeze({ id: 'off', label: '静谧' }),
  Object.freeze({ id: 'rain-ripples', label: '细雨涟漪' }),
  Object.freeze({ id: 'ink-ripples', label: '墨滴流纹' }),
  Object.freeze({ id: 'lamp-dust', label: '暖灯微尘' }),
]);

const VALID_MODES = new Set(FOCUS_AMBIENT_MODES.map((m) => m.id));
const FRAME_INTERVAL_MS = 33; // ~30 fps gentle studio cadence

export function normalizeAmbientMode(raw) {
  return VALID_MODES.has(raw) ? raw : 'off';
}

export function loadAmbientMode(storage = browserStorage()) {
  return normalizeAmbientMode(readText(FOCUS_AMBIENT_KEY, 'off', storage));
}

export function saveAmbientMode(mode, storage = browserStorage()) {
  const normalized = normalizeAmbientMode(mode);
  writeText(FOCUS_AMBIENT_KEY, normalized, storage);
  return normalized;
}

/** Pure particle state initializer for deterministic tests and Canvas2D drawing. */
export function createAmbientParticles(mode, width, height, rand = Math.random) {
  const safeW = Math.max(120, Number(width) || 640);
  const safeH = Math.max(120, Number(height) || 480);
  if (mode === 'rain-ripples') {
    return Array.from({ length: 12 }, (_, idx) => ({
      kind: 'ripple',
      x: rand() * safeW,
      y: rand() * safeH,
      radius: (idx / 12) * 85,
      maxRadius: 58 + rand() * 54,
      speed: 22 + rand() * 14,
      ringCount: rand() > 0.55 ? 2 : 1,
    }));
  }
  if (mode === 'ink-ripples') {
    return Array.from({ length: 7 }, (_, idx) => ({
      kind: 'ink',
      x: safeW * (0.14 + rand() * 0.72),
      y: safeH * (0.14 + rand() * 0.72),
      radius: 18 + (idx / 7) * 95,
      maxRadius: 96 + rand() * 72,
      speed: 10 + rand() * 7,
      wobble: rand() * Math.PI * 2,
    }));
  }
  if (mode === 'lamp-dust') {
    return Array.from({ length: 24 }, () => ({
      kind: 'dust',
      x: rand() * safeW,
      y: rand() * safeH,
      r: 1.2 + rand() * 2.2,
      vx: (rand() - 0.5) * 6,
      vy: -(4 + rand() * 7),
      phase: rand() * Math.PI * 2,
    }));
  }
  return [];
}

/** Advance ambient particles by dtSec (clamped for smooth stability). */
export function stepAmbientParticles(particles, mode, dtSec, width, height, rand = Math.random) {
  const dt = Math.max(0, Math.min(0.12, Number(dtSec) || 0));
  const safeW = Math.max(120, Number(width) || 640);
  const safeH = Math.max(120, Number(height) || 480);
  for (const p of particles) {
    if (p.kind === 'ripple' || p.kind === 'ink') {
      p.radius += p.speed * dt;
      if (p.radius >= p.maxRadius) {
        p.x = mode === 'ink-ripples' ? safeW * (0.14 + rand() * 0.72) : rand() * safeW;
        p.y = mode === 'ink-ripples' ? safeH * (0.14 + rand() * 0.72) : rand() * safeH;
        p.radius = 2;
        p.maxRadius = mode === 'ink-ripples' ? (96 + rand() * 72) : (58 + rand() * 54);
      }
    } else if (p.kind === 'dust') {
      p.phase += dt * 0.9;
      p.x += (p.vx + Math.sin(p.phase) * 3.5) * dt;
      p.y += p.vy * dt;
      if (p.y < -10) {
        p.y = safeH + 10;
        p.x = rand() * safeW;
      }
      if (p.x < -10) p.x = safeW + 10;
      else if (p.x > safeW + 10) p.x = -10;
    }
  }
  return particles;
}

function isAmbientSuppressed(node) {
  if (typeof document !== 'undefined' && document.hidden) return true;
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return true;
    if (window.matchMedia('(forced-colors: active)').matches) return true;
  }
  const host = node?.closest?.('.study-app, .study-seat')
    || (typeof document !== 'undefined' ? document.querySelector?.('.study-app, .study-seat') : null);
  const motion = host?.getAttribute?.('data-motion');
  const contrast = host?.getAttribute?.('data-contrast');
  return motion === 'reduced' || motion === 'off' || contrast === 'high';
}

function readCanvasPalette(node) {
  const host = node?.closest?.('.study-app, .study-seat')
    || (typeof document !== 'undefined' ? document.querySelector?.('.study-app, .study-seat') : null);
  if (!host || typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') {
    return { primary: 'currentColor', secondary: 'currentColor', warm: 'currentColor' };
  }
  const styles = window.getComputedStyle(host);
  const pick = (name, fallback) => styles.getPropertyValue(name)?.trim() || fallback;
  return {
    primary: pick('--info', pick('--text-dim', 'currentColor')),
    secondary: pick('--text-muted', 'currentColor'),
    warm: pick('--warn', pick('--text-dim', 'currentColor')),
    accent: pick('--accent-soft', pick('--text-muted', 'currentColor')),
  };
}

/** Compact opt-in pill selector for Focus-Stage atmospheric canvas modes. */
export function FocusAmbientControls({ mode, onChange }) {
  useInjectCss(chimeCss, 'study-desk-chime');
  return (
    <div className="desk-ambient-bar" role="group" aria-label={ui('专注背景画布')}>
      <span className="desk-ambient-bar__label">{ui('专注画布')}</span>
      <div className="desk-ambient-bar__pills">
        {FOCUS_AMBIENT_MODES.map((item) => {
          const active = mode === item.id;
          return (
            <Button
              key={item.id}
              variant="quiet"
              size="sm"
              shape="pill"
              aria-pressed={active}
              className={'desk-ambient-bar__choice' + (active ? ' is-selected' : '')}
              onClick={() => onChange?.(item.id)}
            >
              {ui(item.label)}
            </Button>
          );
        })}
      </div>
    </div>
  );
}

/** Subtle opt-in Canvas2D backdrop behind TodayTimer's fullscreen focus stage.
    DPR <= 2, ~30fps, live CSS tokens only, halts RAF on hidden tab / high contrast / reduced motion / close. */
export default function FocusAmbientCanvas({ mode = 'off' }) {
  useInjectCss(chimeCss, 'study-desk-chime');
  const canvasRef = useRef(null);
  const paletteRef = useRef(null);
  const [suppressed, setSuppressed] = useState(() => isAmbientSuppressed(null));

  useEffect(() => {
    const sync = () => {
      setSuppressed(isAmbientSuppressed(canvasRef.current));
      if (canvasRef.current) {
        paletteRef.current = readCanvasPalette(canvasRef.current);
      }
    };
    sync();
    const mediaMotion = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : null;
    const mediaForced = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(forced-colors: active)')
      : null;
    mediaMotion?.addEventListener?.('change', sync);
    mediaForced?.addEventListener?.('change', sync);
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', sync);
    }
    const host = canvasRef.current?.closest?.('.study-app, .study-seat')
      || (typeof document !== 'undefined' ? document.querySelector?.('.study-app, .study-seat') : null);
    const rootEl = typeof document !== 'undefined' ? document.documentElement : null;
    let observer = null;
    if (typeof MutationObserver === 'function' && (host || rootEl)) {
      const attrs = ['data-motion', 'data-contrast', 'data-theme', 'data-palette', 'data-accent'];
      observer = new MutationObserver(sync);
      if (host) observer.observe(host, { attributes: true, attributeFilter: attrs });
      if (rootEl && rootEl !== host) observer.observe(rootEl, { attributes: true, attributeFilter: attrs });
    }
    return () => {
      mediaMotion?.removeEventListener?.('change', sync);
      mediaForced?.removeEventListener?.('change', sync);
      if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
        document.removeEventListener('visibilitychange', sync);
      }
      observer?.disconnect();
    };
  }, [mode]);

  useEffect(() => {
    if (mode === 'off' || suppressed) return undefined;
    const canvas = canvasRef.current;
    if (!canvas || typeof canvas.getContext !== 'function') return undefined;
    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;

    let width = 640;
    let height = 480;
    const resize = () => {
      const rect = canvas.getBoundingClientRect?.() || { width: 640, height: 480 };
      width = Math.max(160, Math.round(rect.width || 640));
      height = Math.max(160, Math.round(rect.height || 480));
      const dpr = Math.min(2, (typeof window !== 'undefined' ? window.devicePixelRatio : 1) || 1);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();

    let resizeObserver = null;
    if (typeof ResizeObserver === 'function') {
      resizeObserver = new ResizeObserver(resize);
      resizeObserver.observe(canvas);
    }

    const particles = createAmbientParticles(mode, width, height);
    paletteRef.current = readCanvasPalette(canvas);
    let lastFrameAt = 0;
    let rafId = null;

    const draw = (now) => {
      if (isAmbientSuppressed(canvas)) {
        rafId = null;
        return;
      }
      if (!lastFrameAt || now - lastFrameAt >= FRAME_INTERVAL_MS) {
        const dtSec = lastFrameAt ? (now - lastFrameAt) / 1000 : 0.033;
        lastFrameAt = now;
        stepAmbientParticles(particles, mode, dtSec, width, height);
        ctx.clearRect(0, 0, width, height);
        const palette = paletteRef.current || readCanvasPalette(canvas);

        for (const p of particles) {
          if (p.kind === 'ripple') {
            const life = Math.max(0, 1 - p.radius / p.maxRadius);
            ctx.save();
            ctx.strokeStyle = palette.primary;
            ctx.lineWidth = 1.2;
            ctx.globalAlpha = life * 0.85;
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
            ctx.stroke();
            if (p.ringCount > 1 && p.radius > 14) {
              ctx.globalAlpha = life * 0.45;
              ctx.beginPath();
              ctx.arc(p.x, p.y, p.radius * 0.62, 0, Math.PI * 2);
              ctx.stroke();
            }
            ctx.restore();
          } else if (p.kind === 'ink') {
            const life = Math.max(0, 1 - p.radius / p.maxRadius);
            const easeAlpha = Math.sin(life * Math.PI) * 0.72;
            ctx.save();
            ctx.strokeStyle = palette.secondary;
            ctx.lineWidth = 2.2;
            ctx.globalAlpha = easeAlpha;
            ctx.beginPath();
            ctx.ellipse(p.x, p.y, p.radius, p.radius * 0.82, p.wobble, 0, Math.PI * 2);
            ctx.stroke();
            ctx.strokeStyle = palette.accent;
            ctx.lineWidth = 1;
            ctx.globalAlpha = easeAlpha * 0.55;
            ctx.beginPath();
            ctx.ellipse(p.x, p.y, p.radius * 0.68, p.radius * 0.58, p.wobble + 0.5, 0, Math.PI * 2);
            ctx.stroke();
            ctx.restore();
          } else if (p.kind === 'dust') {
            const twinkle = 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(p.phase * 1.4));
            ctx.save();
            ctx.fillStyle = palette.warm;
            ctx.globalAlpha = twinkle * 0.8;
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
          }
        }
      }
      if (typeof globalThis.requestAnimationFrame === 'function') {
        rafId = globalThis.requestAnimationFrame(draw);
      }
    };

    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('resize', resize);
    }
    if (typeof globalThis.requestAnimationFrame === 'function') {
      rafId = globalThis.requestAnimationFrame(draw);
    }

    return () => {
      if (rafId !== null && typeof globalThis.cancelAnimationFrame === 'function') {
        globalThis.cancelAnimationFrame(rafId);
      }
      resizeObserver?.disconnect();
      if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
        window.removeEventListener('resize', resize);
      }
    };
  }, [mode, suppressed]);

  if (mode === 'off') return null;

  return (
    <canvas
      ref={canvasRef}
      className="desk-ambient-canvas"
      data-ambient-mode={mode}
      aria-hidden="true"
    />
  );
}
