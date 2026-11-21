import React from 'react';
import { ui } from '../i18n.js';
import { Badge, Button, Disclosure, HelpTip, Tooltip } from '../components/index.js';
import { useInjectCss } from '../shared.js';
import { TokenEstimate } from '../TokenUsage.jsx';
import { useStudy } from '../study-context.jsx';
import css from './point-gaps.css';
import { moreLine, noTextLine, plannedHoldLine, pointsLine, pointsListLabel, pointsNotice, pointsTip, prereqMark, prereqTip, restsOnLine, topUpLabel, topUpPlan,
  unavailableLine, unplacedLine } from './point-words.js';

/* 知识点查缺 on the draft page, next to the coverage of its sections (ui/coverage/DraftCoverage.jsx): ONE line, 「70 个知识点，17 个还没有题」, the uncovered points
   in a fold (the ones others rest on first, marked 前置), and ONE action, 「补这些知识点」, the same top-up as the page's other ones (estimate first, the draft's own
   way of writing, a fill round of its own), offered only where the draft can be topped up (`onTopUp`: the page passes it for a draft that can) and while no
   round of its plan is still to run (`report.hold`, one quiet line). With an outline that cannot be counted by, one quiet line says why and where to fix it;
   with no outline, nothing. `report` is `coverage.get`'s `points`
   (lib/evidence/point-report.js draftPointReport). The draft page loads this file on its own (deferredView): it reaches nothing in lib/, so the workspace's first
   load does not carry it (tests/workspace-closure-pages.test.mjs). */
export default function PointGaps({ draft, report, disabled = false, modelReady = true, onTopUp }) {
  useInjectCss(css, 'study-point-gaps');
  const { call } = useStudy();
  if (!draft || !report) return null;
  if (report.status !== 'ok') {
    const line = unavailableLine(report.reason);
    return line ? <p className="cov-points__quiet" data-points-unavailable={report.reason}>{line}</p> : null;
  }
  if (!report.points) return null;
  const topUp = report.topUp;
  return <div className="cov-points" data-point-gaps data-uncovered={report.uncovered}>
    <p className="cov-points__head" role="status">
      <span>{pointsLine(report)}</span>
      <HelpTip label={ui('知识点是怎么算的')}>{pointsTip()}{report.unplaced > 0 ? ` ${unplacedLine(report.unplaced)}` : ''}</HelpTip>
    </p>
    {report.uncovered > 0 && <Disclosure summary={pointsListLabel()} meta={report.uncovered} className="cov-points__fold" data-points-list>
      <ul className="cov-points__list">
        {report.list.map((point) => <li key={point.id} className="cov-points__row" data-point={point.id} data-coverable={point.coverable}>
          <span className="cov-points__name">{point.title}</span>
          {point.dependents > 0 && <Tooltip layer content={prereqTip(point)}><Badge tone="neutral" size="sm" tabIndex={0} data-point-prereq>{prereqMark()}</Badge></Tooltip>}
          {point.prereqs.length > 0 && <small className="cov-points__why">{restsOnLine(point)}</small>}
          {!point.coverable && <small className="cov-points__why" data-point-no-text>{noTextLine()}</small>}
        </li>)}
      </ul>
      {report.more > 0 && <p className="cov-points__note">{moreLine(report.more)}</p>}
    </Disclosure>}
    {report.hold === 'planned-rounds' && onTopUp && report.uncovered > 0 && <p className="cov-points__quiet" data-points-held>{plannedHoldLine()}</p>}
    {topUp && onTopUp && <div className="cov-points__act">
      <small className="cov-points__plan" data-points-plan>{topUpPlan(topUp, report.uncovered - report.uncoverable)}</small>
      <Button size="sm" variant="secondary" disabled={disabled} data-points-topup
        onClick={() => onTopUp(draft, null, { pointIds: topUp.pointIds, notice: pointsNotice(topUp.pointIds.length) })}>{topUpLabel()}</Button>
      {modelReady && call && <TokenEstimate enabled align="end" request={{ feature: 'generate', resumeDraftId: draft.id, draftVersion: draft.draftVersion, coverage: { pointIds: topUp.pointIds } }} />}
    </div>}
  </div>;
}
