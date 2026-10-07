import React, { useEffect, useMemo, useState } from 'react';
import { getUiLanguage, ui, uiFormat } from '../i18n.js';
import { Button, Field, Icon, InlineMessage, PageHeader, TextInput, Disclosure } from '../components/index.js';
import CourseField from '../CourseField.jsx';
import SourcePicker from '../SourcePicker.jsx';
import { groupSourcesByDocument } from '../../lib/source-groups.js';
import ModelSetupGate from '../ModelSetupGate.jsx';
import { TokenEstimateView, useUsageEstimate } from '../TokenUsage.jsx';
import { modelReadiness } from '../generation-status.js';
import { courseNamesOf } from '../PageScope.jsx';
import { sourceMatchesCourse } from '../../lib/source-courses.js';
import { useStudy } from '../study-context.jsx';
import Explain from './Explain.jsx';
import { ROLES, buildRequest, formProblems, pickPool } from './model.js';
import { noPaperNote, refusalWords } from './words.js';

/* 备考补习, the create form: the inputs are chosen by role from the library (课件 required, 样卷 and 大纲 optional, 推荐教材 a plain note), the estimate
   and any refusal are shown before anything starts, and the build itself runs in the 任务 console. A refusal costs nothing (the operation checks the
   inputs before any model call), so the form asks the operation to price the build as soon as it could start and says why it would not. */

const ROLE_TITLE = { lecture: () => ui('课件'), 'past-paper': () => ui('样卷'), syllabus: () => ui('大纲') };
const ROLE_PICK = { lecture: () => ui('选择课件'), 'past-paper': () => ui('选择样卷'), syllabus: () => ui('选择大纲') };

/** Ask `generation.blueprint.build` to price the build (estimate: no model, no job): { status: 'idle' | 'loading' | 'ok' | 'refused', error? }. */
export function useBuildCheck(call, request, enabled, delay = 350) {
  const key = JSON.stringify(request);
  const [state, setState] = useState({ status: 'idle' });
  useEffect(() => {
    if (!enabled || typeof call !== 'function') { setState({ status: 'idle' }); return undefined; }
    let live = true;
    setState(current => current.status === 'ok' ? current : { status: 'loading' });
    const timer = setTimeout(() => {
      Promise.resolve().then(() => call('generation.blueprint.build', { ...request, estimate: true }))
        .then(() => { if (live) setState({ status: 'ok' }); }, error => { if (live) setState({ status: 'refused', error }); });
    }, delay);
    return () => { live = false; clearTimeout(timer); };
  }, [key, enabled]); // eslint-disable-line react-hooks/exhaustive-deps
  return state;
}

/** How many materials (documents, as the picker counts them) of the pool the chosen pages belong to. */
const documentsChosen = (pool, selected) => groupSourcesByDocument(pool).filter(item => item.sourceIds.some(id => selected.includes(id))).length;

function Role({ role, required, pool, selected, onChange, courses, disabled, note, defaultOpen }) {
  return (
    <fieldset className="exam-prep-role" data-role={role}>
      <legend className="exam-prep-role__head">
        <span className="exam-prep-role__title">{ROLE_TITLE[role]()}</span>
        <span className="exam-prep-role__need">{required ? ui('必选') : ui('可选')}</span>
        <Explain k={`role.${role}`} focusable label={uiFormat('「{0}」是什么', [ROLE_TITLE[role]()])}><Icon name="info" size={16} /></Explain>
        <span className="exam-prep-role__count" role="status">{uiFormat('已选 {0} 份', [documentsChosen(pool, selected)])}</span>
      </legend>
      {note}
      <Disclosure summary={ROLE_PICK[role]()} defaultOpen={defaultOpen}>
        <SourcePicker sources={pool} selected={selected} onChange={onChange} courses={courses} disabled={disabled} maxHeight={260} aria-label={ROLE_TITLE[role]()} />
      </Disclosure>
    </fieldset>
  );
}

export default function ExamPrepCreate({ data, initial, onBack, onStarted, openSettings }) {
  const { call, act, busy } = useStudy();
  const [form, setForm] = useState(initial);
  const [others, setOthers] = useState(false), [error, setError] = useState('');
  const known = useMemo(() => courseNamesOf(data), [data.focus?.courses]); // eslint-disable-line react-hooks/exhaustive-deps
  const language = getUiLanguage();
  const base = useMemo(() => others || !form.course ? data.sources : data.sources.filter(source => sourceMatchesCourse(source, form.course, known)), [data.sources, others, form.course, known]);
  const pools = useMemo(() => Object.fromEntries(ROLES.map(role => [role, pickPool(base, form.picks, role)])), [base, form.picks]);
  const problems = formProblems(form);
  const request = useMemo(() => buildRequest(form, data.sources, { language }), [form, data.sources, language]);
  const { supersedes, ...priced } = request;
  const ready = problems.length === 0;
  const check = useBuildCheck(call, request, ready);
  const estimate = useUsageEstimate(call, { feature: 'blueprint', ...priced }, { enabled: ready && check.status !== 'refused' });
  const model = modelReadiness(data);
  const set = patch => { setError(''); setForm(current => ({ ...current, ...patch })); };
  const pick = (role, ids) => set({ picks: { ...form.picks, [role]: ids } });
  const reading = (field, value) => set({ reading: { ...form.reading, [field]: value } });
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
        description={again ? ui('按下面的资料再列一份，生成后取代旧清单，旧清单保留为历史版本。') : ui('选好资料后开始生成；过程在后台进行，进度在任务页，这里会自动更新。')} />
      <form className="exam-prep-form" onSubmit={event => { event.preventDefault(); if (ready && !shown && model.ready) start(); }}>
        <div className="exam-prep-form__fields">
          <Field label={ui('名称')} required hint={ui('例如「网络 · 传输层 考点清单」')}>
            <TextInput value={form.title} maxLength={200} onChange={event => set({ title: event.target.value })} />
          </Field>
          <Field label={ui('范围（可选）')} hint={ui('这份清单覆盖的章节或考试，例如「传输层」')}>
            <TextInput value={form.scope} maxLength={200} onChange={event => set({ scope: event.target.value })} />
          </Field>
          <CourseField value={form.course} onChange={course => set({ course })} courses={data.focus?.courses} disabled={busy} label={ui('课程')} />
        </div>
        <p className="exam-prep-form__others">
          <Button variant="link" size="sm" aria-pressed={others} onClick={() => setOthers(value => !value)}>
            {others ? ui('只看这门课的资料') : ui('也显示其它课程的资料')}
          </Button>
        </p>
        <Role role="lecture" required pool={pools.lecture} selected={form.picks.lecture} onChange={ids => pick('lecture', ids)}
          courses={data.focus?.courses} disabled={busy} defaultOpen />
        <Role role="past-paper" pool={pools['past-paper']} selected={form.picks['past-paper']} onChange={ids => pick('past-paper', ids)}
          courses={data.focus?.courses} disabled={busy} defaultOpen={form.picks['past-paper'].length > 0}
          note={form.picks['past-paper'].length === 0 ? <p className="exam-prep-role__note">{noPaperNote()}</p> : null} />
        <Role role="syllabus" pool={pools.syllabus} selected={form.picks.syllabus} onChange={ids => pick('syllabus', ids)}
          courses={data.focus?.courses} disabled={busy} defaultOpen={form.picks.syllabus.length > 0} />
        <fieldset className="exam-prep-role" data-role="textbook">
          <legend className="exam-prep-role__head">
            <span className="exam-prep-role__title">{ui('推荐教材')}</span>
            <span className="exam-prep-role__need">{ui('可选')}</span>
            <Explain k="role.textbook" focusable label={uiFormat('「{0}」是什么', [ui('推荐教材')])}><Icon name="info" size={16} /></Explain>
          </legend>
          <Disclosure summary={ui('记一条备注')} defaultOpen={!!form.reading.title}>
            <div className="exam-prep-form__fields">
              <Field label={ui('书名')}><TextInput value={form.reading.title} maxLength={200} onChange={event => reading('title', event.target.value)} /></Field>
              <Field label={ui('作者')}><TextInput value={form.reading.author} maxLength={200} onChange={event => reading('author', event.target.value)} /></Field>
              <Field label={ui('网址')} error={problems.includes('reading-url') ? ui('网址要以 http:// 或 https:// 开头') : undefined}>
                <TextInput type="url" value={form.reading.url} maxLength={500} onChange={event => reading('url', event.target.value)} />
              </Field>
              <Field label={ui('备注')}><TextInput value={form.reading.note} maxLength={600} onChange={event => reading('note', event.target.value)} /></Field>
            </div>
          </Disclosure>
        </fieldset>
        <div className="exam-prep-start">
          <div className="exam-prep-estimate">
            <p className="exam-prep-estimate__label">{ui('预计用量')} <Explain k="estimate" focusable label={ui('预计用量的说明')}><Icon name="info" size={16} /></Explain></p>
            {ready ? <TokenEstimateView state={estimate} />
              : <p className="exam-prep-estimate__wait">{problems.includes('title') ? ui('先给清单起个名字，这里就会显示预计用量。') : ui('先选好课件，这里就会显示预计用量。')}</p>}
          </div>
          <div className="exam-prep-check" role="status" aria-live="polite">
            {shown && <InlineMessage tone="warning">{shown}</InlineMessage>}
          </div>
          {model.ready ? (
            <Button type="submit" variant="primary" icon="sparkle" busy={busy} data-usage="examprep.start" disabled={!ready || !!shown || check.status === 'loading'}>
              {ui('开始生成')}
            </Button>
          ) : <ModelSetupGate variant="block" feature="examprep" model={model} onOpenSettings={openSettings} />}
        </div>
      </form>
    </section>
  );
}
