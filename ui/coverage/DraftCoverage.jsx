import React from 'react';
import { ui } from '../i18n.js';
import { Hint } from '../components/index.js';
import { CoverageSummary } from './Coverage.jsx';
import { CoverageTopUp } from './CoverageTopUp.jsx';
import MaterialsReport from './MaterialsReport.jsx';
import RunPanel from './RunPanel.jsx';
import { draftShortfall } from './use-shortfall.js';
import { useStudy } from '../study-context.jsx';

/* What the draft page says about the coverage of its draft, in one place: the fact line and the bar with the one sentence of the plan (ui/coverage/Coverage.jsx CoverageFact), the materials that got no
   question, the run (rounds, tokens, why it stopped, 自动补到完整) and the one top-up. Nothing here writes the coverage figure a second time (#663); the plan and the way the rounds were split are in
   the page's 生成详情. `view` is `coverage.get`'s answer (the page draws this only once it has it). */
export default function DraftCoverage({ draft, view, jobs = [], held = false, unsaved = false, work = null, modelReady = true, saveThen, onTopUp, onOpenSource }) {
  const { busy } = useStudy();
  if (!view) return null;
  const shortfall = draftShortfall(draft, { view, jobs }), materials = view.status === 'ok' ? view.materials : null;
  return <CoverageSummary coverage={view.coverage} focus={view.focus} shortfall={shortfall} onOpen={onOpenSource ? (section) => onOpenSource(section.sourceId, section.start) : undefined}
    lead={<MaterialsReport report={materials} disabled={busy || !!work || held || !modelReady} onTopUp={(keys) => onTopUp(draft, keys, { manual: true })} />}>
    <RunPanel draft={draft} view={view} jobs={jobs} held={held} saveThen={unsaved ? saveThen : undefined} modelReady={modelReady} onOpenSource={onOpenSource} />
    <CoverageTopUp draft={draft} view={view} jobs={jobs} held={held} modelReady={modelReady} onTopUp={onTopUp} />
    {!work && (unsaved || held) && view.canTopUp && view.round?.sections > 0 && <Hint as="small">{held ? ui('草稿已在后台更新，先载入最新草稿，再补题。') : ui('补题前会先保存草稿。')}</Hint>}
  </CoverageSummary>;
}
