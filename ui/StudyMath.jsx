import React from 'react';
import { createFormulaQueue } from './formula-queue.js';

let loading;
const loadRenderer = () => loading ||= import('./study-math-render.js');
/** Formulas below the first screen (an answer or an explanation full of them) are drawn a few per frame, in the order they appear. */
const later = createFormulaQueue();
const onFirstScreen = node => node.getBoundingClientRect().top < (globalThis.innerHeight || Infinity);

export default React.memo(function StudyMath({ formula }) {
  const [renderer, setRenderer] = React.useState(null), [due, setDue] = React.useState(false), box = React.useRef(null);
  React.useEffect(() => {
    let active = true;
    loadRenderer().then(module => { if (active) setRenderer(() => module.renderStudyFormula); }).catch(() => {});
    return () => { active = false; };
  }, []);
  React.useLayoutEffect(() => {
    if (!renderer || due) return undefined;
    if (!box.current || onFirstScreen(box.current)) { setDue(true); return undefined; }
    return later.add(box.current, () => setDue(true));
  }, [renderer, due]);
  const html = React.useMemo(() => due ? renderer?.(formula.source, formula.display) : null, [due, renderer, formula.source, formula.display]);
  return <span ref={box} className={'md-math' + (formula.display ? ' md-math-display' : '')}
    tabIndex={formula.display ? 0 : undefined} onKeyDown={event => event.stopPropagation()}>
    {html ? <span className="md-math-content" dangerouslySetInnerHTML={{ __html: html }} /> : <span className="md-math-source">{formula.raw}</span>}
  </span>;
});
