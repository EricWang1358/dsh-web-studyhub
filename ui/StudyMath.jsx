import React from 'react';

let loading;
const loadRenderer = () => loading ||= import('./study-math-render.js');

export default React.memo(function StudyMath({ formula }) {
  const [renderer, setRenderer] = React.useState(null);
  React.useEffect(() => {
    let active = true;
    loadRenderer().then(module => { if (active) setRenderer(() => module.renderStudyFormula); }).catch(() => {});
    return () => { active = false; };
  }, []);
  const html = React.useMemo(() => renderer?.(formula.source, formula.display), [renderer, formula.source, formula.display]);
  return <span className={'md-math' + (formula.display ? ' md-math-display' : '')}
    tabIndex={formula.display ? 0 : undefined} onKeyDown={event => event.stopPropagation()}>
    {html ? <span className="md-math-content" dangerouslySetInnerHTML={{ __html: html }} /> : <span className="md-math-source">{formula.raw}</span>}
  </span>;
});
