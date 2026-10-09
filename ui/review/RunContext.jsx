import React from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Tooltip } from '../components/index.js';
import { TERMS } from '../mastery-terms.js';
import { masteryText } from '../document-preview/practice/mastery-copy.js';
import { runContextOf, runDeckIds } from './run-context.js';

/** One figure of the line: its label (本章 / 整课程) and the words the lists use for the same questions; the hover says what it counts. */
function Part({ label, summary, hint }) {
  return (
    <Tooltip layer content={`${hint}\n${ui(TERMS.mastery.hint)}`}>
      <span className="review-context__part" tabIndex={0}><span className="review-context__label">{label}</span> {masteryText(summary)}</span>
    </Tooltip>
  );
}

/** The quiet line under a practice page's title: the course of the question on screen (+N when the run carries questions of other courses too), how its
 *  chapter stands and how the whole course stands. */
export default function RunContext({ data, deckId, run }) {
  const context = React.useMemo(() => runContextOf(data, deckId, runDeckIds(run)), [data?.decks, data?.progress, data?.focus, deckId, run?.navigation, run?.scope]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!context) return null;
  const name = context.course || ui('未分类课程');
  const courseName = <span className="review-context__course">{name}</span>;
  return (
    <span className="review-context" data-review-context>
      {context.also.length ? (
        <span className="review-context__where">
          {courseName}
          <Tooltip layer content={uiFormat('这一轮还有：{0}', [context.also.map((other) => other || ui('未分类课程')).join(ui('、'))])}>
            <span className="review-context__more" tabIndex={0}>{`+${context.also.length}`}</span>
          </Tooltip>
        </span>
      ) : courseName}
      <Part label={ui('本章')} summary={context.chapter} hint={ui('这道题所在的题组，课程里的一章。')} />
      {context.whole && <Part label={ui('整课程')} summary={context.whole} hint={uiFormat('「{0}」里所有题组合计（含子课程）。', [name])} />}
    </span>
  );
}
