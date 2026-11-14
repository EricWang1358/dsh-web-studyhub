import React from 'react';
import { ui } from './i18n.js';
import { Button } from './components/Button.jsx';
import { useCopyFeedback } from './use-copy-feedback.js';
import { createFormulaWatch } from './formula-queue.js';

let loading;
const loadRenderer = () => loading ||= import('./study-math-render.js');
let page = null;
/** The formulas outside the reader's column (questions, answers, notes, the book) are drawn as they come near the screen, through the page's one queue. */
const pageWatch = () => page ||= createFormulaWatch(() => null);

export default React.memo(function StudyMath({ formula, copyable = false }) {
  const [renderer, setRenderer] = React.useState(null), [due, setDue] = React.useState(false), box = React.useRef(null);
  const texSource = typeof formula?.source === 'string' ? formula.source.trim() : '';
  const canCopy = Boolean(formula?.display && copyable && texSource);
  const { copied, copy } = useCopyFeedback(() => texSource);
  React.useEffect(() => {
    let active = true;
    loadRenderer().then(module => { if (active) setRenderer(() => module.renderStudyFormula); }).catch(() => {});
    return () => { active = false; };
  }, []);
  React.useEffect(() => {
    if (!renderer || due || !box.current) return undefined;
    return pageWatch().observe(box.current, () => setDue(true));
  }, [renderer, due]);
  const html = React.useMemo(() => due ? renderer?.(formula.source, formula.display) : null, [due, renderer, formula.source, formula.display]);
  return <span ref={box} className={'md-math' + (formula.display ? ' md-math-display' : '')}
    tabIndex={formula.display ? 0 : undefined} onKeyDown={event => event.stopPropagation()}>
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
});
