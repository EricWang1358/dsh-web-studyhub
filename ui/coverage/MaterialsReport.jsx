import React from 'react';
import { ui } from '../i18n.js';
import { Button } from '../components/index.js';
import { useInjectCss } from '../shared.js';
import css from './coverage.css';
import { materialReasonText, materialsReportLine, materialTopUpLabel, missingSourcesLine, raisedLine } from './copy.js';

/* The materials of a draft (flow A, the owner's 2026-10-11 report): ONE line on top, 「选了 8 份，7 份已出题，1 份没出题」, read live from the draft's coverage (`coverage.get`'s `materials`,
   lib/coverage-materials.js materialReport), then each material without a question with its reason and its own 补题 (the sections of it that have none, fitted to one round: the same
   top-up the page offers for the uncovered sections, run as a fill round of its own). Nothing is drawn for a draft of one material that has its questions. */
export default function MaterialsReport({ report, disabled = false, onTopUp }) {
  useInjectCss(css, 'study-coverage');
  if (!report?.selected || (report.selected < 2 && !report.missing && !report.raised && !report.missingSources)) return null;
  return (
    <div className="cov-materials" data-materials-report data-missing={report.missing}>
      <p className="cov-materials__head" role="status">{materialsReportLine(report)}</p>
      {report.raised && <p className="cov-materials__note" data-materials-raised>{raisedLine(report.raised)}</p>}
      {report.missingSources > 0 && <p className="cov-materials__note" data-materials-missing-sources>{missingSourcesLine(report.missingSources)}</p>}
      {report.rows?.length > 0 && <ul className="cov-materials__list">
        {report.rows.map((row) => <li key={row.key} className="cov-materials__row" data-material={row.key} data-reason={row.reason}>
          <span className="cov-materials__name">{row.title || ui('未命名资料')}</span>
          <small className="cov-materials__why">{materialReasonText(row)}</small>
          {row.topUp && onTopUp && <Button size="sm" variant="quiet" className="cov-materials__act" disabled={disabled} data-material-topup={row.key}
            onClick={() => onTopUp(row.topUp.keys)}>{materialTopUpLabel(row.topUp)}</Button>}
        </li>)}
      </ul>}
      {report.more > 0 && <p className="cov-materials__note">{ui('还有更多没出题的资料，补完上面的再看。')}</p>}
    </div>
  );
}
