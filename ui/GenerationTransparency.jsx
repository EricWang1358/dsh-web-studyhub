import React from 'react';
import { ui, uiFormat, uiIsEnglish } from './i18n.js';
import { Button, Checkbox, InlineMessage } from './components/index.js';
import { kinds as kindNames, useInjectCss } from './shared.js';
import { useStudy } from './study-context.jsx';
import { customCountOf, generationRequest, kindsOfForm } from './generate-form.js';
import { splitCount } from '../lib/generation-settings.js';
import { MODULE_INSTRUCTION_MAX, TEMPLATE_NAME_MAX, detectRequirementConflicts, normalizeModuleOverrides, withCourseRules } from '../lib/generation-modules.js';
import transparencyCss from './generation-transparency.css';

function originBadge(origin) {
  return ({
    explicit: ui('显式填写'),
    course: ui('课程继承'),
    'coverage-plan': ui('覆盖计划'),
    'auto-detected': ui('自动识别'),
    default: ui('默认规则'),
    system: ui('系统锁定'),
    none: ui('未启用'),
  })[origin] || ui('默认规则');
}

export function EffectiveRequirementsStrip({ gen, focusCount = 0, referenceCount = 0, ruleCount = 0 }) {
  useInjectCss(transparencyCss, 'study-generation-transparency');
  const kinds = kindsOfForm(gen);
  const customQuotas = gen.kindCounts && typeof gen.kindCounts === 'object' && !Array.isArray(gen.kindCounts);
  const quotaText = kinds.length > 1
    ? (customQuotas
      ? uiFormat('非均分配额：{0}', [kinds.map((k) => `${kindNames[k]} ${gen.kindCounts[k] ?? 0}`).join(' / ')])
      : uiFormat('{0} 种题型均分', [kinds.length]))
    : kindNames[kinds[0]];
  // The run's own modules only: the course's 出题守则 (#889) have their own item.
  const overrides = withCourseRules(gen.moduleOverrides, []);
  return (
    <div className="gen-trans-strip" data-effective-summary>
      <strong>{ui('本次生效要求：')}</strong>
      <span className="gen-trans-strip__item">{quotaText}</span>
      {focusCount > 0 && <span className="gen-trans-strip__item">{uiFormat('课程重点继承 {0} 项', [focusCount])}</span>}
      {referenceCount > 0 && <span className="gen-trans-strip__item">{uiFormat('参考样题 {0} 份（仅作形式参考）', [referenceCount])}</span>}
      {ruleCount > 0 && <span className="gen-trans-strip__item">{uiFormat('本课出题守则 {0} 条', [ruleCount])}</span>}
      {overrides && <span className="gen-trans-strip__item">{overrides.templateName ? uiFormat('自定义模块：{0}', [overrides.templateName]) : ui('已启用自定义推理/错因模块')}</span>}
    </div>
  );
}

/** The preview's own row for the course's 出题守则 (#889): every rule, or that the course has none. */
function CourseRulesRow({ rules }) {
  return (
    <div className="gen-trans-preview__rules" data-preview-course-rules>
      <strong>{rules.length ? uiFormat('本课出题守则（{0} 条，规划、出题和审阅都带上）：', [rules.length]) : ui('本课出题守则：未设置（在课程设置的「更多设置」里添加）')}</strong>
      {rules.length > 0 && <ol>{rules.map((rule) => <li key={rule}>{rule}</li>)}</ol>}
    </div>
  );
}

export default function GenerationTransparency({ gen, setGen, course = '', sourceIds = [], sources = [], plannedGoal = null }) {
  useInjectCss(transparencyCss, 'study-generation-transparency');
  const { call, busy: studyBusy } = useStudy();
  const disabled = Boolean(studyBusy);
  const kinds = kindsOfForm(gen);
  const hasCustomQuota = Boolean(gen.kindCounts && typeof gen.kindCounts === 'object' && !Array.isArray(gen.kindCounts));
  const targetTotal = customCountOf(gen) || plannedGoal || 10;
  const overrides = gen.moduleOverrides && typeof gen.moduleOverrides === 'object' ? gen.moduleOverrides : {};

  const [previewState, setPreviewState] = React.useState({ status: 'idle', data: null, error: '' });

  const referenceDocs = React.useMemo(() => {
    const refIds = new Set(gen.referenceSourceIds || []);
    return (sources || []).filter((s) => refIds.has(s.id));
  }, [sources, gen.referenceSourceIds]);

  const conflicts = React.useMemo(() => detectRequirementConflicts({
    kinds,
    kindCounts: gen.kindCounts,
    referenceFormat: gen.referenceFormat,
    questionReferences: referenceDocs,
    count: customCountOf(gen) || plannedGoal || undefined,
    language: uiIsEnglish() ? 'en' : 'zh',
  }), [kinds, referenceDocs, gen, plannedGoal]);

  const enableCustomQuota = () => {
    const initial = Object.fromEntries(splitCount(kinds, Math.max(1, targetTotal)));
    const sum = Object.values(initial).reduce((a, b) => a + b, 0);
    setGen({ ...gen, kindCounts: initial, customCount: String(Math.max(1, sum)) });
  };

  const resetUniformQuota = () => {
    const next = { ...gen };
    delete next.kindCounts;
    setGen(next);
  };

  const updateKindQuota = (kind, rawValue) => {
    const parsed = rawValue === '' ? 0 : Math.max(0, Math.min(500, Math.floor(Number(rawValue) || 0)));
    const nextCounts = {};
    for (const k of kinds) {
      nextCounts[k] = k === kind ? parsed : (Number.isInteger(gen.kindCounts?.[k]) ? gen.kindCounts[k] : 0);
    }
    const sum = Object.values(nextCounts).reduce((a, b) => a + b, 0);
    setGen({
      ...gen,
      kindCounts: nextCounts,
      ...(sum >= 1 ? { customCount: String(sum) } : {}),
    });
  };

  const updateModule = (moduleKey, patch) => {
    const currentEntry = overrides[moduleKey] && typeof overrides[moduleKey] === 'object'
      ? overrides[moduleKey]
      : { enabled: true, instruction: '' };
    const merged = { ...overrides, [moduleKey]: { ...currentEntry, ...patch } };
    const cleaned = normalizeModuleOverrides(merged);
    const next = { ...gen };
    if (cleaned) next.moduleOverrides = cleaned;
    else delete next.moduleOverrides;
    setGen(next);
  };

  const updateTemplateName = (templateName) => {
    const merged = { ...overrides, templateName };
    const cleaned = normalizeModuleOverrides(merged);
    const next = { ...gen };
    if (cleaned) next.moduleOverrides = cleaned;
    else delete next.moduleOverrides;
    setGen(next);
  };

  const runPreview = async () => {
    if (!call || !sourceIds.length) return;
    setPreviewState({ status: 'loading', data: null, error: '' });
    try {
      const result = await call('generate.preview', generationRequest(gen, { course, sourceIds }));
      setPreviewState({ status: 'ready', data: result, error: '' });
    } catch (error) {
      setPreviewState({ status: 'error', data: null, error: String(error?.message || error) });
    }
  };

  const quotaSum = hasCustomQuota ? kinds.reduce((sum, k) => sum + (Number(gen.kindCounts?.[k]) || 0), 0) : 0;

  const moduleRows = [
    {
      key: 'reasoning',
      title: ui('关键推理与条件辨析'),
      placeholder: ui('例如：必须包含边界条件反例判断，避免纯定义背诵'),
    },
    {
      key: 'distractors',
      title: ui('干扰项错因规则（独立于样题措辞）'),
      placeholder: ui('例如：每个干扰项对应具体常见误区，禁止凑数否定项'),
    },
    {
      key: 'rubric',
      title: ui('开放题 / 动手题评分要点'),
      placeholder: ui('例如：按推理步骤拆分采分点，标明遗漏关键前提的扣分原因'),
    },
  ];

  return (
    <div className="gen-trans-modules" data-generation-transparency>
      {kinds.length >= 2 && (
        <div className="gen-trans-quota" data-quota-editor>
          <div className="gen-trans-quota__bar">
            <span className="generate-note">
              {hasCustomQuota
                ? uiFormat('按独立题目数分配（合计 {0} 题；设为 0 的已勾题型在本次与补题中均不出题）', [quotaSum])
                : ui('默认将总题数在已勾选题型间平均分配。')}
            </span>
            <Button variant="secondary" size="sm" disabled={disabled} data-toggle-custom-quota
              onClick={hasCustomQuota ? resetUniformQuota : enableCustomQuota}>
              {hasCustomQuota ? ui('恢复均分') : ui('自定义各题型题数')}
            </Button>
          </div>
          {hasCustomQuota && (
            <>
              <div className="gen-trans-quota__grid">
                {kinds.map((k) => (
                  <label key={k} className="gen-trans-quota__cell">
                    <span>{kindNames[k]}</span>
                    <input
                      type="number"
                      min={0}
                      max={500}
                      step={1}
                      disabled={disabled}
                      data-quota-kind={k}
                      className="generate-row__input gen-trans-quota__input"
                      value={Number.isInteger(gen.kindCounts?.[k]) ? gen.kindCounts[k] : 0}
                      onChange={(e) => updateKindQuota(k, e.target.value)}
                    />
                  </label>
                ))}
              </div>
              {quotaSum < 1 && <InlineMessage tone="warning">{ui('请至少为一种题型分配 1 道题。')}</InlineMessage>}
              <p className="generate-note">{ui('注：当前配额单位为「独立题数」；分值与预计作答时长仅作展示估算，不冒充自动反推题数。')}</p>
            </>
          )}
        </div>
      )}

      <div className="gen-trans-module">
        <div className="gen-trans-module__head">
          <label htmlFor="generate-module-template">{ui('业务规则模板名称（可选）')}</label>
        </div>
        <input
          id="generate-module-template"
          className="generate-row__input"
          maxLength={TEMPLATE_NAME_MAX}
          disabled={disabled}
          value={overrides.templateName || ''}
          onChange={(e) => updateTemplateName(e.target.value)}
          placeholder={ui('例如：期末辨析强化模板')}
        />
      </div>

      {moduleRows.map(({ key, title, placeholder }) => {
        const entry = overrides[key] && typeof overrides[key] === 'object' ? overrides[key] : { enabled: true, instruction: '' };
        const enabled = entry.enabled !== false;
        return (
          <div key={key} className="gen-trans-module" data-module-key={key}>
            <div className="gen-trans-module__head">
              <span>{title}</span>
              <Checkbox
                label={ui('启用此模块')}
                checked={enabled}
                disabled={disabled}
                onChange={(checked) => updateModule(key, { enabled: checked })}
              />
            </div>
            {enabled && (
              <textarea
                rows={2}
                maxLength={MODULE_INSTRUCTION_MAX}
                disabled={disabled}
                data-module-input={key}
                className="generate-row__input"
                value={entry.instruction || ''}
                onChange={(e) => updateModule(key, { instruction: e.target.value })}
                placeholder={placeholder}
              />
            )}
          </div>
        );
      })}

      <div className="gen-trans-locked" data-locked-protocol>
        <strong>{ui('系统基础安全约束（只读，不可关闭）：')}</strong>{' '}
        {ui('JSON 协议校验 · 仅从证据资料逐字核对引文出处 · 题干与提示防漏答案 · 独立审阅闭环')}
      </div>

      {conflicts.map((item) => (
        <InlineMessage key={item.code} tone={item.severity === 'warn' ? 'warning' : 'info'}>
          {item.message}
        </InlineMessage>
      ))}

      <div>
        <Button variant="secondary" size="sm" disabled={disabled || !sourceIds.length}
          busy={previewState.status === 'loading'} busyLabel={ui('正在汇总生效规则…')}
          data-preview-effective onClick={runPreview}>
          {ui('预览生效要求与阶段规则（零模型调用）')}
        </Button>
      </div>

      {previewState.status === 'error' && <InlineMessage tone="warning">{previewState.error}</InlineMessage>}
      {previewState.status === 'ready' && previewState.data && (
        <div className="gen-trans-preview" data-effective-preview-panel>
          <p className="gen-trans-preview__meta">
            <span>{uiFormat('模型调用：{0} 次（零开销预览）', [previewState.data.modelCalls ?? 0])}</span>
            <span>{uiFormat('规格版本：{0}', [previewState.data.requirementsVersion || '-'])}</span>
            <span>{uiFormat('配额来源：{0}', [originBadge(previewState.data.origins?.quota)])}</span>
            <span>{uiFormat('重点来源：{0}', [originBadge(previewState.data.origins?.focusTopics)])}</span>
          </p>
          <CourseRulesRow rules={previewState.data.modules?.find((module) => module.id === 'course_rules')?.rules || []} />
          <ul className="gen-trans-preview__stages">
            {(previewState.data.stages || []).map((stage) => (
              <li key={stage.id} className="gen-trans-preview__stage">
                <strong>{stage.label}</strong>
                {stage.determinedInputs?.length > 0 && (
                  <div>{ui('已确定输入：')}{stage.determinedInputs.join('；')}</div>
                )}
                {stage.pendingInputs?.length > 0 && (
                  <div className="muted">{ui('运行后产生：')}{stage.pendingInputs.join('；')}</div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
