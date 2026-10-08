import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { uiFormat } from '../i18n.js';
import { useToast } from '../components/index.js';
import { useStudy } from '../study-context.jsx';
import { courseNamesOf, usePageScope } from '../PageScope.jsx';
import { useInjectCss } from '../shared.js';
import ExamPrepCreate from './ExamPrepCreate.jsx';
import ExamPrepDetail from './ExamPrepDetail.jsx';
import ExamPrepList from './ExamPrepList.jsx';
import { dropForm, keptForm } from './form-draft.js';
import { openingForm, rebuildForm } from './form.js';
import { buildsInScope, buildsOf, formFromList, pointLists } from './model.js';
import css from './exam-prep.css';

/* 备考补习: the page. It lists the 考点清单 of the current course (a list is a material of the library with a course, ./model.js), opens one, and builds a
   new one. Three views in one page (list, detail, create), kept in the page's own state; a build runs in the 任务 console and the page follows it
   through the snapshot (data.jobs and data.sources), so there is nothing to refresh by hand. */

export default function ExamPrep({ data, onOpenSource, onOpenTask, openSettings, openImport }) {
  useInjectCss(css, 'study-exam-prep');
  const toast = useToast(), { act } = useStudy();
  const [scope, setScope] = usePageScope(data.root, 'examprep', data.focus?.course ?? '*');
  // A form kept while the learner stepped out to Settings comes back as it was (./form-draft.js).
  const [view, setView] = useState(() => { const kept = keptForm(data.root); return kept ? { name: 'create', initial: kept.form, more: kept.more } : { name: 'list' }; });
  useEffect(() => { dropForm(); }, []);
  const known = useMemo(() => courseNamesOf(data), [data.focus?.courses]); // eslint-disable-line react-hooks/exhaustive-deps
  const everything = useMemo(() => pointLists(data, { scope: '*', known }), [data.sources, data.jobs, known]); // eslint-disable-line react-hooks/exhaustive-deps
  const rows = useMemo(() => scope === '*' ? everything : pointLists(data, { scope, known }), [everything, data.sources, data.jobs, scope, known]); // eslint-disable-line react-hooks/exhaustive-deps
  const history = useMemo(() => pointLists(data, { scope, known, history: true }), [data.examPointLists, scope, known]); // eslint-disable-line react-hooks/exhaustive-deps
  // A build shows only on the page of its own course, and a rebuild is matched to its list among all the lists, not only those of this scope.
  const builds = useMemo(() => buildsInScope(buildsOf(data), scope, known), [data.jobs, scope, known]); // eslint-disable-line react-hooks/exhaustive-deps
  const listIds = useMemo(() => new Set((Array.isArray(data.examPointLists) ? data.examPointLists : []).map(summary => summary?.id)), [data.examPointLists]);
  const list = useCallback(() => setView({ name: 'list' }), []);
  const open = view.name === 'detail' ? [...everything, ...history].find(row => row.id === view.id) : null;
  if (view.name === 'create') {
    return <ExamPrepCreate data={data} initial={view.initial} initialMore={view.more} onBack={list} openSettings={openSettings} openImport={openImport}
      onStarted={result => { toast.success(result.alreadyRunning ? uiFormat('「{0}」已经在生成，进度在任务页。', [result.title]) : uiFormat('已开始生成「{0}」，进度在任务页。', [result.title])); list(); }} />;
  }
  if (open) {
    return <ExamPrepDetail row={open} onBack={list} onOpenSource={onOpenSource} onOpenTask={onOpenTask} onDeleted={row => { toast.success(uiFormat('已删除「{0}」', [row.title])); list(); }}
      onRegenerate={(row, blueprint) => setView({ name: 'create', initial: rebuildForm(formFromList(row, blueprint), data) })} />;
  }
  return <ExamPrepList data={data} scope={scope} onScope={setScope} rows={rows} history={history} builds={builds} listIds={listIds} otherCount={Math.max(0, everything.length - rows.length)}
    onOpen={id => setView({ name: 'detail', id })} onCreate={() => setView({ name: 'create', initial: openingForm(data, { scope, known }) })} onOpenTask={onOpenTask}
    onRestore={row => act('source.archive', { sourceIds: [row.id], archived: false }, () => toast.success(uiFormat('已恢复「{0}」', [row.title])))} />;
}
