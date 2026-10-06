import React, { useState } from 'react';
import { ui } from '../i18n.js';
import { Button, LoadingState, Popover, Select } from '../components/index.js';
import { useInjectCss } from '../shared.js';
import { TokenEstimate } from '../TokenUsage.jsx';
import { useStudy } from '../study-context.jsx';
import { isActiveJob } from '../job-visibility.js';
import { shortfallOf } from '../../lib/shortfall.js';
import { coverageFromDigest } from '../../lib/coverage.js';
import css from './coverage.css';
import { actionLabel, allCoveredText, coveragePathText, nextRoundText } from './copy.js';
import { topUpNotice } from './top-up.js';
import { useCoverage } from './use-coverage.js';
import { jobPart, partStartLine, partTitle } from '../deck-parts.js';

/* 为没覆盖的部分补题 of a material whose questions were PUBLISHED (the owner's decision of 2026-10-06): the 资料 row and the reader's outline offer it, with the same words, the same round and the same
   estimate as the top-up of a draft. It never touches the published deck: it makes a NEW draft whose targets are the document's sections without a question (lib/coverage-state.js documentTopUp),
   in rounds until it is covered (自动补到完整), and that draft becomes the deck's next part when the learner publishes it into the deck (lib/deck-parts.js). */

/**
 * Whether the button is offered, without asking anything: some section has no question (`coverage`: the snapshot's digest, or a coverage), a published deck holds the document's questions, a model is
 * ready, and no top-up of this document is running. What another draft is doing with the sections is said in the popover (the backend knows it).
 */
export function offersDocumentTopUp({ item, coverage, jobs = [], modelReady = true }) {
  const c = Array.isArray(coverage) ? coverageFromDigest(coverage) : coverage;
  if (!modelReady || !item || !(c?.leaves > 0) || c.covered >= c.leaves) return false;
  if (!(item.usedBy || []).some((ref) => ref.kind === 'deck' && !ref.archived)) return false;
  return !jobs.some((job) => isActiveJob(job) && jobPart(job)?.documentKey === item.key);
}

/** What the popover shows: the deck it will be a part of (a choice when several hold the document), the round, the way to full coverage and the estimate; then the one button. */
export function DocumentTopUpBody({ view, onStart }) {
  const { busy } = useStudy();
  const [deckId, setDeckId] = useState(null);
  const offer = view?.topUp;
  if (!offer?.canTopUp) return <div className="cov-topup cov-topup--panel" data-document-topup data-coverage-complete>
    <p className="cov-topup__done">{offer?.inFlight > 0 ? ui('没覆盖的小节正在另一份草稿里补题，请到那份草稿继续。') : allCoveredText(view?.coverage?.units)}</p>
  </div>;
  const chosen = offer.candidates.find((candidate) => candidate.id === deckId) || offer.candidates[0];
  const shortfall = shortfallOf({ coverage: view.coverage, round: offer.round });
  const args = { documentId: view.key, coverage: { sectionIds: offer.round.picks.map((pick) => pick.key), autoComplete: true }, partOf: chosen.id };
  return <div className="cov-topup cov-topup--panel" data-document-topup data-shortfall-action="topup">
    {offer.candidates.length > 1 && <Select aria-label={ui('补到哪个题组')} value={chosen.id} options={offer.candidates.map((candidate) => ({ value: candidate.id, label: candidate.title }))}
      onChange={(value) => setDeckId(value)} data-part-target />}
    <p className="cov-topup__plan" data-part-line>{partStartLine(chosen.title, chosen.nextPart)}</p>
    <p className="cov-topup__plan" data-coverage-round>{nextRoundText(shortfall)}</p>
    {coveragePathText(shortfall) && <p className="cov-topup__path" data-coverage-path>{coveragePathText(shortfall)}</p>}
    <div className="cov-topup__act">
      <Button className="cov-topup__button" variant="primary" disabled={busy} data-coverage-start title={ui('补完这一轮后自动做下一轮，直到每个小节都有题；可以随时暂停或停下。')}
        onClick={() => onStart?.(args, chosen)}>{actionLabel('topup')}</Button>
      <div className="cov-topup__estimate"><TokenEstimate enabled align="end" request={{ feature: 'generate', ...args }} /></div>
    </div>
  </div>;
}

/** The button and its popover. `item` is the document (lib/source-groups.js), `revision` the library's (the answer is asked again when it changes). */
export default function DocumentTopUp({ item, revision, size = 'sm', className = '', placement = 'bottom-end', block = false }) {
  useInjectCss(css, 'study-coverage');
  const { act, notify } = useStudy();
  const [open, setOpen] = useState(false);
  const asked = useCoverage(open && item ? { documentId: item.key } : null, { version: String(revision ?? ''), enabled: open });
  const start = (args, chosen) => { setOpen(false); act('generate', args, (started) => notify?.(topUpNotice({ title: partTitle(chosen.title, chosen.nextPart) }, started))); };
  return <Popover open={open} onOpenChange={setOpen} label={actionLabel('topup')} className={`cov-popover ${className}`.trim()} panelClassName="cov-popover__panel" placement={placement}
    trigger={({ props, ref }) => <Button ref={ref} size={size} variant="secondary" block={block} {...props} data-document-topup-open>{actionLabel('topup')}</Button>}>
    {asked.view ? <DocumentTopUpBody view={asked.view} onStart={start} /> : <LoadingState label={ui('正在读取这份资料的覆盖…')} />}
  </Popover>;
}
