import React from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button, Disclosure, StackedBar, Tooltip } from '../components/index.js';
import { useInjectCss } from '../shared.js';
import { coverageFromDigest } from '../../lib/coverage.js';
import css from './coverage.css';
import { countOf, coverageChipText, coverageLine, planLine, sectionName, stateMeaning, stateWord, reasonWord, uncoveredHead, weightLine } from './copy.js';

/* 覆盖 on screen: the bar, the mark beside an outline entry, the chip beside the mastery mark and the summary of a draft. They are drawn from lib/coverage.js's result
   (`coverage.get`, the snapshot's materialCoverage) and say it in ui/coverage/copy.js, so every screen shows the same numbers in the same words. */

/* A SQUARE with sharp corners, so that at the size of a line of text it cannot be taken for the round mastery ring beside it. */
const SQUARE = <rect x="2.4" y="2.4" width="11.2" height="11.2" rx="1" fill="none" stroke="currentColor" strokeWidth="1.5" />;
const SHAPES = {
  covered: <><rect x="1.8" y="1.8" width="12.4" height="12.4" rx="1.2" fill="currentColor" /><path d="m4.8 8.2 2.2 2.2 4.2-4.4" fill="none" stroke="var(--cov-ink, var(--bg-surface))" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></>,
  'planned-failed': <>{SQUARE}<path d="M4.4 10.6 10.6 4.4M7.4 12 12 7.4M3.8 7.6 7.6 3.8" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></>,
  'never-planned': SQUARE,
};

/** The segments of a coverage as a stacked bar sees them. */
export const coverageSegments = (c) => {
  const scheduled = Math.min(c.scheduled || 0, c.neverPlanned || 0);
  return [
    { value: c.covered, tone: 'info', label: stateWord('covered') },
    { value: c.plannedFailed, tone: 'warning', label: stateWord('planned-failed') },
    ...(scheduled > 0 ? [{ value: scheduled, tone: 'neutral', label: stateWord('never-planned', true, true) }] : []),
    { value: c.neverPlanned - scheduled, tone: 'neutral', label: stateWord('never-planned', c.recorded !== false) },
  ];
};

/** The bar of a coverage: covered, planned and failed, never planned. `legend` writes the three words under it. */
export function CoverageBar({ coverage, legend = false, size = 'md', className = '' }) {
  useInjectCss(css, 'study-coverage');
  if (!coverage?.leaves) return null;
  const line = coverageLine(coverage);
  return <StackedBar className={`cov-bar ${className}`.trim()} segments={coverageSegments(coverage)} name={line} legend={legend} size={size === 'lg' ? 'lg' : 'md'} data-coverage-bar />;
}

/**
 * The state of one section as a small square (shape first: solid with a tick · hatched · dashed and empty), with its words in the accessible name and the tooltip.
 * `title` is what the section is called; `reason` the failure code of a planned-and-failed one.
 */
export function CoverageMark({ state = 'never-planned', title = '', reason, recorded = true, scheduled = false, size = 13, className = '' }) {
  useInjectCss(css, 'study-coverage');
  const word = state === 'planned-failed' && reason ? uiFormat('{0}：{1}', [stateWord(state), reasonWord(reason)]) : stateWord(state, recorded, scheduled), meaning = stateMeaning(state, recorded, scheduled);
  const name = title ? uiFormat('{0}：{1}', [title, word]) : word;
  return <Tooltip layer placement="left-start" content={<span className="cov-mark__tip"><strong>{word}</strong><span>{meaning}</span></span>}>
    <span className={`cov-mark ${className}`.trim()} data-state={state} data-coverage-mark={state} role="img" aria-label={name}>
      <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true" focusable="false">{SHAPES[state] || SHAPES['never-planned']}</svg>
    </span>
  </Tooltip>;
}

/** 「覆盖 9%」 with a small bar: the chip beside the mastery mark of a material row and the reader's toolbar. `coverage` is a coverage, or the digest the snapshot keeps per document (lib/coverage.js coverageDigest). */
export function CoverageChip({ coverage: given, className = '' }) {
  useInjectCss(css, 'study-coverage');
  const coverage = Array.isArray(given) ? coverageFromDigest(given) : given;
  if (!coverage?.leaves) return null;
  const covered = coverage.covered / coverage.leaves * 100, failed = coverage.plannedFailed / coverage.leaves * 100;
  return <Tooltip layer content={<span className="cov-mark__tip"><strong>{coverageLine(coverage)}</strong><span>{ui('覆盖说的是出没出过题；掌握度说的是你答得怎么样。')}</span></span>}>
    <span className={`cov-meter ${className}`.trim()} data-coverage-chip data-state={coverage.covered ? 'some' : 'none'}>
      <span className="cov-meter__bar" aria-hidden="true"><i style={{ width: `${covered}%` }} />{failed > 0 && <i style={{ width: `${failed}%` }} />}</span>
      <span>{coverageChipText(coverage)}</span>
    </span>
  </Tooltip>;
}

/** What a group (a recording, a chapter) is called in the per-recording rows. */
function groupName(group) {
  if (group.recording != null) return group.title ? uiFormat('录音 {0} · {1}', [group.recording, group.title]) : uiFormat('录音 {0}', [group.recording]);
  return group.title || ui('（无标题）');
}

/** The sections without a question, in reading order, each with its state and, when it has one, the reason; the way to the reader is `onOpen(section)`. */
function UncoveredList({ coverage, onOpen }) {
  const open = coverage.sections.filter((section) => section.state !== 'covered');
  const names = new Map((coverage.groups || []).filter((group) => group.recording != null).map((group) => [group.recording, group]));
  if (!open.length) return null;
  return <Disclosure className="cov-list-wrap" summary={uncoveredHead(coverage.units, open.length)} data-coverage-list>
    <ul className="cov-list">
      {open.map((section) => {
        const group = section.recording != null ? names.get(section.recording) : null;
        return <li key={section.key} data-section={section.key} data-state={section.state}>
          <CoverageMark state={section.state} reason={section.reason} recorded={coverage.recorded} scheduled={!!section.scheduled} title={sectionName(section)} />
          <span className="cov-list__name">{sectionName(section)}
            <small>{[group && uiFormat('录音 {0}', [group.recording]), section.state === 'planned-failed' ? uiFormat('计划了没出成：{0}', [reasonWord(section.reason)]) : stateWord(section.state, coverage.recorded, !!section.scheduled)].filter(Boolean).join(' · ')}</small>
            {section.weight && <small className="cov-list__why" data-section-why>{weightLine(section.weight)}</small>}
          </span>
          {onOpen && <Button size="sm" variant="quiet" className="cov-list__open" onClick={() => onOpen(section)} data-section-open={section.key}>{ui('在资料中查看')}</Button>}
        </li>;
      })}
    </ul>
  </Disclosure>;
}

/**
 * The summary at the top of a draft: 「覆盖 7/80 个部分（9%）· 3 个计划了没出成 · 70 个没计划到」, the bar, one row per recording (or chapter) and the list of what has no
 * question with the way to open the reader at it (`onOpen(section)`, the app's openSourceAt at the section's start). `children` is the one top-up. `coverage` is `coverage.get`'s coverage.
 */
export function CoverageSummary({ coverage, onOpen, children, className = '' }) {
  useInjectCss(css, 'study-coverage');
  if (!coverage?.leaves) return null;
  return <section className={`cov-summary ${className}`.trim()} aria-label={ui('这份草稿对资料的覆盖')} data-coverage-summary>
    <p className="cov-summary__kicker">{ui('覆盖')}</p>
    <p className="cov-summary__line" data-coverage-line>{coverageLine(coverage)}</p>
    {coverage.spec && <p className="cov-summary__plan" data-coverage-plan>{planLine(coverage.spec)}</p>}
    <CoverageBar coverage={coverage} legend />
    {coverage.groups?.length > 1 && <ul className="cov-groups" aria-label={coverage.groups.some((group) => group.recording != null) ? ui('每段录音的覆盖') : ui('每一章的覆盖')} data-coverage-groups>
      {coverage.groups.map((group) => <li key={group.id} data-group={group.id}>
        <span className="cov-groups__name">{groupName(group)}</span>
        <StackedBar segments={coverageSegments({ ...group, recorded: coverage.recorded })} name={uiFormat('{0}：覆盖 {1}/{2}', [groupName(group), group.covered, countOf(coverage.units, group.leaves)])} />
        <span className="cov-groups__count">{`${group.covered}/${group.leaves}`}</span>
      </li>)}
    </ul>}
    <UncoveredList coverage={coverage} onOpen={onOpen} />
    {children}
  </section>;
}
