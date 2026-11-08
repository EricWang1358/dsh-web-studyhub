import React, { useMemo, useState } from 'react';
import { ui, uiFormat, errorMessage } from './i18n.js';
import { joinMeta } from './format.js';
import { useStudy } from './study-context.jsx';
import { useInjectCss } from './shared.js';
import { useLiveEffect } from './use-async.js';
import { modelReadiness } from './generation-status.js';
import ModelSetupGate from './ModelSetupGate.jsx';
import {
  Button,
  Checkbox,
  EmptyState,
  Field,
  InlineMessage,
  NumberInput,
  PageHeader,
  SegmentedControl,
  Select,
  TextArea,
  TextInput,
} from './components/index.js';
import css from './exam-coach.css';

const FORMAT_LABELS = {
  quiz: '单选题',
  multi: '多选题',
  truefalse: '判断题',
  cloze: '填空题',
  open: '开放简答/推导',
  task: '实操/综合任务',
  case: '材料案例大题',
};

const ORIGIN_LABELS = {
  'source-fact': '资料事实',
  'reference-observed': '样卷观察',
  'model-suggested': '模型建议',
  'user-defined': '自定义',
};

function formatLabel(fmt) {
  return ui(FORMAT_LABELS[fmt] || '单选题');
}

function originLabel(origin) {
  return ui(ORIGIN_LABELS[origin] || '资料事实');
}

export default function ExamCoachPage({
  data,
  onGoGenerate,
  onApplyToGenerate,
  onOpenSettings,
  onOpenTasks,
}) {
  useInjectCss(css, 'study-exam-coach');
  const { call, act, busy, notify } = useStudy();
  const model = modelReadiness(data);

  const knownCourses = useMemo(() => {
    const names = [
      ...(data?.courses || []).map((c) => c?.name || c?.id),
      ...(data?.sources || []).filter((s) => !s.archived).map((s) => s.course),
      ...(data?.decks || []).filter((d) => !d.archived).map((d) => d.course),
    ].filter((v) => typeof v === 'string' && v.trim());
    return [...new Set(names)];
  }, [data?.courses, data?.sources, data?.decks]);

  const [course, setCourse] = useState(() => data?.focus?.course || knownCourses[0] || '');
  const [stage, setStage] = useState('analyze');
  const [spec, setSpec] = useState(null);
  const [evidence, setEvidence] = useState(null);
  const [compiledPreview, setCompiledPreview] = useState(null);
  const [mockReport, setMockReport] = useState(null);
  const [editingFamilyId, setEditingFamilyId] = useState(null);
  const [editDraft, setEditDraft] = useState({ reasoningText: '', rubricText: '' });
  const [pageError, setPageError] = useState('');
  const [working, setWorking] = useState(false);

  useLiveEffect((live) => {
    setPageError('');
    Promise.resolve(call?.('coach.calibration.get', { course })).then(
      (res) => {
        if (!live() || !res) return;
        setSpec(res.spec || null);
        setEvidence(res.evidence || null);
        if (res.spec?.stage) setStage(res.spec.stage);
      },
      (err) => {
        if (live()) setPageError(errorMessage(err));
      },
    );
  }, [call, course, data?.decks?.length, data?.attempts?.length]);

  const courseOptions = useMemo(() => [
    { value: '', label: ui('全部资料（未分课）') },
    ...knownCourses.map((name) => ({ value: name, label: name })),
  ], [knownCourses]);

  const stageOptions = [
    { value: 'analyze', label: ui('1. 分析考法') },
    { value: 'confirm', label: ui('2. 确认代表题与错因') },
    { value: 'configure', label: ui('3. 调整训练配置') },
    { value: 'evidence', label: ui('4. 出题与能力证据') },
  ];

  async function handleAnalyze(useModel = false) {
    setWorking(true);
    setPageError('');
    try {
      const res = await call('coach.calibration.analyze', { course, useModel });
      setSpec(res.spec);
      setEvidence(res.evidence);
      setCompiledPreview(null);
      setStage('confirm');
      notify?.({ text: ui('已生成考察方式与代表样题草案，请逐项核对确认。'), tone: 'success' });
    } catch (err) {
      setPageError(errorMessage(err));
    } finally {
      setWorking(false);
    }
  }

  async function handleConfirmFlag(familyId, patch) {
    setPageError('');
    try {
      const res = await call('coach.calibration.confirm', { course, familyId, ...patch });
      if (res?.spec) setSpec(res.spec);
      if (res?.evidence) setEvidence(res.evidence);
      setCompiledPreview(null);
      if (patch.revealSampleSolution) {
        notify?.({ text: ui('已展开样题答案并记录解法暴露；近似题干将不计入未见独立证据。'), tone: 'info' });
      }
    } catch (err) {
      setPageError(errorMessage(err));
    }
  }

  async function handleSaveSpec(patch, toastText) {
    setPageError('');
    try {
      const res = await call('coach.calibration.save', { course, ...patch });
      if (res?.spec) setSpec(res.spec);
      if (res?.evidence) setEvidence(res.evidence);
      if (patch.stage) setStage(patch.stage);
      setCompiledPreview(null);
      if (toastText) notify?.({ text: toastText, tone: 'success' });
    } catch (err) {
      setPageError(errorMessage(err));
    }
  }

  function openRuleEditor(family) {
    setEditingFamilyId(family.id);
    setEditDraft({
      reasoningText: (family.reasoningSteps || []).join('\n'),
      rubricText: family.sample?.rubric || (family.rubricPoints || []).map((r) => `${r.criterion}：${r.condition}`).join('\n'),
    });
  }

  async function saveRuleEdits(family) {
    const nextSteps = editDraft.reasoningText.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const nextRubric = editDraft.rubricText.trim();
    const updatedFamilies = (spec?.taskFamilies || []).map((f) => {
      if (f.id !== family.id) return f;
      return {
        ...f,
        reasoningSteps: nextSteps,
        sample: { ...f.sample, rubric: nextRubric },
      };
    });
    await handleSaveSpec(
      { taskFamilies: updatedFamilies },
      ui('已更新推理与评分规则；版本已推进，请重新确认该项考察意图与答案。'),
    );
    setEditingFamilyId(null);
  }

  function updateFamilyLocal(familyId, updater) {
    if (!spec) return;
    setSpec({
      ...spec,
      taskFamilies: spec.taskFamilies.map((f) => (f.id === familyId ? updater(f) : f)),
    });
  }

  async function handleBuildPreview() {
    setWorking(true);
    setPageError('');
    try {
      const built = await call('coach.calibration.buildRequest', { course });
      let genPreview = null;
      if (built.totalCount > 0 && built.request.sourceIds?.length > 0) {
        try {
          genPreview = await call('generate.preview', built.request);
        } catch {
          genPreview = null;
        }
      }
      setCompiledPreview({ built, genPreview });
    } catch (err) {
      setPageError(errorMessage(err));
    } finally {
      setWorking(false);
    }
  }

  async function handleApplyToGenerateForm() {
    setPageError('');
    try {
      const built = await call('coach.calibration.buildRequest', { course });
      if (onApplyToGenerate) {
        onApplyToGenerate(built);
      } else {
        onGoGenerate?.();
      }
    } catch (err) {
      setPageError(errorMessage(err));
    }
  }

  async function handleDirectGenerate() {
    setWorking(true);
    setPageError('');
    try {
      const built = await call('coach.calibration.buildRequest', { course });
      if (built.totalCount <= 0) {
        setPageError(ui('当前启用配额为 0 题，请先在「调整训练配置」里设置至少 1 个非零配额任务族。'));
        return;
      }
      await act('generate', built.request, () => {
        notify?.({ text: ui('已按教练校准要求启动后台出题，可在「任务」页查看实际请求追溯。'), tone: 'success' });
        onOpenTasks?.();
      });
    } catch (err) {
      setPageError(errorMessage(err));
    } finally {
      setWorking(false);
    }
  }

  async function handleCheckStrictMock() {
    setWorking(true);
    setPageError('');
    try {
      const activeFamilies = (spec?.taskFamilies || []).filter((f) => f.quota > 0);
      const sections = activeFamilies.length
        ? activeFamilies.map((f) => ({
            id: f.id,
            title: f.title,
            allowedKinds: f.allowFormSubstitute ? f.allowedFormats : [f.primaryFormat],
            count: Math.max(1, Math.min(f.quota, 5)),
            marksPerItem: f.marksPerItem,
            timePerItemSec: f.timeBudgetSec,
            requiresSharedMaterial: f.quotaUnit === 'shared-material-group' || f.primaryFormat === 'case',
            subpartsCount: f.quotaUnit === 'subquestion' ? Math.max(2, f.questionsPerUnit) : 0,
          }))
        : [{ id: 'default-quiz', title: ui('基础客观题'), allowedKinds: ['quiz'], count: 4, marksPerItem: 2, timePerItemSec: 90 }];
      const res = await call('coach.mockPaper.compose', { course, examShape: { sections } });
      setMockReport(res);
    } catch (err) {
      setPageError(errorMessage(err));
    } finally {
      setWorking(false);
    }
  }

  const hasSources = (data?.sources || []).some((s) => !s.archived);
  const calibratedCount = (spec?.taskFamilies || []).filter((f) => f.calibrated).length;
  const totalFamilies = spec?.taskFamilies?.length || 0;

  return (
    <section className="page exam-coach-page" data-page="examcoach">
      <PageHeader
        eyebrow={ui('考试与统计')}
        title={ui('考试教练')}
        description={ui('先分析考察方式、确认代表变式与干扰项错因，再按模块化配额生成并分开核对资料覆盖、训练覆盖与独立能力证据。普通直接出题无需经过此处。')}
        actions={onGoGenerate ? <Button variant="quiet" onClick={onGoGenerate}>{ui('直接去创建题组')}</Button> : undefined}
      />

      {!model.ready && (
        <ModelSetupGate variant="banner" feature="examcoach" model={model} onOpenSettings={onOpenSettings} />
      )}

      {pageError && <InlineMessage tone="error">{pageError}</InlineMessage>}

      <div className="exam-coach-toolbar">
        <div className="exam-coach-course-row">
          <Field label={ui('当前课程')} inline width="sm">
            <Select options={courseOptions} value={course} onChange={(val) => setCourse(val)} />
          </Field>
          {spec && (
            <div className="exam-coach-badges">
              <span className="exam-coach-badge exam-coach-badge--info">
                {uiFormat('规格版本 {0}', [spec.specVersion])}
              </span>
              <span className={`exam-coach-badge ${calibratedCount === totalFamilies && totalFamilies > 0 ? 'exam-coach-badge--ok' : 'exam-coach-badge--warn'}`}>
                {uiFormat('已校准 {0}/{1} 项任务族', [calibratedCount, totalFamilies])}
              </span>
            </div>
          )}
        </div>
        <SegmentedControl
          label={ui('教练阶段')}
          size="sm"
          wrap
          value={stage}
          options={stageOptions}
          onChange={(next) => {
            setStage(next);
            if (spec && spec.stage !== next) {
              handleSaveSpec({ stage: next });
            }
          }}
        />
      </div>

      {!hasSources && stage === 'analyze' && (
        <EmptyState
          icon="file"
          title={ui('还没有课程资料')}
          description={ui('导入讲义、教材或往年样卷后，教练可以区分资料事实与样卷观察并整理考察任务族；你也可以先查看现有题库的能力证据分界。')}
          primary={onGoGenerate ? { label: ui('前往创建题组导入资料'), onClick: onGoGenerate } : undefined}
        />
      )}

      {stage === 'analyze' && (
        <div className="exam-coach-card">
          <div className="exam-coach-card__head">
            <div>
              <h2 className="exam-coach-card__title">{ui('第 1 步：分析考察方式与范围边界')}</h2>
              <p className="exam-coach-meta">
                {ui('区分“答题形式（单选/开放/实操）”与“实际考察任务（前置条件、关键推理步骤、期望交付物）”，不把表面场景词当作复杂应用题。')}
              </p>
            </div>
            <div className="exam-coach-actions">
              <Button variant="primary" lock={busy || working} onClick={() => handleAnalyze(false)}>
                {spec ? ui('重新整理考察方式') : ui('分析考察方式')}
              </Button>
              {model.ready && (
                <Button variant="secondary" lock={busy || working} onClick={() => handleAnalyze(true)}>
                  {ui('结合 AI 深化补充')}
                </Button>
              )}
            </div>
          </div>

          {spec && (
            <>
              <div className="exam-coach-note">
                {spec.scopeBoundary?.sampleFrequencyNote}
              </div>
              {spec.scopeBoundary?.uncoveredMaterialSections?.length > 0 && (
                <div className="exam-coach-note exam-coach-note--warn">
                  <strong>{ui('样卷未覆盖的资料章节：')}</strong>
                  {spec.scopeBoundary.uncoveredMaterialSections.join('、')}
                </div>
              )}

              <div className="exam-coach-grid">
                {spec.taskFamilies.map((f) => (
                  <div key={f.id} className="exam-coach-card exam-coach-card--raised">
                    <div className="exam-coach-badges">
                      <span className="exam-coach-badge exam-coach-badge--info">{originLabel(f.origin)}</span>
                      <span className="exam-coach-badge">{uiFormat('主形式：{0}', [formatLabel(f.primaryFormat)])}</span>
                      <span className="exam-coach-badge">
                        {uiFormat('允许形式：{0}', [f.allowedFormats.map(formatLabel).join(' / ')])}
                      </span>
                    </div>
                    <h3 className="exam-coach-card__title">{f.title}</h3>
                    <p className="exam-coach-meta">{f.formatTradeoff}</p>
                    <ul className="exam-coach-list">
                      {f.reasoningSteps.map((step, i) => (
                        <li key={i}>{step}</li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>

              <div className="exam-coach-actions">
                <Button variant="primary" onClick={() => setStage('confirm')}>{ui('下一步：逐项确认代表题与错因')}</Button>
              </div>
            </>
          )}
        </div>
      )}

      {stage === 'confirm' && (
        <div className="exam-coach-card">
          <div className="exam-coach-card__head">
            <div>
              <h2 className="exam-coach-card__title">{ui('第 2 步：确认代表变式、关键推理与错因')}</h2>
              <p className="exam-coach-meta">
                {ui('「外观满意」「考察意图满意」「答案已核实」三项独立记录；样题默认隐藏标准答案，展开核对会记录解法暴露。')}
              </p>
            </div>
            {!spec && (
              <Button variant="primary" lock={busy || working} onClick={() => handleAnalyze(false)}>
                {ui('先生成代表题草案')}
              </Button>
            )}
          </div>

          {spec?.taskFamilies?.map((f) => (
            <div key={f.id} className="exam-coach-card exam-coach-card--raised" data-family-id={f.id}>
              <div className="exam-coach-card__head">
                <div>
                  <h3 className="exam-coach-card__title">{f.title}</h3>
                  <p className="exam-coach-meta">
                    {joinMeta([
                      originLabel(f.origin),
                      uiFormat('答题形式：{0}', [formatLabel(f.primaryFormat)]),
                      uiFormat('期望产出：{0}', [f.expectedArtifact]),
                    ])}
                  </p>
                </div>
                <div className="exam-coach-badges">
                  {f.calibrated ? (
                    <span className="exam-coach-badge exam-coach-badge--ok">{ui('三项校准已就绪')}</span>
                  ) : (
                    <span className="exam-coach-badge exam-coach-badge--warn">
                      {f.confirmations?.staleReason === 'rules-updated' ? ui('规则已变更，需重新确认') : ui('待完成三项确认')}
                    </span>
                  )}
                </div>
              </div>

              {f.defects?.length > 0 && (
                <div className="exam-coach-note exam-coach-note--warn">
                  {f.defects.map((d, i) => <div key={i}>{d.message}</div>)}
                </div>
              )}

              <div>
                <strong className="exam-coach-meta">{ui('关键推理步骤：')}</strong>
                <ul className="exam-coach-list">
                  {f.reasoningSteps.map((step, i) => <li key={i}>{step}</li>)}
                </ul>
              </div>

              {f.distractorRules?.length > 0 && (
                <div>
                  <strong className="exam-coach-meta">{ui('干扰项错因映射（绑定稳定选项 ID，乱序后仍一致）：')}</strong>
                  <ul className="exam-coach-list">
                    {f.distractorRules.map((d) => (
                      <li key={d.id}>{`${joinMeta([d.code, d.label])}：${d.reason}`}</li>
                    ))}
                  </ul>
                </div>
              )}

              {f.rubricPoints?.length > 0 && (
                <div>
                  <strong className="exam-coach-meta">{ui('分步评分细则（Rubric）：')}</strong>
                  <ul className="exam-coach-list">
                    {f.rubricPoints.map((r) => (
                      <li key={r.id}>{uiFormat('{0}（{1} 分）：{2}', [r.criterion, r.marks, r.condition])}</li>
                    ))}
                  </ul>
                </div>
              )}

              {f.sample?.stem && (
                <div className="exam-coach-sample">
                  <strong>{ui('代表样题：')}</strong>
                  <div>{f.sample.stem}</div>
                  {Array.isArray(f.sample.options) && f.sample.options.length > 0 && (
                    <ul className="exam-coach-options">
                      {f.sample.options.map((o) => (
                        <li key={o.id} className="exam-coach-option">
                          {`[${o.id}] ${o.text}`}
                          {!f.sample.redacted && o.correct ? ` — ${ui('正确项')}` : ''}
                          {o.misconceptionReason ? ` （${uiFormat('错因假设：{0}', [o.misconceptionReason])}）` : ''}
                        </li>
                      ))}
                    </ul>
                  )}

                  {f.sample.redacted ? (
                    <div className="exam-coach-actions">
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => handleConfirmFlag(f.id, { revealSampleSolution: true })}
                      >
                        {ui('展开答案与评分解析（记录解法暴露）')}
                      </Button>
                    </div>
                  ) : (
                    <div className="exam-coach-note exam-coach-note--warn">
                      <div><strong>{ui('参考答案：')}</strong>{f.sample.answer || ui('见评分细则')}</div>
                      {f.sample.rubric && <div><strong>{ui('评分标准：')}</strong>{f.sample.rubric}</div>}
                      <div>{ui('已记录样题解法暴露：后续近似题干的作答不会算作未见独立通过。')}</div>
                    </div>
                  )}
                </div>
              )}

              {editingFamilyId === f.id ? (
                <div className="exam-coach-sample">
                  <Field label={ui('关键推理步骤（每行一步）')} width="full">
                    <TextArea
                      rows={3}
                      value={editDraft.reasoningText}
                      onChange={(e) => setEditDraft({ ...editDraft, reasoningText: e.target.value })}
                    />
                  </Field>
                  <Field label={ui('样题分步评分细则（避免“酌情给分”等模糊表述）')} width="full">
                    <TextArea
                      rows={3}
                      value={editDraft.rubricText}
                      onChange={(e) => setEditDraft({ ...editDraft, rubricText: e.target.value })}
                    />
                  </Field>
                  <div className="exam-coach-actions">
                    <Button variant="primary" size="sm" onClick={() => saveRuleEdits(f)}>{ui('保存规则修改')}</Button>
                    <Button variant="quiet" size="sm" onClick={() => setEditingFamilyId(null)}>{ui('取消')}</Button>
                  </div>
                </div>
              ) : (
                <div className="exam-coach-actions">
                  <Button variant="quiet" size="sm" onClick={() => openRuleEditor(f)}>
                    {ui('编辑推理步骤与评分规则')}
                  </Button>
                </div>
              )}

              <div className="exam-coach-confirm-row">
                <Checkbox
                  label={ui('外观满意')}
                  checked={!!f.confirmations?.appearanceApproved}
                  onChange={(checked) => handleConfirmFlag(f.id, { appearanceApproved: checked })}
                />
                <Checkbox
                  label={ui('考察意图满意')}
                  checked={!!f.confirmations?.intentApproved}
                  onChange={(checked) => handleConfirmFlag(f.id, { intentApproved: checked })}
                />
                <Checkbox
                  label={ui('答案已核实')}
                  checked={!!f.confirmations?.answerVerified}
                  onChange={(checked) => handleConfirmFlag(f.id, { answerVerified: checked })}
                />
              </div>
            </div>
          ))}

          {spec && (
            <div className="exam-coach-actions">
              <Button variant="primary" onClick={() => setStage('configure')}>{ui('下一步：调整题型配额与训练配置')}</Button>
            </div>
          )}
        </div>
      )}

      {stage === 'configure' && (
        <div className="exam-coach-card">
          <div className="exam-coach-card__head">
            <div>
              <h2 className="exam-coach-card__title">{ui('第 3 步：非均分配额、任务增删与考前压缩')}</h2>
              <p className="exam-coach-meta">
                {ui('支持配额设为 0（本轮不出）、按共用材料题组换算题量，以及时间紧张时只保留重点与薄弱项（绝不降低达标标准）。')}
              </p>
            </div>
          </div>

          {!spec ? (
            <Button variant="primary" onClick={() => handleAnalyze(false)}>{ui('先初始化教练方案')}</Button>
          ) : (
            <>
              <div className="exam-coach-field-row">
                <Field label={ui('配置模板名称')} width="md">
                  <TextInput
                    value={spec.templateName || ''}
                    onChange={(e) => setSpec({ ...spec, templateName: e.target.value })}
                  />
                </Field>
                <Checkbox
                  label={ui('开启考前压缩模式（自动延后非重点项，不降低通过标准）')}
                  checked={!!spec.crunchMode?.enabled}
                  onChange={(checked) => setSpec({
                    ...spec,
                    crunchMode: { ...(spec.crunchMode || {}), enabled: checked },
                  })}
                />
                {spec.crunchMode?.enabled && (
                  <Field label={ui('剩余可用时间')} width="sm">
                    <NumberInput
                      min={15}
                      max={1200}
                      suffix={ui('分钟')}
                      value={spec.crunchMode?.remainingMinutes ?? 120}
                      onChange={(e) => setSpec({
                        ...spec,
                        crunchMode: { ...(spec.crunchMode || {}), remainingMinutes: Math.max(15, Number(e.target.value) || 60) },
                      })}
                    />
                  </Field>
                )}
              </div>

              {spec.taskFamilies.map((f) => (
                <div key={f.id} className="exam-coach-card exam-coach-card--raised">
                  <div className="exam-coach-card__head">
                    <Field label={ui('考察任务名称')} width="md">
                      <TextInput
                        value={f.title}
                        onChange={(e) => updateFamilyLocal(f.id, (cur) => ({ ...cur, title: e.target.value }))}
                      />
                    </Field>
                    <Button
                      variant="quiet"
                      size="sm"
                      onClick={() => handleSaveSpec({ operations: [{ type: 'delete', familyId: f.id }] }, ui('已移除该考察任务族'))}
                    >
                      {ui('删除任务族')}
                    </Button>
                  </div>

                  <div className="exam-coach-field-row">
                    <Field label={ui('本轮配额（可填 0）')} width="sm">
                      <NumberInput
                        min={0}
                        max={50}
                        value={f.quota}
                        onChange={(e) => updateFamilyLocal(f.id, (cur) => ({ ...cur, quota: Math.max(0, Math.floor(Number(e.target.value) || 0)) }))}
                      />
                    </Field>
                    <Field label={ui('配额单位')} width="sm">
                      <Select
                        value={f.quotaUnit}
                        options={[
                          { value: 'question', label: ui('按独立题计') },
                          { value: 'shared-material-group', label: ui('按材料题组计（每组多问）') },
                          { value: 'subquestion', label: ui('按大题小问计') },
                        ]}
                        onChange={(val) => updateFamilyLocal(f.id, (cur) => ({
                          ...cur,
                          quotaUnit: val,
                          questionsPerUnit: val === 'shared-material-group' ? 3 : 1,
                        }))}
                      />
                    </Field>
                    <Field label={ui('优先级')} width="sm">
                      <Select
                        value={f.priority}
                        options={[
                          { value: 'high', label: ui('重点必练') },
                          { value: 'medium', label: ui('常规巩固') },
                          { value: 'deferred', label: ui('暂缓延后') },
                        ]}
                        onChange={(val) => updateFamilyLocal(f.id, (cur) => ({ ...cur, priority: val }))}
                      />
                    </Field>
                    <Field label={ui('单题目标限时')} width="sm">
                      <NumberInput
                        min={15}
                        max={3600}
                        suffix={ui('秒')}
                        value={f.timeBudgetSec}
                        onChange={(e) => updateFamilyLocal(f.id, (cur) => ({ ...cur, timeBudgetSec: Math.max(15, Number(e.target.value) || 90) }))}
                      />
                    </Field>
                  </div>

                  <Checkbox
                    label={ui('允许转换为简化题型做前置练习（此类降级题不计入原复杂任务达标）')}
                    checked={!!f.allowFormSubstitute}
                    onChange={(checked) => updateFamilyLocal(f.id, (cur) => ({ ...cur, allowFormSubstitute: checked }))}
                  />
                </div>
              ))}

              <div className="exam-coach-actions">
                <Button
                  variant="secondary"
                  onClick={() => handleSaveSpec({
                    operations: [{
                      type: 'add',
                      family: {
                        id: `custom-${Date.now().toString(36)}`,
                        title: ui('自定义应用任务族'),
                        origin: 'user-defined',
                        primaryFormat: 'open',
                        allowedFormats: ['open'],
                        allowFormSubstitute: false,
                        quota: 2,
                        priority: 'high',
                        reasoningSteps: [ui('核对题干约束条件'), ui('分步推导并验证结论')],
                        rubricPoints: [{ criterion: ui('分步推导完整'), marks: 5, condition: ui('列出依据并逐步求解') }],
                        sample: {
                          format: 'open',
                          stem: ui('请结合给定约束条件分步推导并验证边界情况。'),
                          answer: ui('先列前提，再分步求解并核对边界。'),
                          rubric: ui('列出前提与依据（2分）；分步推导准确且检验边界（3分）。'),
                        },
                      },
                    }],
                  }, ui('已新增自定义任务族'))}
                >
                  {ui('新增任务族')}
                </Button>
                <Button
                  variant="primary"
                  onClick={() => handleSaveSpec({
                    templateName: spec.templateName,
                    crunchMode: spec.crunchMode,
                    taskFamilies: spec.taskFamilies,
                    stage: 'evidence',
                  }, ui('训练配置已保存'))}
                >
                  {ui('保存配置并查看生成与能力证据')}
                </Button>
              </div>
            </>
          )}
        </div>
      )}

      {stage === 'evidence' && (
        <>
          <div className="exam-coach-card">
            <div className="exam-coach-card__head">
              <div>
                <h2 className="exam-coach-card__title">{ui('第 4 步：按校准配置出题与三层证据核对')}</h2>
                <p className="exam-coach-meta">
                  {ui('将教练配置编译为可追溯的模块化出题请求，并严格分开展示「资料覆盖」「训练覆盖」与「独立能力证据」。')}
                </p>
              </div>
              <div className="exam-coach-actions">
                {spec && (
                  <>
                    <Button variant="secondary" lock={busy || working} onClick={handleBuildPreview}>
                      {ui('预览生效要求与配额')}
                    </Button>
                    <Button variant="secondary" lock={busy || working} onClick={handleApplyToGenerateForm}>
                      {ui('带入创建题组表单')}
                    </Button>
                    <Button variant="primary" lock={busy || working || !model.ready} onClick={handleDirectGenerate}>
                      {ui('按校准方案立即出题')}
                    </Button>
                  </>
                )}
              </div>
            </div>

            {compiledPreview?.built && (
              <div className="exam-coach-sample" data-testid="coach-compiled-preview">
                <strong>{uiFormat('生效配置摘要（规格 {0}）', [compiledPreview.built.coachSpecVersion])}</strong>
                <div className="exam-coach-meta">
                  {joinMeta([
                    uiFormat('总题量：{0} 题', [compiledPreview.built.totalCount]),
                    uiFormat('题型分配：{0}', [
                      Object.entries(compiledPreview.built.kindCounts)
                        .map(([k, n]) => `${formatLabel(k)} ${n}`)
                        .join(' / ') || ui('0 题'),
                    ]),
                  ])}
                </div>
                {compiledPreview.built.zeroQuotaFamilies?.length > 0 && (
                  <div className="exam-coach-meta">
                    {uiFormat('本轮配额为 0（不出题）：{0}', [compiledPreview.built.zeroQuotaFamilies.map((z) => z.title).join('、')])}
                  </div>
                )}
                {compiledPreview.built.deferredFamilies?.length > 0 && (
                  <div className="exam-coach-note exam-coach-note--warn">
                    {uiFormat('考前压缩已延后（未降低保留项达标标准）：{0}', [compiledPreview.built.deferredFamilies.map((d) => d.title).join('、')])}
                  </div>
                )}
                {compiledPreview.built.uncalibratedFamilies?.length > 0 && (
                  <div className="exam-coach-note exam-coach-note--warn">
                    {uiFormat('提示：仍有 {0} 项任务族未完成全部三项校准确认。', [compiledPreview.built.uncalibratedFamilies.length])}
                  </div>
                )}
                {compiledPreview.genPreview?.requirementsVersion && (
                  <div className="exam-coach-meta">
                    {uiFormat('出题管线要求版本：{0}', [compiledPreview.genPreview.requirementsVersion])}
                  </div>
                )}
              </div>
            )}
          </div>

          {evidence && (
            <div className="exam-coach-evidence-grid" data-testid="coach-three-layer-evidence">
              <div className="exam-coach-card">
                <h3 className="exam-coach-card__title">{ui('1. 资料覆盖')}</h3>
                <p className="exam-coach-meta">{ui('资料章节是否已有题目触及；纯记忆卡覆盖高不等于具备复杂考试能力。')}</p>
                <div className="exam-coach-stat-row">
                  <span>{ui('已触及资料小节')}</span>
                  <strong>{`${evidence.materialCoverage.coveredSections} / ${evidence.materialCoverage.totalSections}`}</strong>
                </div>
                <div className="exam-coach-stat-row">
                  <span>{ui('题库已发布题目')}</span>
                  <strong>{evidence.materialCoverage.totalPublishedCards}</strong>
                </div>
                <div className="exam-coach-stat-row">
                  <span>{ui('纯记忆/填空卡数量')}</span>
                  <strong>{evidence.materialCoverage.recallOnlyCardCount}</strong>
                </div>
                <div className="exam-coach-stat-row">
                  <span>{ui('仅表面场景词包装（如“某公司…”）')}</span>
                  <strong>{evidence.materialCoverage.surfaceApplicationCardCount}</strong>
                </div>
              </div>

              <div className="exam-coach-card">
                <h3 className="exam-coach-card__title">{ui('2. 训练覆盖')}</h3>
                <p className="exam-coach-meta">{ui('当前校准版本任务族的计划、生成、质检可用与实练进度。')}</p>
                <div className="exam-coach-stat-row">
                  <span>{ui('计划题量（当前版本）')}</span>
                  <strong>{evidence.trainingCoverage.planned}</strong>
                </div>
                <div className="exam-coach-stat-row">
                  <span>{ui('已生成匹配题数')}</span>
                  <strong>{evidence.trainingCoverage.generated}</strong>
                </div>
                <div className="exam-coach-stat-row">
                  <span>{ui('经检查可用题数')}</span>
                  <strong>{evidence.trainingCoverage.verifiedUsable}</strong>
                </div>
                <div className="exam-coach-stat-row">
                  <span>{ui('已实际作答练习')}</span>
                  <strong>{evidence.trainingCoverage.practiced}</strong>
                </div>
                <div className="exam-coach-stat-row">
                  <span>{ui('旧规格版本题 / 前置降级题（不混计）')}</span>
                  <strong>{`${evidence.trainingCoverage.outdatedVersionCardCount} / ${evidence.trainingCoverage.excludedScaffoldOrDowngradeCount}`}</strong>
                </div>
              </div>

              <div className="exam-coach-card">
                <h3 className="exam-coach-card__title">{ui('3. 独立能力证据')}</h3>
                <p className="exam-coach-meta">{evidence.capabilityEvidence.verdict}</p>
                <div className="exam-coach-stat-row">
                  <span>{ui('未见题独立通过')}</span>
                  <strong>{evidence.capabilityEvidence.unseenIndependentPassCount}</strong>
                </div>
                <div className="exam-coach-stat-row">
                  <span>{ui('隔日保持验证（≥12h 新变式）')}</span>
                  <strong>
                    {evidence.capabilityEvidence.delayedIndependent.status === 'unknown'
                      ? ui('未知（缺少时间戳）')
                      : `${evidence.capabilityEvidence.delayedIndependent.passedFamilyCount} / ${evidence.capabilityEvidence.delayedIndependent.totalActiveFamilyCount}`}
                  </strong>
                </div>
                <div className="exam-coach-stat-row">
                  <span>{ui('限时内独立达标')}</span>
                  <strong>
                    {evidence.capabilityEvidence.timedIndependent.status === 'unknown'
                      ? ui('未知（未计时记录）')
                      : uiFormat('{0} 次达标 / {1} 次超时', [
                          evidence.capabilityEvidence.timedIndependent.passedCount,
                          evidence.capabilityEvidence.timedIndependent.overBudgetCount,
                        ])}
                  </strong>
                </div>
                <div className="exam-coach-stat-row">
                  <span>{ui('复习熟练卡片（仅代表见过，非考试证据）')}</span>
                  <strong>{evidence.capabilityEvidence.reviewFamiliarity.reviewedCards}</strong>
                </div>
                <div className="exam-coach-stat-row">
                  <span>{ui('同题重做 / 辅助或已暴露 / 自评')}</span>
                  <strong>
                    {`${evidence.capabilityEvidence.sameItemRepeatCount} / ${evidence.capabilityEvidence.assistedOrExposedCount} / ${evidence.capabilityEvidence.selfReportedCount}`}
                  </strong>
                </div>
              </div>
            </div>
          )}

          <div className="exam-coach-card">
            <div className="exam-coach-card__head">
              <div>
                <h3 className="exam-coach-card__title">{ui('严格同型模拟卷核对')}</h3>
                <p className="exam-coach-meta">
                  {ui('检查当前题库能否在不拿无关题型凑数、不平铺拆散大题小问、不静默丢弃必需配图的前提下组成同型模拟卷。')}
                </p>
              </div>
              <Button variant="secondary" lock={busy || working} onClick={handleCheckStrictMock}>
                {ui('核对同型组卷缺口')}
              </Button>
            </div>

            {mockReport && (
              <div className="exam-coach-sample" data-testid="coach-strict-mock-report">
                <div className="exam-coach-badges">
                  <span className={`exam-coach-badge ${mockReport.complete ? 'exam-coach-badge--ok' : 'exam-coach-badge--warn'}`}>
                    {mockReport.complete ? ui('可完整组成同型卷') : uiFormat('存在 {0} 处结构缺口（未凑数）', [mockReport.shortfalls.length])}
                  </span>
                  <span className="exam-coach-badge">
                    {uiFormat('可达分值：{0} / {1} 分', [mockReport.totalMarks, mockReport.targetMarks])}
                  </span>
                </div>
                {mockReport.shortfalls?.map((sf) => (
                  <div key={sf.sectionId} className="exam-coach-note exam-coach-note--warn">
                    {uiFormat('「{0}」需 {1} 题，实有合格 {2} 题：{3}', [sf.title, sf.requested, sf.fulfilled, sf.reason])}
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}
