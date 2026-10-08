import { useEffect, useRef, useState } from 'react';
import { ui } from '../i18n.js';
import { importOutcome } from '../ImportHub.jsx';
import { importedReferences } from '../reference-questions.js';
import { usePageScope } from '../PageScope.jsx';
import { importHandoff } from './import-handoff.js';

/* Adding materials: the one entry (ImportHub) for the 添加资料 dialog and the empty Sources page. What the learner typed into
   the paste box and which courses are ticked survive closing the dialog; what an import leads to (a draft, the sources page, a
   highlight, an offer to make questions) is decided here. */
export function useSourceImport({ core, lib, nav, drafts, intents, data }) {
  const { notify } = core;
  const { setModal, setGen, setSelectedSources, setSourceHighlight } = lib.set;
  const modal = lib.state.modal;
  const [sourceCourses, setSourceCourses] = usePageScope(data?.root, 'text-import-courses', data?.focus?.course || '');
  const [paste, setPaste] = useState({ title: '', text: '' });
  const latest = useRef(null);
  latest.current = { page: nav.page, modal };
  // A dialog opened for one course keeps its own course choice; otherwise the page-wide one applies.
  const ownCourse = modal?.type === 'add' && modal.course !== undefined;
  const formCourse = ownCourse ? modal.course : sourceCourses;
  const changeFormCourse = (course) => (ownCourse ? setModal((current) => ({ ...current, course })) : setSourceCourses(course));
  useEffect(() => { if (nav.page !== 'sources') setSourceHighlight(null); }, [nav.page, setSourceHighlight]);
  const generateFromSources = (ids) => intents.goGenerate({ sourceIds: ids, remember: true });

  function finishImport(summary) {
    const { page, modal: open } = latest.current;
    const handoff = importHandoff(open, summary);
    if (handoff) {
      const { ids } = handoff;
      if (handoff.call) handoff.call(ids);
      else if (handoff.reference) {
        setGen((current) => ({ ...current, referenceSourceIds: importedReferences(current.referenceSourceIds, ids).referenceSourceIds }));
        setSelectedSources((current) => importedReferences([], ids, current).sourceIds);
      }
      setModal(null);
      notify(handoff.notice);
      return;
    }
    const outcome = importOutcome(summary, { page });
    setModal(null);
    if (!outcome) return;
    if (outcome.select?.length) setSelectedSources((current) => [...new Set([...current, ...outcome.select])]);
    if (outcome.openDraft) drafts.openDraft(outcome.openDraft);
    else if (outcome.page && outcome.page !== page) nav.show.page(outcome.page);
    if (outcome.highlight) setSourceHighlight({ ids: outcome.highlight, at: Date.now() });
    const ids = outcome.highlight;
    notify({ text: outcome.notice.text, tone: outcome.notice.tone,
      ...(outcome.notice.action === 'generate' ? { action: { label: ui('用它出题'), run: () => generateFromSources(ids) } } : {}) });
  }
  return { paste, setPaste, formCourse, changeFormCourse, finishImport, generateFromSources };
}
