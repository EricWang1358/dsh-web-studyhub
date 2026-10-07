import React, { useCallback, useMemo, useState } from 'react';
import { uiFormat } from '../i18n.js';
import { useToast } from '../components/index.js';
import { courseNamesOf, usePageScope } from '../PageScope.jsx';
import { useInjectCss } from '../shared.js';
import ExamPrepCreate from './ExamPrepCreate.jsx';
import ExamPrepDetail from './ExamPrepDetail.jsx';
import ExamPrepList from './ExamPrepList.jsx';
import { ROLES, buildsOf, formFromList, pointLists } from './model.js';
import css from './exam-prep.css';

/* 备考补习: the page. It lists the 考点清单 of the current course (a list is a material of the library with a course, ./model.js), opens one, and builds a
   new one. Three views in one page (list, detail, create), kept in the page's own state; a build runs in the 任务 console and the page follows it
   through the snapshot (data.jobs and data.sources), so there is nothing to refresh by hand. */

const blankForm = course => ({ title: course ? uiFormat('{0} 考点清单', [course]) : '', scope: '', course: course || '', supersedes: undefined,
  picks: Object.fromEntries(ROLES.map(role => [role, []])), reading: { title: '', author: '', url: '', note: '' } });

export default function ExamPrep({ data, onOpenSource, onOpenTask, openSettings }) {
  useInjectCss(css, 'study-exam-prep');
  const toast = useToast();
  const [scope, setScope] = usePageScope(data.root, 'examprep', data.focus?.course ?? '*');
  const [view, setView] = useState({ name: 'list' });
  const known = useMemo(() => courseNamesOf(data), [data.focus?.courses]); // eslint-disable-line react-hooks/exhaustive-deps
  const everything = useMemo(() => pointLists(data, { scope: '*', known }), [data.sources, data.jobs, known]); // eslint-disable-line react-hooks/exhaustive-deps
  const rows = useMemo(() => scope === '*' ? everything : pointLists(data, { scope, known }), [everything, data.sources, data.jobs, scope, known]); // eslint-disable-line react-hooks/exhaustive-deps
  const builds = useMemo(() => buildsOf(data), [data.jobs]); // eslint-disable-line react-hooks/exhaustive-deps
  const list = useCallback(() => setView({ name: 'list' }), []);
  const open = view.name === 'detail' ? everything.find(row => row.id === view.id) : null;
  const courseNow = scope !== '*' && scope !== '' ? scope : data.focus?.course || '';
  if (view.name === 'create') {
    return <ExamPrepCreate data={data} initial={view.initial} onBack={list} openSettings={openSettings}
      onStarted={result => { toast.success(result.alreadyRunning ? uiFormat('「{0}」已经在生成，进度在任务页。', [result.title]) : uiFormat('已开始生成「{0}」，进度在任务页。', [result.title])); list(); }} />;
  }
  if (open) {
    return <ExamPrepDetail row={open} onBack={list} onOpenSource={onOpenSource} onOpenTask={onOpenTask} onDeleted={row => { toast.success(uiFormat('已删除「{0}」', [row.title])); list(); }}
      onRegenerate={row => setView({ name: 'create', initial: formFromList(row.source) })} />;
  }
  return <ExamPrepList data={data} scope={scope} onScope={setScope} rows={rows} builds={builds} otherCount={Math.max(0, everything.length - rows.length)}
    onOpen={id => setView({ name: 'detail', id })} onCreate={() => setView({ name: 'create', initial: blankForm(courseNow) })} onOpenTask={onOpenTask} />;
}
