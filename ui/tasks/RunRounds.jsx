import React, { useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button } from '../components/index.js';
import { joinMeta } from '../format.js';
import { roundResult, roundStatusWord, roundTitle, sectionName, stateWord } from '../coverage/copy.js';

/* The rounds of a coverage run (lib/coverage-run.js), at the top of 轮次与批次: one row per round with its state, what it asked for and, once it has run, what it kept, how many sections it newly covered and what it cost.
   A row opens to the sections of that round, each with its coverage now. The rounds come from the job's own copy of the run (the contract's detail.run); the sections of a round are on the draft (its plan,
   `editorial.coverageSpec.rounds[i].sectionIds`) and their coverage is `coverage.get`'s. */

const DOT = { pending: 'queued', running: 'run', done: 'done', failed: 'fail', skipped: 'stopped' };

/** The sections a round holds, by name and state: [{ key, name, state }], from the draft's plan and the coverage view. */
export function sectionsOfRound(draft, round, coverage) {
  const keys = draft?.editorial?.coverageSpec?.rounds?.[round.index ?? round.round - 1]?.sectionIds || [], byKey = new Map((coverage?.sections || []).map((section) => [section.key, section]));
  // Five recordings have a 「第二部分」 each: the name says which recording it is in.
  const named = (section) => (section.recording != null ? uiFormat('录音 {0} · {1}', [section.recording, sectionName(section)]) : sectionName(section));
  return keys.map((key) => { const section = byKey.get(key); return { key, name: section ? named(section) : key.split('#').pop(), state: section?.state || 'never-planned', scheduled: !!section?.scheduled, recorded: coverage?.recorded !== false }; });
}

export default function RunRounds({ run, draft, coverage }) {
  const list = run?.list || [], [open, setOpen] = useState(null);
  if (!list.length) return null;
  return (
    <div className="tc-rounds" data-run-rounds aria-label={ui('出题计划的轮次')}>
      <p className="tc-rounds__head">{ui('出题计划的轮次')}<small>{uiFormat('{0}/{1} 轮已完成', [run.done, run.total])}</small></p>
      <ol className="tc-rounds__list">
        {list.map((round, index) => {
          const sections = open === index ? sectionsOfRound(draft, { ...round, index }, coverage) : [];
          return (
            <li key={index} data-round={round.round} data-status={round.status}>
              <Button variant="quiet" block className="tc-round" aria-expanded={open === index} onClick={() => setOpen(open === index ? null : index)}>
                <span className="tc-dot" data-state={DOT[round.status] || 'queued'} aria-hidden="true" />
                <span className="tc-round__name">{roundTitle(round)}<span className="tc-round__result">{roundResult(round)}</span></span>
                <span className="tc-num" data-round-status={round.status}>{roundStatusWord(round.status)}</span>
              </Button>
              {open === index && <ul className="tc-round__sections">
                {sections.length === 0 && <li className="tc-empty">{ui('这一轮的小节在草稿保存后才能查看。')}</li>}
                {sections.map((section) => <li key={section.key} data-state={section.state}><span>{section.name}</span><small>{joinMeta([section.state !== 'covered' && ['done', 'failed'].includes(round.status) ? ui('这一轮没出成题') : stateWord(section.state, section.recorded, section.scheduled)])}</small></li>)}
              </ul>}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
