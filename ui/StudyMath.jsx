import React from 'react';
import { ui } from './i18n.js';
import { Button } from './components/Button.jsx';
import { useCopyFeedback } from './use-copy-feedback.js';
import { createFormulaWatch } from './formula-queue.js';

let loading = null;
let cachedRenderer = null;
const htmlCache = new Map();
const MAX_HTML_CACHE = 400;
const SYNC_BUDGET_PER_TICK = 8;
let syncUsed = 0;
let syncResetScheduled = false;

const loadRenderer = () => loading ||= import('./study-math-render.js').then((module) => {
  cachedRenderer = module.renderStudyFormula;
  return cachedRenderer;
});

function consumeSyncSlot() {
  if (syncUsed >= SYNC_BUDGET_PER_TICK) return false;
  syncUsed += 1;
  if (!syncResetScheduled) {
    syncResetScheduled = true;
    const reset = () => { syncUsed = 0; syncResetScheduled = false; };
    if (typeof queueMicrotask === 'function') queueMicrotask(reset);
    else Promise.resolve().then(reset);
  }
  return true;
}

const cacheKey = (source, display) => `${display ? '1' : '0'}:${source}`;

function renderCached(renderer, source, display) {
  if (!renderer || typeof source !== 'string') return null;
  const key = cacheKey(source, display);
  if (htmlCache.has(key)) return htmlCache.get(key);
  const html = renderer(source, display);
  if (htmlCache.size >= MAX_HTML_CACHE) htmlCache.delete(htmlCache.keys().next().value);
  htmlCache.set(key, html);
  return html;
}

/** Pre-warm the KaTeX chunk so subsequent card switches/flips render synchronously on frame 1. */
export const warmStudyMathRenderer = () => loadRenderer();

/** Test helper: inspect or reset module-level formula caches between unit tests. */
export function resetStudyMathCacheForTests() {
  loading = null;
  cachedRenderer = null;
  htmlCache.clear();
  syncUsed = 0;
  syncResetScheduled = false;
}

let page = null;
/** The formulas outside the reader's column (questions, answers, notes, the book) are drawn as they come near the screen, through the page's one queue. */
const pageWatch = () => page ||= createFormulaWatch(() => null);

const sameFormula = (prev, next) => (
  prev.copyable === next.copyable
  && prev.formula?.source === next.formula?.source
  && prev.formula?.display === next.formula?.display
  && prev.formula?.raw === next.formula?.raw
);

export default React.memo(function StudyMath({ formula, copyable = false }) {
  const source = formula?.source;
  const display = Boolean(formula?.display);
  const cachedHtml = typeof source === 'string' && htmlCache.has(cacheKey(source, display))
    ? htmlCache.get(cacheKey(source, display))
    : undefined;
  const [renderer, setRenderer] = React.useState(() => cachedRenderer);
  const [due, setDue] = React.useState(() => {
    if (cachedHtml !== undefined) return true;
    if (cachedRenderer && (typeof IntersectionObserver === 'undefined' || consumeSyncSlot())) return true;
    return false;
  });
  const box = React.useRef(null);
  const texSource = typeof source === 'string' ? source.trim() : '';
  const canCopy = Boolean(display && copyable && texSource);
  const { copied, copy } = useCopyFeedback(() => texSource);
  React.useEffect(() => {
    if (renderer) return undefined;
    let active = true;
    loadRenderer().then((fn) => {
      if (active && fn) setRenderer(() => fn);
    }).catch(() => {});
    return () => { active = false; };
  }, [renderer]);
  React.useEffect(() => {
    if (!renderer || due || !box.current) return undefined;
    return pageWatch().observe(box.current, () => setDue(true));
  }, [renderer, due]);
  const html = React.useMemo(() => {
    if (cachedHtml !== undefined) return cachedHtml;
    if (!due || !renderer) return null;
    return renderCached(renderer, source, display);
  }, [cachedHtml, due, renderer, source, display]);
  return <span ref={box} className={'md-math' + (display ? ' md-math-display' : '')}
    tabIndex={display ? 0 : undefined} onKeyDown={event => event.stopPropagation()}>
    {html ? <span className="md-math-content" dangerouslySetInnerHTML={{ __html: html }} /> : <span className="md-math-source">{formula.raw}</span>}
    {canCopy && <Button
      size="sm"
      variant="quiet"
      className="md-math-copy"
      data-copied={copied ? 'true' : undefined}
      icon={copied ? 'check' : undefined}
      aria-label={copied ? ui('已复制') : ui('复制公式')}
      onClick={event => { event.stopPropagation(); copy(); }}
    >{copied ? ui('已复制') : 'TeX'}</Button>}
  </span>;
}, sameFormula);
