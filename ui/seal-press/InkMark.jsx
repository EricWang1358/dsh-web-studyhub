/* Thin, React-19-safe editorial ink mark wrapper around lazy `rough-notation` (MIT).
   Draws hand-inked underlines, circles or ochre highlighter sweeps using live StudyHub CSS tokens,
   switches to an instant static stroke under prefers-reduced-motion or [data-motion="reduced"|"off"],
   and always removes its SVG annotation cleanly on unmount/re-render. */
import React from 'react';
import { cx } from '../components/css.js';
import { useInjectCss } from '../shared.js';
import { useAppearance } from '../use-appearance.js';
import { cssColorToHex, findStudyRoot, prefersReducedMotion, resolveThemePalette } from './palette.js';
import inkMarkCss from './ink-mark.css';

function resolveMarkColor(palette, type, tone) {
  const base = tone === 'success'
    ? palette.ok
    : tone === 'accent'
      ? (type === 'highlight' ? palette.accent : palette.accentText)
      : tone === 'info'
        ? palette.info
        : tone === 'error'
          ? palette.bad
          : palette.warn;
  const hex = cssColorToHex(base, '#d9a441');
  return type === 'highlight' ? `${hex}47` : hex;
}

export default function InkMark({
  type = 'underline',
  tone = 'warning',
  active = true,
  strokeWidth = 2,
  padding = 3,
  iterations = 2,
  multiline = false,
  animate = true,
  className,
  children,
}) {
  useInjectCss(inkMarkCss, 'study-ink-mark');
  const [appearance] = useAppearance();
  const minimal = appearance.minimal === 'on';
  const targetRef = React.useRef(null);
  const [themeTick, setThemeTick] = React.useState(0);

  React.useEffect(() => {
    if (minimal || typeof window === 'undefined' || !active) return undefined;
    const root = findStudyRoot(targetRef.current);
    if (!root || typeof MutationObserver !== 'function') return undefined;
    const observer = new MutationObserver(() => setThemeTick((n) => n + 1));
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme', 'data-palette', 'data-accent', 'data-motion'] });
    return () => observer.disconnect();
  }, [active, minimal]);

  React.useEffect(() => {
    if (minimal || !active || typeof window === 'undefined') return undefined;
    const el = targetRef.current;
    if (!el) return undefined;
    let cancelled = false;
    let annotation = null;

    import('rough-notation')
      .then((mod) => {
        if (cancelled || !el.isConnected) return;
        const annotate = mod?.annotate || mod?.default?.annotate;
        if (typeof annotate !== 'function') return;
        const palette = resolveThemePalette(el);
        const reduced = prefersReducedMotion(el);
        const color = resolveMarkColor(palette, type, tone);
        annotation = annotate(el, {
          type,
          color,
          strokeWidth,
          padding,
          iterations,
          multiline,
          animate: Boolean(animate && !reduced),
          animationDuration: 520,
        });
        annotation.show();
      })
      .catch(() => {
        /* Keep plain semantic text if dynamic import fails in restricted runtimes. */
      });

    return () => {
      cancelled = true;
      try {
        annotation?.remove?.();
      } catch {
        /* Ignore cleanup errors if element already detached. */
      }
      annotation = null;
    };
  }, [active, animate, iterations, minimal, multiline, padding, strokeWidth, themeTick, tone, type]);

  if (minimal) return children ?? null;

  return (
    <span className={cx('sh-ink-mark-host', className)}>
      <span ref={targetRef} className="sh-ink-mark" data-ink-type={type} data-ink-tone={tone}>
        {children}
      </span>
    </span>
  );
}
