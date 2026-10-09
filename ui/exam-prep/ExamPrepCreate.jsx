import React, { useEffect, useMemo, useRef, useState } from 'react';
import { getUiLanguage, ui } from '../i18n.js';
import { Button, Icon, InlineMessage, PageHeader } from '../components/index.js';
import CourseField from '../CourseField.jsx';
import ModelSetupGate from '../ModelSetupGate.jsx';
import { TokenEstimateView, useUsageEstimate } from '../TokenUsage.jsx';
import { modelReadiness } from '../generation-status.js';
import { courseNamesOf } from '../PageScope.jsx';
import { useStudy } from '../study-context.jsx';
import { useLiveEffect } from '../use-async.js';
import DocTable from './DocTable.jsx';
import Explain from './Explain.jsx';
import MoreSettings from './MoreSettings.jsx';
import { assignIds, assignRole, defaultTitle, documentsOf, guidanceOf, hasMoreValues, languageOf, picksFor, poolOf, roleCounts, settingsOf, suggestionsOf } from './form.js';
import { keepForm } from './form-draft.js';
import { countsLine, noPaperWords } from './form-words.js';
import { ROLES, buildRequest, formProblems } from './model.js';
import { refusalWords } from './words.js';

/* 备考补习, the create form. It opens already filled in (the documents of the course, each with the role suggested for it and the reason), so the main path
   is: read the table, press 开始生成. Whatever is optional sits in 更多设置. The estimate and any refusal are shown before anything starts (a refusal costs
   nothing: the operation checks the inputs before any model call), and the build itself runs in the 任务 console. */

/** Ask `generation.blueprint.build` to price the build (estimate: no model, no job): { status: 'idle' | 'loading' | 'ok' | 'refused', error? }. */
export function useBuildCheck(call, request, enabled, delay = 350) {
  const key = JSON.stringify(request);
  const [state, setState] = useState({ status: 'idle' });
  useLiveEffect(live => {
    if (!enabled || typeof call !== 'function') { setState({ status: 'idle' }); return undefined; }
    setState(current => current.status === 'ok' ? current : { status: 'loading' });
    const timer = setTimeout(() => {
      Promise.resolve().then(() => call('generation.blueprint.build', { ...request, estimate: true }))
        .then(() => { if (live()) setState({ status: 'ok' }); }, error => { if (live()) setState({ status: 'refused', error }); });
    }, delay);
    return () => clearTimeout(timer);
  }, [key, enabled]);
  return state;
}

/** How long a step out to Settings may take to leave the page: a form is kept only when the page really goes away. */
const LEAVING_MS = 600;

export default function ExamPrepCreate({ data, initial, initialMore, onBack, onStarted, openSettings, openImport }) {
  const { call, act, busy } = useStudy();
  const [form, setForm] = useState(initial);
  const [more, setMore] = useState(() => initialMore ?? hasMoreValues(initial));
  const [error, setError] = useState('');
  const known = useMemo(() => courseNamesOf(data), [data.focus?.courses]); // eslint-disable-line react-hooks/exhaustive-deps
  const settings = useMemo(() => settingsOf(data), [data.settings?.examPrep]); // eslint-disable-line react-hooks/exhaustive-deps
  const items = useMemo(() => documentsOf(data.sources), [data.sources]);
  const picked = useMemo(() => new Set(ROLES.flatMap(role => form.picks[role] || [])), [form.picks]);
  const pool = useMemo(() => poolOf(items, { course: form.course, others: !!form.others, picked, known }), [items, form.course, form.others, picked, known]);
  const suggestions = useMemo(() => suggestionsOf(pool, { course: form.course, known, guidance: guidanceOf(data, form.course), paperWords: settings.paperWords,
    autoRoles: settings.autoRoles }), [pool, form.course, known, data.courses, settings]); // eslint-disable-line react-hooks/exhaustive-deps
  const counts = useMemo(() => roleCounts(pool, form.picks), [pool, form.picks]);
  const title = defaultTitle(form, pool, data);
  const request = useMemo(() => buildRequest(form, data.sources, { language: languageOf(form, getUiLanguage()), defaultTitle: title }), [form, data.sources, title]);
  const { supersedes, ...priced } = request;
  const problems = formProblems(form, request);
  const ready = problems.length === 0;
  const check = useBuildCheck(call, request, ready);
  const estimate = useUsageEstimate(call, { feature: 'blueprint', ...priced }, { enabled: ready && check.status !== 'refused' });
  const model = modelReadiness(data);
  // Settings is another page, so stepping out drops this one; the form is kept for the way back (and only if the page really goes).
  const latest = useRef({ form, more }), leaving = useRef(false);
  latest.current = { form, more };
  useEffect(() => () => { if (leaving.current) keepForm(data.root, latest.current); }, [data.root]);
  const goSettings = section => {
    leaving.current = true;
    setTimeout(() => { leaving.current = false; }, LEAVING_MS);
    openSettings?.(section);
  };
  const set = patch => { setError(''); setForm(current => ({ ...current, ...patch })); };
  const setPicks = update => { setError(''); setForm(current => ({ ...current, picks: update(current.picks) })); };
  const reading = (field, value) => setForm(current => ({ ...current, reading: { ...current.reading, [field]: value } }));
  const course = value => set(form.askCourse ? { course: value, picks: picksFor(data, value, known) } : { course: value });
  const importAs = role => openImport?.({ course: form.course, onImported: ids => setPicks(picks => assignIds(picks, ids, role)) });
  const start = async () => {
    setError('');
    try {
      await act('generation.blueprint.build', request, result => onStarted({ ...result, title: request.title }), { rethrow: true });
    } catch (failure) { setError(refusalWords(failure)); }
  };
  const refused = check.status === 'refused' ? refusalWords(check.error) : '';
  const shown = error || refused;
  const again = !!form.supersedes;
  return (
    <section className="page exam-prep exam-prep-create" data-usage-area="examprep">
      <PageHeader title={again ? ui('重新生成考点清单') : ui('新建考点清单')} back={{ label: ui('返回考点清单'), onClick: onBack }}
        description={again ? ui('按下面的资料再列一份，生成后取代旧清单，旧清单保留为历史版本。')
          : ui('看得出用途的资料已经分好，其余默认不用；选好课件后开始生成，过程在后台进行，进度在任务页，这里会自动更新。')} />
      <form className="exam-prep-form" onSubmit={event => { event.preventDefault(); if (ready && !shown && model.ready) start(); }}>
        <ModelSetupGate variant="banner" feature="examprep" model={model} onOpenSettings={() => goSettings()} />
        {form.askCourse && (
          <div className="exam-prep-ask">
            <p className="exam-prep-ask__note">{ui('没能判断这些资料属于哪门课，请选一下；留空也可以。')}</p>
            <CourseField value={form.course} onChange={course} courses={data.focus?.courses} disabled={busy} label={ui('课程')} />
          </div>
        )}
        <section className="exam-prep-docs" aria-label={ui('用来列考点的资料')}>
          <div className="exam-prep-docs__head">
            <p className="exam-prep-docs__counts" role="status">{countsLine(counts)}</p>
            <Explain k="roles" focusable label={ui('用途是什么')}><Icon name="info" size={16} /></Explain>
          </div>
          {pool.length > 0 && counts['past-paper'] === 0 && (
            <p className="exam-prep-docs__none">
              {noPaperWords()}
              {openImport && <>{' '}<Button variant="link" size="sm" disabled={busy} onClick={() => importAs('past-paper')}>{ui('导入样卷')}</Button></>}
            </p>
          )}
          {pool.length ? (
            <DocTable items={pool} picks={form.picks} suggestions={suggestions} sources={data.sources} course={form.course} known={known}
              courses={data.focus?.courses} disabled={busy}
              onRole={(item, role) => setPicks(picks => assignRole(picks, item, role))} onPages={(item, role, ids) => setPicks(picks => assignRole(picks, item, role, ids))} />
          ) : (
            <p className="exam-prep-docs__empty">
              {ui('这里还没有可用的资料，先导入课件。')}
              {openImport && <>{' '}<Button variant="link" size="sm" disabled={busy} onClick={() => importAs('lecture')}>{ui('导入资料')}</Button></>}
            </p>
          )}
        </section>
        <MoreSettings form={form} title={title} courses={data.focus?.courses} hideCourse={!!form.askCourse} disabled={busy} open={more} onToggle={setMore}
          onChange={set} onReading={reading} problems={problems} onSettings={openSettings ? goSettings : undefined} />
        <div className="exam-prep-start">
          <div className="exam-prep-estimate">
            <p className="exam-prep-estimate__label">
              {ui('预计用量')} <Explain k="estimate" focusable label={ui('预计用量的说明')}><Icon name="info" size={16} /></Explain>
            </p>
            {ready ? <TokenEstimateView state={estimate} /> : <p className="exam-prep-estimate__wait">{ui('先选至少一份课件（或大纲），这里就会显示预计用量。')}</p>}
          </div>
          <div className="exam-prep-check" role="status" aria-live="polite">
            {shown && <InlineMessage tone="warning">{shown}</InlineMessage>}
          </div>
          <Button type="submit" variant="primary" icon="sparkle" busy={busy} data-usage="examprep.start" disabled={!ready || !!shown || check.status === 'loading' || !model.ready}>
            {ui('开始生成')}
          </Button>
        </div>
      </form>
    </section>
  );
}
