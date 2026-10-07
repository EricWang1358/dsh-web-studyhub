import React from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button } from '../components/index.js';
import { useInjectCss } from '../shared.js';
import css from './coverage.css';
import { repeatingExplain } from './copy.js';

/* The explanation under 「这几个小节反复失败」, closed until asked for (the console and the draft page say the facts in a line; the reason lives here): for each failing section what happened, with the numbers the run
   recorded (ui/coverage/copy.js repeatingExplain), why, and what the learner can do. The controls are the ones the app has: the section in the reader (where 看原页 is), and the generation preferences.
   They are offered only when the host that renders this can open them, so no button does nothing. */
export default function RepeatingExplain({ shortfall, onOpenSource, onOpenSettings, max = 3 }) {
  useInjectCss(css, 'study-coverage');
  const { items, advice, needs } = repeatingExplain(shortfall);
  if (!items.length) return null;
  const pages = onOpenSource ? items.filter((item) => item.sourceId).slice(0, max) : [], planning = !!onOpenSettings && needs.includes('plan');
  return (
    <details className="cov-why" data-repeating-explain>
      <summary>{ui('为什么、怎么办')}</summary>
      <ul className="cov-why__list">
        {items.map((item) => <li key={item.key} data-section={item.key}><span>{item.fact}</span>{item.why && <small>{item.why}</small>}</li>)}
      </ul>
      <ul className="cov-why__advice">{advice.map((line) => <li key={line}>{line}</li>)}</ul>
      {(pages.length > 0 || planning) && <div className="cov-why__acts">
        {pages.map((item) => <Button key={item.key} size="sm" variant="quiet" data-open-page={item.key} onClick={() => onOpenSource(item.sourceId, item.start)}>{uiFormat('在资料里打开 · {0}', [item.name])}</Button>)}
        {planning && <Button size="sm" variant="quiet" data-open-settings="settings-generation" onClick={() => onOpenSettings('settings-generation')}>{ui('去设置 › 出题偏好')}</Button>}
      </div>}
    </details>
  );
}
