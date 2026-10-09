import React from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Tooltip } from '../components/index.js';
import { TERMS } from '../mastery-terms.js';
import { masteryText } from '../document-preview/practice/mastery-copy.js';
import { runContextOf } from './run-context.js';

/** One figure of the line: its label (本章 / 整课程) and the words the lists use for the same questions; the hover says what it counts. */
function Part({ label, summary, hint }) {
  return (
    <Tooltip layer content={`${hint}\n${ui(TERMS.mastery.hint)}`}>
      <span className="review-context__part" tabIndex={0}><span className="review-context__label">{label}</span> {masteryText(summary)}</span>
    </Tooltip>
  );
}

/** The quiet line under a practice page's title: the course of the question on screen, how its chapter stands and how the whole course stands. */
export default function RunContext({ data, deckId }) {
  const context = React.useMemo(() => runContextOf(data, deckId), [data?.decks, data?.progress, data?.focus, deckId]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!context) return null;
  const name = context.course || ui('未分类课程');
  return (
    <span className="review-context" data-review-context>
      <span className="review-context__course">{name}</span>
      <Part label={ui('本章')} summary={context.chapter} hint={ui('这道题所在的题组，课程里的一章。')} />
      {context.whole && <Part label={ui('整课程')} summary={context.whole} hint={uiFormat('「{0}」里所有题组合计（含子课程）。', [name])} />}
    </span>
  );
}
