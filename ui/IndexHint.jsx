import React, { useState } from 'react';
import { ui } from './i18n.js';
import { useInjectCss } from './shared.js';
import { Button, Icon, Tooltip } from './components/index.js';
import { useStudy } from './study-context.jsx';
import useIndexCoverage from './use-index-coverage.js';
import { indexGoLabel, indexWhyLine, indexWhyTip } from './index-scope.js';
import { goIndex, indexHintFor, indexHinted, markIndexHinted, INDEX_HINT_PAGES } from './index-hint.js';
import css from './index-hint.css';

/* One quiet hint for a book of 150 pages or more that has no search index yet, wherever the learner is about to do something whole-book: ask 深度定制 about it,
   or generate from it. It says what to do and why (the index runs on this computer, costs no tokens, and then a whole-book run reads only the relevant
   pages) and its button opens 设置 › 检索扩展 with the book's course chosen. It is made once per document (dismissing it or pressing the button counts),
   and says nothing for an indexed or short book, or when the coverage is not known. The hover has the fuller facts. */

/** The state both forms share: the book to name (or null), the coverage read only when there is a book long enough, and the two ways to be done with it. */
function useIndexHintState({ docs, onOpenSettings, initialCoverage, hidden }) {
  const { call } = useStudy();
  const [used, setUsed] = useState(() => new Set());
  const open = (docs || []).filter(doc => !used.has(doc.key));
  const wanted = !hidden && typeof onOpenSettings === 'function' && open.some(doc => doc.pages >= INDEX_HINT_PAGES && !indexHinted(doc.key));
  const [live] = useIndexCoverage(call, { enabled: wanted && initialCoverage === undefined });
  const hint = wanted ? indexHintFor(open, initialCoverage ?? live) : null;
  const done = () => setUsed(current => new Set(current).add(hint.doc.key));
  return { hint, go: () => { goIndex(onOpenSettings, hint); done(); }, dismiss: () => { markIndexHinted(hint.doc.key); done(); } };
}

/**
 * Props: docs ([{ key, sourceIds, pages, courses }], ui/index-hint.js hintDocOf), onOpenSettings (the page's own: (section) => …; without it nothing is offered),
 * variant ('line': the sentence with 建立索引 and 知道了 | 'link': only the quiet button, its hover has the sentence; for a row that has other links),
 * hidden (the page already says it elsewhere), initialCoverage (previews and tests; else read from the host).
 */
export default function IndexHint({ docs, onOpenSettings, initialCoverage, hidden = false, variant = 'line', className }) {
  useInjectCss(css, 'study-index-hint');
  const { hint, go, dismiss } = useIndexHintState({ docs, onOpenSettings, initialCoverage, hidden });
  if (!hint) return null;
  const text = [indexWhyLine(), ...indexWhyTip()].join('\n');
  if (variant === 'link') return (
    <Tooltip layer content={text}><Button variant="link" size="sm" data-index-hint onClick={go}>{linkLabel(hint.canIndex)}</Button></Tooltip>
  );
  return (
    <p className={`index-hint${className ? ` ${className}` : ''}`} role="status" data-index-hint>
      <Icon name="info" size={14} className="index-hint__icon" />
      <Tooltip layer anchorClassName="index-hint__tip" content={indexWhyTip().join('\n')}><span tabIndex={0}>{indexWhyLine()}</span></Tooltip>
      <Button variant="link" size="sm" onClick={go}>{indexGoLabel(hint.canIndex)}</Button>
      <Button variant="quiet" size="sm" onClick={dismiss}>{ui('知道了')}</Button>
    </p>
  );
}

const linkLabel = canIndex => (canIndex === false ? ui('先安装检索扩展') : ui('先建立检索索引'));

/** The same hint as one quiet link of a card's `links` ([{ label, tip, aria, run }], ui/tasks/CompactJobCard.jsx), or null when there is nothing to say. */
export function useIndexLink({ docs, onOpenSettings, initialCoverage }) {
  const { hint, go } = useIndexHintState({ docs, onOpenSettings, initialCoverage, hidden: false });
  if (!hint) return null;
  const label = linkLabel(hint.canIndex);
  return { label, tip: [indexWhyLine(), ...indexWhyTip()].join('\n'), aria: label, run: go };
}
