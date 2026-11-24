import React from 'react';
import { ui } from './i18n.js';
import { Button } from './components/Button.jsx';
import { useCopyFeedback } from './use-copy-feedback.js';

let loading = null;
let cachedRenderer = null;
const svgCache = new Map();
const MAX_SVG_CACHE = 200;

const loadRenderer = () => (loading ||= import('./study-diagram-render.js').then((module) => {
  cachedRenderer = module.renderStudyDiagram;
  return cachedRenderer;
}));

function renderCached(renderer, source) {
  if (!renderer || typeof source !== 'string') return null;
  if (svgCache.has(source)) return svgCache.get(source);
  const result = renderer(source);
  if (svgCache.size >= MAX_SVG_CACHE) svgCache.delete(svgCache.keys().next().value);
  svgCache.set(source, result);
  return result;
}

/** Pre-warm the diagram renderer chunk (mirrors warmStudyMathRenderer for tests and smooth first paint). */
export const warmStudyDiagramRenderer = () => loadRenderer();

/** Test helper: reset module-level diagram caches between unit tests. */
export function resetStudyDiagramCacheForTests() {
  loading = null;
  cachedRenderer = null;
  svgCache.clear();
}

const KIND_LABELS = {
  flowchart: () => ui('流程图'),
  sequence: () => ui('时序图'),
  state: () => ui('状态图'),
};

export default React.memo(function StudyDiagram({ content, interactive = true, fallback }) {
  const [renderer, setRenderer] = React.useState(() => cachedRenderer);
  const [showSource, setShowSource] = React.useState(false);
  const { copied, copy } = useCopyFeedback(() => content);

  React.useEffect(() => {
    if (renderer) return undefined;
    let active = true;
    loadRenderer().then((fn) => {
      if (active && fn) setRenderer(() => fn);
    }).catch(() => {});
    return () => { active = false; };
  }, [renderer]);

  const result = React.useMemo(() => {
    if (!renderer) return null;
    return renderCached(renderer, content);
  }, [renderer, content]);

  // While the lazy chunk loads, or when syntax is invalid/unsupported, show the standard code block without errors or blank space.
  if (!result) return fallback;

  const kindLabel = KIND_LABELS[result.kind]?.() ?? ui('示意图');
  const toggleLabel = showSource ? ui('查看图示') : ui('查看源码');

  return (
    <figure className="md-diagram" data-diagram-kind={result.kind}>
      {interactive && (
        <div className="md-diagram-head">
          <span className="md-diagram-label">{kindLabel}</span>
          <div className="md-diagram-actions">
            <Button
              size="sm"
              variant="quiet"
              aria-label={toggleLabel}
              aria-pressed={showSource}
              onClick={(event) => {
                event.stopPropagation();
                setShowSource((prev) => !prev);
              }}
            >
              {showSource ? ui('图示') : ui('源码')}
            </Button>
            <Button
              size="sm"
              variant="quiet"
              data-copied={copied ? 'true' : undefined}
              icon={copied ? 'check' : undefined}
              aria-label={copied ? ui('已复制') : ui('复制代码')}
              onClick={(event) => {
                event.stopPropagation();
                copy();
              }}
            >
              {copied ? ui('已复制') : ui('复制')}
            </Button>
          </div>
        </div>
      )}
      {showSource && interactive ? (
        <pre className="md-code md-diagram-source"><code>{content}</code></pre>
      ) : (
        <div className="md-diagram-canvas" dangerouslySetInnerHTML={{ __html: result.svg }} />
      )}
    </figure>
  );
});
