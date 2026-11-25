import React from 'react';
import { ui, uiFormat, uiIsEnglish } from './i18n.js';
import { Button, Checkbox, InlineMessage } from './components/index.js';
import { kinds as kindNames, useInjectCss } from './shared.js';
import { useStudy } from './study-context.jsx';
import { customCountOf, kindsOfForm } from './generate-form.js';
import { FormRow } from './generate-rows.jsx';
import { EXTRA_REQUIREMENTS, previewRows } from './generation-preview.js';
import { splitCount } from '../lib/generation-settings.js';
import { MODULE_INSTRUCTION_MAX, TEMPLATE_NAME_MAX, detectRequirementConflicts, normalizeModuleOverrides, withCourseRules } from '../lib/generation-modules.js';
import transparencyCss from './generation-transparency.css';

export function EffectiveRequirementsStrip({ gen, focusCount = 0, referenceCount = 0, ruleCount = 0 }) {
  useInjectCss(transparencyCss, 'study-generation-transparency');
  const kinds = kindsOfForm(gen);
  const customQuotas = gen.kindCounts && typeof gen.kindCounts === 'object' && !Array.isArray(gen.kindCounts);
  const quotaText = kinds.length > 1
    ? (customQuotas
      ? uiFormat('各题型题数：{0}', [kinds.map((k) => `${kindNames[k]} ${gen.kindCounts[k] ?? 0}`).join(' / ')])
      : uiFormat('{0} 种题型均分', [kinds.length]))
    : kindNames[kinds[0]];
  // The run's own modules only: the course's 出题守则 (#889) have their own item.
  const overrides = withCourseRules(gen.moduleOverrides, []);
  // Nothing but the question types: the page already shows them, so there is nothing to add.
  if (!customQuotas && !focusCount && !referenceCount && !ruleCount && !overrides) return null;
  return (
    <div className="gen-trans-strip" data-effective-summary>
      <strong>{ui('本次出题：')}</strong>
      <span className="gen-trans-strip__item">{quotaText}</span>
      {focusCount > 0 && <span className="gen-trans-strip__item">{uiFormat('课程重点继承 {0} 项', [focusCount])}</span>}
      {referenceCount > 0 && <span className="gen-trans-strip__item">{uiFormat('参考样题 {0} 份（仅作形式参考）', [referenceCount])}</span>}
      {ruleCount > 0 && <span className="gen-trans-strip__item">{uiFormat('本课出题守则 {0} 条', [ruleCount])}</span>}
      {overrides && <span className="gen-trans-strip__item">{overrides.templateName ? uiFormat('额外要求：{0}', [overrides.templateName]) : ui('已加额外要求')}</span>}
    </div>
  );
}

/** What this run will ask for, as the rows of `previewRows` (a label and its words; a list where there are several). */
export function EffectivePreview({ rows }) {
  return (
    <dl className="gen-trans-preview" data-effective-preview-panel>
      {rows.map((row) => (
        <div key={row.key} className="gen-trans-preview__row" data-preview-row={row.key}>
          <dt>{row.label}</dt>
          <dd>
            {row.items ? <ul>{row.items.map((item) => <li key={item}>{item}</li>)}</ul> : row.value}
            {row.name ? <small className="gen-trans-preview__name">{uiFormat('要求名称：{0}', [row.name])}</small> : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export default function GenerationTransparency({ gen, setGen, sourceIds = [], sources = [], plannedGoal = null, focusCount = 0, rules = [] }) {
  useInjectCss(transparencyCss, 'study-generation-transparency');
  const { busy: studyBusy } = useStudy();
  const disabled = Boolean(studyBusy);
  const kinds = kindsOfForm(gen);
  const hasCustomQuota = Boolean(gen.kindCounts && typeof gen.kindCounts === 'object' && !Array.isArray(gen.kindCounts));
  const targetTotal = customCountOf(gen) || plannedGoal || 10;
  const overrides = gen.moduleOverrides && typeof gen.moduleOverrides === 'object' ? gen.moduleOverrides : {};
  const [previewOpen, setPreviewOpen] = React.useState(false);
  const [quotaDrafts, setQuotaDrafts] = React.useState({});
  const [moduleDrafts, setModuleDrafts] = React.useState({});
  const [templateDraft, setTemplateDraft] = React.useState(null);

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
    setQuotaDrafts({});
    setGen({ ...gen, kindCounts: initial, customCount: String(Math.max(1, sum)) });
  };

  const resetUniformQuota = () => {
    const next = { ...gen };
    delete next.kindCounts;
    setQuotaDrafts({});
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

  const quotaSum = hasCustomQuota ? kinds.reduce((sum, k) => sum + (Number(gen.kindCounts?.[k]) || 0), 0) : 0;
  const rows = previewOpen ? previewRows({ gen, sources, sourceIds, plannedGoal, focusCount, referenceCount: referenceDocs.length, rules }) : [];

  return (
    <div className="gen-trans-modules" data-generation-transparency>
      <p className="generate-note">{ui('想让题目更贴近你的考法，可以在这里写；不写就按默认来。')}</p>
      {kinds.length >= 2 && (
        <FormRow label={ui('各题型题数')} data-quota-editor>
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
                      value={quotaDrafts[k] ?? String(Number.isInteger(gen.kindCounts?.[k]) ? gen.kindCounts[k] : 0)}
                      onChange={(e) => {
                        const raw = e.target.value;
                        setQuotaDrafts((cur) => ({ ...cur, [k]: raw }));
                        if (raw !== '') updateKindQuota(k, raw);
                      }}
                      onBlur={() => {
                        if (!(k in quotaDrafts)) return;
                        updateKindQuota(k, quotaDrafts[k]);
                        setQuotaDrafts((cur) => { const next = { ...cur }; delete next[k]; return next; });
                      }}
                    />
                  </label>
                ))}
              </div>
              {quotaSum < 1 && <InlineMessage tone="warning">{ui('请至少为一种题型分配 1 道题。')}</InlineMessage>}
            </>
          )}
        </FormRow>
      )}

      {EXTRA_REQUIREMENTS.map(({ key, label, placeholder }) => {
        const entry = overrides[key] && typeof overrides[key] === 'object' ? overrides[key] : { enabled: true, instruction: '' };
        const enabled = entry.enabled !== false;
        // A requirement with nothing written is not "in use": the choice to switch one off shows only once there is a sentence (or it was switched off before).
        const offerSwitch = Boolean(entry.instruction) || !enabled;
        return (
          <FormRow key={key} label={label} htmlFor={`generate-module-${key}`} data-module-key={key}>
            <textarea
              id={`generate-module-${key}`}
              rows={2}
              maxLength={MODULE_INSTRUCTION_MAX}
              disabled={disabled}
              data-module-input={key}
              className={enabled ? 'generate-row__input' : 'generate-row__input generate-input--off'}
              value={moduleDrafts[key] ?? (entry.instruction || '')}
              onChange={(e) => {
                const raw = e.target.value;
                setModuleDrafts((cur) => ({ ...cur, [key]: raw }));
                updateModule(key, { instruction: raw });
              }}
              onBlur={() => {
                setModuleDrafts((cur) => {
                  if (!(key in cur)) return cur;
                  const next = { ...cur };
                  delete next[key];
                  return next;
                });
              }}
              placeholder={placeholder}
            />
            {offerSwitch && (
              <Checkbox
                label={ui('用上这条')}
                checked={enabled}
                disabled={disabled}
                onChange={(checked) => updateModule(key, { enabled: checked })}
              />
            )}
          </FormRow>
        );
      })}

      <FormRow label={ui('要求名称（可选）')} htmlFor="generate-module-template">
        <input
          id="generate-module-template"
          className="generate-row__input"
          maxLength={TEMPLATE_NAME_MAX}
          disabled={disabled}
          value={templateDraft ?? (overrides.templateName || '')}
          onChange={(e) => {
            const raw = e.target.value;
            setTemplateDraft(raw);
            updateTemplateName(raw);
          }}
          onBlur={() => setTemplateDraft(null)}
          placeholder={ui('例如：期末辨析强化')}
        />
      </FormRow>

      {conflicts.map((item) => (
        <InlineMessage key={item.code} tone={item.severity === 'warn' ? 'warning' : 'info'}>
          {item.message}
        </InlineMessage>
      ))}

      {/* No label: the button already says what it shows; the empty label column keeps it on the controls' edge. */}
      <FormRow label={null}>
        <Button variant="secondary" size="sm" disabled={!sourceIds.length} aria-expanded={previewOpen}
          data-preview-effective onClick={() => setPreviewOpen((open) => !open)}>
          {previewOpen ? ui('收起预览') : ui('预览本次出题要求')}
        </Button>
        {previewOpen && <EffectivePreview rows={rows} />}
      </FormRow>
    </div>
  );
}
